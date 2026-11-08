// An OpenAI image request is tried at most twice, and an image turn whose
// request may have reached OpenAI never goes back to the queue: a second run
// is billed again. Not sent at all (no connection, no name): tried again,
// nothing billed. No answer in time, a broken connection or a 5xx: tried
// again with the same Idempotency-Key, then a note that it may have been
// billed. A 4xx or an unreadable 2xx: never tried again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { classifyOpenAIImageFetchError, registerMessagesRoutes, resolveTerminalFailurePayload } from './messages-routes.mjs';
import {
  FAKE_OPENAI_BASE_URL,
  captureRoutes,
  executeImageOperation,
  fetchFailure,
  invokeRoute,
  makeImageOperationDeps,
  makeRouteDeps,
  recordingStmts,
  stubImageFetch,
} from './messages-routes-test-harness.mjs';

const GENERATE = '/api/openai/images/generate';
const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
const okReply = () => ({ status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] } });
const BILLED_MAYBE = 'the request may have been billed; retry the message.';

function generateRoutes(config = {}) {
  return captureRoutes(makeRouteDeps({
    ts: () => '00:00:00.000',
    config,
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    MAX_UPLOAD_ATTACHMENTS: 6,
    getOpenAIProviderSettings: () => ({
      configured: true,
      enabled: true,
      apiKey: 'sk-test-key',
      baseUrl: FAKE_OPENAI_BASE_URL,
      model: 'gpt-image-2',
      models: [],
    }),
  }), registerMessagesRoutes);
}

let counter = 0;
function generate(routes, overrides = {}) {
  counter += 1;
  return invokeRoute(routes, 'POST', GENERATE, {
    body: { messageId: `q-retry-${counter}`, conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a red kite', ...overrides },
  });
}

test('network errors are told apart by whether the request can have reached OpenAI', () => {
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('ECONNREFUSED')), 'unsent');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('ENOTFOUND')), 'unsent');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('EAI_AGAIN')), 'unsent');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('UND_ERR_CONNECT_TIMEOUT')), 'unsent');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('ERR_TLS_CERT_ALTNAME_INVALID')), 'unsent');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('CERT_HAS_EXPIRED')), 'unsent');
  const both = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new AggregateError([fetchFailure('ECONNREFUSED').cause, fetchFailure('ECONNREFUSED').cause]), { code: 'ECONNREFUSED' }),
  });
  assert.equal(classifyOpenAIImageFetchError(both), 'unsent');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('ECONNRESET')), 'broken');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('UND_ERR_SOCKET')), 'broken');
  assert.equal(classifyOpenAIImageFetchError(new TypeError('fetch failed')), 'broken');
  assert.equal(classifyOpenAIImageFetchError(fetchFailure('UND_ERR_HEADERS_TIMEOUT')), 'timeout');
  assert.equal(classifyOpenAIImageFetchError(new DOMException('The operation timed out.', 'TimeoutError')), 'timeout');
});

test('5xx, 5xx: exactly two requests with one Idempotency-Key, then a note naming the status', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 502, text: '<html>Bad gateway</html>' }, { status: 503, json: { error: { message: 'overloaded' } } }] });
  const { status, body } = await generate(generateRoutes());

  assert.equal(calls.openai.length, 2);
  const keys = calls.openai.map((call) => call.init.headers['Idempotency-Key']);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assert.equal(status, 502);
  assert.equal(body.outcome, 'uncertain');
  assert.equal(body.code, 'IMAGE_PROVIDER_UNAVAILABLE');
  assert.equal(body.error, `OpenAI answered 503 (tried twice); ${BILLED_MAYBE}`);
  assert.equal(body.relayProcessing, undefined);
});

