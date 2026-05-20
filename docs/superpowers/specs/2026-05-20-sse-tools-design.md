# sse-tools Design Spec

**Date:** 2026-05-20  
**Status:** Approved

---

## Overview

`sse-tools` is a production-grade npm package for handling Server-Sent Events (SSE) on the frontend. It unifies stream parsing, reconnection with exponential backoff, automatic disconnect handling, and resume-from-checkpoint (断点续传) into a single coherent API.

**Key decisions:**
- TypeScript source, dual CJS + ESM output
- Functional API style
- Single package with subpath exports (`sse-tools/fetch`, `sse-tools/eventsource`)
- Two modes share internal logic but are separately importable for tree-shaking
- `_internal/` modules are not exposed via `exports`

---

## 1. Directory Structure

```
sse-tools/
├── src/
│   ├── fetch/
│   │   └── index.ts          # createFetchSSE()
│   ├── eventsource/
│   │   └── index.ts          # createEventSource()
│   ├── _internal/
│   │   ├── parser.ts         # SSE protocol parser (string in → SSEEvent[] out)
│   │   ├── reconnect.ts      # Reconnect scheduler + equal-jitter backoff
│   │   └── types.ts          # Internal-only types (ParsedSSEChunk, ReconnectState)
│   └── types.ts              # Public types (SSEOptions, SSEEvent, SSEConnection, etc.)
├── dist/                     # tsup build output
├── scripts/
│   └── e2e-server.js         # Local SSE server for E2E tests
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## 2. Package Exports (`package.json`)

```json
{
  "main": "./dist/fetch/index.cjs",
  "module": "./dist/fetch/index.mjs",
  "exports": {
    ".": {
      "types": "./dist/types.d.ts"
    },
    "./fetch": {
      "import": "./dist/fetch/index.mjs",
      "require": "./dist/fetch/index.cjs",
      "types": "./dist/fetch/index.d.ts"
    },
    "./eventsource": {
      "import": "./dist/eventsource/index.mjs",
      "require": "./dist/eventsource/index.cjs",
      "types": "./dist/eventsource/index.d.ts"
    }
  }
}
```

- `"."` exports types only (no runtime code); enables `import type { SSEOptions } from 'sse-tools'`
- `main`/`module` fallbacks for toolchains that don't read `exports` (e.g. Jest default config)
- `_internal/` is intentionally absent from exports

---

## 3. Public API

### 3.1 Shared Types (`src/types.ts`)

```ts
interface RetryOptions {
  maxAttempts: number    // default: 5; Infinity for unlimited
  initialDelay: number   // ms, default: 1000
  maxDelay: number       // ms, default: 30_000
  multiplier: number     // exponential base, default: 2
  jitter: boolean        // default: true (uses equal jitter)
}

interface SSEEvent {
  data: string
  event: string          // defaults to "message" when field absent
  id?: string
  retry?: number
}

type SSEState = 'connecting' | 'open' | 'closed' | 'reconnecting'

interface SSEErrorContext {
  attempt: number
  willRetry: boolean
  nextDelay?: number     // only present when willRetry is true
}
```

### 3.2 `sse-tools/fetch` — `createFetchSSE()`

```ts
import { createFetchSSE } from 'sse-tools/fetch'

const connection = createFetchSSE({
  url: string
  method?: string                          // default: 'GET'
  headers?: Record<string, string>
  body?: BodyInit

  retry?: Partial<RetryOptions>
  lastEventId?: string                     // initial value for 断点续传
  onIdUpdate?: (id: string) => void        // called when server sends id field

  onMessage: (event: SSEEvent) => void
  onError?: (err: Error, ctx: SSEErrorContext) => void
  onOpen?: () => void
  onClose?: (reason: 'manual' | 'complete' | 'exhausted' | 'error') => void
})

// Returned handle
interface FetchSSEConnection {
  close(): void
  readonly state: SSEState
}
```

### 3.3 `sse-tools/eventsource` — `createEventSource()`

Exposes EventSource-like semantics but uses fetch internally, enabling custom headers and POST body (deviating from native EventSource intentionally).

```ts
import { createEventSource } from 'sse-tools/eventsource'

const es = createEventSource({
  url: string
  method?: string                          // default: 'GET'; supports POST for AI streaming
  headers?: Record<string, string>         // supports Authorization etc. (native ES can't)
  body?: BodyInit

  retry?: Partial<RetryOptions>
  lastEventId?: string
  onIdUpdate?: (id: string) => void

  onError?: (err: Error, ctx: SSEErrorContext) => void
  onOpen?: () => void
  onClose?: (reason: 'manual' | 'complete' | 'exhausted' | 'error') => void
})

