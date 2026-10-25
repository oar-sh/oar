// POST /api/image-operations/:id/execute: the provider call runs through the
// relay's own routes, and a failure is published as the row's terminal error.
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes, resolveTerminalFailurePayload } from './messages-routes.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const EXECUTE = '/api/image-operations/:operationId/execute';

function imageOperationDeps({ latestAttempt = null } = {}) {
  const operation = {
    id: 'img_op_demo',
    queue_message_id: 'q-1',
    conversation_id: 'conv-1',
    provider: 'openai',
    execution_mode: 'direct_images',
    selected_image_model: 'gpt-image-2',
    prompt: 'turn the sky purple',
    parameters_json: JSON.stringify({ quality: 'low', size: '1024x1024', count: 1 }),
    parent_node_id: null,
  };
  const finished = [];
  let attempt = latestAttempt;
  const deps = makeRouteDeps({
    featureFlags: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: true },
    isTrulyLocalRequest: () => true,
    uuidv4: () => crypto.randomUUID(),
    config: { authToken: 'test-token', port: 4999 },
    remotePath: '',
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      getOperation: { get: (id) => (id === operation.id ? operation : null) },
      listNodesForOperation: { all: () => [] },
      findQById: { get: () => ({ id: 'q-1', image_operation_id: operation.id, processing_at: '2026-10-24T10:00:00.000Z' }) },
      getLatestAttempt: { get: () => attempt },
      insertAttempt: { run: (row) => { attempt = { id: row.id, attempt_number: row.attemptNumber, status: 'started', started_at: row.startedAt }; } },
      finishAttempt: { run: (row) => { finished.push(row); } },
      listAssets: { all: () => [] },
    },
  });
  return { deps, finished };
}

/** Stands in for the relay's calls to itself, recording what they sent. */
function stubSelfFetch(t, answers) {
  const posts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    const body = JSON.parse(init.body);
    posts.push({ route, body });
    const [status, payload] = answers[route] || [200, { ok: true }];
    return { ok: status < 400, status, json: async () => payload };
  };
  t.after(() => { globalThis.fetch = original; });
  return posts;
}

test('an image request the provider refuses is published as the row\'s terminal error', async (t) => {
  const posts = stubSelfFetch(t, {
    '/api/openai/images/generate': [400, { error: 'Invalid image size' }],
  });
  const { deps, finished } = imageOperationDeps();
  const routes = captureRoutes(deps, registerMessagesRoutes);

  const { status, body } = await invokeRoute(routes, 'POST', EXECUTE, { params: { operationId: 'img_op_demo' } });

  assert.equal(status, 409);
  assert.equal(body.outcome, 'terminal');
  assert.equal(finished[0].status, 'failed_terminal');
  const generate = posts.find((p) => p.route === '/api/openai/images/generate').body;
  assert.equal(generate.model, 'gpt-image-2');
  assert.equal(generate.quality, 'low');
  const failure = posts.find((p) => p.route === '/api/response').body;
  // /api/response reads `terminalError`; anything else was an empty reply it refused.
  const resolved = resolveTerminalFailurePayload(failure);
  assert.equal(resolved?.terminal, true);
  assert.equal(resolved.stableCode, 'relay.image-provider-rejected');
  assert.equal(resolved.message, 'Invalid image size');
  assert.equal(posts.some((p) => p.route === '/api/requeue'), false);
});

test('an interrupted earlier attempt is published as an uncertain terminal error', async (t) => {
  const posts = stubSelfFetch(t, {});
  const { deps } = imageOperationDeps({
    latestAttempt: { id: 'img_attempt_1', attempt_number: 1, status: 'started', started_at: '2026-10-24T09:00:00.000Z' },
  });
  const routes = captureRoutes(deps, registerMessagesRoutes);

  const { status, body } = await invokeRoute(routes, 'POST', EXECUTE, { params: { operationId: 'img_op_demo' } });

  assert.equal(status, 409);
  assert.equal(body.outcome, 'uncertain');
  assert.equal(posts.some((p) => p.route === '/api/openai/images/generate'), false);
  const resolved = resolveTerminalFailurePayload(posts.find((p) => p.route === '/api/response').body);
  assert.equal(resolved?.stableCode, 'relay.image-attempt-interrupted');
});

test('a provider outage requeues the row instead of failing it', async (t) => {
  const posts = stubSelfFetch(t, {
    '/api/openai/images/generate': [502, { error: 'Bad gateway' }],
  });
  const { deps } = imageOperationDeps();
  const routes = captureRoutes(deps, registerMessagesRoutes);

  const { status, body } = await invokeRoute(routes, 'POST', EXECUTE, { params: { operationId: 'img_op_demo' } });

  assert.equal(status, 503);
  assert.equal(body.outcome, 'retryable');
  assert.deepEqual(posts.find((p) => p.route === '/api/requeue').body, { messageId: 'q-1' });
  assert.equal(posts.some((p) => p.route === '/api/response'), false);
});