test('timeout, timeout: two requests, then the "did not answer" note', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ hang: true }] });
  const { status, body } = await generate(generateRoutes({ openaiImageGenerateTimeoutMs: 15 }));

  assert.equal(calls.openai.length, 2);
  assert.equal(status, 504);
  assert.equal(body.outcome, 'uncertain');
  assert.equal(body.error, `OpenAI did not answer within 15 ms (tried twice); ${BILLED_MAYBE}`);
});

test('a broken connection, twice: two requests, then the note', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ error: fetchFailure('ECONNRESET') }] });
  const { body } = await generate(generateRoutes());
  assert.equal(calls.openai.length, 2);
  assert.equal(body.error, `The connection to OpenAI broke off (tried twice); ${BILLED_MAYBE}`);
});

test('ECONNREFUSED, then a good reply: two requests and the images, no note', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ error: fetchFailure('ECONNREFUSED') }, okReply()] });
  const { status, body } = await generate(generateRoutes());
  assert.equal(calls.openai.length, 2);
  assert.equal(status, 200);
  assert.equal(body.generatedImages.length, 1);
  assert.equal('note' in body, false);
});

const SENT_AGAIN = 'it was sent once more and the first try may have been billed as well.';
// A first try that may have reached OpenAI, then a good reply, and the note.
const RETRIED_THEN_OK = [
  ['a timeout', { hang: true }, `OpenAI did not answer the first try within 15 ms; ${SENT_AGAIN}`],
  ['a reset before the headers', { error: fetchFailure('ECONNRESET') }, `The connection to OpenAI broke off on the first try; ${SENT_AGAIN}`],
  ['a 503', { status: 503, json: { error: { message: 'overloaded' } } }, `OpenAI answered the first try with 503; ${SENT_AGAIN}`],
];

for (const [label, first, note] of RETRIED_THEN_OK) {
  test(`${label}, then a good reply: the images and a note that the first try may have been billed`, async (t) => {
    const calls = stubImageFetch(t, { openai: [first, okReply()] });
    const { status, body } = await generate(generateRoutes({ openaiImageGenerateTimeoutMs: 15 }));
    assert.equal(calls.openai.length, 2);
    assert.equal(status, 200);
    assert.equal(body.generatedImages.length, 1);
    assert.equal(body.note, note);
  });

  test(`an operation: ${label}, then a good reply: the note goes to /api/response`, async (t) => {
    const calls = stubImageFetch(t, { openai: [first, okReply()] });
    const { deps } = makeImageOperationDeps({ config: { openaiImageGenerateTimeoutMs: 15 } });
    const { status, body } = await executeImageOperation(deps);
    assert.equal(calls.openai.length, 2);
    assert.equal(status, 200);
    assert.equal(body.outcome, 'completed');
    assert.equal(body.note, note);
    const response = calls.self.find((p) => p.route === '/api/response').body;
    assert.equal(response.generatedImages.length, 1);
    assert.equal(response.imageNote, note);
  });
}

test('an operation: ECONNREFUSED, then a good reply: no note', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ error: fetchFailure('ECONNREFUSED') }, okReply()] });
  const { deps } = makeImageOperationDeps();
  const { body } = await executeImageOperation(deps);
  assert.equal(calls.openai.length, 2);
  assert.equal(body.outcome, 'completed');
  assert.equal('note' in body, false);
  assert.equal('imageNote' in calls.self.find((p) => p.route === '/api/response').body, false);
});

