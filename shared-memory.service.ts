import { Injectable, InjectionToken, inject } from '@angular/core';
import { SharedDataMap, SharedKey, safeValidateSharedValue } from './shared-contract';

type SharedValue<T = any> = T;

export type SharedStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SharedAction = 'init' | 'set' | 'loading' | 'error' | 'remove' | 'clear';

export interface SharedMemoryEntry<T = SharedValue> {
  key: string;
  status: SharedStatus;
  value?: T;
  error?: unknown;
  updatedAt: number;
  version: number;
}

export interface SharedMemoryChange<T = SharedValue> extends SharedMemoryEntry<T> {
  action: SharedAction;
  previousValue?: T;
}

export interface SharedMemoryWaitOptions {
  timeoutMs?: number;
}

export interface SharedWaiter<T = SharedValue> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SharedMemoryStore {
  values: Map<string, SharedValue>;
  statuses: Map<string, SharedStatus>;
  errors: Map<string, unknown>;
  subscribers: Map<string, Set<(event: SharedMemoryChange) => void>>;
  waiters: Map<string, Array<SharedWaiter>>;
  inflightLoads: Map<string, Promise<SharedValue>>;
  versions: Map<string, number>;
  updatedAt: Map<string, number>;
  epochs: Map<string, number>;
}

export interface SharedReader {
  get<K extends SharedKey>(key: K): SharedDataMap[K] | undefined;
  getEntry<K extends SharedKey>(key: K): SharedMemoryEntry<SharedDataMap[K]>;
  getStatus<K extends SharedKey>(key: K): SharedStatus;
  getError(key: SharedKey): unknown;
  has<K extends SharedKey>(key: K): boolean;
  wait<K extends SharedKey>(key: K, options?: SharedMemoryWaitOptions): Promise<SharedDataMap[K]>;
  subscribe<K extends SharedKey>(
    key: K,
    listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
    options?: { emitCurrent?: boolean }
  ): () => void;
}

export interface SharedWriter {
  init<K extends SharedKey>(key: K): void;
  set<K extends SharedKey>(key: K, value: SharedDataMap[K]): void;
  setLoading<K extends SharedKey>(key: K): void;
  setError<K extends SharedKey>(key: K, error: unknown): void;
  load<K extends SharedKey>(
    key: K,
    source: Promise<unknown> | (() => Promise<unknown>)
  ): Promise<SharedDataMap[K]>;
  remove<K extends SharedKey>(key: K): void;
  clear(): void;
}

export const SHARED_MEMORY_STORE = new InjectionToken<SharedMemoryStore>('SHARED_MEMORY_STORE');

function now(): number {
  return Date.now();
}

function createEntry<T = SharedValue>(
  key: string,
  patch: Partial<SharedMemoryEntry<T>> = {}
): SharedMemoryEntry<T> {
  return {
    key,
    status: patch.status ?? 'idle',
    value: patch.value,
    error: patch.error,
    updatedAt: patch.updatedAt ?? now(),
    version: patch.version ?? 0,
  };
}

function createChange<T = SharedValue>(
  key: string,
  patch: Partial<SharedMemoryChange<T>> = {}
): SharedMemoryChange<T> {
  return {
    ...createEntry<T>(key, patch),
    action: patch.action ?? 'init',
    previousValue: patch.previousValue,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, key?: string): Promise<T> {
  if (timeoutMs === undefined || timeoutMs === null) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待 shared key "${key ?? 'unknown'}" 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function ensureStore(store?: SharedMemoryStore): SharedMemoryStore {
  if (store) return store;
  return createSharedMemoryStore();
}

function bumpMeta(store: SharedMemoryStore, key: SharedKey): { version: number; updatedAt: number } {
  const version = (store.versions.get(key) ?? 0) + 1;
  const updatedAt = now();
  store.versions.set(key, version);
  store.updatedAt.set(key, updatedAt);
  return { version, updatedAt };
}

function bumpEpoch(store: SharedMemoryStore, key: SharedKey): number {
  const next = (store.epochs.get(key) ?? 0) + 1;
  store.epochs.set(key, next);
  return next;
}

function currentEpoch(store: SharedMemoryStore, key: SharedKey): number {
  return store.epochs.get(key) ?? 0;
}

function emit<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  action: SharedAction,
  previousValue?: SharedDataMap[K]
): void {
  const listeners = store.subscribers.get(key);
  if (!listeners?.size) return;

  const change = createChange<SharedDataMap[K]>(key, {
    ...storeToEntry(store, key),
    action,
    previousValue,
  });

  listeners.forEach((listener) => {
    try {
      listener(change as SharedMemoryChange);
    } catch {
      // ignore subscriber errors
    }
  });
}

function storeToEntry<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedMemoryEntry<SharedDataMap[K]> {
  const value = store.values.get(key) as SharedDataMap[K] | undefined;
  return createEntry<SharedDataMap[K]>(key, {
    status: store.statuses.get(key) ?? (value === undefined ? 'idle' : 'ready'),
    value,
    error: store.errors.get(key),
    updatedAt: store.updatedAt.get(key) ?? 0,
    version: store.versions.get(key) ?? 0,
  });
}

function resolveWaiters<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]): void {
  const waiters = store.waiters.get(key);
  if (!waiters?.length) return;

  waiters.forEach(({ resolve, timer }) => {
    if (timer) clearTimeout(timer);
    resolve(value as SharedValue);
  });
  store.waiters.delete(key);
}

