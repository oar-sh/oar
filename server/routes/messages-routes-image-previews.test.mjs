// Partial previews of an image turn: a gpt-image request is streamed, each
// partial is written beside the turn's final images and announced to the
// owner's clients, and nothing of it outlives the turn. A retry drops the
// first try's partials; a stream that broke off after OpenAI started counts
// as "may have been billed", like a timeout. dall-e does not stream, and a
// reply that is no event stream is read as JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { registerMessagesRoutes } from './messages-routes.mjs';
import { OPENAI_IMAGE_USAGE_EVENT } from '../../shared/openai-image-spend.mjs';
import {
  FAKE_OPENAI_BASE_URL,
  captureRoutes,
  executeImageOperation,
  fetchFailure,
  invokeRoute,
  makeImageOperationDeps,
  makeRouteDeps,
  openAIImageSse,
  recordingIo,
  recordingStmts,
  stubImageFetch,
} from './messages-routes-test-harness.mjs';

const GENERATE = '/api/openai/images/generate';
const PARTIAL_ROUTE = '/api/generated-image/:conversationId/:messageId/partials/:fileName';
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
// A second PNG (the 1x1 above with another pixel), so partial and final differ.
const OTHER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const USAGE = { input_tokens: 12, output_tokens: 272, total_tokens: 284, input_tokens_details: { text_tokens: 12, image_tokens: 0 } };
const BILLED_MAYBE = 'the request may have been billed; retry the message.';
const REPO_ROOT = process.cwd();

const twoPartialsAndFinal = (extra = {}) => ({
  status: 200,
  sse: openAIImageSse([
    { partial: 0, b64: OTHER_PNG_BASE64 },
    { partial: 1, b64: OTHER_PNG_BASE64 },
    { completed: true, b64: ONE_PIXEL_PNG_BASE64, usage: USAGE },
  ], extra),
});
const brokenAfterOnePartial = () => ({
  status: 200,
  sse: openAIImageSse([{ partial: 0, b64: OTHER_PNG_BASE64 }]),
  breakWith: Object.assign(new TypeError('terminated'), { cause: fetchFailure('ECONNRESET').cause }),
});

let counter = 0;

/**
 * One relay around the generate route and /api/response: session-state
 * root under .test-artifacts, conversation conv-1 of SDK session sdk-1, the
 * queue row of `messageId` processing, every socket event recorded.
 */
