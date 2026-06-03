import { Injectable, InjectionToken, inject } from '@angular/core';
import { SharedDataMap, SharedKey, safeValidateSharedValue } from './shared-contract';

type SharedValue<T = any> = T;

export interface SharedMemoryStore {
  values: Map<string, SharedValue>;
  promises: Map<string, Promise<SharedValue>>;
  resolvers: Map<string, Array<(value: SharedValue) => void>>;
}

export const SHARED_MEMORY_STORE = new InjectionToken<SharedMemoryStore>(
  'SHARED_MEMORY_STORE'
);

export function createSharedMemoryStore(): SharedMemoryStore {
  return {
    values: new Map(),
    promises: new Map(),
    resolvers: new Map(),
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
  }

  /**
   * 直接写入内存，写入前会做 schema 校验
   */
  set<K extends SharedKey>(key: K, value: unknown): void {
    const result = safeValidateSharedValue(key, value);
    if (!result.success) {
      throw result.error;
    }

    this.store.values.set(key, result.data);

    const resolvers = this.store.resolvers.get(key);
    if (resolvers?.length) {
      resolvers.forEach((resolve) => resolve(result.data));
      this.store.resolvers.delete(key);
    }

    this.store.promises.delete(key);
  }

  /**
   * 从内存读取
   */
  get<K extends SharedKey>(key: K): SharedDataMap[K] | undefined {
    return this.store.values.get(key) as SharedDataMap[K] | undefined;
  }

  /**
   * 判断是否已有值
   */
  has<K extends SharedKey>(key: K): boolean {
    return this.store.values.has(key);
  }

  /**
   * 等待某个 key 有值
   * 如果已经有值，直接返回
   */
  wait<K extends SharedKey>(key: K): Promise<SharedDataMap[K]> {
    const existed = this.store.values.get(key);
    if (existed !== undefined) {
      return Promise.resolve(existed as SharedDataMap[K]);
    }

    const existedPromise = this.store.promises.get(key);
    if (existedPromise) {
      return existedPromise as Promise<SharedDataMap[K]>;
    }

    const promise = new Promise<SharedDataMap[K]>((resolve) => {
      const list = this.store.resolvers.get(key) ?? [];
      list.push(resolve as (value: SharedValue) => void);
      this.store.resolvers.set(key, list);
    });

    this.store.promises.set(key, promise as Promise<SharedValue>);
    return promise;
  }

  /**
   * 传入 Promise，结果会自动缓存到内存
   * 如果已经缓存过，直接返回缓存值
   * 写入前会经过 schema 校验
   */
  async setByPromise<K extends SharedKey>(key: K, source: Promise<unknown>): Promise<SharedDataMap[K]> {
    const existed = this.store.values.get(key);
    if (existed !== undefined) {
      return existed as SharedDataMap[K];
    }

    const running = this.store.promises.get(key);
    if (running) {
      return running as Promise<SharedDataMap[K]>;
    }

    const p = source.then((value) => {
      this.set(key, value);
      return this.get(key)!;
    });

    this.store.promises.set(key, p as Promise<SharedValue>);
    return p;
  }

  /**
   * 更方便一点：
   * - 有缓存就直接返回
   * - 没缓存就执行 Promise 并缓存
   */
  async ensure<K extends SharedKey>(key: K, source: Promise<unknown>): Promise<SharedDataMap[K]> {
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
    this.store.values.delete(key);
    this.store.promises.delete(key);
    this.store.resolvers.delete(key);
  }

  /**
   * 清空全部
   */
  clear(): void {
    this.store.values.clear();
    this.store.promises.clear();
    this.store.resolvers.clear();
  }
}

export const sharedMemory = {
  createStore: createSharedMemoryStore,
  set<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
    const result = safeValidateSharedValue(key, value);
    if (!result.success) {
      throw result.error;
    }
    store.values.set(key, result.data);
  },
  get<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
    return store.values.get(key) as SharedDataMap[K] | undefined;
  },
  has(store: SharedMemoryStore, key: SharedKey): boolean {
    return store.values.has(key);
  },
  bind(target: SharedMemoryStore, source: SharedMemoryStore) {
    target.values = source.values;
    target.promises = source.promises;
    target.resolvers = source.resolvers;
  },
};