function rejectWaiters(store: SharedMemoryStore, key: SharedKey, error: unknown): void {
  const waiters = store.waiters.get(key);
  if (!waiters?.length) return;

  waiters.forEach(({ reject, timer }) => {
    if (timer) clearTimeout(timer);
    reject(error);
  });
  store.waiters.delete(key);
}

function setValueCore<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]): void {
  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  const { version, updatedAt } = bumpMeta(store, key);

  store.values.set(key, value);
  store.statuses.set(key, 'ready');
  store.errors.delete(key);
  store.inflightLoads.delete(key);

  resolveWaiters(store, key, value);
  emit(store, key, 'set', previousValue);

  // keep the entry timestamp stable for consumers
  store.updatedAt.set(key, updatedAt);
  store.versions.set(key, version);
}

function setLoadingCore<K extends SharedKey>(store: SharedMemoryStore, key: K): void {
  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  const { version, updatedAt } = bumpMeta(store, key);

  store.statuses.set(key, 'loading');
  store.errors.delete(key);

  emit(store, key, 'loading', previousValue);

  store.updatedAt.set(key, updatedAt);
  store.versions.set(key, version);
}

function setErrorCore<K extends SharedKey>(store: SharedMemoryStore, key: K, error: unknown): void {
  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  const { version, updatedAt } = bumpMeta(store, key);

  store.statuses.set(key, 'error');
  store.errors.set(key, error);
  store.inflightLoads.delete(key);

  rejectWaiters(store, key, error);
  emit(store, key, 'error', previousValue);

  store.updatedAt.set(key, updatedAt);
  store.versions.set(key, version);
}

function removeCore<K extends SharedKey>(store: SharedMemoryStore, key: K): void {
  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  bumpEpoch(store, key);
  const { version, updatedAt } = bumpMeta(store, key);

  store.values.delete(key);
  store.statuses.set(key, 'idle');
  store.errors.delete(key);
  store.inflightLoads.delete(key);

  rejectWaiters(store, key, new Error(`shared key "${String(key)}" 已被移除`));
  emit(store, key, 'remove', previousValue);

  store.updatedAt.set(key, updatedAt);
  store.versions.set(key, version);
}

function clearCore(store: SharedMemoryStore): void {
  const keys = new Set<string>([
    ...store.values.keys(),
    ...store.statuses.keys(),
    ...store.errors.keys(),
    ...store.waiters.keys(),
    ...store.subscribers.keys(),
    ...store.inflightLoads.keys(),
  ]);

  keys.forEach((key) => bumpEpoch(store, key));

  keys.forEach((key) => {
    const previousValue = store.values.get(key);
    const { version, updatedAt } = bumpMeta(store, key);

    const listeners = store.subscribers.get(key);
    if (listeners?.size) {
      const change = createChange(key, {
        status: 'idle',
        value: undefined,
        error: undefined,
        updatedAt,
        version,
        action: 'clear',
        previousValue: previousValue as SharedValue,
      });

      listeners.forEach((listener) => {
        try {
          listener(change);
        } catch {
          // ignore
        }
      });
    }

    rejectWaiters(store, key, new Error(`shared key "${key}" 已被清空`));
  });

  store.values.clear();
  store.statuses.clear();
  store.errors.clear();
  store.inflightLoads.clear();
  store.waiters.clear();
  store.versions.clear();
  store.updatedAt.clear();
}