function makeRelay(t, { config = {}, leftoverMs = 60_000 } = {}) {
  counter += 1;
  const messageId = `q-preview-${counter}`;
  const root = path.join(REPO_ROOT, '.test-artifacts', `image-previews-${process.pid}-${counter}`);
  fs.rmSync(root, { recursive: true, force: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let queueRow = { id: messageId, conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-image-2', retry_count: 0 };
  const { events, io } = recordingIo({ except: [OPENAI_IMAGE_USAGE_EVENT] });
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => queueRow },
    getRuntimeSessionByConversation: { get: () => ({ provider_type: 'openai' }) },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'sdk-1' }) },
  });
  let uuidCounter = 0;
  const deps = makeRouteDeps({
    ts: () => '00:00:00.000',
    uuidv4: () => `reply-${counter}-${++uuidCounter}`,
    io,
    stmts,
    db: {
      prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    config,
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    openAIImagePreviewLeftoverMs: leftoverMs,
    MAX_UPLOAD_ATTACHMENTS: 6,
    getOpenAIProviderSettings: () => ({
      configured: true,
      enabled: true,
      apiKey: 'sk-test-key',
      baseUrl: FAKE_OPENAI_BASE_URL,
      model: 'gpt-image-2',
      models: [],
    }),
    resolveSessionStateRoot: () => root,
    readSessionTranscriptMessages: () => [],
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    relayThoughtsForResponse: () => [],
    relayThoughtsForQueueMessage: () => [],
    sanitizeActivityText: (value) => String(value || ''),
    hydrateAttachment: (attachment) => attachment,
    parseAttachments: () => [],
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    runtimeState: {},
  });
  const handlers = new Map();
  const routes = captureRoutes(deps, (app, routeDeps) => registerMessagesRoutes({
    ...app,
    get: (routePath, ...list) => {
      handlers.set(`GET ${routePath}`, list);
      app.get(routePath, ...list);
    },
  }, routeDeps));
  const conversationDir = path.join(root, 'sdk-1', 'generated-images', 'conv-1');
  return {
    messageId,
    root,
    deps,
    routes,
    handlers,
    events,
    calls,
    conversationDir,
    partialsDir: path.join(conversationDir, messageId, 'partials'),
    setQueueRow: (row) => { queueRow = row ? { ...queueRow, ...row } : null; },
    generate: (overrides = {}) => invokeRoute(routes, 'POST', GENERATE, {
      body: { messageId, conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a paper boat on a pond', size: '1024x1024', quality: 'low', ...overrides },
    }),
    respond: (body) => invokeRoute(routes, 'POST', '/api/response', { body: { messageId, conversationId: 'conv-1', ...body } }),
    previewEvents: () => events.filter((entry) => entry.event.startsWith('image_')),
  };
}

/** GET a partial through the route with a response that takes the bytes. */
async function getPartial(relay, params) {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve) => res.on('end', resolve));
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; res.end(); return res; };
  const handler = relay.routes.get(`GET ${PARTIAL_ROUTE}`);
  await handler({ params: { conversationId: 'conv-1', messageId: relay.messageId, ...params }, headers: {}, query: {} }, res);
  await ended;
  return { status: res.statusCode, body: res.body, headers: res.headers, bytes: Buffer.concat(chunks) };
}

const partialUrl = (relay, fileName) => `/api/generated-image/conv-1/${relay.messageId}/partials/${fileName}`;

test('a streamed generation: started, two previews written beside the final, the final from the completed event; the reply stored, the previews go', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, { openai: [twoPartialsAndFinal()] });
  // A turn the relay never finished (it went down): its partials are swept.
  const stale = path.join(relay.conversationDir, 'q-crashed', 'partials');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'img-01-try1-p0.png'), Buffer.from(OTHER_PNG_BASE64, 'base64'));

  const { status, body } = await relay.generate();
  assert.equal(status, 200);
  const sent = JSON.parse(calls.openai[0].init.body);
  assert.equal(sent.stream, true);
  assert.equal(sent.partial_images, 2);
  assert.equal(body.generatedImages.length, 1);
  assert.equal(body.generatedImages[0].data, ONE_PIXEL_PNG_BASE64);
  // The completed event's usage is the request's.
  assert.deepEqual(body.usage, USAGE);

  const [started, first, second, ...rest] = relay.previewEvents();
  assert.equal(rest.length, 0);
  assert.equal(started.event, 'image_started');
  assert.deepEqual(Object.keys(started.payload).sort(), ['attempt', 'conversationId', 'count', 'messageId', 'model', 'quality', 'size', 'startedAt']);
  assert.deepEqual({ ...started.payload, startedAt: 'x' }, {
    conversationId: 'conv-1', messageId: relay.messageId, attempt: 1, size: '1024x1024', quality: 'low', count: 1, model: 'gpt-image-2', startedAt: 'x',
  });
  assert.ok(Number.isFinite(Date.parse(started.payload.startedAt)));
  for (const [event, index] of [[first, 0], [second, 1]]) {
    assert.equal(event.event, 'image_preview');
    assert.deepEqual(event.payload, {
      conversationId: 'conv-1',
      messageId: relay.messageId,
      attempt: 1,
      imageIndex: 0,
      partialIndex: index,
      contentUrl: partialUrl(relay, `img-01-try1-p${index}.png`),
      mime: 'image/png',
      size: '1024x1024',
      quality: 'low',
      model: 'gpt-image-2',
      startedAt: started.payload.startedAt,
    });
    assert.equal(fs.existsSync(path.join(relay.partialsDir, `img-01-try1-p${index}.png`)), true);
  }

  // The owner's client loads a partial.
  const served = await getPartial(relay, { fileName: 'img-01-try1-p1.png' });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.bytes.toString('base64'), OTHER_PNG_BASE64);

  // The reply is stored: the final image in the reply's folder, then the
  // previews go, files and folder, and the crashed turn's leftovers too.
  const reply = await relay.respond({ text: '', model: 'gpt-image-2', generatedImages: body.generatedImages, imageUsage: body.usage });
  assert.equal(reply.status, 200);
  const names = relay.events.map((entry) => entry.event);
  const reset = relay.events[relay.events.length - 1];
  assert.equal(reset.event, 'image_preview_reset');
  assert.deepEqual(reset.payload, { conversationId: 'conv-1', messageId: relay.messageId, attempt: 1, reason: 'done' });
  assert.ok(names.indexOf('assistant_message') < names.indexOf('image_preview_reset'));
  assert.equal(fs.existsSync(path.join(relay.conversationDir, relay.messageId)), false);
  assert.equal(fs.existsSync(path.join(relay.conversationDir, 'q-crashed')), false);
  const finals = fs.readdirSync(relay.conversationDir, { recursive: true }).map(String);
  assert.deepEqual(finals.filter((entry) => entry.endsWith('.png')).map((entry) => path.basename(entry)), ['img-01.png']);
  // Gone with the turn.
  assert.equal((await getPartial(relay, { fileName: 'img-01-try1-p1.png' })).status, 404);
});

