import React, { useEffect, useMemo, useState } from 'react';
import {
  SharedDataMap,
  SharedKey,
  safeValidateSharedValue,
} from './shared-contract';

export type SharedStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SharedMemoryChange<T = any> {
  key: string;
  status: SharedStatus;
  value?: T;
  error?: unknown;
  updatedAt: number;
  version: number;
  action: 'init' | 'set' | 'loading' | 'error' | 'remove' | 'clear';
  previousValue?: T;
}

export interface SharedMemoryStore {
  values: Map<string, any>;
  statuses: Map<string, SharedStatus>;
  errors: Map<string, unknown>;
  subscribers: Map<string, Set<(event: SharedMemoryChange) => void>>;
  waiters: Map<string, Array<{ resolve: (value: any) => void; reject: (error: unknown) => void; timer?: ReturnType<typeof setTimeout> }>>;
  inflightLoads: Map<string, Promise<any>>;
  versions: Map<string, number>;
  updatedAt: Map<string, number>;
  epochs: Map<string, number>;
}

function now(): number {
  return Date.now();
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

function emit<T>(store: SharedMemoryStore, event: SharedMemoryChange<T>) {
  const listeners = store.subscribers.get(event.key);
  if (!listeners?.size) return;

  listeners.forEach((listener) => {
    try {
      listener(event as SharedMemoryChange);
    } catch {
      // ignore
    }
  });
}

function bumpMeta(store: SharedMemoryStore, key: SharedKey) {
  const version = (store.versions.get(key) ?? 0) + 1;
  const updatedAt = now();
  store.versions.set(key, version);
  store.updatedAt.set(key, updatedAt);
  return { version, updatedAt };
}

function bumpEpoch(store: SharedMemoryStore, key: SharedKey) {
  const next = (store.epochs.get(key) ?? 0) + 1;
  store.epochs.set(key, next);
  return next;
}

function resolveWaiters(store: SharedMemoryStore, key: SharedKey, value: any) {
  const waiters = store.waiters.get(key);
  if (!waiters?.length) return;

  waiters.forEach(({ resolve, timer }) => {
    if (timer) clearTimeout(timer);
    resolve(value);
  });
  store.waiters.delete(key);
}

function rejectWaiters(store: SharedMemoryStore, key: SharedKey, error: unknown) {
  const waiters = store.waiters.get(key);
  if (!waiters?.length) return;

  waiters.forEach(({ reject, timer }) => {
    if (timer) clearTimeout(timer);
    reject(error);
  });
  store.waiters.delete(key);
}

export function setSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
  const result = safeValidateSharedValue(key, value);
  if (!result.success) throw result.error;

  const previousValue = store.values.get(key);
  bumpEpoch(store, key);
  const { version, updatedAt } = bumpMeta(store, key);

  store.values.set(key, result.data);
  store.statuses.set(key, 'ready');
  store.errors.delete(key);
  store.inflightLoads.delete(key);

  resolveWaiters(store, key, result.data);

  emit(store, {
    key,
    status: 'ready',
    value: result.data,
    error: undefined,
    updatedAt,
    version,
    action: 'set',
    previousValue,
  });
}

export function setSharedLoading<K extends SharedKey>(store: SharedMemoryStore, key: K) {
  const previousValue = store.values.get(key);
  bumpEpoch(store, key);
  const { version, updatedAt } = bumpMeta(store, key);

  store.statuses.set(key, 'loading');
  store.errors.delete(key);
  store.inflightLoads.delete(key);

  emit(store, {
    key,
    status: 'loading',
    value: previousValue,
    error: undefined,
    updatedAt,
    version,
    action: 'loading',
    previousValue,
  });
}

export function setSharedError<K extends SharedKey>(store: SharedMemoryStore, key: K, error: unknown) {
  const previousValue = store.values.get(key);
  bumpEpoch(store, key);
  const { version, updatedAt } = bumpMeta(store, key);

  store.statuses.set(key, 'error');
  store.errors.set(key, error);
  store.inflightLoads.delete(key);

  rejectWaiters(store, key, error);

  emit(store, {
    key,
    status: 'error',
    value: previousValue,
    error,
    updatedAt,
    version,
    action: 'error',
    previousValue,
  });
}

export function getSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
  return store.values.get(key) as SharedDataMap[K] | undefined;
}

export function subscribeSharedData<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
  options: { emitCurrent?: boolean } = {}
): () => void {
  const listeners = store.subscribers.get(key) ?? new Set();
  listeners.add(listener as (event: SharedMemoryChange) => void);
  store.subscribers.set(key, listeners);

  if (options.emitCurrent !== false) {
    const currentValue = store.values.get(key) as SharedDataMap[K] | undefined;
    listener({
      key,
      status: store.statuses.get(key) ?? (currentValue === undefined ? 'idle' : 'ready'),
      value: currentValue,
      error: store.errors.get(key),
      updatedAt: store.updatedAt.get(key) ?? now(),
      version: store.versions.get(key) ?? 0,
      action: 'init',
      previousValue: currentValue,
    } as SharedMemoryChange<SharedDataMap[K]>);
  }

  return () => {
    const current = store.subscribers.get(key);
    current?.delete(listener as (event: SharedMemoryChange) => void);
    if (current && current.size === 0) store.subscribers.delete(key);
  };
}

