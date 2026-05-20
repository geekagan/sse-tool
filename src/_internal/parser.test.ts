import { describe, it, expect } from 'vitest'
import { parseSSEChunk } from './parser'

describe('parseSSEChunk — normal cases', () => {
  it('parses a single data event', () => {
    const { events, remaining } = parseSSEChunk('', 'data: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
    expect(events[0].event).toBe('message')
    expect(events[0].idPresent).toBe(false)
    expect(remaining).toBe('')
  })

  it('defaults event type to "message" when event field is absent', () => {
    const { events } = parseSSEChunk('', 'data: x\n\n')
    expect(events[0].event).toBe('message')
  })

  it('parses named event type', () => {
    const { events } = parseSSEChunk('', 'event: update\ndata: payload\n\n')
    expect(events[0].event).toBe('update')
    expect(events[0].data).toBe('payload')
  })

  it('joins multi-line data with newline', () => {
    const { events } = parseSSEChunk('', 'data: line1\ndata: line2\n\n')
    expect(events[0].data).toBe('line1\nline2')
  })

  it('parses id field — idPresent true, id set', () => {
    const { events } = parseSSEChunk('', 'id: 42\ndata: hello\n\n')
    expect(events[0].idPresent).toBe(true)
    expect(events[0].id).toBe('42')
  })

  it('parses retry field as integer ms', () => {
    const { events } = parseSSEChunk('', 'retry: 3000\ndata: hello\n\n')
    expect(events[0].retry).toBe(3000)
  })

  it('ignores comment lines (starting with :)', () => {
    const { events } = parseSSEChunk('', ': this is a comment\ndata: hello\n\n')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })

  it('does not dispatch if data buffer is empty', () => {
    const { events } = parseSSEChunk('', 'event: ping\n\n')
    expect(events).toHaveLength(0)
  })

  it('parses two events from one chunk', () => {
    const { events } = parseSSEChunk('', 'data: first\n\ndata: second\n\n')
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('first')
    expect(events[1].data).toBe('second')
  })

  it('returns remaining as incomplete text after last event', () => {
    const { events, remaining } = parseSSEChunk('', 'data: done\n\ndata: incomplete')
    expect(events).toHaveLength(1)
    expect(remaining).toBe('data: incomplete')
  })

  it('returns full input as remaining when no complete event', () => {
    const { events, remaining } = parseSSEChunk('', 'data: partial')
    expect(events).toHaveLength(0)
    expect(remaining).toBe('data: partial')
  })

  it('normalizes CRLF to LF', () => {
    const { events } = parseSSEChunk('', 'data: hello\r\n\r\n')
    expect(events[0].data).toBe('hello')
  })

  it('normalizes bare CR to LF', () => {
    const { events } = parseSSEChunk('', 'data: hello\r\r')
    expect(events[0].data).toBe('hello')
  })
})

describe('parseSSEChunk — boundary and edge cases', () => {
  it('parses data with no space after colon (data:hello)', () => {
    const { events } = parseSSEChunk('', 'data:hello\n\n')
    expect(events[0].data).toBe('hello')
  })

  it('treats field-only line (no colon) as empty value — no dispatch', () => {
    const { events } = parseSSEChunk('', 'data\n\n')
    expect(events).toHaveLength(0)
  })

  it('treats data: (colon, empty value) as empty — no dispatch', () => {
    const { events } = parseSSEChunk('', 'data:\n\n')
    expect(events).toHaveLength(0)
  })

  it('id field with empty string — idPresent true, id ""', () => {
    const { events } = parseSSEChunk('', 'id:\ndata: hello\n\n')
    expect(events[0].idPresent).toBe(true)
    expect(events[0].id).toBe('')
  })

  it('event without id field — idPresent false', () => {
    const { events } = parseSSEChunk('', 'data: hello\n\n')
    expect(events[0].idPresent).toBe(false)
    expect(events[0].id).toBe('')
  })

  it('consecutive blank lines dispatch once per accumulated data', () => {
    const { events } = parseSSEChunk('', 'data: first\n\n\ndata: second\n\n')
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('first')
    expect(events[1].data).toBe('second')
  })

  it('ignores invalid retry value (non-digit string)', () => {
    const { events } = parseSSEChunk('', 'retry: abc\ndata: hello\n\n')
    expect(events[0].retry).toBeUndefined()
  })

  it('ignores retry with negative sign (not pure digits)', () => {
    const { events } = parseSSEChunk('', 'retry: -1000\ndata: hello\n\n')
    expect(events[0].retry).toBeUndefined()
  })

  it('handles very long data line (100k chars)', () => {
    const longData = 'x'.repeat(100_000)
    const { events } = parseSSEChunk('', `data: ${longData}\n\n`)
    expect(events[0].data).toBe(longData)
  })

  it('reassembles event split across chunks at field boundary', () => {
    const { remaining: r1 } = parseSSEChunk('', 'da')
    const { events } = parseSSEChunk(r1, 'ta: hello\n\n')
    expect(events[0].data).toBe('hello')
  })

  it('reassembles event split across chunks mid-value', () => {
    const { remaining: r1 } = parseSSEChunk('', 'data: hel')
    const { events } = parseSSEChunk(r1, 'lo\n\n')
    expect(events[0].data).toBe('hello')
  })

  it('reassembles event split across chunks at newline boundary', () => {
    const { remaining: r1 } = parseSSEChunk('', 'data: hello\n')
    const { events } = parseSSEChunk(r1, '\n')
    expect(events[0].data).toBe('hello')
  })

  it('strips only ONE leading space from value', () => {
    const { events } = parseSSEChunk('', 'data:  two spaces\n\n')
    expect(events[0].data).toBe(' two spaces')
  })

  it('preserves comment-like data values', () => {
    const { events } = parseSSEChunk('', 'data: :not a comment\n\n')
    expect(events[0].data).toBe(':not a comment')
  })

  it('handles multiple events split one character at a time', () => {
    const raw = 'data: a\n\ndata: b\n\ndata: c\n\n'
    let buf = ''
    const allEvents: ReturnType<typeof parseSSEChunk>['events'] = []
    for (const char of raw) {
      const { events, remaining } = parseSSEChunk(buf, char)
      allEvents.push(...events)
      buf = remaining
    }
    expect(allEvents).toHaveLength(3)
    expect(allEvents.map(e => e.data)).toEqual(['a', 'b', 'c'])
  })
})