async function postImageReply(t, body) {
  const testRoot = path.join(process.cwd(), '.test-artifacts', `image-retry-reply-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => ({ id: 'q-1', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-image-2', retry_count: 0 }) },
    getRuntimeSessionByConversation: { get: () => ({ provider_type: 'openai' }) },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'conv-1' }) },
  });
  let uuidCounter = 0;
  const deps = makeRouteDeps({
    ts: () => '00:00:00.000',
    uuidv4: () => `uuid-${++uuidCounter}`,
    io: { emit() {} },
    stmts,
    db: {
      prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    MAX_UPLOAD_ATTACHMENTS: 6,
    resolveSessionStateRoot: () => testRoot,
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
    config: {},
  });
  const captured = await invokeRoute(captureRoutes(deps, registerMessagesRoutes), 'POST', '/api/response', {
    body: { messageId: 'q-1', conversationId: 'conv-1', model: 'gpt-image-2', generatedImages: [{ mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }], ...body },
  });
  return { status: captured.status, text: calls.find((call) => call.stmt === 'insertMsg')?.args[3] };
}

test('the note is the reply\'s text after the reply line, or after the model\'s own text', async (t) => {
  const note = `The connection to OpenAI broke off on the first try; ${SENT_AGAIN}`;
  const line = await postImageReply(t, { text: '', imageNote: note });
  assert.equal(line.status, 200);
  assert.equal(line.text, `1 image · 1x1 · gpt-image-2. Note: ${note}`);

  const own = await postImageReply(t, { text: 'Here is the kite.', imageNote: note });
  assert.equal(own.text, `Here is the kite.\n\nNote: ${note}`);

  const none = await postImageReply(t, { text: '' });
  assert.equal(none.text, '1 image · 1x1 · gpt-image-2');
});

test('not reachable twice: the note says nothing was billed', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ error: fetchFailure('ENOTFOUND') }] });
  const { body } = await generate(generateRoutes());
  assert.equal(calls.openai.length, 2);
  assert.equal(body.outcome, 'terminal');
  assert.equal(body.code, 'IMAGE_PROVIDER_UNREACHABLE');
  assert.equal(body.error, 'OpenAI could not be reached; nothing was billed; retry the message.');
});

test('a timeout and then no connection: told as the timeout, which may have been billed', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ hang: true }, { error: fetchFailure('ECONNREFUSED') }] });
  const { body } = await generate(generateRoutes({ openaiImageGenerateTimeoutMs: 15 }));
  assert.equal(calls.openai.length, 2);
  assert.equal(body.outcome, 'uncertain');
  assert.equal(body.error, `OpenAI did not answer within 15 ms (tried twice); ${BILLED_MAYBE}`);
});

test('a 4xx is never tried again; its note carries OpenAI\'s message', async (t) => {
  for (const [answer, expected] of [
    [{ status: 400, json: { error: { message: 'Your request was rejected by the safety system' } } },
      'OpenAI refused the image request (400): Your request was rejected by the safety system.'],
    [{ status: 429, json: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } },
      'OpenAI refused the image request (429): You exceeded your current quota.'],
    [{ status: 429, json: { error: { message: 'Rate limit reached for images per minute' } } },
      'OpenAI refused the image request (429): Rate limit reached for images per minute.'],
  ]) {
    const calls = stubImageFetch(t, { openai: [answer] });
    const { status, body } = await generate(generateRoutes());
    assert.equal(calls.openai.length, 1);
    assert.equal(status, answer.status);
    assert.equal(body.outcome, 'terminal');
    assert.equal(body.error, expected);
  }
});

test('a 2xx with a body that is not usable is billed and never tried again', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 200, text: '<!doctype html>' }] });
  const { body } = await generate(generateRoutes());
  assert.equal(calls.openai.length, 1);
  assert.equal(body.relayProcessing, true);
  assert.match(body.error, /The generation was billed; the message was not retried\.$/);
});

test('a second request for the same queue message is refused without a call', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 500, json: {} }, { status: 500, json: {} }, okReply()] });
  const routes = generateRoutes();
  const request = { messageId: 'q-repeat', conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a red kite' };

  const first = await invokeRoute(routes, 'POST', GENERATE, { body: request });
  assert.equal(first.body.outcome, 'uncertain');
  const second = await invokeRoute(routes, 'POST', GENERATE, { body: request });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'IMAGE_ATTEMPT_REPEATED');
  assert.equal(calls.openai.length, 2);

  // One that never reached OpenAI may be sent again.
  const unsent = stubImageFetch(t, { openai: [{ error: fetchFailure('ECONNREFUSED') }, { error: fetchFailure('ECONNREFUSED') }, okReply()] });
  const offline = { ...request, messageId: 'q-offline' };
  assert.equal((await invokeRoute(routes, 'POST', GENERATE, { body: offline })).body.code, 'IMAGE_PROVIDER_UNREACHABLE');
  assert.equal((await invokeRoute(routes, 'POST', GENERATE, { body: offline })).status, 200);
  assert.equal(unsent.openai.length, 3);
});

test('an operation: 5xx, 5xx is two requests and an uncertain note, never a requeue', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 500, json: { error: { message: 'server_error' } } }] });
  const { deps, finished, inserted } = makeImageOperationDeps();

  const { status, body } = await executeImageOperation(deps);

  assert.equal(status, 409);
  assert.equal(body.outcome, 'uncertain');
  assert.equal(calls.openai.length, 2);
  // One attempt row for both requests: a restart between them finds it
  // started and sends nothing more.
  assert.equal(inserted.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'uncertain');
  assert.equal(finished[0].errorCode, 'IMAGE_PROVIDER_UNAVAILABLE');
  assert.equal(calls.self.some((p) => p.route === '/api/requeue'), false);
  const resolved = resolveTerminalFailurePayload(calls.self.find((p) => p.route === '/api/response').body);
  assert.equal(resolved.stableCode, 'relay.image-provider-unavailable');
  assert.equal(resolved.message, `OpenAI answered 500 (tried twice); ${BILLED_MAYBE}`);
});

test('an operation not reachable twice is a note, never a requeue', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ error: fetchFailure('ECONNREFUSED') }] });
  const { deps, finished } = makeImageOperationDeps();

  const { body } = await executeImageOperation(deps);

  assert.equal(body.outcome, 'terminal');
  assert.equal(calls.openai.length, 2);
  assert.equal(finished[0].status, 'failed_retryable');
  assert.equal(calls.self.some((p) => p.route === '/api/requeue'), false);
  assert.equal(resolveTerminalFailurePayload(calls.self.find((p) => p.route === '/api/response').body).message,
    'OpenAI could not be reached; nothing was billed; retry the message.');
});

test('an operation whose attempt ended is not sent again when it comes back', async (t) => {
  const calls = stubImageFetch(t, { openai: [{ status: 500, json: {} }] });
  const { deps } = makeImageOperationDeps();
  await executeImageOperation(deps);
  assert.equal(calls.openai.length, 2);

  // The note was lost, the row came back to the worker: same note, no call.
  const again = await executeImageOperation(deps);
  assert.equal(again.status, 409);
  assert.equal(again.body.outcome, 'uncertain');
  assert.equal(calls.openai.length, 2);
  const notes = calls.self.filter((p) => p.route === '/api/response').map((p) => resolveTerminalFailurePayload(p.body).message);
  assert.equal(notes.length, 2);
  assert.equal(notes[0], notes[1]);
});

test('a relay restart between the two tries: the attempt is uncertain and nothing more is sent', async (t) => {
  const calls = stubImageFetch(t, {});
  // What the first process left: one started attempt; the row was
  // re-delivered after the restart.
  const { deps, finished } = makeImageOperationDeps({
    latestAttempt: { id: 'img_attempt_1', attempt_number: 1, status: 'started', started_at: '2026-10-24T09:59:00.000Z' },
  });

  const { body } = await executeImageOperation(deps);

  assert.equal(body.outcome, 'uncertain');
  assert.equal(calls.openai.length, 0);
  assert.equal(finished[0].status, 'uncertain');
  assert.equal(finished[0].errorCode, 'IMAGE_ATTEMPT_INTERRUPTED');
  assert.match(resolveTerminalFailurePayload(calls.self.find((p) => p.route === '/api/response').body).message, /may have been billed/);
});

function requeueRoutes({ queueRow, latestAttempt = null }) {
  const finished = [];
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => queueRow },
    getLatestAttempt: { get: () => latestAttempt },
    finishAttempt: { run: (row) => { finished.push(row); return { changes: 1 }; } },
  });
  const prepared = [];
  const deps = makeRouteDeps({
    ts: () => '00:00:00.000',
    uuidv4: () => 'response-1',
    io: { emit() {} },
    stmts,
    db: {
      prepare: (sql) => { prepared.push(sql); return { run: () => ({ changes: 1 }), get: () => null, all: () => [] }; },
      transaction: (fn) => (...args) => fn(...args),
    },
    MAX_REQUEUE_RETRIES: 5,
    computeRetryDelayMs: () => 0,
    addMsIso: () => null,
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, apiKey: 'sk-test-key', baseUrl: FAKE_OPENAI_BASE_URL, models: [] }),
    MAX_UPLOAD_ATTACHMENTS: 6,
  });
  return { routes: captureRoutes(deps, registerMessagesRoutes), calls, finished, prepared };
}

const IMAGE_ROW = Object.freeze({
  id: 'q-1',
  conversation_id: 'conv-1',
  status: 'processing',
  relay_mode: 'agent',
  model: 'gpt-image-2',
  retry_count: 0,
  image_operation_id: 'img_op_demo',
});

test('/api/requeue fails an image row whose request was sent instead of queueing it again', async () => {
  for (const [latestAttempt, expectedCode] of [
    [{ id: 'a-1', status: 'started' }, 'relay.image-attempt-interrupted'],
    [{ id: 'a-1', status: 'uncertain', error_code: 'IMAGE_PROVIDER_NO_ANSWER', error_message: 'OpenAI did not answer within 180 s (tried twice); the request may have been billed; retry the message.' }, 'relay.image-provider-no-answer'],
  ]) {
    const { routes, calls, finished, prepared } = requeueRoutes({ queueRow: IMAGE_ROW, latestAttempt });
    const { body } = await invokeRoute(routes, 'POST', '/api/requeue', { body: { messageId: 'q-1' } });
    assert.equal(body.terminal, true);
    assert.equal(body.code, expectedCode);
    assert.equal(calls.filter((call) => call.stmt === 'setFailed').length, 1);
    assert.equal(prepared.some((sql) => /UPDATE queue/.test(sql) && /status = \?/.test(sql)), false, 'not put back to pending');
    assert.equal(finished.length, latestAttempt.status === 'started' ? 1 : 0);
  }
});

test('/api/requeue still queues an image row whose request was never sent', async () => {
  const { routes, calls, prepared } = requeueRoutes({ queueRow: IMAGE_ROW, latestAttempt: null });
  const { body } = await invokeRoute(routes, 'POST', '/api/requeue', { body: { messageId: 'q-1' } });
  assert.equal(body.ok, true);
  assert.equal(body.terminal, undefined);
  assert.equal(calls.filter((call) => call.stmt === 'setFailed').length, 0);
  assert.equal(prepared.some((sql) => /UPDATE queue/.test(sql)), true);
});

test('/api/requeue fails a direct image row once its request went out', async (t) => {
  stubImageFetch(t, { openai: [{ status: 500, json: {} }] });
  const directRow = { ...IMAGE_ROW, id: 'q-direct', image_operation_id: null };
  const { routes, calls } = requeueRoutes({ queueRow: directRow });
  await invokeRoute(routes, 'POST', GENERATE, {
    body: { messageId: 'q-direct', conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a red kite' },
  });

  const { body } = await invokeRoute(routes, 'POST', '/api/requeue', { body: { messageId: 'q-direct' } });
  assert.equal(body.terminal, true);
  assert.equal(body.code, 'relay.image-attempt-repeated');
  assert.equal(calls.filter((call) => call.stmt === 'setFailed').length, 1);
});
