import React, { useEffect, useMemo, useState } from 'react';
import { SharedDataMap, SharedKey, safeValidateSharedValue } from './shared-contract';

export interface SharedMemoryStore {
  values: Map<string, any>;
  promises: Map<string, Promise<any>>;
  resolvers: Map<string, Array<(value: any) => void>>;
}

export function createSharedMemoryStore(): SharedMemoryStore {
  return {
    values: new Map(),
    promises: new Map(),
    resolvers: new Map(),
  };
}

export function setSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K, value: SharedDataMap[K]) {
  const result = safeValidateSharedValue(key, value);
  if (!result.success) {
    throw result.error;
  }

  store.values.set(key, result.data);

  const resolvers = store.resolvers.get(key);
  if (resolvers?.length) {
    resolvers.forEach((resolve) => resolve(result.data));
    store.resolvers.delete(key);
  }

  store.promises.delete(key);
}

export function getSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K): SharedDataMap[K] | undefined {
  return store.values.get(key) as SharedDataMap[K] | undefined;
}

export function waitSharedData<K extends SharedKey>(store: SharedMemoryStore, key: K): Promise<SharedDataMap[K]> {
  const existed = store.values.get(key);
  if (existed !== undefined) {
    return Promise.resolve(existed as SharedDataMap[K]);
  }

  const running = store.promises.get(key);
  if (running) {
    return running as Promise<SharedDataMap[K]>;
  }

  const p = new Promise<SharedDataMap[K]>((resolve) => {
    const list = store.resolvers.get(key) ?? [];
    list.push(resolve as (value: any) => void);
    store.resolvers.set(key, list);
  });

  store.promises.set(key, p as Promise<any>);
  return p;
}

export async function setSharedDataByPromise<K extends SharedKey>(
  store: SharedMemoryStore,
  key: K,
  source: Promise<unknown>
): Promise<SharedDataMap[K]> {
  const existed = store.values.get(key);
  if (existed !== undefined) {
    return existed as SharedDataMap[K];
  }

  const running = store.promises.get(key);
  if (running) {
    return running as Promise<SharedDataMap[K]>;
  }

  const p = source.then((value) => {
    setSharedData(store, key, value as SharedDataMap[K]);
    return getSharedData(store, key)!;
  });

  store.promises.set(key, p as Promise<any>);
  return p;
}

export function SharedDataViewer({ store }: { store: SharedMemoryStore }) {
  const [user, setUser] = useState<SharedDataMap['userInfo'] | null>(null);

  useEffect(() => {
    const cached = getSharedData(store, 'userInfo');
    if (cached) {
      setUser(cached);
      return;
    }

    waitSharedData(store, 'userInfo').then((data) => {
      setUser(data);
    });
  }, [store]);

  return (
    <div>
      <h3>Shared Data</h3>
      <pre>{JSON.stringify(user, null, 2)}</pre>
    </div>
  );
}

export function Demo() {
  const store = useMemo(() => createSharedMemoryStore(), []);

  useEffect(() => {
    setSharedData(store, 'userInfo', { id: 1, name: 'Tom' });
  }, [store]);

  return <SharedDataViewer store={store} />;
}

// 基座把同一个 store 对象传给 Angular 和 React。
// 这样数据不是挂在 window 上，而是挂在应用注入出来的共享对象上。