test('the partial route serves only a file the running turn wrote, of its own conversation', async (t) => {
  const relay = makeRelay(t);
  stubImageFetch(t, { openai: [twoPartialsAndFinal()] });
  await relay.generate();
  // A file beside the partials that the turn did not write.
  fs.writeFileSync(path.join(relay.partialsDir, 'img-09-try1-p0.png'), Buffer.from(OTHER_PNG_BASE64, 'base64'));

  assert.equal((await getPartial(relay, { fileName: 'img-01-try1-p0.png' })).status, 200);
  for (const params of [
    { fileName: 'img-09-try1-p0.png' },
    { fileName: '../partials/img-01-try1-p0.png' },
    { fileName: '..%2Fimg-01-try1-p0.png' },
    { fileName: 'content' },
    { conversationId: 'conv-2', fileName: 'img-01-try1-p0.png' },
    { messageId: 'q-other', fileName: 'img-01-try1-p0.png' },
  ]) {
    const refused = await getPartial(relay, params);
    assert.equal(refused.status, 404, JSON.stringify(params));
    assert.equal(refused.bytes.length, 0);
  }
  // Behind the owner's auth, like the final images; share views read over
  // their own token routes, which serve message attachments only.
  const list = relay.handlers.get(`GET ${PARTIAL_ROUTE}`);
  assert.equal(list[0], relay.deps.auth);
  // The events go to the owner's sockets only (io.emit: a share view has none).
  assert.ok(relay.previewEvents().length >= 3);
});

