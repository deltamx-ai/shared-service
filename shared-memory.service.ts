import { Injectable } from '@angular/core';

type SharedValue<T = any> = T;

interface SharedStore {
  values: Map<string, SharedValue>;
  promises: Map<string, Promise<SharedValue>>;
  resolvers: Map<string, (value: SharedValue) => void>;
}

declare global {
  interface Window {
    __SHARED_APP_MEMORY__?: SharedStore;
  }
}

@Injectable({
  providedIn: 'root',
})
export class SharedMemoryService {
  private store: SharedStore = this.getStore();

  private getStore(): SharedStore {
    if (!window.__SHARED_APP_MEMORY__) {
      window.__SHARED_APP_MEMORY__ = {
        values: new Map(),
        promises: new Map(),
        resolvers: new Map(),
      };
    }
    return window.__SHARED_APP_MEMORY__;
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
  set<T = any>(key: string, value: T) {
    window.__SHARED_APP_MEMORY__ ||= {
      values: new Map(),
      promises: new Map(),
      resolvers: new Map(),
    };
    window.__SHARED_APP_MEMORY__.values.set(key, value);
  },
  get<T = any>(key: string): T | undefined {
    return window.__SHARED_APP_MEMORY__?.values.get(key) as T | undefined;
  },
  has(key: string): boolean {
    return !!window.__SHARED_APP_MEMORY__?.values.has(key);
  },
};
