import type { RetryOptions } from '../types'
import type { ReconnectConfig } from './types'

const DEFAULTS: ReconnectConfig = {
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 30_000,
  multiplier: 2,
  jitter: true,
}

export function resolveRetryConfig(partial?: Partial<RetryOptions>): ReconnectConfig {
  return { ...DEFAULTS, ...partial }
}

/**
 * Computes the next reconnect delay for a given attempt number.
 * Uses equal-jitter: result is in [base/2, base], never exceeds maxDelay.
 */
export function computeDelay(config: ReconnectConfig, attempt: number): number {
  const base = Math.min(
    config.initialDelay * Math.pow(config.multiplier, attempt),
    config.maxDelay,
  )
  if (!config.jitter) return base
  const half = base / 2
  return half + Math.random() * half
}

export interface ReconnectHandle {
  scheduleNext(delayMs: number, fn: () => void): void
  cancel(): void
}

export function createReconnectHandle(): ReconnectHandle {
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    scheduleNext(delayMs, fn) {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, delayMs)
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/**
 * Parses a Retry-After header value.
 * Returns delay in milliseconds, or null if unparseable.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  // Try pure integer seconds (ASCII digits only)
  if (/^\d+$/.test(header.trim())) return parseInt(header.trim(), 10) * 1000
  // Try HTTP-date
  const ms = Date.parse(header)
  if (!isNaN(ms)) return Math.max(0, ms - Date.now())
  return null
}
