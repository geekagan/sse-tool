import type { ParsedSSEEvent } from './types'

/**
 * Parses a chunk of SSE stream text, combining with any carry-over buffer.
 * Returns dispatched events and the remaining unparsed text (prepend to next chunk).
 *
 * Decoding (Uint8Array → string) is the caller's responsibility.
 * Complies with https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export function parseSSEChunk(
  buffer: string,
  newChunk: string,
): { events: ParsedSSEEvent[]; remaining: string } {
  // Normalize all line endings to \n
  const raw = (buffer + newChunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = raw.split('\n')

  // The last element is always the text after the last \n (the partial trailing line).
  // If the input ends with \n, this is ''. We carry it into the next chunk.
  // We only process lines[0..n-2] as complete, newline-terminated lines.
  const trailingPartial = lines[lines.length - 1]
  const completeLines = lines.slice(0, -1)

  const events: ParsedSSEEvent[] = []

  let dataLines: string[] = []
  let eventType = 'message'
  let idPresent = false
  let idValue = ''
  let retry: number | undefined
  let lastDispatchIdx = -1

  for (let i = 0; i < completeLines.length; i++) {
    const line = completeLines[i]

    if (line === '') {
      // Blank line: dispatch current event if data buffer is non-empty
      const data = dataLines.join('\n')
      if (data.length > 0) {
        events.push({ data, event: eventType, idPresent, id: idValue, retry })
      }
      // Reset accumulators
      dataLines = []
      eventType = 'message'
      idPresent = false
      idValue = ''
      retry = undefined
      lastDispatchIdx = i
    } else if (line.startsWith(':')) {
      // Comment — silently ignore
    } else {
      const colonIdx = line.indexOf(':')
      let field: string
      let value: string

      if (colonIdx === -1) {
        // No colon: whole line is field name, value is "" (per spec)
        field = line
        value = ''
      } else {
        field = line.slice(0, colonIdx)
        value = line.slice(colonIdx + 1)
        // Strip exactly one leading space (per spec)
        if (value.startsWith(' ')) value = value.slice(1)
      }

      switch (field) {
        case 'data':
          dataLines.push(value)
          break
        case 'event':
          eventType = value || 'message'
          break
        case 'id':
          // id field present (even with empty value) — distinct from absent
          idPresent = true
          idValue = value
          break
        case 'retry':
          // Only accept ASCII digit strings (per spec)
          if (/^\d+$/.test(value)) retry = parseInt(value, 10)
          break
        // Unknown fields are ignored per spec
      }
    }
  }

  // Remaining: undispatched complete lines + trailing partial, rejoined.
  // This always reconstructs the original undispatched text faithfully.
  const undispatchedLines =
    lastDispatchIdx === -1 ? completeLines : completeLines.slice(lastDispatchIdx + 1)

  const remaining = [...undispatchedLines, trailingPartial].join('\n')

  return { events, remaining }
}
