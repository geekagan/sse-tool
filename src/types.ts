export interface RetryOptions {
  /** Default: 5. Set to Infinity for unlimited retries. */
  maxAttempts: number
  /** Initial delay in ms before first retry. Default: 1000. */
  initialDelay: number
  /** Maximum delay cap in ms. Default: 30_000. */
  maxDelay: number
  /** Exponential backoff multiplier. Default: 2. */
  multiplier: number
  /** Apply equal-jitter to delay. Default: true. */
  jitter: boolean
}

/** A dispatched SSE event as defined by the WHATWG SSE spec. */
export interface SSEEvent {
  data: string
  /** Defaults to "message" when the event field is absent. */
  event: string
  /**
   * Present only when the server sent an `id:` field.
   * An empty string `""` means the server explicitly cleared the lastEventId.
   * Absence (`undefined`) means the id field was not present in this event.
   */
  id?: string
  retry?: number
}

export type SSEState = 'connecting' | 'open' | 'closed' | 'reconnecting'

export type SSECloseReason =
  | 'manual'     // user called close()
  | 'complete'   // server closed the stream normally (ReadableStream done)
  | 'exhausted'  // max reconnect attempts reached
  | 'error'      // unrecoverable HTTP error (401/403/404/422)

export interface SSEErrorContext {
  attempt: number
  willRetry: boolean
  /** Only present when willRetry is true. */
  nextDelay?: number
}

export interface FetchSSEOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
  retry?: Partial<RetryOptions>
  /** Initial Last-Event-ID for resume (断点续传). */
  lastEventId?: string
  /** Called whenever the server sends a new event id. Persist this to resume later. */
  onIdUpdate?: (id: string) => void
  onMessage: (event: SSEEvent) => void
  onError?: (err: Error, ctx: SSEErrorContext) => void
  onOpen?: () => void
  onClose?: (reason: SSECloseReason) => void
}

export interface FetchSSEConnection {
  close(): void
  readonly state: SSEState
}

export interface EventSourceOptions {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
  retry?: Partial<RetryOptions>
  lastEventId?: string
  onIdUpdate?: (id: string) => void
  onError?: (err: Error, ctx: SSEErrorContext) => void
  onOpen?: () => void
  onClose?: (reason: SSECloseReason) => void
}

export type SSEEventListener = (event: SSEEvent) => void

/**
 * EventSource-like handle.
 * INTENTIONAL DEVIATION from native EventSource:
 * - listener receives SSEEvent, not MessageEvent.
 * - Supports method, headers, and body (native EventSource does not).
 */
export interface EventSourceConnection {
  addEventListener(type: string, listener: SSEEventListener): void
  removeEventListener(type: string, listener: SSEEventListener): void
  close(): void
  /** 0=CONNECTING, 1=OPEN, 2=CLOSED — matches native EventSource.readyState values. */
  readonly readyState: 0 | 1 | 2
}