function loadCore<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  source: Promise<unknown> | (() => Promise<unknown>)
): Promise<SharedDataMap[K]> {
  const existed = store.values.get(key);
  if (existed !== undefined) {
    return Promise.resolve(existed as SharedDataMap[K]);
  }

  const running = store.inflightLoads.get(key);
  if (running) {
    return running as Promise<SharedDataMap[K]>;
  }

  setLoadingCore(store, key);
  const epoch = currentEpoch(store, key);
  const sourcePromise = typeof source === 'function' ? source() : source;

  const loadPromise = sourcePromise
    .then((value) => {
      if (currentEpoch(store, key) !== epoch) {
        throw new Error(`shared key "${String(key)}" 已失效`);
      }

      const result = safeValidateSharedValue(key, value);
      if (!result.success) {
        throw result.error;
      }

      setValueCore(store, key, result.data);
      return result.data;
    })
    .catch((error) => {
      if (currentEpoch(store, key) === epoch) {
        setErrorCore(store, key, error);
      }
      throw error;
    })
    .finally(() => {
      if (store.inflightLoads.get(key) === loadPromise) {
        store.inflightLoads.delete(key);
      }
    });

  store.inflightLoads.set(key, loadPromise as Promise<SharedValue>);
  return loadPromise;
}

export function createSharedMemoryStore(): SharedMemoryStore {
  return {
    values: new Map(),
    statuses: new Map(),
    errors: new Map(),
    subscribers: new Map(),
    waiters: new Map(),
    inflightLoads: new Map(),
    versions: new Map(),
    updatedAt: new Map(),
    epochs: new Map(),
  };
}

export function createSharedReader(store: SharedMemoryStore): SharedReader {
  return {
    get: <K extends SharedKey>(key: K) => store.values.get(key) as SharedDataMap[K] | undefined,
    getEntry: <K extends SharedKey>(key: K) => storeToEntry(store, key),
    getStatus: <K extends SharedKey>(key: K) => store.statuses.get(key) ?? (store.values.has(key) ? 'ready' : 'idle'),
    getError: (key: SharedKey) => store.errors.get(key),
    has: <K extends SharedKey>(key: K) => store.values.has(key),
    wait: <K extends SharedKey>(key: K, options: SharedMemoryWaitOptions = {}) => {
      const existed = store.values.get(key);
      if (existed !== undefined) {
        return Promise.resolve(existed as SharedDataMap[K]);
      }

      const status = store.statuses.get(key) ?? 'idle';
      if (status === 'error') {
        return Promise.reject(store.errors.get(key) ?? new Error(`shared key "${String(key)}" 已进入 error 状态`));
      }

      const running = store.inflightLoads.get(key);
      if (running) {
        return withTimeout(running as Promise<SharedDataMap[K]>, options.timeoutMs, String(key));
      }

      return new Promise<SharedDataMap[K]>((resolve, reject) => {
        const waiter: SharedWaiter = { resolve: resolve as (value: SharedValue) => void, reject };

        if (options.timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            const current = store.waiters.get(key);
            if (current) {
              store.waiters.set(key, current.filter((item) => item !== waiter));
            }
            reject(new Error(`等待 shared key "${String(key)}" 超时 (${options.timeoutMs}ms)`));
          }, options.timeoutMs);
        }

        const list = store.waiters.get(key) ?? [];
        list.push(waiter);
        store.waiters.set(key, list);
      });
    },
    subscribe: <K extends SharedKey>(
      key: K,
      listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
      options: { emitCurrent?: boolean } = {}
    ) => {
      const listenerSet = store.subscribers.get(key) ?? new Set();
      listenerSet.add(listener as (event: SharedMemoryChange) => void);
      store.subscribers.set(key, listenerSet);

      if (options.emitCurrent !== false) {
        const current = storeToEntry(store, key);
        listener({
          ...current,
          action: 'init',
          previousValue: current.value,
        } as SharedMemoryChange<SharedDataMap[K]>);
      }

      return () => {
        const current = store.subscribers.get(key);
        current?.delete(listener as (event: SharedMemoryChange) => void);
        if (current && current.size === 0) {
          store.subscribers.delete(key);
        }
      };
    },
  };
}

export function createSharedWriter(store: SharedMemoryStore): SharedWriter {
  return {
    init: <K extends SharedKey>(key: K) => setLoadingCore(store, key),
    set: <K extends SharedKey>(key: K, value: SharedDataMap[K]) => {
      const result = safeValidateSharedValue(key, value);
      if (!result.success) {
        throw result.error;
      }
      setValueCore(store, key, result.data);
    },
    setLoading: <K extends SharedKey>(key: K) => setLoadingCore(store, key),
    setError: <K extends SharedKey>(key: K, error: unknown) => setErrorCore(store, key, error),
    load: <K extends SharedKey>(
      key: K,
      source: Promise<unknown> | (() => Promise<unknown>)
    ) => loadCore(store, key, source),
    remove: <K extends SharedKey>(key: K) => removeCore(store, key),
    clear: () => clearCore(store),
  };
}

