import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computeDelay, createReconnectHandle, parseRetryAfter, resolveRetryConfig } from './reconnect'

describe('resolveRetryConfig', () => {
  it('returns all defaults when called with no args', () => {
    const c = resolveRetryConfig()
    expect(c).toEqual({ maxAttempts: 5, initialDelay: 1000, maxDelay: 30_000, multiplier: 2, jitter: true })
  })

  it('overrides only the provided fields', () => {
    const c = resolveRetryConfig({ maxAttempts: 3, initialDelay: 500 })
    expect(c.maxAttempts).toBe(3)
    expect(c.initialDelay).toBe(500)
    expect(c.maxDelay).toBe(30_000)
    expect(c.jitter).toBe(true)
  })

  it('accepts Infinity for maxAttempts', () => {
    const c = resolveRetryConfig({ maxAttempts: Infinity })
    expect(c.maxAttempts).toBe(Infinity)
  })
})

describe('computeDelay (no jitter)', () => {
  const config = resolveRetryConfig({ jitter: false })

  it('returns initialDelay at attempt 0', () => {
    expect(computeDelay(config, 0)).toBe(1000)
  })

  it('doubles delay each attempt (multiplier=2)', () => {
    expect(computeDelay(config, 1)).toBe(2000)
    expect(computeDelay(config, 2)).toBe(4000)
    expect(computeDelay(config, 3)).toBe(8000)
  })

  it('caps at maxDelay', () => {
    expect(computeDelay(config, 100)).toBe(30_000)
  })

  it('respects custom multiplier', () => {
    const c = resolveRetryConfig({ jitter: false, multiplier: 3 })
    expect(computeDelay(c, 1)).toBe(3000)
    expect(computeDelay(c, 2)).toBe(9000)
  })
})

describe('computeDelay (equal jitter)', () => {
  it('result is in [half, base] range for all attempts', () => {
    const config = resolveRetryConfig({ jitter: true, initialDelay: 1000 })
    for (let i = 0; i < 20; i++) {
      const d = computeDelay(config, 0)
      expect(d).toBeGreaterThanOrEqual(500)
      expect(d).toBeLessThanOrEqual(1000)
    }
  })

  it('jitter never exceeds maxDelay', () => {
    const config = resolveRetryConfig({ jitter: true, maxDelay: 5000 })
    for (let i = 0; i < 20; i++) {
      expect(computeDelay(config, 100)).toBeLessThanOrEqual(5000)
    }
  })
})

describe('createReconnectHandle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('calls fn after specified delay', () => {
    const fn = vi.fn()
    const h = createReconnectHandle()
    h.scheduleNext(1000, fn)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('cancel() prevents fn from being called', () => {
    const fn = vi.fn()
    const h = createReconnectHandle()
    h.scheduleNext(1000, fn)
    h.cancel()
    vi.advanceTimersByTime(2000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('scheduleNext() replaces a pending schedule', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const h = createReconnectHandle()
    h.scheduleNext(1000, fn1)
    h.scheduleNext(500, fn2)
    vi.advanceTimersByTime(1000)
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalledOnce()
  })

  it('cancel() is a no-op when nothing is scheduled', () => {
    const h = createReconnectHandle()
    expect(() => h.cancel()).not.toThrow()
  })
})

describe('parseRetryAfter', () => {
  it('parses integer seconds and returns ms', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
  })

  it('parses "0" as 0ms', () => {
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('returns null for null input', () => {
    expect(parseRetryAfter(null)).toBeNull()
  })

  it('returns null for non-parseable string', () => {
    expect(parseRetryAfter('bad-value')).toBeNull()
  })

  it('parses a future HTTP-date and returns approximate ms', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const result = parseRetryAfter(future)
    expect(result).toBeGreaterThan(9000)
    expect(result).toBeLessThanOrEqual(10_000)
  })
})
