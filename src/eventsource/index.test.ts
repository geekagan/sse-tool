import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventSource } from './index'

function makeSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let idx = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (idx < chunks.length) controller.enqueue(encoder.encode(chunks[idx++]))
      else controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

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

describe('createEventSource — addEventListener / removeEventListener', () => {
  it('delivers "message" events to addEventListener("message") listener', async () => {
    const listener = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['data: hello\n\n']))
    const es = createEventSource({ url: '/sse' })
    es.addEventListener('message', listener)
    await flush()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ data: 'hello', event: 'message' }))
  })

  it('delivers named events to the matching listener only', async () => {
    const updateListener = vi.fn()
    const messageListener = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['event: update\ndata: payload\n\n']))
    const es = createEventSource({ url: '/sse' })
    es.addEventListener('message', messageListener)
    es.addEventListener('update', updateListener)
    await flush()
    expect(updateListener).toHaveBeenCalledOnce()
    expect(messageListener).not.toHaveBeenCalled()
  })

  it('removeEventListener prevents future calls', async () => {
    const listener = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['data: hello\n\n']))
    const es = createEventSource({ url: '/sse' })
    es.addEventListener('message', listener)
    es.removeEventListener('message', listener)
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('multiple listeners for same type all receive the event', async () => {
    const l1 = vi.fn()
    const l2 = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['data: ping\n\n']))
    const es = createEventSource({ url: '/sse' })
    es.addEventListener('message', l1)
    es.addEventListener('message', l2)
    await flush()
    expect(l1).toHaveBeenCalledOnce()
    expect(l2).toHaveBeenCalledOnce()
  })

  it('adding the same listener twice only calls it once', async () => {
    const listener = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse(['data: hi\n\n']))
    const es = createEventSource({ url: '/sse' })
    es.addEventListener('message', listener)
    es.addEventListener('message', listener)
    await flush()
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('createEventSource — readyState', () => {
  it('readyState is 0 (CONNECTING) before connection opens', () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}))
    const es = createEventSource({ url: '/sse' })
    expect(es.readyState).toBe(0)
  })

  it('readyState is 1 (OPEN) while stream is active', async () => {
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const es = createEventSource({ url: '/sse' })
    await flush()
    expect(es.readyState).toBe(1)
  })

  it('readyState is 2 (CLOSED) after stream ends', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    const es = createEventSource({ url: '/sse' })
    await flush()
    expect(es.readyState).toBe(2)
  })

  it('readyState is 2 after close() is called', async () => {
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const es = createEventSource({ url: '/sse' })
    await flush()
    es.close()
    expect(es.readyState).toBe(2)
  })
})

describe('createEventSource — lifecycle callbacks', () => {
  it('calls onClose("complete") when stream ends naturally', async () => {
    const onClose = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createEventSource({ url: '/sse', onClose })
    await flush()
    expect(onClose).toHaveBeenCalledWith('complete')
  })

  it('calls onClose("manual") when close() is called', async () => {
    const onClose = vi.fn()
    const stream = new ReadableStream({ start() {} })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(stream, { status: 200 }))
    const es = createEventSource({ url: '/sse', onClose })
    await flush()
    es.close()
    expect(onClose).toHaveBeenCalledWith('manual')
  })

  it('calls onOpen when connection opens', async () => {
    const onOpen = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createEventSource({ url: '/sse', onOpen })
    await flush()
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe('createEventSource — fetch deviations (intentional)', () => {
  it('supports POST with body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createEventSource({ url: '/sse', method: 'POST', body: '{"prompt":"hello"}' })
    await flush()
    expect(fetch).toHaveBeenCalledWith('/sse', expect.objectContaining({
      method: 'POST',
      body: '{"prompt":"hello"}',
    }))
  })

  it('supports Authorization header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeSSEResponse([]))
    createEventSource({ url: '/sse', headers: { Authorization: 'Bearer token' } })
    await flush()
    expect(fetch).toHaveBeenCalledWith('/sse', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }))
  })
})
