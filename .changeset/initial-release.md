---
"sse-tools": minor
---

Initial release: production-grade SSE for the frontend.

- `createFetchSSE`: fetch+ReadableStream-based SSE with reconnection, backoff, and resume
- `createEventSource`: EventSource-compatible API built on top of `createFetchSSE`
- WHATWG-compliant SSE stream parsing with cross-chunk buffer support
- Equal-jitter exponential backoff with configurable limits
- HTTP status-aware retry logic (no retry on 401/403/404/422; respect Retry-After on 429/503)
- Resume from checkpoint via `lastEventId` + `onIdUpdate` hook
- Dual CJS + ESM output with subpath exports for tree-shaking
