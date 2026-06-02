import React, { useEffect, useState } from 'react';

declare global {
  interface Window {
    __SHARED_APP_MEMORY__?: {
      values: Map<string, any>;
      promises: Map<string, Promise<any>>;
      resolvers: Map<string, (value: any) => void>;
    };
  }
}

export function setSharedData<T = any>(key: string, value: T) {
  window.__SHARED_APP_MEMORY__ ||= {
    values: new Map(),
    promises: new Map(),
    resolvers: new Map(),
  };
  window.__SHARED_APP_MEMORY__.values.set(key, value);
}

export function getSharedData<T = any>(key: string): T | undefined {
  return window.__SHARED_APP_MEMORY__?.values.get(key) as T | undefined;
}

export function waitSharedData<T = any>(key: string): Promise<T> {
  const existed = window.__SHARED_APP_MEMORY__?.values.get(key);
  if (existed !== undefined) {
    return Promise.resolve(existed as T);
  }

  window.__SHARED_APP_MEMORY__ ||= {
    values: new Map(),
    promises: new Map(),
    resolvers: new Map(),
  };

  const running = window.__SHARED_APP_MEMORY__.promises.get(key);
  if (running) {
    return running as Promise<T>;
  }

  const p = new Promise<T>((resolve) => {
    window.__SHARED_APP_MEMORY__!.resolvers.set(key, resolve as (value: any) => void);
  });

  window.__SHARED_APP_MEMORY__.promises.set(key, p as Promise<any>);
  return p;
}

export function SharedDataViewer() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const cached = getSharedData('userInfo');
    if (cached) {
      setUser(cached);
      return;
    }

    waitSharedData('userInfo').then((data) => {
      setUser(data);
    });
  }, []);

  return (
    <div>
      <h3>Shared Data</h3>
      <pre>{JSON.stringify(user, null, 2)}</pre>
    </div>
  );
}

// 如果你在 React 子应用里，想接收 Angular 主应用塞进来的 Promise 结果：
//
// setSharedData('userInfo', { id: 1, name: 'Tom' })
//
// 或者：
//
// fetch('/api/user')
//   .then(res => res.json())
//   .then(data => setSharedData('userInfo', data))
