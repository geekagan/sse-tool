import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFetchSSE } from './index'

// Build a Response with a ReadableStream of SSE text chunks
function makeSSEResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  let idx = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]))
      } else {
        controller.close()
      }
    },
  })
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

// Build a Response whose body reader delivers one chunk then throws on the next read.
// Uses a mocked reader object (not a real ReadableStream) to avoid Node.js's WebStreams
// internal error propagation causing unhandled rejection warnings.
function makeErrorStream(firstChunk: string): Response {
  const encoder = new TextEncoder()
  const chunk = encoder.encode(firstChunk)
  let calls = 0
  const mockReader = {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      calls++
      if (calls === 1) return { done: false, value: chunk }
      throw new Error('network error mid-stream')
    },
    cancel: () => Promise.resolve(),
    releaseLock: () => {},
    get closed(): Promise<undefined> { return Promise.resolve(undefined) },
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    body: { getReader: () => mockReader } as unknown as ReadableStream<Uint8Array>,
  } as Response
}

// Build an HTTP error response (no body)
function makeHttpError(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

// Flush pending microtasks
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createFetchSSE — happy path', () => {
  it('calls onOpen when 200 response is received', async () => {
    const onOpen = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onOpen })
    await flush()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('delivers parsed events via onMessage', async () => {
    const onMessage = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['data: hello\n\n']))
    createFetchSSE({ url: '/sse', onMessage })
    await flush()
    expect(onMessage).toHaveBeenCalledWith({ data: 'hello', event: 'message' })
  })

  it('calls onClose("complete") when stream ends normally', async () => {
    const onClose = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['data: hello\n\n']))
    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onClose })
    await flush()
    expect(onClose).toHaveBeenCalledWith('complete')
  })

  it('state is "connecting" before fetch resolves', () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    expect(conn.state).toBe('connecting')
  })

  it('state is "open" while reading stream', async () => {
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    expect(conn.state).toBe('open')
  })

  it('state is "closed" after stream completes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    expect(conn.state).toBe('closed')
  })

  it('sends Accept and Cache-Control headers', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    expect(fetch).toHaveBeenCalledWith('/sse', expect.objectContaining({
      headers: expect.objectContaining({
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      }),
    }))
  })
})

describe('createFetchSSE — manual close', () => {
  it('calling close() sets state to "closed"', async () => {
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    conn.close()
    expect(conn.state).toBe('closed')
  })

  it('calling close() triggers onClose("manual")', async () => {
    const onClose = vi.fn()
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn(), onClose })
    await flush()
    conn.close()
    expect(onClose).toHaveBeenCalledWith('manual')
  })

  it('calling close() twice fires onClose only once', async () => {
    const onClose = vi.fn()
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn(), onClose })
    await flush()
    conn.close()
    conn.close()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('close() after natural stream end is a no-op', async () => {
    const onClose = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    const conn = createFetchSSE({ url: '/sse', onMessage: vi.fn(), onClose })
    await flush()
    expect(onClose).toHaveBeenCalledWith('complete')
    conn.close()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('createFetchSSE — HTTP error handling', () => {
  it('does not retry on 401, calls onClose("error")', async () => {
    const onClose = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeHttpError(401))
    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onClose })
    await flush()
    expect(onClose).toHaveBeenCalledWith('error')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 403', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeHttpError(403))
    createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeHttpError(404))
    createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 422', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeHttpError(422))
    createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries on 503 with backoff delay', async () => {
    const onError = vi.fn()
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeHttpError(503))
      .mockResolvedValueOnce(makeSSEResponse([]))

    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onError, retry: { jitter: false } })
    await flush()
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ willRetry: true, nextDelay: 1000 }),
    )
    vi.advanceTimersByTime(1000)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries on 429 with Retry-After header delay', async () => {
    const onError = vi.fn()
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeHttpError(429, { 'Retry-After': '5' }))
      .mockResolvedValueOnce(makeSSEResponse([]))

    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onError })
    await flush()
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ willRetry: true, nextDelay: 5000 }),
    )
    vi.advanceTimersByTime(5000)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries on 500 with backoff', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeHttpError(500))
      .mockResolvedValueOnce(makeSSEResponse([]))

    createFetchSSE({ url: '/sse', onMessage: vi.fn(), retry: { jitter: false } })
    await flush()
    vi.advanceTimersByTime(1000)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries and calls onClose("exhausted")', async () => {
    const onClose = vi.fn()
    vi.mocked(fetch).mockResolvedValue(makeHttpError(500))

    createFetchSSE({
      url: '/sse',
      onMessage: vi.fn(),
      onClose,
      retry: { maxAttempts: 2, jitter: false },
    })

    await flush()                              // attempt 0 fails
    vi.advanceTimersByTime(1000); await flush() // attempt 1 fails
    vi.advanceTimersByTime(2000); await flush() // attempt 2 fails → exhausted
    expect(onClose).toHaveBeenCalledWith('exhausted')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('createFetchSSE — network errors', () => {
  it('retries on fetch rejection (network down)', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(makeSSEResponse([]))

    const onError = vi.fn()
    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onError, retry: { jitter: false } })
    await flush()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ willRetry: true }))
    vi.advanceTimersByTime(1000)
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries when ReadableStream errors mid-read', async () => {
    const onMessage = vi.fn()
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeErrorStream('data: first\n\n'))
      .mockResolvedValueOnce(makeSSEResponse(['data: recovered\n\n']))

    createFetchSSE({ url: '/sse', onMessage, retry: { jitter: false } })
    await flush()
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'first' }))

    vi.advanceTimersByTime(1000)
    await flush()
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ data: 'recovered' }))
  })
})

describe('createFetchSSE — lastEventId / resume', () => {
  it('sends Last-Event-ID header when lastEventId is provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createFetchSSE({ url: '/sse', onMessage: vi.fn(), lastEventId: 'abc-123' })
    await flush()
    expect(fetch).toHaveBeenCalledWith('/sse', expect.objectContaining({
      headers: expect.objectContaining({ 'Last-Event-ID': 'abc-123' }),
    }))
  })

  it('does NOT send Last-Event-ID when lastEventId is absent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createFetchSSE({ url: '/sse', onMessage: vi.fn() })
    await flush()
    const callHeaders = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(callHeaders['Last-Event-ID']).toBeUndefined()
  })

  it('calls onIdUpdate when server sends id field', async () => {
    const onIdUpdate = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['id: 99\ndata: hello\n\n']))
    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onIdUpdate })
    await flush()
    expect(onIdUpdate).toHaveBeenCalledWith('99')
  })

  it('sends updated Last-Event-ID on reconnect', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeErrorStream('id: 77\ndata: first\n\n'))
      .mockResolvedValueOnce(makeSSEResponse([]))

    createFetchSSE({ url: '/sse', onMessage: vi.fn(), retry: { jitter: false } })
    await flush()
    vi.advanceTimersByTime(1000)
    await flush()

    expect(fetch).toHaveBeenNthCalledWith(2, '/sse', expect.objectContaining({
      headers: expect.objectContaining({ 'Last-Event-ID': '77' }),
    }))
  })

  it('server retry: field overrides nextDelay reported in onError', async () => {
    const onError = vi.fn()
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeErrorStream('retry: 9000\ndata: hi\n\n'))
      .mockResolvedValueOnce(makeSSEResponse([]))

    createFetchSSE({ url: '/sse', onMessage: vi.fn(), onError, retry: { jitter: false } })
    await flush()
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ nextDelay: 9000 }),
    )
  })
})
