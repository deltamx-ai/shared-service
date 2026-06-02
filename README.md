# shared-service

一个给 Angular / React 微前端共用的页面级内存桥。

## 作用

- Angular 主应用里把请求结果塞进内存
- React 子应用直接读取同一份数据
- 支持传 `Promise`，结果落地后自动缓存
- 同一个 key 只保留一份值

## 文件

- `shared-memory.service.ts`：Angular Service
- `react-usage-example.tsx`：React 使用示例

## Angular 用法

```ts
constructor(private sharedMemory: SharedMemoryService) {}

async loadUser() {
  await this.sharedMemory.ensure('userInfo', fetch('/api/user').then(res => res.json()));
}

const user = this.sharedMemory.get('userInfo');
```

## React 用法

```tsx
import { getSharedData, waitSharedData } from './react-usage-example';

const user = getSharedData('userInfo');

if (!user) {
  waitSharedData('userInfo').then((data) => {
    console.log(data);
  });
}
```

## 注意

- 这个方案依赖同一个浏览器页面里的 `window`
- 刷新页面后内存会丢失
- 更适合微前端场景下的运行时共享，不适合持久化数据