export function waitSharedData<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  options: { timeoutMs?: number } = {}
): Promise<SharedDataMap[K]> {
  const existed = store.values.get(key);
  if (existed !== undefined) return Promise.resolve(existed as SharedDataMap[K]);

  const status = store.statuses.get(key) ?? 'idle';
  if (status === 'error') {
    return Promise.reject(store.errors.get(key) ?? new Error(`shared key "${String(key)}" 已进入 error 状态`));
  }

  const running = store.inflightLoads.get(key);
  if (running) return running as Promise<SharedDataMap[K]>;

  return new Promise<SharedDataMap[K]>((resolve, reject) => {
    const waiter = { resolve: resolve as (value: any) => void, reject };

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
}

export function loadSharedData<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  source: Promise<unknown> | (() => Promise<unknown>)
): Promise<SharedDataMap[K]> {
  const existed = store.values.get(key);
  if (existed !== undefined) return Promise.resolve(existed as SharedDataMap[K]);

  const running = store.inflightLoads.get(key);
  if (running) return running as Promise<SharedDataMap[K]>;

  setSharedLoading(store, key);
  const epoch = store.epochs.get(key) ?? 0;
  const sourcePromise = typeof source === 'function' ? source() : source;

  const p = sourcePromise
    .then((value) => {
      if ((store.epochs.get(key) ?? 0) !== epoch) {
        throw new Error(`shared key "${String(key)}" 已失效`);
      }
      setSharedData(store, key, value as SharedDataMap[K]);
      return getSharedData(store, key)!;
    })
    .catch((error) => {
      if ((store.epochs.get(key) ?? 0) === epoch) {
        setSharedError(store, key, error);
      }
      throw error;
    });

  store.inflightLoads.set(key, p as Promise<any>);
  return p;
}

export function createSharedReader(store: SharedMemoryStore) {
  return {
    get: <K extends SharedKey>(key: K) => getSharedData(store, key),
    wait: <K extends SharedKey>(key: K, options?: { timeoutMs?: number }) => waitSharedData(store, key, options),
    subscribe: <K extends SharedKey>(
      key: K,
      listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
      options?: { emitCurrent?: boolean }
    ) => subscribeSharedData(store, key, listener, options),
    getStatus: (key: SharedKey) => store.statuses.get(key) ?? (store.values.has(key) ? 'ready' : 'idle'),
    getError: (key: SharedKey) => store.errors.get(key),
  };
}

export function createSharedWriter(store: SharedMemoryStore) {
  return {
    init: <K extends SharedKey>(key: K) => setSharedLoading(store, key),
    set: <K extends SharedKey>(key: K, value: SharedDataMap[K]) => setSharedData(store, key, value),
    setLoading: <K extends SharedKey>(key: K) => setSharedLoading(store, key),
    setError: <K extends SharedKey>(key: K, error: unknown) => setSharedError(store, key, error),
    load: <K extends SharedKey>(
      key: K,
      source: Promise<unknown> | (() => Promise<unknown>)
    ) => loadSharedData(store, key, source),
  };
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

export function createSharedFacade(store: SharedMemoryStore) {
  return {
    store,
    reader: createSharedReader(store),
    writer: createSharedWriter(store),
  };
}

export const sharedMemory = {
  createStore: createSharedMemoryStore,
  reader: createSharedReader,
  writer: createSharedWriter,
  get<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
    return getSharedData(store, key);
  },
  wait<K extends SharedKey>(store: SharedMemoryStore, key: K, options?: { timeoutMs?: number }) {
    return waitSharedData(store, key, options);
  },
  subscribe: subscribeSharedData,
  set<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
    return setSharedData(store, key, value);
  },
  setLoading<K extends SharedKey>(store: SharedMemoryStore, key: K) {
    return setSharedLoading(store, key);
  },
  setError<K extends SharedKey>(store: SharedMemoryStore, key: K, error: unknown) {
    return setSharedError(store, key, error);
  },
  load<K extends SharedKey>(store: SharedMemoryStore, key: K, source: Promise<unknown> | (() => Promise<unknown>)) {
    return loadSharedData(store, key, source);
  },
};

@Injectable({
  providedIn: 'root',
})
export class SharedMemoryService {
  private readonly store = inject(SHARED_MEMORY_STORE, { optional: true }) ?? createSharedMemoryStore();

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

  reader() {
    return createSharedReader(this.store);
  }

  writer() {
    return createSharedWriter(this.store);
  }

  get<K extends SharedKey>(key: K): SharedDataMap[K] | undefined {
    return this.reader().get(key);
  }

  wait<K extends SharedKey>(key: K, options?: { timeoutMs?: number }) {
    return this.reader().wait(key, options);
  }

  subscribe<K extends SharedKey>(
    key: K,
    listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
    options?: { emitCurrent?: boolean }
  ) {
    return this.reader().subscribe(key, listener, options);
  }

  init<K extends SharedKey>(key: K) {
    return this.writer().init(key);
  }

  set<K extends SharedKey>(key: K, value: SharedDataMap[K]) {
    return this.writer().set(key, value);
  }

  setLoading<K extends SharedKey>(key: K) {
    return this.writer().setLoading(key);
  }

  setError<K extends SharedKey>(key: K, error: unknown) {
    return this.writer().setError(key, error);
  }

  load<K extends SharedKey>(key: K, source: Promise<unknown> | (() => Promise<unknown>)) {
    return this.writer().load(key, source);
  }
}
