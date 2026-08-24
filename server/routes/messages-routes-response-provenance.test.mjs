import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes } from './messages-routes.mjs';

// Route-level pins for the /api/response provenance contract: which provider a
// turn is credited to must be decided by the authenticated responder identity
// on BOTH the success and the terminal-failure path (the original hijack
// incident presented as stolen turns dying on 402 through the terminal path,
// which used to record nothing).

function recordingStmts(explicit = {}) {
  const calls = [];
  const target = { ...explicit };
  const stmts = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      const recorder = {
        run: (...args) => { calls.push({ stmt: String(prop), args }); return { changes: 1 }; },
        get: () => null,
        all: () => [],
      };
      obj[prop] = recorder;
      return recorder;
    },
  });
  return { calls, stmts };
}

function makeDeps({ queueRow = null, runtimeSessionsBySid = {}, conversationProvider = 'github', stmtOverrides = {} } = {}) {
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => queueRow },
    getRuntimeSessionByConversation: {
      get: () => (conversationProvider ? { provider_type: conversationProvider } : null),
    },
    getRuntimeSessionBySdkSessionId: {
      get: (sid) => runtimeSessionsBySid[String(sid || '').trim()] || null,
    },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'conv-1' }) },
    findPendingQuestionByMessage: { get: () => null },
    findRecentlyAnsweredQuestionByMessage: { get: () => null },
    ...stmtOverrides,
  });
  const emitted = [];
  let uuidCounter = 0;
  const deps = {
    auth: (_req, _res, next) => next(),
    uuidv4: () => `test-uuid-${++uuidCounter}`,
    ts: () => '12:00:00',
    db: {
      transaction: (fn) => (...args) => fn(...args),
      prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }),
    },
    stmts,
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    touchCli: () => {},
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'default',
    DEFAULT_MODEL: 'gpt-5',
    MAX_UPLOAD_BYTES: 1024 * 1024,
    normalizeAttachments: () => [],
    collectReferenceAttachmentsFromText: () => ({ attachments: [] }),
    mergeMessageAttachments: (left, right) => [...(left || []), ...(right || [])],
    resolveRequestedModel: () => ({ ok: false, error: 'unsupported', available: [] }),
    getOpenAIProviderSettings: () => ({ configured: false, enabled: false, model: '', models: [] }),
    getCursorProviderSettings: () => ({ enabled: false, model: '', models: [] }),
    featureFlags: {},
    relayBridgeOwnerService: {
      normalizeIdentity: (raw) => {
        const sessionId = String(raw?.sessionId || '').trim();
        return sessionId ? { sessionId } : null;
      },
    },
    readSessionTranscriptMessages: () => [],
    resolveSessionStateRoot: () => '/tmp',
    ensureSessionId: () => 'session-1',
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
    backgroundTaskStore: null,
    sessionWorkerRegistry: null,
    sessionWorkerSupervisor: null,
    pushDispatchService: null,
    runtimeState: {},
    config: {},
  };
  return { deps, calls, emitted };
}

function responseHandler(deps) {
  let handler = null;
  const app = {
    post(registeredPath, ...handlers) {
      if (registeredPath === '/api/response') handler = handlers[handlers.length - 1];
    },
    get() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, '/api/response should be registered');
  return handler;
}

async function invokeResponse(deps, body, headers = {}) {
  const handler = responseHandler(deps);
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await handler({ body, headers, query: {} }, res);
  return captured;
}

const processingRow = {
  id: 'q-1',
  conversation_id: 'conv-1',
  status: 'processing',
  relay_mode: 'agent',
  model: 'grok-4.5',
  retry_count: 0,
};

test('a successful response credits the responder identity\'s provider', async () => {
  const { deps, calls } = makeDeps({
    queueRow: { ...processingRow },
    conversationProvider: 'cursor',
    runtimeSessionsBySid: { 'worker-sid': { provider_type: 'cursor', conversation_id: 'conv-1' } },
  });
  const { status, body } = await invokeResponse(
    deps,
    { messageId: 'q-1', conversationId: 'conv-1', text: 'the answer', model: 'grok-4.5', mode: 'agent' },
    { 'x-relay-session-id': 'worker-sid' },
  );
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const provenance = calls.find((call) => call.stmt === 'setMessageExecutedProvider');
  assert.ok(provenance, 'executed_provider must be written');
  assert.equal(provenance.args[0], 'cursor');
});

test('an identity-less chat response is credited to github, not the bound provider', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const { deps, calls } = makeDeps({
    queueRow: { ...processingRow },
    conversationProvider: 'cursor',
  });
  const { status } = await invokeResponse(deps, {
    messageId: 'q-1', conversationId: 'conv-1', text: 'stolen answer', model: 'grok-4.5', mode: 'agent',
  });
  assert.equal(status, 200);
  const provenance = calls.find((call) => call.stmt === 'setMessageExecutedProvider');
  assert.equal(provenance.args[0], 'github');
  assert.ok(
    warns.mock.calls.some((call) => /PROVIDER MISMATCH/.test(String(call.arguments[0] || ''))),
    'a crossover must be logged',
  );
});

test('a server-executed image operation is credited to the bound provider', async () => {
  const { deps, calls } = makeDeps({
    queueRow: { ...processingRow, image_operation_id: 'op-1' },
    conversationProvider: 'openai',
  });
  const { status } = await invokeResponse(deps, {
    messageId: 'q-1', conversationId: 'conv-1', text: 'image done', model: 'gpt-image-1', mode: 'agent',
  });
  assert.equal(status, 200);
  const provenance = calls.find((call) => call.stmt === 'setMessageExecutedProvider');
  assert.equal(provenance.args[0], 'openai');
});

test('a terminal failure records provenance and keeps the turn\'s thoughts', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const { deps, calls } = makeDeps({
    queueRow: { ...processingRow },
    conversationProvider: 'cursor',
  });
  const { status, body } = await invokeResponse(deps, {
    messageId: 'q-1',
    conversationId: 'conv-1',
    terminalError: { code: 'quota_exceeded', stableCode: 'copilot.quota_exceeded', message: 'Monthly quota exhausted' },
  });
  assert.equal(status, 200);
  assert.equal(body.terminal, true);
  const provenance = calls.find((call) => call.stmt === 'setMessageExecutedProvider');
  assert.ok(provenance, 'the terminal path must record executed_provider');
  assert.equal(provenance.args[0], 'github');
  const thoughts = calls.find((call) => call.stmt === 'linkThoughtsToResponse');
  assert.ok(thoughts, 'a failed turn must keep its reasoning');
  assert.equal(thoughts.args[1], 'q-1');
  assert.ok(
    warns.mock.calls.some((call) => /PROVIDER MISMATCH/.test(String(call.arguments[0] || ''))),
    'the terminal crossover must be logged — this was the original incident signature',
  );
});

test('a worker answering another conversation\'s turn is flagged as a conversation mismatch', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const { deps } = makeDeps({
    queueRow: { ...processingRow },
    conversationProvider: 'cursor',
    runtimeSessionsBySid: { 'worker-sid': { provider_type: 'cursor', conversation_id: 'conv-OTHER' } },
  });
  const { status } = await invokeResponse(
    deps,
    { messageId: 'q-1', conversationId: 'conv-1', text: 'answer', model: 'grok-4.5', mode: 'agent' },
    { 'x-relay-session-id': 'worker-sid' },
  );
  assert.equal(status, 200);
  assert.ok(
    warns.mock.calls.some((call) => /CONVERSATION MISMATCH/.test(String(call.arguments[0] || ''))),
    'same-provider cross-conversation execution must be visible',
  );
});
