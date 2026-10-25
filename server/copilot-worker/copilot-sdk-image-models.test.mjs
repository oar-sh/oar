// Image models on the SDK engine: an OpenAI `gpt-image-*` / `dall-e-*` row
// goes to the relay's image routes and never into the Copilot runtime, which
// has no capacity for it (shared/worker-runtime/direct-openai-image.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  loadFixture,
  makeRunner,
  waitFor,
} from './copilot-sdk-test-harness.mjs';

const imageMessage = Object.freeze({
  ...baseMessage,
  text: 'turn the sky purple',
  model: 'gpt-image-2',
  providerType: 'openai',
  providerModel: 'gpt-image-2',
  attemptId: 'attempt-q-1',
  attachments: [{ name: 'harbour.png', type: 'image/png', path: '/tmp/relay-fixture-uploads/harbour.png' }],
});

const EXECUTE = '/api/image-operations/img_op_demo/execute';

function httpError(status, body) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.detail = body?.error || '';
  error.body = body;
  return error;
}

/**
 * Records every relay call with its options; `routes` maps a route to a body
 * or to a function of (body, options) that returns one or throws.
 */
function makeImageApi(routes = {}) {
  const calls = [];
  async function api(method, routePath, body, options) {
    calls.push({ method, routePath, body, options });
    const handler = routes[routePath];
    if (typeof handler === 'function') return handler(body, options);
    return handler === undefined ? {} : handler;
  }
  api.calls = calls;
  api.bodiesFor = (routePath) => calls.filter((c) => c.routePath === routePath).map((c) => c.body);
  return api;
}

function setup(routes) {
  const stub = makeImageApi(routes);
  const client = createFakeCopilotClient();
  const { runner, started } = makeRunner({ stub, client });
  return { stub, client, runner, started };
}

test('an image model with an image operation runs the operation and never reaches the runtime', async () => {
  const { stub, client, runner, started } = setup({ [EXECUTE]: { ok: true, outcome: 'completed' } });

  assert.equal(await runner.handlePendingPayload({ message: { ...imageMessage, imageOperationId: 'img_op_demo' } }), true);

  // No runtime: no client start, no session, no prompt.
  assert.equal(started.length, 0);
  assert.equal(client.sessions.length, 0);
  const execute = stub.calls.filter((c) => c.routePath === EXECUTE);
  assert.equal(execute.length, 1);
  assert.deepEqual(execute[0].body, { messageId: 'q-1' });
  // An edit can outlast fetch's header timeout.
  assert.equal(execute[0].options?.longCall, true);
  // The route published the reply itself.
  assert.equal(stub.bodiesFor('/api/response').length, 0);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
});

test('an image row is owned while its image call runs', async () => {
  let finish;
  const { runner } = setup({
    [EXECUTE]: () => new Promise((resolve) => { finish = () => resolve({ ok: true, outcome: 'completed' }); }),
  });

  const delivered = runner.handlePendingPayload({ message: { ...imageMessage, imageOperationId: 'img_op_demo' } });
  await waitFor(() => typeof finish === 'function', { label: 'execute called' });
  // The heartbeat keeps the lease, and the crash guard would requeue it.
  assert.deepEqual(runner.getActiveQueueMessageIds(), [{ id: 'q-1', attemptId: 'attempt-q-1' }]);
  assert.equal(runner.getActiveQueueMessageId(), 'q-1');
  assert.equal(runner.isTurnActive(), true);

  finish();
  assert.equal(await delivered, true);
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
  assert.equal(runner.getActiveQueueMessageId(), '');
  assert.equal(runner.isTurnActive(), false);
});

test('every image operation outcome the route answers is left to the route', async () => {
  const answers = [
    ['executing', () => ({ ok: true, outcome: 'executing' })],
    ['terminal', () => { throw httpError(409, { ok: false, outcome: 'terminal', error: 'Your request was rejected' }); }],
    ['uncertain', () => { throw httpError(409, { ok: false, outcome: 'uncertain', error: 'not retried' }); }],
    ['retryable', () => { throw httpError(503, { ok: false, outcome: 'retryable', error: 'provider unavailable' }); }],
    // An answer without a body falls back by status.
    ['terminal (no body)', () => { throw httpError(409, null); }],
    ['retryable (no body)', () => { throw httpError(503, null); }],
  ];
  for (const [label, answer] of answers) {
    const { stub, started, runner } = setup({ [EXECUTE]: answer });
    assert.equal(await runner.handlePendingPayload({ message: { ...imageMessage, imageOperationId: 'img_op_demo' } }), true, label);
    assert.equal(started.length, 0, label);
    // The route published the failure or requeued the row; the worker adds nothing.
    assert.equal(stub.bodiesFor('/api/response').length, 0, label);
    assert.equal(stub.bodiesFor('/api/requeue').length, 0, label);
  }
});

