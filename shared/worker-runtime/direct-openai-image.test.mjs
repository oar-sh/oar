import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECT_IMAGE_OUTCOMES,
  OPENAI_IMAGE_TERMINAL_CODE,
  isDirectOpenAIImageTerminalStatus,
  isOpenAIImageTerminalError,
  runDirectOpenAIImageTurn,
  shouldUseDirectOpenAIImageApi,
} from './direct-openai-image.mjs';

const message = Object.freeze({
  id: 'q-7',
  conversationId: 'conv-7',
  relayMode: 'agent',
  text: 'a lighthouse at dusk',
  model: 'gpt-image-1',
  providerType: 'openai',
  providerModel: 'gpt-image-1',
  attachments: [],
});

function httpError(status, body) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.detail = body?.error || '';
  error.body = body;
  return error;
}

function recordingApi(routes = {}) {
  const calls = [];
  async function api(method, routePath, body, options) {
    calls.push({ method, routePath, body, options });
    const handler = routes[routePath];
    if (typeof handler === 'function') return handler(body);
    return handler === undefined ? {} : handler;
  }
  api.calls = calls;
  api.bodyOf = (routePath) => calls.find((c) => c.routePath === routePath)?.body || null;
  return api;
}

test('only OpenAI image models take the direct path', () => {
  for (const model of ['gpt-image-1', 'gpt-image-2', 'GPT-IMAGE-2.5-preview', 'dall-e-3']) {
    assert.equal(shouldUseDirectOpenAIImageApi({ providerType: 'openai', providerModel: model }), true, model);
  }
  assert.equal(shouldUseDirectOpenAIImageApi({ providerType: 'openai', model: 'gpt-image-1' }), true);
  assert.equal(shouldUseDirectOpenAIImageApi({ providerType: 'openai', providerModel: 'gpt-5.4-mini' }), false);
  // A Copilot conversation never does, whatever the model is called.
  assert.equal(shouldUseDirectOpenAIImageApi({ providerType: 'github', providerModel: 'gpt-image-1' }), false);
  assert.equal(shouldUseDirectOpenAIImageApi({}), false);
  assert.equal(shouldUseDirectOpenAIImageApi(), false);
});

test('the provider statuses that fail an image request outright', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) assert.equal(isDirectOpenAIImageTerminalStatus(status), true, status);
  for (const status of [500, 502, 504, undefined, 'x']) assert.equal(isDirectOpenAIImageTerminalStatus(status), false, String(status));
});

test('an image operation reports the outcome the execute route answered', async () => {
  for (const outcome of DIRECT_IMAGE_OUTCOMES) {
    const api = recordingApi({ '/api/image-operations/img_op_7/execute': { ok: true, outcome } });
    const result = await runDirectOpenAIImageTurn({
      api,
      message: { ...message, imageOperationId: 'img_op_7' },
      requestOptions: { longCall: true },
    });
    assert.deepEqual(result, { via: 'operation', outcome });
    assert.equal(api.calls.length, 1);
    assert.deepEqual(api.calls[0].body, { messageId: 'q-7' });
    assert.deepEqual(api.calls[0].options, { longCall: true });
  }
});

test('an image operation the route already failed reads its outcome from the error body', async () => {
  const cases = [
    [httpError(409, { outcome: 'uncertain' }), 'uncertain'],
    [httpError(409, { outcome: 'terminal' }), 'terminal'],
    [httpError(503, { outcome: 'retryable' }), 'retryable'],
    [httpError(409, null), 'terminal'],
    [httpError(503, null), 'retryable'],
  ];
  for (const [error, outcome] of cases) {
    const api = recordingApi({ '/api/image-operations/img_op_7/execute': () => { throw error; } });
    const result = await runDirectOpenAIImageTurn({ api, message: { ...message, imageOperationId: 'img_op_7' } });
    assert.equal(result.outcome, outcome);
  }
});

test('an image operation that fails otherwise or answers an unknown outcome throws a plain error', async () => {
  const unreachable = recordingApi({ '/api/image-operations/img_op_7/execute': () => { throw httpError(500, { error: 'boom' }); } });
  await assert.rejects(
    runDirectOpenAIImageTurn({ api: unreachable, message: { ...message, imageOperationId: 'img_op_7' } }),
    (error) => error.status === 500 && !isOpenAIImageTerminalError(error),
  );
  const nonsense = recordingApi({ '/api/image-operations/img_op_7/execute': { outcome: 'perhaps' } });
  await assert.rejects(
    runDirectOpenAIImageTurn({ api: nonsense, message: { ...message, imageOperationId: 'img_op_7' } }),
    /invalid outcome/,
  );
});

test('the direct path generates, then publishes the images with the caller fields', async () => {
  const api = recordingApi({
    '/api/openai/images/generate': {
      model: 'gpt-image-1',
      generatedImages: [{ data: 'aGVsbG8=', mimeType: 'image/png', name: 'a' }, { data: 'aGk=', mimeType: 'image/png', name: 'b' }],
    },
  });
  const result = await runDirectOpenAIImageTurn({
    api,
    message: { ...message, reasoningEffort: 'medium', contextTier: '1536x1024' },
    responseFields: { attemptId: 'attempt-7' },
  });
  assert.deepEqual(result, { via: 'direct', outcome: 'completed', imageCount: 2, model: 'gpt-image-1' });
  assert.deepEqual(api.calls.map((c) => c.routePath), ['/api/activity', '/api/openai/images/generate', '/api/response']);
  const generate = api.bodyOf('/api/openai/images/generate');
  assert.equal(generate.quality, 'medium');
  assert.equal(generate.size, '1536x1024');
  const response = api.bodyOf('/api/response');
  assert.equal(response.text, '');
  assert.equal(response.generatedImages.length, 2);
  assert.equal(response.modelOrigin, 'manual');
  assert.equal(response.attemptId, 'attempt-7');
});

test('a provider refusal on the direct path is a terminal image error; anything else is not', async () => {
  const refused = recordingApi({ '/api/openai/images/generate': () => { throw httpError(400, { error: 'Invalid image size' }); } });
  await assert.rejects(
    runDirectOpenAIImageTurn({ api: refused, message }),
    (error) => isOpenAIImageTerminalError(error)
      && error.code === OPENAI_IMAGE_TERMINAL_CODE
      && error.message === 'OpenAI image request failed: Invalid image size'
      && error.status === 400,
  );
  assert.equal(refused.calls.some((c) => c.routePath === '/api/response'), false);

  const gateway = recordingApi({ '/api/openai/images/generate': () => { throw httpError(502, { error: 'Bad gateway' }); } });
  await assert.rejects(runDirectOpenAIImageTurn({ api: gateway, message }), (error) => error.status === 502 && !isOpenAIImageTerminalError(error));

  const empty = recordingApi({ '/api/openai/images/generate': { generatedImages: [] } });
  await assert.rejects(runDirectOpenAIImageTurn({ api: empty, message }), /returned no images/);

  await assert.rejects(runDirectOpenAIImageTurn({ api: recordingApi(), message: { ...message, text: '  ' } }), /missing prompt/);
});
