# @geekagan/sse-toolkit

[English](./README.en.md) | 中文

面向前端的生产级 SSE（Server-Sent Events）工具库。

- **符合 WHATWG 标准**的 SSE 流解析
- **指数退避**加等比抖动的自动重连
- **断点续传**：通过 `Last-Event-ID` 与外部持久化钩子恢复进度
- **两种模式**：`fetch+ReadableStream`（完全可控）或兼容 `EventSource` 的 API
- **Tree-shakeable**：子路径导出，按需引入
- **零依赖**，同时支持 CJS 和 ESM

## 安装

```bash
npm install @geekagan/sse-toolkit
```

## 快速上手

### fetch 模式

```ts
import { createFetchSSE } from '@geekagan/sse-toolkit/fetch'

const conn = createFetchSSE({
  url: '/api/stream',
  onMessage(event) {
    console.log(event.data)
  },
  onError(err, ctx) {
    console.error(`第 ${ctx.attempt} 次尝试，willRetry: ${ctx.willRetry}`)
  },
  onClose(reason) {
    console.log('已关闭:', reason) // 'manual' | 'complete' | 'exhausted' | 'error'
  },
})

// 稍后关闭连接
conn.close()
```

### EventSource 兼容模式

```ts
import { createEventSource } from '@geekagan/sse-toolkit/eventsource'

const es = createEventSource({ url: '/api/stream' })

es.addEventListener('message', (event) => {
  console.log(event.data)
})

es.addEventListener('update', (event) => {
  console.log('具名事件:', event.data)
})

// es.readyState: 0（连接中）| 1（已连接）| 2（已关闭）
es.close()
```

## API

### `createFetchSSE(options): FetchSSEConnection`

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `url` | `string` | 必填 | SSE 端点 URL |
| `method` | `string` | `'GET'` | HTTP 请求方法 |
| `headers` | `Record<string, string>` | `{}` | 额外请求头 |
| `body` | `BodyInit` | — | 请求体（POST 场景使用） |
| `lastEventId` | `string` | `''` | 用于断点续传的初始 `Last-Event-ID` |
| `onIdUpdate` | `(id: string) => void` | — | 服务端发送新事件 ID 时触发 |
| `onMessage` | `(event: SSEEvent) => void` | 必填 | 每条 SSE 事件触发 |
| `onOpen` | `() => void` | — | 连接建立时触发 |
| `onError` | `(err: Error, ctx: SSEErrorContext) => void` | — | 发生错误时触发 |
| `onClose` | `(reason: SSECloseReason) => void` | — | 连接永久关闭时触发 |
| `retry` | `Partial<RetryOptions>` | 见下方 | 重连配置 |

**RetryOptions 默认值：**

```ts
{
  maxAttempts: 10,
  initialDelay: 1000,   // 毫秒
  maxDelay: 30000,      // 毫秒
  multiplier: 2,
  jitter: true,
}
```

**FetchSSEConnection：**

```ts
interface FetchSSEConnection {
  close(): void
  readonly state: 'connecting' | 'open' | 'reconnecting' | 'closed'
}
```

### `createEventSource(options): EventSourceConnection`

选项与 `createFetchSSE` 相同（去掉 `onMessage`），另增：

```ts
interface EventSourceConnection {
  addEventListener(type: string, listener: (event: SSEEvent) => void): void
  removeEventListener(type: string, listener: (event: SSEEvent) => void): void
  close(): void
  readonly readyState: 0 | 1 | 2
}
```

## 断点续传

```ts
// 持久化最后接收的事件 ID
const conn = createFetchSSE({
  url: '/api/stream',
  lastEventId: localStorage.getItem('lastEventId') ?? '',
  onIdUpdate(id) {
    localStorage.setItem('lastEventId', id)
  },
  onMessage(event) {
    console.log(event.data)
  },
})
```

重连时，`@geekagan/sse-toolkit` 会自动在请求头中携带 `Last-Event-ID`，服务端据此从正确位置恢复推送。

## POST 请求

原生 `EventSource` API 不支持 POST，`@geekagan/sse-toolkit` 支持：

```ts
const conn = createFetchSSE({
  url: '/api/chat',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'Hello' }),
  onMessage(event) {
    process.stdout.write(event.data)
  },
})
```

## HTTP 状态码处理

| 状态码 | 行为 |
|---|---|
| 2xx | 正常流式传输 |
| 401、403、404、422 | 不重试 → `onClose('error')` |
| 429、503 | 重试，遵循 `Retry-After` 响应头 |
| 其他 5xx | 退避重试 |

## 重连退避策略

采用等比抖动退避：`delay/2 + random(0, delay/2)`。在保证最小延迟下限的同时，有效避免惊群效应。

## 类型

所有公开类型均从根入口导出：

```ts
import type { SSEEvent, FetchSSEOptions, RetryOptions, SSECloseReason } from '@geekagan/sse-toolkit'
```

## License

MIT
