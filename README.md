# shared-service

一个给 Angular / React 微前端共用的共享内存方案。

## 核心思路

不再把数据挂到 `window` 上。

而是由**基座应用**创建一个共享 store，然后把这个 store 作为 props / 注入对象，传给各个子应用。

这样做的好处：

- 不污染 `window`
- 不容易被别的脚本误改
- 基座可以统一控制共享数据
- 子应用之间通过同一个 store 读写数据

## 文件

- `shared-memory.service.ts`：Angular 侧服务
- `react-usage-example.tsx`：React 侧示例

## 原理

基座先创建一份共享 store：

```ts
const store = createSharedMemoryStore();
```

然后把它传给 Angular 和 React 子应用。

Angular 写入：

```ts
sharedMemory.set(store, 'userInfo', data);
```

React 读取：

```ts
const user = getSharedData(store, 'userInfo');
```

如果数据还没回来，React 可以调用：

```ts
waitSharedData(store, 'userInfo').then((data) => {
  console.log(data);
});
```

## Angular 用法

```ts
import { SharedMemoryService, SHARED_MEMORY_STORE, createSharedMemoryStore } from './shared-memory.service';

// 基座中创建共享 store
const store = createSharedMemoryStore();

// Angular 注入时绑定同一个 store
providers: [
  { provide: SHARED_MEMORY_STORE, useValue: store }
]
```

然后在服务里使用：

```ts
constructor(private sharedMemory: SharedMemoryService) {}

async loadUser() {
  await this.sharedMemory.ensure('userInfo', fetch('/api/user').then(res => res.json()));
}
```

## React 用法

```tsx
import { createSharedMemoryStore, setSharedData, getSharedData, waitSharedData } from './react-usage-example';

const store = createSharedMemoryStore();
setSharedData(store, 'userInfo', { id: 1, name: 'Tom' });
const user = getSharedData(store, 'userInfo');
```

## 注意

- 这套方案依赖基座把同一个 store 实例传给所有子应用
- 只要基座还活着，数据就还在
- 刷新页面后，store 需要由基座重新创建并重新注入
- 这是运行时共享，不是持久化存储
