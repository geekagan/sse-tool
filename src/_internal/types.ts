import type { SSECloseReason, SSEState } from '../types'

/**
 * Fine-grained internal state. The public SSEState collapses all closed_* variants to 'closed'.
 * This distinction lets close() be a no-op when the connection is already closed.
 */
export type InternalState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed_complete'
  | 'closed_manual'
  | 'closed_error'
  | 'closed_exhausted'

export function toPublicState(s: InternalState): SSEState {
  return s.startsWith('closed_') ? 'closed' : (s as SSEState)
}

export function toCloseReason(s: InternalState): SSECloseReason {
  switch (s) {
    case 'closed_complete':  return 'complete'
    case 'closed_manual':    return 'manual'
    case 'closed_error':     return 'error'
    case 'closed_exhausted': return 'exhausted'
    default: throw new Error(`${s} is not a closed state`)
  }
}

/** Internal SSE event with richer id tracking than the public SSEEvent. */
export interface ParsedSSEEvent {
  data: string
  event: string
  /** True when the id field appeared in the raw event, even if value is "". */
  idPresent: boolean
  /** The id value. Meaningful only when idPresent is true. */
  id: string
  retry?: number
}

export interface ReconnectConfig {
  maxAttempts: number
  initialDelay: number
  maxDelay: number
  multiplier: number
  jitter: boolean
}
