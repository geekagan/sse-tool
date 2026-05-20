import type { FetchSSEOptions, FetchSSEConnection, SSEState, SSECloseReason } from '../types'
import type { InternalState, ReconnectConfig } from '../_internal/types'
import { toPublicState } from '../_internal/types'
import { parseSSEChunk } from '../_internal/parser'
import {
  computeDelay,
  createReconnectHandle,
  parseRetryAfter,
  resolveRetryConfig,
} from '../_internal/reconnect'

const NO_RETRY = new Set([401, 403, 404, 422])
const RETRY_WITH_OVERRIDE = new Set([429, 503])

export function createFetchSSE(options: FetchSSEOptions): FetchSSEConnection {
  const config: ReconnectConfig = resolveRetryConfig(options.retry)
  let state: InternalState = 'connecting'
  let lastEventId = options.lastEventId ?? ''
  let attempt = 0
  let abortCtrl: AbortController | null = null
  const reconnect = createReconnectHandle()

  const isClosed = () => state.startsWith('closed_')

  function terminate(reason: SSECloseReason): void {
    if (isClosed()) return
    reconnect.cancel()
    abortCtrl?.abort()
    abortCtrl = null
    state = `closed_${reason}` as InternalState
    options.onClose?.(reason)
  }

  function scheduleReconnect(err: Error, overrideDelay: number | null): void {
    if (isClosed()) return
    const exhausted = config.maxAttempts !== Infinity && attempt >= config.maxAttempts
    if (exhausted) {
      options.onError?.(err, { attempt, willRetry: false })
      terminate('exhausted')
      return
    }
    const delay = overrideDelay !== null ? overrideDelay : computeDelay(config, attempt)
    options.onError?.(err, { attempt, willRetry: true, nextDelay: delay })
    state = 'reconnecting'
    attempt++
    reconnect.scheduleNext(delay, () => {
      if (!isClosed()) connect()
    })
  }

  async function connect(): Promise<void> {
    if (isClosed()) return
    state = 'connecting'
    abortCtrl = new AbortController()

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...options.headers,
    }
    if (lastEventId) headers['Last-Event-ID'] = lastEventId

    let response: Response
    try {
      response = await fetch(options.url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        signal: abortCtrl.signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      scheduleReconnect(err as Error, null)
      return
    }

    if (!response.ok) {
      const httpErr = new Error(`HTTP ${response.status}`)
      if (NO_RETRY.has(response.status)) {
        options.onError?.(httpErr, { attempt, willRetry: false })
        terminate('error')
        return
      }
      if (RETRY_WITH_OVERRIDE.has(response.status)) {
        const override = parseRetryAfter(response.headers.get('Retry-After'))
        scheduleReconnect(httpErr, override)
        return
      }
      scheduleReconnect(httpErr, null)
      return
    }

    if (!response.body) {
      terminate('error')
      return
    }

    state = 'open'
    options.onOpen?.()

    const decoder = new TextDecoder()
    let buffer = ''
    const reader = response.body.getReader()

    try {
      while (true) {
        if (isClosed()) { reader.cancel(); return }
        const { done, value } = await reader.read()
        if (done) { terminate('complete'); return }

        const { events, remaining } = parseSSEChunk(buffer, decoder.decode(value, { stream: true }))
        buffer = remaining

        for (const ev of events) {
          if (isClosed()) return
          if (ev.idPresent) {
            lastEventId = ev.id
            options.onIdUpdate?.(ev.id)
          }
          if (ev.retry !== undefined) {
            config.initialDelay = ev.retry
          }
          options.onMessage({
            data: ev.data,
            event: ev.event,
            ...(ev.idPresent ? { id: ev.id } : {}),
            ...(ev.retry !== undefined ? { retry: ev.retry } : {}),
          })
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      try { reader.cancel() } catch { /* ignore cancel errors */ }
      scheduleReconnect(err as Error, null)
    }
  }

  connect()

  return {
    get state(): SSEState { return toPublicState(state) },
    close(): void { terminate('manual') },
  }
}