test('an edit streams too, as image_edit events', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, { openai: [twoPartialsAndFinal({ family: 'image_edit' })] });
  const { status, body } = await relay.generate({
    attachments: [{ name: 'base.png', type: 'image/png', dataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}` }],
  });
  assert.equal(status, 200);
  assert.equal(calls.openai[0].path, '/images/edits');
  assert.equal(calls.openai[0].init.body.get('stream'), 'true');
  assert.equal(body.generatedImages.length, 1);
  assert.deepEqual(relay.previewEvents().map((entry) => entry.event), ['image_started', 'image_preview', 'image_preview']);
});

test('a stream that breaks off after a partial, then a good try: reset "retry", the first try\'s partials gone, and the note', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, { openai: [brokenAfterOnePartial(), twoPartialsAndFinal()] });
  const { status, body } = await relay.generate();

  assert.equal(status, 200);
  assert.equal(calls.openai.length, 2);
  assert.equal(calls.openai[0].init.headers['Idempotency-Key'], calls.openai[1].init.headers['Idempotency-Key']);
  assert.equal(body.note, 'OpenAI\'s image stream broke off on the first try; it was sent once more and the first try may have been billed as well.');
  assert.deepEqual(relay.previewEvents().map((entry) => [entry.event, entry.payload.attempt, entry.payload.reason || entry.payload.partialIndex]), [
    ['image_started', 1, undefined],
    ['image_preview', 1, 0],
    ['image_preview_reset', 1, 'retry'],
    ['image_started', 2, undefined],
    ['image_preview', 2, 0],
    ['image_preview', 2, 1],
  ]);
  // One start time for the whole turn, the elapsed timer's.
  const starts = relay.previewEvents().filter((entry) => entry.event === 'image_started').map((entry) => entry.payload.startedAt);
  assert.equal(starts[0], starts[1]);
  assert.deepEqual(fs.readdirSync(relay.partialsDir).sort(), ['img-01-try2-p0.png', 'img-01-try2-p1.png']);
  assert.equal((await getPartial(relay, { fileName: 'img-01-try1-p0.png' })).status, 404);

  // The reply carries the note, and only the final image.
  const reply = await relay.respond({ text: '', model: 'gpt-image-2', generatedImages: body.generatedImages, imageNote: body.note });
  assert.equal(reply.status, 200);
  const insert = relay.calls.find((call) => call.stmt === 'insertMsg');
  // Both tries were booked: the broken one at its estimate.
  assert.match(insert.args[3], /^1 image · 1x1 · gpt-image-2 · ~USD \d+\.\d+ \(estimate\)\. Note: OpenAI's image stream broke off on the first try;/);
  const attachments = JSON.parse(insert.args[6]);
  assert.equal(attachments.length, 1);
  assert.doesNotMatch(JSON.stringify(attachments), /partials/);
  assert.equal(relay.previewEvents().at(-1).payload.reason, 'done');
  assert.equal(fs.existsSync(relay.partialsDir), false);
});

test('broken twice after partials: files gone at once, the note says it may have been billed, reset "failed" once the note is stored', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, { openai: [brokenAfterOnePartial()] });
  const { status, body } = await relay.generate();

  assert.equal(calls.openai.length, 2);
  assert.equal(status, 502);
  assert.equal(body.code, 'IMAGE_STREAM_BROKEN');
  assert.equal(body.outcome, 'uncertain');
  assert.equal(body.error, `OpenAI's image stream broke off before the image was complete (tried twice); ${BILLED_MAYBE}`);
  assert.deepEqual(fs.existsSync(relay.partialsDir) ? fs.readdirSync(relay.partialsDir) : [], []);

  // The worker publishes the note.
  const failed = await relay.respond({
    text: body.error,
    terminalError: { kind: 'openai-image-failed', code: 'image-stream-broken', stableCode: 'image-stream-broken', message: body.error },
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.terminal, true);
  const reset = relay.previewEvents().at(-1);
  assert.deepEqual(reset.payload, { conversationId: 'conv-1', messageId: relay.messageId, attempt: 2, reason: 'failed' });
  assert.equal(fs.existsSync(path.join(relay.conversationDir, relay.messageId)), false);
});

test('a timeout in the middle of the stream is a timeout, retried once', async (t) => {
  const relay = makeRelay(t, { config: { openaiImageGenerateTimeoutMs: 40 } });
  const calls = stubImageFetch(t, { openai: [{ status: 200, sse: openAIImageSse([{ partial: 0, b64: OTHER_PNG_BASE64 }]), hangAfter: true }] });
  const { status, body } = await relay.generate();
  assert.equal(calls.openai.length, 2);
  assert.equal(status, 504);
  assert.equal(body.error, `OpenAI did not answer within 40 ms (tried twice); ${BILLED_MAYBE}`);
});

test('an error event: a refusal is not tried again, a server error is', async (t) => {
  const relay = makeRelay(t);
  const refusal = { status: 200, sse: openAIImageSse([{ error: { message: 'Your request was rejected by the safety system.', type: 'invalid_request_error', code: 'moderation_blocked' } }]) };
  const calls = stubImageFetch(t, { openai: [refusal] });
  const refused = await relay.generate();
  assert.equal(calls.openai.length, 1);
  assert.equal(refused.body.code, 'IMAGE_PROVIDER_REJECTED');
  assert.match(refused.body.error, /rejected by the safety system/);

  const other = makeRelay(t);
  const serverError = { status: 200, sse: openAIImageSse([{ partial: 0, b64: OTHER_PNG_BASE64 }, { error: { message: 'boom', type: 'server_error' } }]) };
  const again = stubImageFetch(t, { openai: [serverError, twoPartialsAndFinal()] });
  const ok = await other.generate();
  assert.equal(again.openai.length, 2);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.note, 'OpenAI answered the first try with a server error; it was sent once more and the first try may have been billed as well.');
});

test('a stream that ends without its image is retried; a count of 2 collects both completed images in order', async (t) => {
  const relay = makeRelay(t);
  const empty = { status: 200, sse: openAIImageSse([{ partial: 0, b64: OTHER_PNG_BASE64 }]) };
  const twoImages = {
    status: 200,
    sse: openAIImageSse([
      { partial: 0, b64: OTHER_PNG_BASE64 },
      { completed: true, b64: ONE_PIXEL_PNG_BASE64 },
      { partial: 0, b64: OTHER_PNG_BASE64 },
      { completed: true, b64: OTHER_PNG_BASE64, usage: USAGE },
    ]),
  };
  const calls = stubImageFetch(t, { openai: [empty, twoImages] });
  const { status, body } = await relay.generate({ n: 2 });
  assert.equal(calls.openai.length, 2);
  assert.equal(JSON.parse(calls.openai[1].init.body).n, 2);
  assert.equal(status, 200);
  assert.deepEqual(body.generatedImages.map((image) => image.data), [ONE_PIXEL_PNG_BASE64, OTHER_PNG_BASE64]);
  assert.deepEqual(body.usage, USAGE);
  assert.match(body.note, /^OpenAI's image stream broke off on the first try;/);
  const previews = relay.previewEvents().filter((entry) => entry.event === 'image_preview' && entry.payload.attempt === 2);
  assert.deepEqual(previews.map((entry) => [entry.payload.imageIndex, path.basename(entry.payload.contentUrl)]), [
    [0, 'img-01-try2-p0.png'],
    [1, 'img-02-try2-p0.png'],
  ]);
  assert.equal(relay.previewEvents().find((entry) => entry.event === 'image_started').payload.count, 2);
});

test('dall-e does not stream: no stream fields, no previews, the placeholder still starts and ends', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, { openai: [{ status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] } }] });
  const { status, body } = await relay.generate({ model: 'dall-e-3', size: '1024x1024', quality: 'standard' });
  assert.equal(status, 200);
  const sent = JSON.parse(calls.openai[0].init.body);
  assert.equal('stream' in sent, false);
  assert.equal('partial_images' in sent, false);
  assert.deepEqual(relay.previewEvents().map((entry) => entry.event), ['image_started']);
  await relay.respond({ text: '', model: 'dall-e-3', generatedImages: body.generatedImages });
  assert.deepEqual(relay.previewEvents().map((entry) => entry.event), ['image_started', 'image_preview_reset']);
});

