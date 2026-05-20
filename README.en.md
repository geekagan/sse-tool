# @geekagan/sse-toolkit

English | [中文](./README.md)

Production-grade SSE (Server-Sent Events) for the frontend.

- **WHATWG-compliant** SSE stream parsing
- **Exponential backoff** with equal-jitter reconnection
- **Resume from checkpoint** via `Last-Event-ID` and external persistence hook
- **Two modes**: `fetch+ReadableStream` (full control) or `EventSource`-compatible API
- **Tree-shakeable**: subpath exports — import only what you use
- **Zero dependencies**, dual CJS + ESM

## Installation

```bash
npm install @geekagan/sse-toolkit
```

## Quick start

### fetch mode

```ts
import { createFetchSSE } from '@geekagan/sse-toolkit/fetch'

const conn = createFetchSSE({
  url: '/api/stream',
  onMessage(event) {
    console.log(event.data)
  },
  onError(err, ctx) {
    console.error(`attempt ${ctx.attempt}, willRetry: ${ctx.willRetry}`)
  },
  onClose(reason) {
    console.log('closed:', reason) // 'manual' | 'complete' | 'exhausted' | 'error'
  },
})

// later
conn.close()
```

### EventSource-compatible mode

```ts
import { createEventSource } from '@geekagan/sse-toolkit/eventsource'

const es = createEventSource({ url: '/api/stream' })

es.addEventListener('message', (event) => {
  console.log(event.data)
})

es.addEventListener('update', (event) => {
  console.log('named event:', event.data)
})

// es.readyState: 0 (connecting) | 1 (open) | 2 (closed)
es.close()
```

## API

### `createFetchSSE(options): FetchSSEConnection`

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | required | SSE endpoint URL |
| `method` | `string` | `'GET'` | HTTP method |
| `headers` | `Record<string, string>` | `{}` | Extra request headers |
| `body` | `BodyInit` | — | Request body (useful for POST) |
| `lastEventId` | `string` | `''` | Initial `Last-Event-ID` for resume |
| `onIdUpdate` | `(id: string) => void` | — | Called when server sends a new event id |
| `onMessage` | `(event: SSEEvent) => void` | required | Called for each SSE event |
| `onOpen` | `() => void` | — | Called when connection is established |
| `onError` | `(err: Error, ctx: SSEErrorContext) => void` | — | Called on error |
| `onClose` | `(reason: SSECloseReason) => void` | — | Called when connection is permanently closed |
| `retry` | `Partial<RetryOptions>` | see below | Reconnect configuration |

**RetryOptions defaults:**

```ts
{
  maxAttempts: 10,
  initialDelay: 1000,   // ms
  maxDelay: 30000,      // ms
  multiplier: 2,
  jitter: true,
}
```

**FetchSSEConnection:**

```ts
interface FetchSSEConnection {
  close(): void
  readonly state: 'connecting' | 'open' | 'reconnecting' | 'closed'
}
```

### `createEventSource(options): EventSourceConnection`

Same options as `createFetchSSE` minus `onMessage`, plus:

```ts
interface EventSourceConnection {
  addEventListener(type: string, listener: (event: SSEEvent) => void): void
  removeEventListener(type: string, listener: (event: SSEEvent) => void): void
  close(): void
  readonly readyState: 0 | 1 | 2
}
```

## Resume / checkpoint (断点续传)

```ts
// Persist the last received event ID
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

On reconnect, `@geekagan/sse-toolkit` automatically sends `Last-Event-ID` in the request headers so the server can resume from the correct position.

## POST with body

The native `EventSource` API doesn't support POST. `@geekagan/sse-toolkit` does:

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

## HTTP status handling

| Status | Behavior |
|---|---|
| 2xx | Stream normally |
| 401, 403, 404, 422 | No retry → `onClose('error')` |
| 429, 503 | Retry, respecting `Retry-After` header |
| Other 5xx | Retry with backoff |

## Reconnect backoff

Uses equal-jitter backoff: `delay/2 + random(0, delay/2)`. This avoids thundering herd while preserving a minimum floor on the delay.

## Types

All public types are exported from the root entry:

```ts
import type { SSEEvent, FetchSSEOptions, RetryOptions, SSECloseReason } from '@geekagan/sse-toolkit'
```

## License

MIT
