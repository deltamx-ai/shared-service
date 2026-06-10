import React, { useEffect, useMemo, useState } from 'react';
import { SharedDataMap, SharedKey, safeValidateSharedValue } from './shared-contract';

export type SharedStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SharedMemoryChange<T = any> {
  key: string;
  status: SharedStatus;
  value?: T;
  error?: unknown;
  updatedAt: number;
  version: number;
  action: 'set' | 'loading' | 'error' | 'remove' | 'clear';
  previousValue?: T;
}

export interface SharedResolver<T = any> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SharedMemoryStore {
  values: Map<string, any>;
  promises: Map<string, Promise<any>>;
  resolvers: Map<string, Array<SharedResolver>>;
  statuses: Map<string, SharedStatus>;
  errors: Map<string, unknown>;
  subscribers: Map<string, Set<(event: SharedMemoryChange) => void>>;
  versions: Map<string, number>;
}

function now(): number {
  return Date.now();
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

export function setSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
  const result = safeValidateSharedValue(key, value);
  if (!result.success) {
    throw result.error;
  }

  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  const version = (store.versions.get(key) ?? 0) + 1;

  store.versions.set(key, version);
  store.values.set(key, result.data);
  store.statuses.set(key, 'ready');
  store.errors.delete(key);
  store.promises.delete(key);

  const resolvers = store.resolvers.get(key);
  if (resolvers?.length) {
    resolvers.forEach(({ resolve, timer }) => {
      if (timer) clearTimeout(timer);
      resolve(result.data);
    });
    store.resolvers.delete(key);
  }

  emit(store, {
    key,
    status: 'ready',
    value: result.data,
    error: undefined,
    updatedAt: now(),
    version,
    action: 'set',
    previousValue,
  });
}

export function setSharedLoading<K extends SharedKey>(store: SharedMemoryStore, key: K) {
  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  const version = (store.versions.get(key) ?? 0) + 1;
  store.versions.set(key, version);
  store.statuses.set(key, 'loading');
  store.errors.delete(key);
  store.promises.delete(key);

  emit(store, {
    key,
    status: 'loading',
    value: previousValue,
    error: undefined,
    updatedAt: now(),
    version,
    action: 'loading',
    previousValue,
  });
}

export function setSharedError<K extends SharedKey>(store: SharedMemoryStore, key: K, error: unknown) {
  const previousValue = store.values.get(key) as SharedDataMap[K] | undefined;
  const version = (store.versions.get(key) ?? 0) + 1;
  store.versions.set(key, version);
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

  emit(store, {
    key,
    status: 'error',
    value: previousValue,
    error,
    updatedAt: now(),
    version,
    action: 'error',
    previousValue,
  });
}

export function getSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
  return store.values.get(key) as SharedDataMap[K] | undefined;
}

export function getSharedStatus(store: SharedMemoryStore, key: SharedKey): SharedStatus {
  return store.statuses.get(key) ?? (store.values.has(key) ? 'ready' : 'idle');
}

export function getSharedError(store: SharedMemoryStore, key: SharedKey): unknown {
  return store.errors.get(key);
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
    const value = store.values.get(key) as SharedDataMap[K] | undefined;
    listener({
      key,
      status: getSharedStatus(store, key),
      value,
      error: store.errors.get(key),
      updatedAt: now(),
      version: store.versions.get(key) ?? 0,
      action: 'set',
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

  const status = getSharedStatus(store, key);
  if (status === 'error') {
    return Promise.reject(getSharedError(store, key) ?? new Error(`shared key "${String(key)}" 已进入 error 状态`));
  }

  const running = store.promises.get(key);
  if (running) {
    if (options.timeoutMs === undefined) return running as Promise<SharedDataMap[K]>;
    return new Promise<SharedDataMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 shared key "${String(key)}" 超时 (${options.timeoutMs}ms)`)), options.timeoutMs);
      running.then(
        (value) => {
          clearTimeout(timer);
          resolve(value as SharedDataMap[K]);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  return new Promise<SharedDataMap[K]>((resolve, reject) => {
    const resolver: SharedResolver = { resolve: resolve as (value: any) => void, reject };

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
}

export async function setSharedDataByPromise<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  source: Promise<unknown> | (() => Promise<unknown>)
): Promise<SharedDataMap[K]> {
  const existed = store.values.get(key);
  if (existed !== undefined) return existed as SharedDataMap[K];

  const running = store.promises.get(key);
  if (running) return running as Promise<SharedDataMap[K]>;

  setSharedLoading(store, key);
  const sourcePromise = typeof source === 'function' ? source() : source;
  const p = sourcePromise
    .then((value) => {
      setSharedData(store, key, value as SharedDataMap[K]);
      return getSharedData(store, key)!;
    })
    .catch((error) => {
      setSharedError(store, key, error);
      throw error;
    });

  store.promises.set(key, p as Promise<any>);
  return p;
}

export function createSharedFacade(store: SharedMemoryStore) {
  return {
    store,
    set: <K extends SharedKey>(key: K, value: SharedDataMap[K]) => setSharedData(store, key, value),
    setLoading: <K extends SharedKey>(key: K) => setSharedLoading(store, key),
    setError: <K extends SharedKey>(key: K, error: unknown) => setSharedError(store, key, error),
    get: <K extends SharedKey>(key: K) => getSharedData(store, key),
    getStatus: (key: SharedKey) => getSharedStatus(store, key),
    getError: (key: SharedKey) => getSharedError(store, key),
    wait: <K extends SharedKey>(key: K, options?: { timeoutMs?: number }) => waitSharedData(store, key, options),
    ensure: <K extends SharedKey>(key: K, source: Promise<unknown> | (() => Promise<unknown>)) =>
      setSharedDataByPromise(store, key, source),
    subscribe: <K extends SharedKey>(
      key: K,
      listener: (event: SharedMemoryChange<SharedDataMap[K]>) => void,
      options?: { emitCurrent?: boolean }
    ) => subscribeSharedData(store, key, listener, options),
  };
}

export function SharedDataViewer({ store }: { store: SharedMemoryStore }) {
  const [state, setState] = useState<SharedMemoryChange<SharedDataMap['userInfo']> | null>(null);

  useEffect(() => {
    return subscribeSharedData(store, 'userInfo', (event) => {
      setState(event);
    });
  }, [store]);

  return (
    <div>
      <h3>Shared Data</h3>
      <pre>{JSON.stringify(state, null, 2)}</pre>
    </div>
  );
}

export function Demo() {
  const store = useMemo(() => createSharedMemoryStore(), []);

  useEffect(() => {
    setSharedLoading(store, 'userInfo');
    setTimeout(() => {
      setSharedData(store, 'userInfo', { id: 1, name: 'Tom' });
    }, 500);
  }, [store]);

  return <SharedDataViewer store={store} />;
}

// 基座把同一个 store 对象传给 Angular 和 React。
// 这样数据不是挂在 window 上，而是挂在应用注入出来的共享对象上。
// 如果对象暂时没数据，可以先 setLoading，再由子项目把数据挂回去。
