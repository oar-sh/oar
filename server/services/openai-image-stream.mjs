'use strict';

// The server-sent events of a streamed OpenAI image request (`stream: true`
// on /images/generations or /images/edits), read off the fetch Response body
// chunk by chunk.
//
// A data line carries a whole image as base64, several million characters:
// the reader splits lines with indexOf/slice only, keeps the pieces of an
// unfinished line and joins them once per line, and never runs a regexp over
// a line (a long-running relay compiles regexps unoptimised, and `[..]+`
// overflows the regexp stack at 4,194,304 characters). One event may not
// grow past `maxEventChars`, so a stream that never ends a line cannot take
// the relay's memory.
//
// SSE rules as far as OpenAI uses them: lines end in LF or CRLF (a lone CR
// is not a line end here), a blank line ends an event, `data:` lines join
// with LF, a line starting with `:` is a comment, the one space after the
// field's colon goes, `id` and `retry` are ignored. At the end of the body an
// unfinished last event still counts.

export const SSE_MAX_EVENT_CHARS = 64 * 1024 * 1024;
export const SSE_EVENT_TOO_LARGE_CODE = 'SSE_EVENT_TOO_LARGE';

function eventTooLarge(maxEventChars) {
  const error = new Error(`A stream event grew past ${maxEventChars} characters`);
  error.code = SSE_EVENT_TOO_LARGE_CODE;
  return error;
}

/**
 * A push parser: `push(text)` with each decoded chunk, `end()` once the body
 * ended; `onEvent({ event, data })` gets every event that has data (`event`
 * is 'message' when the stream names none). Throws SSE_EVENT_TOO_LARGE_CODE.
 */
export function createSseParser({ onEvent, maxEventChars = SSE_MAX_EVENT_CHARS } = {}) {
  const limit = Math.max(1, Number(maxEventChars) || SSE_MAX_EVENT_CHARS);
  let pieces = [];
  let pendingChars = 0;
  let eventName = '';
  let dataLines = [];
  let dataChars = 0;

  const dispatch = () => {
    if (dataLines.length) onEvent?.({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = '';
    dataLines = [];
    dataChars = 0;
  };

  const processLine = (line) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58) return; // ':' comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
      dataChars += value.length + 1;
      if (dataChars > limit) throw eventTooLarge(limit);
    } else if (field === 'event') {
      eventName = value;
    }
  };

  const takeLine = (tail) => {
    let line = tail;
    if (pieces.length) {
      pieces.push(tail);
      line = pieces.join('');
      pieces = [];
      pendingChars = 0;
    }
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    processLine(line);
  };

  return {
    push(text) {
      const chunk = String(text ?? '');
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start);
        if (newline < 0) {
          const rest = chunk.slice(start);
          pieces.push(rest);
          pendingChars += rest.length;
          if (pendingChars + dataChars > limit) throw eventTooLarge(limit);
          return;
        }
        takeLine(chunk.slice(start, newline));
        start = newline + 1;
      }
    },
    end() {
      if (pieces.length) takeLine('');
      dispatch();
    },
  };
}

/**
 * The events of a body (a web ReadableStream, or any async iterable of
 * Uint8Array or string chunks), in order. A body that breaks off throws its
 * error from the iteration; a UTF-8 sequence split across chunks is kept
 * whole.
 */
export async function* readSseEvents(body, { maxEventChars = SSE_MAX_EVENT_CHARS } = {}) {
  const ready = [];
  const parser = createSseParser({ onEvent: (event) => ready.push(event), maxEventChars });
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of body) {
    parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    for (let index = 0; index < ready.length; index += 1) yield ready[index];
    ready.length = 0;
  }
  parser.push(decoder.decode());
  parser.end();
  for (const event of ready) yield event;
}

/** True when a fetch Response is a server-sent event stream. */
export function isEventStreamResponse(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '').trim().toLowerCase();
  return contentType.startsWith('text/event-stream') && Boolean(response?.body);
}

/**
 * What one event of an image stream is, for generations
 * (`image_generation.*`) and edits (`image_edit.*`) alike, by the payload's
 * `type` (else the SSE event name):
 * - `{ type: 'partial', name, payload }`: `.partial_image` (b64_json,
 *   partial_image_index, size, quality, output_format, background);
 * - `{ type: 'completed', name, payload }`: `.completed` (b64_json, usage, …);
 * - `{ type: 'error', name, error }`: an `error` event, or a payload with an
 *   `error` object (`error` is `{ message, type, code }` as far as given);
 * - `{ type: 'invalid', name }`: data that is not a JSON object;
 * - `{ type: 'ignored', name }`: anything else.
 */
export function interpretOpenAIImageStreamEvent({ event = '', data = '' } = {}) {
  const sseName = String(event || '');
  const text = String(data ?? '');
  if (text === '[DONE]') return { type: 'ignored', name: sseName };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { type: 'invalid', name: sseName };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { type: 'invalid', name: sseName };
  const name = String(payload.type || sseName || '');
  if (name.endsWith('.partial_image')) return { type: 'partial', name, payload };
  if (name.endsWith('.completed')) return { type: 'completed', name, payload };
  if (name === 'error' || name.endsWith('.failed') || (payload.error && typeof payload.error === 'object')) {
    const error = payload.error && typeof payload.error === 'object' ? payload.error : payload;
    return {
      type: 'error',
      name,
      error: {
        message: String(error.message || '').slice(0, 240),
        type: String(error.type || '').slice(0, 80),
        code: String(error.code || '').slice(0, 80),
      },
    };
  }
  return { type: 'ignored', name };
}