test('a gpt-image reply that is no event stream is read as JSON; a 400 about streaming is sent again without it', async (t) => {
  const relay = makeRelay(t);
  stubImageFetch(t, { openai: [{ status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }], usage: USAGE } }] });
  const plain = await relay.generate();
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.body.usage, USAGE);
  assert.deepEqual(relay.previewEvents().map((entry) => entry.event), ['image_started']);

  const other = makeRelay(t);
  const calls = stubImageFetch(t, {
    openai: [
      { status: 400, json: { error: { message: "Unknown parameter: 'partial_images'." } } },
      { status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] } },
    ],
  });
  const resent = await other.generate();
  assert.equal(resent.status, 200);
  assert.equal(calls.openai.length, 2);
  assert.equal(JSON.parse(calls.openai[0].init.body).stream, true);
  assert.equal('stream' in JSON.parse(calls.openai[1].init.body), false);
  // Nothing went to OpenAI's work: no note.
  assert.equal('note' in resent.body, false);
});

test('an image operation streams the same way, and a turn whose end never comes is ended by the timer', async (t) => {
  const root = path.join(REPO_ROOT, '.test-artifacts', `image-previews-op-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = stubImageFetch(t, { openai: [twoPartialsAndFinal()] });
  const { events, io } = recordingIo({ except: [OPENAI_IMAGE_USAGE_EVENT] });
  const { deps } = makeImageOperationDeps();
  Object.assign(deps, { io, resolveSessionStateRoot: () => root, openAIImagePreviewLeftoverMs: 30 });
  const { status, body } = await executeImageOperation(deps);
  assert.equal(status, 200);
  assert.deepEqual(body.usage, USAGE);
  const response = calls.self.find((call) => call.route === '/api/response');
  assert.equal(response.body.generatedImages.length, 1);
  // The usage is booked where the request ran, not by /api/response.
  assert.equal('imageUsage' in response.body, false);
  assert.deepEqual(events.map((entry) => [entry.event, entry.payload.messageId]), [
    ['image_started', 'q-1'],
    ['image_preview', 'q-1'],
    ['image_preview', 'q-1'],
  ]);
  const partialsDir = path.join(root, 'conv-1', 'generated-images', 'conv-1', 'q-1', 'partials');
  assert.equal(fs.readdirSync(partialsDir).length, 2);

  // The self-call to /api/response was a stub here: nobody ends the turn.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(events.at(-1), { event: 'image_preview_reset', payload: { conversationId: 'conv-1', messageId: 'q-1', attempt: 1, reason: 'done' } });
  assert.equal(fs.existsSync(path.join(root, 'conv-1', 'generated-images', 'conv-1', 'q-1')), false);
});

test('the resend without stream fields is one of the two requests: a resend that times out is final', async (t) => {
  const relay = makeRelay(t, { config: { openaiImageGenerateTimeoutMs: 40 } });
  const calls = stubImageFetch(t, {
    openai: [
      { status: 400, json: { error: { message: "Unknown parameter: 'stream'." } } },
      { status: 200, hang: true },
      { status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] } },
    ],
  });
  const { status, body } = await relay.generate();
  assert.equal(calls.openai.length, 2, 'never a third request');
  assert.equal(status, 504);
  assert.equal(body.error, `OpenAI did not answer within 40 ms (sent twice, once without previews); ${BILLED_MAYBE}`);
  // The resend's body differs: its own Idempotency-Key.
  const keys = calls.openai.map((call) => call.init.headers['Idempotency-Key']);
  assert.equal(keys[0], `oar-image-${relay.messageId}`);
  assert.equal(keys[1], `oar-image-${relay.messageId}-nostream`);
});

test('only a 400 naming the stream fields is resent: a 429 about streaming requests is final', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, {
    openai: [
      { status: 429, json: { error: { message: 'Rate limit reached for streaming requests.' } } },
      { status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] } },
    ],
  });
  const { status, body } = await relay.generate();
  assert.equal(calls.openai.length, 1);
  assert.equal(status, 429);
  assert.match(body.error, /^OpenAI refused the image request \(429\): Rate limit reached for streaming requests\./);
});

test('a stream that breaks off after its completed image keeps that image: one request', async (t) => {
  const relay = makeRelay(t);
  const calls = stubImageFetch(t, {
    openai: [{
      ...twoPartialsAndFinal(),
      breakWith: Object.assign(new TypeError('terminated'), { cause: fetchFailure('ECONNRESET').cause }),
    }],
  });
  const { status, body } = await relay.generate();
  assert.equal(calls.openai.length, 1);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.generatedImages.length, 1);
  assert.deepEqual(body.usage, USAGE);
  assert.equal('note' in body, false);

  // A timeout after the completed image: the same.
  const late = makeRelay(t, { config: { openaiImageGenerateTimeoutMs: 40 } });
  const lateCalls = stubImageFetch(t, { openai: [{ ...twoPartialsAndFinal(), hangAfter: true }] });
  const kept = await late.generate();
  assert.equal(lateCalls.openai.length, 1);
  assert.equal(kept.status, 200);
  assert.equal(kept.body.generatedImages.length, 1);

  // With a count of 2, one completed image is not enough: tried again.
  const two = makeRelay(t);
  const twoCalls = stubImageFetch(t, {
    openai: [
      { ...twoPartialsAndFinal(), breakWith: Object.assign(new TypeError('terminated'), { cause: fetchFailure('ECONNRESET').cause }) },
      {
        status: 200,
        sse: openAIImageSse([
          { completed: true, b64: ONE_PIXEL_PNG_BASE64, usage: USAGE },
          { completed: true, b64: OTHER_PNG_BASE64, usage: USAGE },
        ]),
      },
    ],
  });
  const both = await two.generate({ n: 2 });
  assert.equal(twoCalls.openai.length, 2);
  assert.equal(both.status, 200);
  assert.equal(both.body.generatedImages.length, 2);
});

test('partials and completed events past what the turn asked for are dropped, no file written', async (t) => {
  const relay = makeRelay(t);
  const events = [];
  for (let index = 0; index < 40; index += 1) events.push({ partial: index, b64: OTHER_PNG_BASE64 });
  for (let index = 0; index < 12; index += 1) events.push({ completed: true, b64: ONE_PIXEL_PNG_BASE64, usage: USAGE });
  const calls = stubImageFetch(t, { openai: [{ status: 200, sse: openAIImageSse(events, { chunkSize: 4096 }) }] });
  const written = [];
  const watcher = setInterval(() => {
    try { for (const name of fs.readdirSync(relay.partialsDir)) if (!written.includes(name)) written.push(name); } catch {}
  }, 1);
  t.after(() => clearInterval(watcher));
  const { status, body } = await relay.generate();
  clearInterval(watcher);
  assert.equal(calls.openai.length, 1);
  assert.equal(status, 200);
  assert.equal(body.generatedImages.length, 1, 'the first completed event of a count of 1');
  const previews = relay.previewEvents().filter((entry) => entry.event === 'image_preview');
  assert.deepEqual(previews.map((entry) => [entry.payload.imageIndex, entry.payload.partialIndex]), [[0, 0], [0, 1]]);
  assert.ok(written.every((name) => /^img-01-try1-p[01]\./.test(name)), written.join(', '));
});

test('the partial route does not follow a link put in the partials folder', { skip: process.platform === 'win32' }, async (t) => {
  const relay = makeRelay(t);
  stubImageFetch(t, { openai: [twoPartialsAndFinal()] });
  await relay.generate();
  const served = path.join(relay.partialsDir, 'img-01-try1-p0.png');
  assert.equal((await getPartial(relay, { fileName: 'img-01-try1-p0.png' })).status, 200);
  // The turn's own file name, now a link to a file elsewhere.
  const outside = path.join(relay.root, 'outside.png');
  fs.writeFileSync(outside, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  fs.rmSync(served);
  fs.symlinkSync(outside, served);
  const refused = await getPartial(relay, { fileName: 'img-01-try1-p0.png' });
  assert.equal(refused.status, 404);
  assert.equal(refused.bytes.length, 0);
});
