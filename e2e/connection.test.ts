import { describe, it, expect } from 'vitest'
import { createFetchSSE } from '../src/fetch/index'
import { createEventSource } from '../src/eventsource/index'

const BASE = 'http://localhost:4399'

describe('E2E: createFetchSSE', () => {
  it('receives 3 events from /sse and closes with "complete"', () =>
    new Promise<void>((resolve, reject) => {
      const messages: string[] = []
      createFetchSSE({
        url: `${BASE}/sse`,
        onMessage: (e) => messages.push(e.data),
        onClose: (reason) => {
          try {
            expect(reason).toBe('complete')
            expect(messages).toEqual(['message-1', 'message-2', 'message-3'])
            resolve()
          } catch (err) { reject(err) }
        },
        onError: (_err, ctx) => { if (!ctx.willRetry) reject(new Error('unexpected error')) },
      })
    }))

  it('does not retry on 401, calls onClose("error")', () =>
    new Promise<void>((resolve, reject) => {
      createFetchSSE({
        url: `${BASE}/sse-401`,
        onMessage: () => {},
        onClose: (reason) => {
          try { expect(reason).toBe('error'); resolve() }
          catch (err) { reject(err) }
        },
      })
    }))

  it('receives event before drop then reconnects on /sse-drop', () =>
    new Promise<void>((resolve, reject) => {
      const messages: string[] = []
      const conn = createFetchSSE({
        url: `${BASE}/sse-drop`,
        onMessage: (e) => {
          messages.push(e.data)
          // Got the message; close manually after first reconnect attempt
          setTimeout(() => {
            conn.close()
            try {
              expect(messages).toContain('before-drop')
              resolve()
            } catch (err) { reject(err) }
          }, 1500)
        },
        onError: () => {},
        retry: { maxAttempts: 1, jitter: false, initialDelay: 200 },
      })
    }))
})

describe('E2E: createEventSource', () => {
  it('receives named "message" events via addEventListener', () =>
    new Promise<void>((resolve, reject) => {
      const data: string[] = []
      const es = createEventSource({ url: `${BASE}/sse` })
      es.addEventListener('message', (e) => data.push(e.data))
      setTimeout(() => {
        try {
          expect(data.length).toBeGreaterThan(0)
          es.close()
          resolve()
        } catch (err) { reject(err) }
      }, 500)
    }))
})