// Returned handle (EventSource-compatible interface)
interface EventSourceConnection {
  addEventListener(type: string, listener: (event: SSEEvent) => void): void
  removeEventListener(type: string, listener: (event: SSEEvent) => void): void
  close(): void
  readonly readyState: 0 | 1 | 2   // 0=CONNECTING, 1=OPEN, 2=CLOSED
}
```

---

## 4. Reconnection & HTTP Status Code Strategy

### 4.1 Backoff Formula (equal jitter)

```
delay(n) = min(initialDelay × multiplier^n, maxDelay)
half     = delay(n) / 2
actual   = half + random(0, half)
```

Equal jitter guarantees a minimum delay floor while avoiding thundering herd.

### 4.2 HTTP Status Code Behavior

| Status | Behavior |
|--------|----------|
| 401 / 403 / 404 / 422 | No retry → `onClose('error')` |
| 429 / 503 | Retry; respect `Retry-After` header if present, else normal backoff |
| Other 5xx | Retry with normal backoff |
| Network error (fetch rejects) | Retry with normal backoff |
| `ReadableStream` closes mid-stream | Retry with normal backoff |
| `ReadableStream` ends normally | **No retry** → `onClose('complete')` |

### 4.3 `retry:` Field in SSE Protocol

When the server sends `retry: 3000`, it overrides `initialDelay` for subsequent reconnects (per WHATWG SSE spec).

---

## 5. SSE Protocol Parser (`_internal/parser.ts`)

### 5.1 Interface

```ts
// Decoding (Uint8Array → string) happens in the fetch adapter, not the parser.
// The parser is a pure string-in / events-out function with a carry-over buffer.
function parseSSEChunk(buffer: string, newChunk: string): {
  events: SSEEvent[]
  remaining: string   // incomplete line to prepend to the next chunk
}
```

### 5.2 Protocol Rules (WHATWG compliant)

- Fields are separated by `:`. `data:hello` (no space) is valid; `data` (no colon) means `data: ""`
- `data` may span multiple lines; lines are joined with `\n`
- `event` defaults to `"message"` when absent
- `id: ` (empty string) clears `lastEventId` — distinct from the `id` field being absent
- `retry:` value updates `initialDelay` if it parses as a valid integer
- Lines starting with `:` are comments — silently ignored, never dispatched
- A blank line (`\n\n`) dispatches the accumulated event

### 5.3 `id` Field Edge Cases

```ts
// id field present with empty value → clear lastEventId (spec-required)
// id field absent from event      → lastEventId unchanged
//
// These MUST be distinguished via field presence, not falsy check.
// Use a sentinel (e.g. `id: null` for absent vs `id: ""` for explicit empty).
```

### 5.4 `TextDecoder` Usage in Fetch Adapter

```ts
const decoder = new TextDecoder()
let buffer = ''
for await (const chunk of stream) {
  const text = decoder.decode(chunk, { stream: true })
  const { events, remaining } = parseSSEChunk(buffer, text)
  buffer = remaining
  for (const event of events) handleEvent(event)
}
```

---

## 6. Testing Strategy

### 6.1 Unit Tests — `_internal/parser.ts` (highest priority)

Normal cases:
- Single-line data
- Multi-line data (joined with `\n`)
- Named events (`event: update`)
- `retry:` field overrides delay
- Comment lines ignored

Boundary / "weird but valid" cases:
- `data:hello` (no space after colon — spec allows)
- `data` (no colon at all — spec defines as `data: ""`)
- Consecutive blank lines
- Very long data lines
- `id` field present with empty string vs absent
- Cross-chunk splits at arbitrary positions (including mid-field-name, mid-value, mid-newline)

### 6.2 Integration Tests — Reconnect Scheduler

Use `vi.useFakeTimers()` + mocked `fetch`. Four distinct mock scenarios:

1. `fetch` rejects (network down) → triggers retry
2. `fetch` resolves with non-2xx status:
   - 401/403/404/422 → no retry, `onClose('error')`
   - 429/503 with `Retry-After` → retry after header delay
   - 5xx → retry with backoff
3. `fetch` 200 + `ReadableStream` closes mid-stream → triggers retry
4. `fetch` 200 + `ReadableStream` ends normally → **no retry**, `onClose('manual')`

Verify: backoff delay calculation, `Retry-After` parsing, `maxAttempts` exhaustion → `onClose('exhausted')`.

### 6.3 E2E Tests (local only, not in CI)

Real Node.js SSE server in `scripts/e2e-server.js`. Run full lifecycle:
connect → receive events → server drops connection → reconnect → `close()`.

```json
"scripts": {
  "test": "vitest run",
  "test:e2e": "node scripts/e2e-server.js & sleep 1 && vitest run e2e"
}
```

---

## 7. Toolchain

| Role | Tool |
|------|------|
| Build | `tsup` — one command, outputs ESM + CJS + `.d.ts` |
| Test | `vitest` |
| Lint | `eslint` + `@typescript-eslint` |
| Version / Changelog | `changesets` — PR-level changesets, auto-generated CHANGELOG, GitHub Actions release PR |
| CI | GitHub Actions — lint + test on push/PR |