export const sharedMemory = {
  createStore: createSharedMemoryStore,
  reader: createSharedReader,
  writer: createSharedWriter,
  get<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
    return store.values.get(key) as SharedDataMap[K] | undefined;
  },
  getEntry<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedMemoryEntry<SharedDataMap[K]> {
    return storeToEntry(store, key);
  },
  getStatus(store: SharedMemoryStore, key: SharedKey): SharedStatus {
    return store.statuses.get(key) ?? (store.values.has(key) ? 'ready' : 'idle');
  },
  getError(store: SharedMemoryStore, key: SharedKey): unknown {
    return store.errors.get(key);
  },
  has(store: SharedMemoryStore, key: SharedKey): boolean {
    return store.values.has(key);
  },
  wait<K extends SharedKey>(
    store: SharedMemoryStore,
    key: K,
    options: SharedMemoryWaitOptions = {}
  ): Promise<SharedDataMap[K]> {
    return createSharedReader(store).wait(key, options);
  },
  subscribe<K extends SharedKey>(
    store: SharedMemoryStore,
    key: K,
    listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
    options: { emitCurrent?: boolean } = {}
  ): () => void {
    return createSharedReader(store).subscribe(key, listener, options);
  },
  set<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
    createSharedWriter(store).set(key, value);
  },
  setLoading<K extends SharedKey>(store: SharedMemoryStore, key: K) {
    createSharedWriter(store).setLoading(key);
  },
  setError<K extends SharedKey>(store: SharedMemoryStore, key: K, error: unknown) {
    createSharedWriter(store).setError(key, error);
  },
  load<K extends SharedKey>(
    store: SharedMemoryStore,
    key: K,
    source: Promise<unknown> | (() => Promise<unknown>)
  ): Promise<SharedDataMap[K]> {
    return createSharedWriter(store).load(key, source);
  },
  remove<K extends SharedKey>(store: SharedMemoryStore, key: K) {
    createSharedWriter(store).remove(key);
  },
  clear(store: SharedMemoryStore) {
    createSharedWriter(store).clear();
  },
};

@Injectable({
  providedIn: 'root',
})
export class SharedMemoryService {
  private readonly store = inject(SHARED_MEMORY_STORE, { optional: true }) ?? createSharedMemoryStore();

  /**
   * 基座把同一个 store 传进来。
   */
  bindStore(store: SharedMemoryStore): void {
    this.store.values = store.values;
    this.store.statuses = store.statuses;
    this.store.errors = store.errors;
    this.store.subscribers = store.subscribers;
    this.store.waiters = store.waiters;
    this.store.inflightLoads = store.inflightLoads;
    this.store.versions = store.versions;
    this.store.updatedAt = store.updatedAt;
    this.store.epochs = store.epochs;
  }

  reader(): SharedReader {
    return createSharedReader(this.store);
  }

  writer(): SharedWriter {
    return createSharedWriter(this.store);
  }

  // 下面这层保留兼容，默认更偏向 consumer 视角。
  get<K extends SharedKey>(key: K): SharedDataMap[K] | undefined {
    return this.reader().get(key);
  }

  getEntry<K extends SharedKey>(key: K): SharedMemoryEntry<SharedDataMap[K]> {
    return this.reader().getEntry(key);
  }

  getStatus<K extends SharedKey>(key: K): SharedStatus {
    return this.reader().getStatus(key);
  }

  getError(key: SharedKey): unknown {
    return this.reader().getError(key);
  }

  has<K extends SharedKey>(key: K): boolean {
    return this.reader().has(key);
  }

  wait<K extends SharedKey>(key: K, options: SharedMemoryWaitOptions = {}): Promise<SharedDataMap[K]> {
    return this.reader().wait(key, options);
  }

  subscribe<K extends SharedKey>(
    key: K,
    listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
    options: { emitCurrent?: boolean } = {}
  ): () => void {
    return this.reader().subscribe(key, listener, options);
  }

  init<K extends SharedKey>(key: K): void {
    this.writer().init(key);
  }

  set<K extends SharedKey>(key: K, value: SharedDataMap[K]): void {
    this.writer().set(key, value);
  }

  setLoading<K extends SharedKey>(key: K): void {
    this.writer().setLoading(key);
  }

  setError<K extends SharedKey>(key: K, error: unknown): void {
    this.writer().setError(key, error);
  }

  load<K extends SharedKey>(
    key: K,
    source: Promise<unknown> | (() => Promise<unknown>)
  ): Promise<SharedDataMap[K]> {
    return this.writer().load(key, source);
  }

  remove<K extends SharedKey>(key: K): void {
    this.writer().remove(key);
  }

  clear(): void {
    this.writer().clear();
  }
}
