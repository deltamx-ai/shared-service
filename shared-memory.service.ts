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

export interface SharedResolver<T = SharedValue> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SharedMemoryStore {
  values: Map<string, SharedValue>;
  promises: Map<string, Promise<SharedValue>>;
  resolvers: Map<string, Array<SharedResolver>>;
  statuses: Map<string, SharedStatus>;
  errors: Map<string, unknown>;
  subscribers: Map<string, Set<(event: SharedMemoryChange) => void>>;
  versions: Map<string, number>;
  updatedAt: Map<string, number>;
  epochs: Map<string, number>;
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

export function createSharedMemoryStore(): SharedMemoryStore {
  return {
    values: new Map(),
    promises: new Map(),
    resolvers: new Map(),
    statuses: new Map(),
    errors: new Map(),
    subscribers: new Map(),
    versions: new Map(),
    updatedAt: new Map(),
    epochs: new Map(),
  };
}

@Injectable({
  providedIn: 'root',
})
export class SharedMemoryService {
  private readonly store = inject(SHARED_MEMORY_STORE, { optional: true }) ?? createSharedMemoryStore();

  /**
   * 基座初始化时把同一个 store 传进来。
   * 这样多个子应用都能共享同一份内存对象，而不是挂到 window 上。
   */
  bindStore(store: SharedMemoryStore): void {
    this.store.values = store.values;
    this.store.promises = store.promises;
    this.store.resolvers = store.resolvers;
    this.store.statuses = store.statuses;
    this.store.errors = store.errors;
    this.store.subscribers = store.subscribers;
    this.store.versions = store.versions;
    this.store.updatedAt = store.updatedAt;
    this.store.epochs = store.epochs;
  }

  private nextEpoch(key: SharedKey): number {
    const next = (this.store.epochs.get(key) ?? 0) + 1;
    this.store.epochs.set(key, next);
    return next;
  }

  private currentEpoch(key: SharedKey): number {
    return this.store.epochs.get(key) ?? 0;
  }

  private bumpMeta(key: SharedKey): { version: number; updatedAt: number } {
    const version = (this.store.versions.get(key) ?? 0) + 1;
    const updatedAt = now();
    this.store.versions.set(key, version);
    this.store.updatedAt.set(key, updatedAt);
    return { version, updatedAt };
  }

