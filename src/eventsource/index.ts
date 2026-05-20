import type { EventSourceOptions, EventSourceConnection, SSEEventListener, SSEEvent } from '../types'
import { createFetchSSE } from '../fetch'

export function createEventSource(options: EventSourceOptions): EventSourceConnection {
  const listeners = new Map<string, Set<SSEEventListener>>()
  let readyState: 0 | 1 | 2 = 0

  function dispatch(event: SSEEvent): void {
    const handlers = listeners.get(event.event)
    if (handlers) {
      for (const h of handlers) h(event)
    }
  }

  const inner = createFetchSSE({
    ...options,
    onMessage(event) {
      dispatch(event)
    },
    onOpen() {
      readyState = 1
      options.onOpen?.()
    },
    onClose(reason) {
      readyState = 2
      options.onClose?.(reason)
    },
    onError: options.onError,
  })

  return {
    addEventListener(type: string, listener: SSEEventListener): void {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: SSEEventListener): void {
      listeners.get(type)?.delete(listener)
    },
    close(): void {
      inner.close()
    },
    get readyState(): 0 | 1 | 2 {
      return readyState
    },
  }
}
