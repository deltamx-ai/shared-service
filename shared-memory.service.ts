import { Injectable, InjectionToken, inject } from '@angular/core';

type SharedValue<T = any> = T;

export interface SharedMemoryStore {
  values: Map<string, SharedValue>;
  promises: Map<string, Promise<SharedValue>>;
  resolvers: Map<string, (value: SharedValue) => void>;
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
   * 直接写入内存
   */
  set<T = any>(key: string, value: T): void {
    this.store.values.set(key, value);

    const resolve = this.store.resolvers.get(key);
    if (resolve) {
      resolve(value);
      this.store.resolvers.delete(key);
    }

    this.store.promises.delete(key);
  }

  /**
   * 从内存读取
   */
  get<T = any>(key: string): T | undefined {
    return this.store.values.get(key) as T | undefined;
  }

  /**
   * 判断是否已有值
   */
  has(key: string): boolean {
    return this.store.values.has(key);
  }

  /**
   * 等待某个 key 有值
   * 如果已经有值，直接返回
   */
  wait<T = any>(key: string): Promise<T> {
    const existed = this.store.values.get(key);
    if (existed !== undefined) {
      return Promise.resolve(existed as T);
    }

    const existedPromise = this.store.promises.get(key);
    if (existedPromise) {
      return existedPromise as Promise<T>;
    }

    const promise = new Promise<T>((resolve) => {
      this.store.resolvers.set(key, resolve as (value: SharedValue) => void);
    });

    this.store.promises.set(key, promise as Promise<SharedValue>);
    return promise;
  }

  /**
   * 传入 Promise，结果会自动缓存到内存
   * 如果已经缓存过，直接返回缓存值
   */
  async setByPromise<T = any>(key: string, source: Promise<T>): Promise<T> {
    const existed = this.store.values.get(key);
    if (existed !== undefined) {
      return existed as T;
    }

    const running = this.store.promises.get(key);
    if (running) {
      return running as Promise<T>;
    }

    const p = source.then((value) => {
      this.set(key, value);
      return value;
    });

    this.store.promises.set(key, p as Promise<SharedValue>);
    return p;
  }

  /**
   * 更方便一点：
   * - 有缓存就直接返回
   * - 没缓存就执行 Promise 并缓存
   */
  async ensure<T = any>(key: string, source: Promise<T>): Promise<T> {
    const existed = this.get<T>(key);
    if (existed !== undefined) {
      return existed;
    }
    return this.setByPromise(key, source);
  }

  /**
   * 删除某个 key
   */
  remove(key: string): void {
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
  set<T = any>(store: SharedMemoryStore, key: string, value: T) {
    store.values.set(key, value);
  },
  get<T = any>(store: SharedMemoryStore, key: string): T | undefined {
    return store.values.get(key) as T | undefined;
  },
  has(store: SharedMemoryStore, key: string): boolean {
    return store.values.has(key);
  },
  bind(target: SharedMemoryStore, source: SharedMemoryStore) {
    target.values = source.values;
    target.promises = source.promises;
    target.resolvers = source.resolvers;
  },
};