  private rejectWaiters(key: SharedKey, error: unknown): void {
    const resolvers = this.store.resolvers.get(key);
    if (!resolvers?.length) return;

    resolvers.forEach(({ reject, timer }) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    this.store.resolvers.delete(key);
  }

  private resolveWaiters<K extends SharedKey>(key: K, value: SharedDataMap[K]): void {
    const resolvers = this.store.resolvers.get(key);
    if (!resolvers?.length) return;

    resolvers.forEach(({ resolve, timer }) => {
      if (timer) clearTimeout(timer);
      resolve(value as SharedValue);
    });
    this.store.resolvers.delete(key);
  }

  private emit<K extends SharedKey>(key: K, action: SharedAction, previousValue?: SharedDataMap[K]): void {
    const listenerSet = this.store.subscribers.get(key);
    if (!listenerSet?.size) return;

    const event = this.getEntry(key);
    const change: SharedMemoryChange<SharedDataMap[K]> = {
      ...event,
      action,
      previousValue,
    };

    listenerSet.forEach((listener) => {
      try {
        listener(change as SharedMemoryChange);
      } catch {
        // ignore subscriber errors
      }
    });
  }

  /**
   * 直接写入内存，写入前会做 schema 校验
   */
  set<K extends SharedKey>(key: K, value: unknown): void {
    const result = safeValidateSharedValue(key, value);
    if (!result.success) {
      throw result.error;
    }

    this.nextEpoch(key);
    const previousValue = this.store.values.get(key) as SharedDataMap[K] | undefined;
    this.bumpMeta(key);

    this.store.values.set(key, result.data);
    this.store.statuses.set(key, 'ready');
    this.store.errors.delete(key);
    this.store.promises.delete(key);

    this.resolveWaiters(key, result.data);

    this.emit(key, 'set', previousValue);
  }

  /**
   * 把某个 key 标记为 loading。适合“对象先共享出去，数据后补上”的场景。
   */
  setLoading<K extends SharedKey>(key: K): void {
    this.nextEpoch(key);
    const previousValue = this.store.values.get(key) as SharedDataMap[K] | undefined;
    this.bumpMeta(key);

    this.store.statuses.set(key, 'loading');
    this.store.errors.delete(key);
    this.store.promises.delete(key);

    this.emit(key, 'loading', previousValue);
  }

  /**
   * 把某个 key 标记为 error，并保留当前 value（如果有的话）
   */
  setError<K extends SharedKey>(key: K, error: unknown): void {
    this.nextEpoch(key);
    const previousValue = this.store.values.get(key) as SharedDataMap[K] | undefined;
    this.bumpMeta(key);

    this.store.statuses.set(key, 'error');
    this.store.errors.set(key, error);
    this.store.promises.delete(key);

    this.rejectWaiters(key, error);

    this.emit(key, 'error', previousValue);
  }

  /**
   * 从内存读取
   */
  get<K extends SharedKey>(key: K): SharedDataMap[K] | undefined {
    return this.store.values.get(key) as SharedDataMap[K] | undefined;
  }

  /**
   * 读取当前完整状态
   */
  getEntry<K extends SharedKey>(key: K): SharedMemoryEntry<SharedDataMap[K]> {
    const value = this.store.values.get(key) as SharedDataMap[K] | undefined;
    return createEntry<SharedDataMap[K]>(key, {
      status: this.store.statuses.get(key) ?? (value === undefined ? 'idle' : 'ready'),
      value,
      error: this.store.errors.get(key),
      updatedAt: this.store.updatedAt.get(key) ?? 0,
      version: this.store.versions.get(key) ?? 0,
    });
  }

  /**
   * 读取当前状态
   */
  getStatus<K extends SharedKey>(key: K): SharedStatus {
    return this.store.statuses.get(key) ?? (this.store.values.has(key) ? 'ready' : 'idle');
  }

  /**
   * 读取当前错误
   */
  getError(key: SharedKey): unknown {
    return this.store.errors.get(key);
  }

  /**
   * 判断是否已有值
   */
  has<K extends SharedKey>(key: K): boolean {
    return this.store.values.has(key);
  }

  /**
   * 订阅某个 key 的变化
   * 默认会先推一次当前快照，方便 UI 直接渲染。
   */
  subscribe<K extends SharedKey>(
    key: K,
    listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
    options: { emitCurrent?: boolean } = {}
  ): () => void {
    const listenerSet = this.store.subscribers.get(key) ?? new Set();
    listenerSet.add(listener as (event: SharedMemoryChange) => void);
    this.store.subscribers.set(key, listenerSet);

    if (options.emitCurrent !== false) {
      const current = this.getEntry(key);
      listener({
        ...current,
        action: 'init',
        previousValue: current.value,
      } as SharedMemoryChange<SharedDataMap[K]>);
    }

    return () => {
      const current = this.store.subscribers.get(key);
      current?.delete(listener as (event: SharedMemoryChange) => void);
      if (current && current.size === 0) {
        this.store.subscribers.delete(key);
      }
    };
  }

  /**
   * 等待某个 key 有值
   * 如果已经有值，直接返回
   * 支持超时
   */
  wait<K extends SharedKey>(key: K, options: SharedMemoryWaitOptions = {}): Promise<SharedDataMap[K]> {
    const existed = this.store.values.get(key);
    if (existed !== undefined) {
      return Promise.resolve(existed as SharedDataMap[K]);
    }

    const status = this.getStatus(key);
    if (status === 'error') {
      return Promise.reject(this.getError(key) ?? new Error(`shared key "${String(key)}" 已进入 error 状态`));
    }

    const running = this.store.promises.get(key);
    if (running) {
      return withTimeout(running as Promise<SharedDataMap[K]>, options.timeoutMs, String(key));
    }

    return new Promise<SharedDataMap[K]>((resolve, reject) => {
      const resolver: SharedResolver = { resolve: resolve as (value: SharedValue) => void, reject };

      if (options.timeoutMs !== undefined) {
        resolver.timer = setTimeout(() => {
          const current = this.store.resolvers.get(key);
          if (current) {
            this.store.resolvers.set(key, current.filter((item) => item !== resolver));
          }
          reject(new Error(`等待 shared key "${String(key)}" 超时 (${options.timeoutMs}ms)`));
        }, options.timeoutMs);
      }

      const list = this.store.resolvers.get(key) ?? [];
      list.push(resolver);
      this.store.resolvers.set(key, list);
    });
  }

  /**
   * 传入 Promise 或异步工厂，结果会自动缓存到内存
   * 如果已经缓存过，直接返回缓存值
   * 写入前会经过 schema 校验
   */
  async setByPromise<K extends SharedKey>(
    key: K,
    source: Promise<unknown> | (() => Promise<unknown>)
  ): Promise<SharedDataMap[K]> {
    const existed = this.store.values.get(key);
    if (existed !== undefined) {
      return existed as SharedDataMap[K];
    }

    const running = this.store.promises.get(key);
    if (running) {
      return running as Promise<SharedDataMap[K]>;
    }

    this.setLoading(key);
    const epoch = this.currentEpoch(key);
    const sourcePromise = typeof source === 'function' ? source() : source;

    const p = sourcePromise
      .then((value) => {
        if (this.currentEpoch(key) !== epoch) {
          throw new Error(`shared key "${String(key)}" 已失效`);
        }

        this.set(key, value);
        return this.get(key)!;
      })
      .catch((error) => {
        if (this.currentEpoch(key) === epoch) {
          this.setError(key, error);
        }
        throw error;
      });

    this.store.promises.set(key, p as Promise<SharedValue>);
    return p;
  }

  /**
   * 更方便一点：
   * - 有缓存就直接返回
   * - 没缓存就执行 Promise 并缓存
   */
  async ensure<K extends SharedKey>(
    key: K,
    source: Promise<unknown> | (() => Promise<unknown>)
  ): Promise<SharedDataMap[K]> {
    const existed = this.get(key);
    if (existed !== undefined) {
      return existed;
    }
    return this.setByPromise(key, source);
  }

  /**
   * 删除某个 key
   */
  remove<K extends SharedKey>(key: K): void {
    const previousValue = this.store.values.get(key) as SharedDataMap[K] | undefined;
    this.nextEpoch(key);
    this.bumpMeta(key);

    this.store.values.delete(key);
    this.store.promises.delete(key);
    this.store.statuses.set(key, 'idle');
    this.store.errors.delete(key);

    this.rejectWaiters(key, new Error(`shared key "${String(key)}" 已被移除`));

    this.emit(key, 'remove', previousValue);
  }

  /**
   * 清空全部
   */
  clear(): void {
    const keys = new Set<string>([
      ...this.store.values.keys(),
      ...this.store.promises.keys(),
      ...this.store.statuses.keys(),
      ...this.store.errors.keys(),
      ...this.store.resolvers.keys(),
      ...this.store.subscribers.keys(),
    ]);

    keys.forEach((key) => {
      this.nextEpoch(key);
      this.bumpMeta(key);
    });

    keys.forEach((key) => {
      const previousValue = this.store.values.get(key);
      const status = this.getStatus(key as SharedKey);
      const listenerSet = this.store.subscribers.get(key);
      if (!listenerSet?.size) return;

      const event = createEntry(key, {
        status: 'idle',
        value: previousValue,
        error: undefined,
        updatedAt: this.store.updatedAt.get(key) ?? now(),
        version: this.store.versions.get(key) ?? 0,
      });

      const change: SharedMemoryChange = {
        ...event,
        action: 'clear',
        previousValue: previousValue as SharedValue,
      };

      listenerSet.forEach((listener) => {
        try {
          listener(change);
        } catch {
          // ignore
        }
      });

      this.rejectWaiters(key as SharedKey, new Error(`shared key "${String(key)}" 已被清空`));
      this.store.promises.delete(key);
      this.store.statuses.delete(key);
      this.store.errors.delete(key);
      this.store.values.delete(key);
      this.store.resolvers.delete(key);
      this.store.versions.delete(key);
      this.store.updatedAt.delete(key);
    });
  }
}

export const sharedMemory = {
  createStore: createSharedMemoryStore,
  set<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
    const result = safeValidateSharedValue(key, value);
    if (!result.success) {
      throw result.error;
    }

    const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
    const version = (store.versions.get(key) ?? 0) + 1;
    const updatedAt = now();
    store.epochs.set(key, (store.epochs.get(key) ?? 0) + 1);
    store.versions.set(key, version);
    store.updatedAt.set(key, updatedAt);
    store.values.set(key, result.data);
    store.statuses.set(key, 'ready');
    store.errors.delete(key);

    const resolvers = store.resolvers.get(key);
    if (resolvers?.length) {
      resolvers.forEach(({ resolve, timer }) => {
        if (timer) clearTimeout(timer);
        resolve(result.data);
      });
      store.resolvers.delete(key);
    }

    store.promises.delete(key);

    const listenerSet = store.subscribers.get(key);
    if (listenerSet?.size) {
      const event: SharedMemoryChange<SharedDataMap[K]> = {
        key,
        status: 'ready',
        value: result.data,
        error: undefined,
        updatedAt,
        version,
        action: 'set',
        previousValue,
      };
      listenerSet.forEach((listener) => {
        try {
          listener(event as SharedMemoryChange);
        } catch {
          // ignore
        }
      });
    }
  },
  setLoading<K extends SharedKey>(store: SharedMemoryStore, key: K) {
    const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
    const version = (store.versions.get(key) ?? 0) + 1;
    const updatedAt = now();
    store.epochs.set(key, (store.epochs.get(key) ?? 0) + 1);
    store.versions.set(key, version);
    store.updatedAt.set(key, updatedAt);
    store.statuses.set(key, 'loading');
    store.errors.delete(key);
    store.promises.delete(key);

    const listenerSet = store.subscribers.get(key);
    if (listenerSet?.size) {
      const event: SharedMemoryChange<SharedDataMap[K]> = {
        key,
        status: 'loading',
        value: previousValue,
        error: undefined,
        updatedAt,
        version,
        action: 'loading',
        previousValue,
      };
      listenerSet.forEach((listener) => {
        try {
          listener(event as SharedMemoryChange);
        } catch {
          // ignore
        }
      });
    }
  },
  setError<K extends SharedKey>(store: SharedMemoryStore, key: K, error: unknown) {
    const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
    const version = (store.versions.get(key) ?? 0) + 1;
    const updatedAt = now();
    store.epochs.set(key, (store.epochs.get(key) ?? 0) + 1);
    store.versions.set(key, version);
    store.updatedAt.set(key, updatedAt);
    store.statuses.set(key, 'error');
    store.errors.set(key, error);
    store.promises.delete(key);

    const resolvers = store.resolvers.get(key);
    if (resolvers?.length) {
      resolvers.forEach(({ reject, timer }) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      store.resolvers.delete(key);
    }

    const listenerSet = store.subscribers.get(key);
    if (listenerSet?.size) {
      const event: SharedMemoryChange<SharedDataMap[K]> = {
        key,
        status: 'error',
        value: previousValue,
        error,
        updatedAt,
        version,
        action: 'error',
        previousValue,
      };
      listenerSet.forEach((listener) => {
        try {
          listener(event as SharedMemoryChange);
        } catch {
          // ignore
        }
      });
    }
  },
  get<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
    return store.values.get(key) as SharedDataMap[K] | undefined;
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
    const existed = store.values.get(key);
    if (existed !== undefined) {
      return Promise.resolve(existed as SharedDataMap[K]);
    }

    const status = store.statuses.get(key) ?? 'idle';
    if (status === 'error') {
      return Promise.reject(store.errors.get(key) ?? new Error(`shared key "${String(key)}" 已进入 error 状态`));
    }

    const running = store.promises.get(key);
    if (running) {
      return withTimeout(running as Promise<SharedDataMap[K]>, options.timeoutMs, String(key));
    }

    return new Promise<SharedDataMap[K]>((resolve, reject) => {
      const resolver: SharedResolver = { resolve: resolve as (value: SharedValue) => void, reject };

      if (options.timeoutMs !== undefined) {
        resolver.timer = setTimeout(() => {
          const current = store.resolvers.get(key);
          if (current) {
            store.resolvers.set(key, current.filter((item) => item !== resolver));
          }
          reject(new Error(`等待 shared key "${String(key)}" 超时 (${options.timeoutMs}ms)`));
        }, options.timeoutMs);
      }

      const list = store.resolvers.get(key) ?? [];
      list.push(resolver);
      store.resolvers.set(key, list);
    });
  },
  setByPromise<K extends SharedKey>(
    store: SharedMemoryStore,
    key: K,
    source: Promise<unknown> | (() => Promise<unknown>)
  ): Promise<SharedDataMap[K]> {
    const existed = store.values.get(key);
    if (existed !== undefined) {
      return Promise.resolve(existed as SharedDataMap[K]);
    }

    const running = store.promises.get(key);
    if (running) {
      return running as Promise<SharedDataMap[K]>;
    }

    sharedMemory.setLoading(store, key);
    const epoch = store.epochs.get(key) ?? 0;
    const sourcePromise = typeof source === 'function' ? source() : source;

    const p = sourcePromise
      .then((value) => {
        if ((store.epochs.get(key) ?? 0) !== epoch) {
          throw new Error(`shared key "${String(key)}" 已失效`);
        }

        sharedMemory.set(store, key, value as SharedDataMap[K]);
        return sharedMemory.get(store, key)!;
      })
      .catch((error) => {
        if ((store.epochs.get(key) ?? 0) === epoch) {
          sharedMemory.setError(store, key, error);
        }
        throw error;
      });

    store.promises.set(key, p as Promise<SharedValue>);
    return p;
  },
  ensure<K extends SharedKey>(store: SharedMemoryStore, key: K, source: Promise<unknown> | (() => Promise<unknown>)) {
    const existed = sharedMemory.get(store, key);
    if (existed !== undefined) {
      return Promise.resolve(existed);
    }
    return sharedMemory.setByPromise(store, key, source);
  },
  remove<K extends SharedKey>(store: SharedMemoryStore, key: K) {
    const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
    store.epochs.set(key, (store.epochs.get(key) ?? 0) + 1);
    store.values.delete(key);
    store.promises.delete(key);
    store.statuses.set(key, 'idle');
    store.errors.delete(key);
    store.updatedAt.set(key, now());
    store.versions.set(key, (store.versions.get(key) ?? 0) + 1);

    const resolvers = store.resolvers.get(key);
    if (resolvers?.length) {
      resolvers.forEach(({ reject, timer }) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`shared key "${String(key)}" 已被移除`));
      });
      store.resolvers.delete(key);
    }

    const listenerSet = store.subscribers.get(key);
    if (listenerSet?.size) {
      const event: SharedMemoryChange<SharedDataMap[K]> = {
        key,
        status: 'idle',
        value: undefined,
        error: undefined,
        updatedAt: store.updatedAt.get(key) ?? now(),
        version: store.versions.get(key) ?? 0,
        action: 'remove',
        previousValue,
      };
      listenerSet.forEach((listener) => {
        try {
          listener(event as SharedMemoryChange);
        } catch {
          // ignore
        }
      });
    }
  },
  clear(store: SharedMemoryStore) {
    const keys = new Set<string>([
      ...store.values.keys(),
      ...store.promises.keys(),
      ...store.statuses.keys(),
      ...store.errors.keys(),
      ...store.resolvers.keys(),
      ...store.subscribers.keys(),
    ]);

    keys.forEach((key) => {
      store.epochs.set(key, (store.epochs.get(key) ?? 0) + 1);
      const previousValue = store.values.get(key);
      const listenerSet = store.subscribers.get(key);
      const version = (store.versions.get(key) ?? 0) + 1;
      const updatedAt = now();
      store.versions.set(key, version);
      store.updatedAt.set(key, updatedAt);

      if (listenerSet?.size) {
        const event: SharedMemoryChange = {
          key,
          status: 'idle',
          value: undefined,
          error: undefined,
          updatedAt,
          version,
          action: 'clear',
          previousValue: previousValue as SharedValue,
        };
        listenerSet.forEach((listener) => {
          try {
            listener(event);
          } catch {
            // ignore
          }
        });
      }

      const resolvers = store.resolvers.get(key);
      if (resolvers?.length) {
        resolvers.forEach(({ reject, timer }) => {
          if (timer) clearTimeout(timer);
          reject(new Error(`shared key "${String(key)}" 已被清空`));
        });
      }
    });

    store.values.clear();
    store.promises.clear();
    store.resolvers.clear();
    store.statuses.clear();
    store.errors.clear();
    store.versions.clear();
    store.updatedAt.clear();
  },
};
