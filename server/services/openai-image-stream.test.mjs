// The line reader of a streamed OpenAI image request: SSE fields assembled
// per event whatever the chunk borders, both event families told apart, an
// error event, a cap per event, and a data line of several million base64
// characters read with V8's regexp optimisation off (the state of a relay
// with some uptime), where a regexp over the line would overflow.
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SSE_EVENT_TOO_LARGE_CODE,
  createSseParser,
  interpretOpenAIImageStreamEvent,
  isEventStreamResponse,
  readSseEvents,
} from './openai-image-stream.mjs';

const FIXTURE = [
  ': a comment the reader skips\r\n',
  'event: image_generation.partial_image\r\n',
  'data: {"type":"image_generation.partial_image","b64_json":"QUJD","partial_image_index":0,"size":"1024x1024","quality":"low","output_format":"png","background":"opaque","created_at":1}\r\n',
  '\r\n',
  'event: image_edit.partial_image\n',
  'data: {"type":"image_edit.partial_image",\n',
  'data: "b64_json":"REVG","partial_image_index":1}\n',
  '\n',
  'id: 7\nretry: 1000\n',
  'event: image_generation.completed\n',
  'data:{"type":"image_generation.completed","b64_json":"R0hJ","usage":{"input_tokens":5,"output_tokens":60,"total_tokens":65}}\n',
  '\n',
  'event: error\n',
  'data: {"type":"error","error":{"message":"Something broke","type":"server_error","code":"server_error"}}\n',
  '\n',
].join('');

function* chunksOf(text, sizes) {
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const size = sizes[index % sizes.length];
    yield text.slice(start, start + size);
    start += size;
    index += 1;
  }
}

async function collect(body, options) {
  const events = [];
  for await (const event of readSseEvents(body, options)) events.push(event);
  return events;
}

function expectFixtureEvents(events) {
  assert.deepEqual(events.map((event) => event.event), [
    'image_generation.partial_image',
    'image_edit.partial_image',
    'image_generation.completed',
    'error',
  ]);
  const kinds = events.map((event) => interpretOpenAIImageStreamEvent(event));
  assert.deepEqual(kinds.map((entry) => entry.type), ['partial', 'partial', 'completed', 'error']);
  assert.equal(kinds[0].payload.b64_json, 'QUJD');
  assert.equal(kinds[0].payload.partial_image_index, 0);
  // Two data lines joined with a line feed, still one JSON object.
  assert.equal(events[1].data, '{"type":"image_edit.partial_image",\n"b64_json":"REVG","partial_image_index":1}');
  assert.equal(kinds[1].name, 'image_edit.partial_image');
  assert.equal(kinds[1].payload.partial_image_index, 1);
  assert.deepEqual(kinds[2].payload.usage, { input_tokens: 5, output_tokens: 60, total_tokens: 65 });
  assert.deepEqual(kinds[3].error, { message: 'Something broke', type: 'server_error', code: 'server_error' });
}

test('the fixture in one chunk', async () => {
  expectFixtureEvents(await collect([FIXTURE]));
});

test('the fixture cut at every awkward place: inside data:, inside CRLF, between events, one character at a time', async () => {
  // Every split point once: two chunks each.
  for (let at = 1; at < FIXTURE.length; at += 1) {
    expectFixtureEvents(await collect([FIXTURE.slice(0, at), FIXTURE.slice(at)]));
  }
  expectFixtureEvents(await collect(chunksOf(FIXTURE, [1])));
  expectFixtureEvents(await collect(chunksOf(FIXTURE, [3, 7, 2, 11])));
});

test('bytes: a UTF-8 character split across chunks stays whole, and a web ReadableStream reads too', async () => {
  const text = 'data: {"type":"image_generation.partial_image","note":"Grüße ✓"}\n\n';
  const bytes = new TextEncoder().encode(text);
  const cut = bytes.indexOf(0xc3) + 1; // inside "ü"
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  const events = await collect(stream);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message');
  assert.equal(interpretOpenAIImageStreamEvent(events[0]).payload.note, 'Grüße ✓');
});

test('a last event without its blank line still counts; an event without data does not', async () => {
  const events = await collect(['event: lonely\n\n', 'data: {"type":"image_edit.completed","b64_json":"QQ=="}']);
  assert.equal(events.length, 1);
  assert.equal(interpretOpenAIImageStreamEvent(events[0]).type, 'completed');
});