test('an image operation that cannot be reached or answers nonsense requeues the row', async () => {
  for (const answer of [
    () => { throw httpError(500, { error: 'boom' }); },
    () => ({ ok: true, outcome: 'maybe' }),
  ]) {
    const { stub, started, runner } = setup({ [EXECUTE]: answer });
    assert.equal(await runner.handlePendingPayload({ message: { ...imageMessage, imageOperationId: 'img_op_demo' } }), true);
    assert.equal(started.length, 0);
    assert.equal(stub.bodiesFor('/api/response').length, 0);
    assert.deepEqual(stub.bodiesFor('/api/requeue'), [{ messageId: 'q-1', attemptId: 'attempt-q-1' }]);
  }
});

test('without an image operation the worker calls the image API and publishes the generated image', async () => {
  const { stub, started, runner } = setup({
    '/api/openai/images/generate': {
      ok: true,
      model: 'gpt-image-2',
      generatedImages: [{ data: 'aGVsbG8=', mimeType: 'image/png', name: 'generated-image-1' }],
    },
  });

  assert.equal(await runner.handlePendingPayload({ message: { ...imageMessage, quality: 'low', size: '1024x1024' } }), true);

  assert.equal(started.length, 0);
  const [generate] = stub.bodiesFor('/api/openai/images/generate');
  assert.equal(generate.model, 'gpt-image-2');
  assert.equal(generate.prompt, 'turn the sky purple');
  assert.equal(generate.quality, 'low');
  assert.equal(generate.size, '1024x1024');
  // The attached image goes along: the request is an edit.
  assert.deepEqual(generate.attachments, imageMessage.attachments);
  const [response] = stub.bodiesFor('/api/response');
  assert.equal(response.messageId, 'q-1');
  assert.equal(response.text, '');
  assert.equal(response.generatedImages.length, 1);
  assert.equal(response.model, 'gpt-image-2');
  // Fenced to the delivery's attempt like every other worker publish.
  assert.equal(response.attemptId, 'attempt-q-1');
});

test('an image request OpenAI refuses fails the row with the image code, not a Copilot turn note', async () => {
  const { stub, started, runner } = setup({
    '/api/openai/images/generate': () => { throw httpError(400, { error: 'Invalid image size' }); },
  });

  assert.equal(await runner.handlePendingPayload({ message: imageMessage }), true);

  assert.equal(started.length, 0);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  const [response] = stub.bodiesFor('/api/response');
  assert.equal(response.text, 'OpenAI image request failed: Invalid image size');
  assert.equal(response.terminalError.code, 'image-provider-rejected');
  assert.equal(response.terminalError.stableCode, 'image-provider-rejected');
  assert.equal(response.terminalError.queueMessageId, 'q-1');
  assert.doesNotMatch(response.terminalError.message, /Copilot/);
  assert.equal(response.attemptId, 'attempt-q-1');
});

test('an image API failure that may pass requeues the row', async () => {
  const { stub, runner } = setup({
    '/api/openai/images/generate': () => { throw httpError(502, { error: 'Bad gateway' }); },
  });

  assert.equal(await runner.handlePendingPayload({ message: imageMessage }), true);

  assert.equal(stub.bodiesFor('/api/response').length, 0);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), [{ messageId: 'q-1', attemptId: 'attempt-q-1' }]);
});

test('an image row delivered while a chat turn runs is not steered into it', async () => {
  const stub = makeImageApi({ [EXECUTE]: { ok: true, outcome: 'completed' } });
  // The chat turn's runtime answers only when the test says so: it is still
  // running when the image row arrives.
  const client = createFakeCopilotClient();
  const { runner } = makeRunner({ stub, client });

  const chat = runner.handlePendingPayload({ message: { ...baseMessage, providerType: 'openai', model: 'gpt-5.4-mini' } });
  await waitFor(() => client.session?.sends.length === 1, { label: 'chat prompt sent' });

  assert.equal(await runner.handlePendingPayload({ message: { ...imageMessage, id: 'q-2', imageOperationId: 'img_op_demo' } }), true);

  assert.equal(client.session.sends.length, 1);
  assert.deepEqual(stub.bodiesFor(EXECUTE), [{ messageId: 'q-2' }]);
  client.session.replay(loadFixture('happy-turn'));
  assert.equal(await chat, true);
  assert.equal(stub.bodiesFor('/api/response').filter((body) => body.messageId === 'q-1').length, 1);
  await runner.dispose();
});

test('a failed chat turn on a BYOK OpenAI worker is reported as an OpenAI turn', async () => {
  // A runtime error on a model the runtime has no capacity for; codes stay.
  const events = loadFixture('quota-turn').map((event) => (event.type === 'session.error'
    ? { ...event, data: { errorType: 'query', message: '503 No available capacity was found for the model' } }
    : event));
  const stub = makeImageApi();
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(events) });
  const { runner } = makeRunner({
    stub,
    client,
    env: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'sk-test', COPILOT_MODEL: 'gpt-5.4-mini' },
  });

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, providerType: 'openai', model: 'gpt-5.4-mini' } }), true);

  const [response] = stub.bodiesFor('/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.query');
  assert.match(response.terminalError.message, /^System note: the OpenAI turn on the Copilot SDK engine failed \(503 No available capacity/);
  await runner.dispose();
});