test('a body that breaks off throws from the iteration after the events read so far', async () => {
  async function* broken() {
    yield 'data: {"type":"image_generation.partial_image","b64_json":"QUJD"}\n\n';
    yield 'data: {"type":"image_gen';
    throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } });
  }
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of readSseEvents(broken())) seen.push(event);
  }, /terminated/);
  assert.equal(seen.length, 1);
});

test('an event past the cap stops the reader, with or without line ends', () => {
  const noEnd = createSseParser({ onEvent: () => {}, maxEventChars: 100 });
  assert.throws(() => noEnd.push(`data: ${'A'.repeat(200)}`), (error) => error.code === SSE_EVENT_TOO_LARGE_CODE);
  const manyLines = createSseParser({ onEvent: () => {}, maxEventChars: 100 });
  assert.throws(() => {
    for (let index = 0; index < 20; index += 1) manyLines.push(`data: ${'A'.repeat(10)}\n`);
  }, (error) => error.code === SSE_EVENT_TOO_LARGE_CODE);
  // Under the cap per event, any number of events.
  const fine = [];
  const ok = createSseParser({ onEvent: (event) => fine.push(event), maxEventChars: 100 });
  for (let index = 0; index < 20; index += 1) ok.push(`data: ${'A'.repeat(50)}\n\n`);
  assert.equal(fine.length, 20);
});

test('interpretOpenAIImageStreamEvent: names by payload type, then the SSE name; junk is invalid or ignored', () => {
  assert.equal(interpretOpenAIImageStreamEvent({ event: 'image_edit.completed', data: '{"b64_json":"QQ=="}' }).type, 'completed');
  assert.equal(interpretOpenAIImageStreamEvent({ event: 'message', data: '{"type":"image_generation.partial_image"}' }).type, 'partial');
  assert.equal(interpretOpenAIImageStreamEvent({ event: 'message', data: '{"type":"response.in_progress"}' }).type, 'ignored');
  assert.equal(interpretOpenAIImageStreamEvent({ event: 'message', data: '[DONE]' }).type, 'ignored');
  assert.equal(interpretOpenAIImageStreamEvent({ event: 'image_generation.completed', data: '{"b64' }).type, 'invalid');
  assert.equal(interpretOpenAIImageStreamEvent({ event: 'x', data: '[1,2]' }).type, 'invalid');
  const bare = interpretOpenAIImageStreamEvent({ event: 'message', data: '{"error":{"message":"Your request was rejected","code":"moderation_blocked"}}' });
  assert.equal(bare.type, 'error');
  assert.equal(bare.error.code, 'moderation_blocked');
});

test('isEventStreamResponse reads the content type and wants a body', () => {
  const headers = (type) => ({ get: (name) => (name === 'content-type' ? type : null) });
  assert.equal(isEventStreamResponse({ headers: headers('text/event-stream; charset=utf-8'), body: {} }), true);
  assert.equal(isEventStreamResponse({ headers: headers('application/json'), body: {} }), false);
  assert.equal(isEventStreamResponse({ headers: headers('text/event-stream'), body: null }), false);
  assert.equal(isEventStreamResponse({ text: async () => '' }), false);
});

test('with V8 regexp optimisation off, a partial and a completed event of 9 MB base64 each are read whole', () => {
  // A file URL, not a path: the ESM loader takes a Windows path such as
  // d:\... for a URL with the scheme "d:" and refuses it.
  const moduleUrl = new URL('./openai-image-stream.mjs', import.meta.url).href;
  const script = `
    import { readSseEvents, interpretOpenAIImageStreamEvent } from ${JSON.stringify(moduleUrl)};
    const big = 'A'.repeat(9_000_000);
    const text = 'event: image_generation.partial_image\\r\\ndata: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"' + big + '"}\\r\\n\\r\\n'
      + 'event: image_generation.completed\\ndata: {"type":"image_generation.completed","b64_json":"' + big + '","usage":{"total_tokens":9}}\\n\\n';
    const bytes = new TextEncoder().encode(text);
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 65_536) yield bytes.subarray(at, at + 65_536);
    }
    const out = [];
    for await (const event of readSseEvents(chunks())) {
      const seen = interpretOpenAIImageStreamEvent(event);
      out.push([seen.type, seen.payload.b64_json.length]);
    }
    console.log('RESULT ' + JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['--no-regexp-optimization', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  // A child that could not start, timed out, or failed its import must fail
  // this test with its own output, never pass without running the code.
  assert.equal(result.error, undefined, `child did not run: ${result.error?.message}`);
  assert.equal(result.status, 0, `child exited ${result.status} (signal ${result.signal})\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `child printed no result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(JSON.parse(line.slice('RESULT '.length)), [['partial', 9_000_000], ['completed', 9_000_000]]);
});
