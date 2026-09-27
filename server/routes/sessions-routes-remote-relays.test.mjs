import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { withRemotePromptHeader } from '../../shared/remote-relay-contract.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// The inbound side of remote relays on the conversation routes, against the
// REAL schema: a conversation another relay's agent bootstraps keeps its
// origin, the list and conversation payloads expose it (camelCase) for the
// "via <relay>" marker and the bubble badge, a public share hides the other
// relay's address, and the inbound switch refuses bootstrap and archive from
// agents only. Relay names, hosts and titles are fictional.

const NOW = '2026-09-24T10:00:00.000Z';

const ORIGIN = {
  relayId: 'relay-id-win',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-source-1',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};
const STORED_ORIGIN = { kind: 'agent', ...ORIGIN };
const agentHeaders = { 'x-oar-remote-origin': ORIGIN.relayId, 'x-oar-remote-hops': '1' };

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    put: record('PUT'),
    delete: record('DELETE'),
    use() {},
  };
}

function setup({ withRemoteRelays = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const repository = createRemoteRelayRepository(db);
  const inboundState = { enabled: true };
  const remoteRelayInbound = withRemoteRelays
    ? {
        repository,
        listRelays: () => [],
        selfNames: () => ['linux-test'],
        inboundEnabled: () => inboundState.enabled,
        recordUnlock: (conversationId, relayId, messageId) => repository.recordUnlock(conversationId, relayId, messageId),
        describeRelay: () => null,
      }
    : null;
  const emitted = [];
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (v) => v,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({
      models: ['gpt-5.4-mini'],
      currentModel: 'gpt-5.4-mini',
      defaultModel: 'gpt-5.4-mini',
      reasoningByModel: { 'gpt-5.4-mini': ['none'] },
      providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    }),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ ok: true }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'client-remote-1',
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-session-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'ask', 'plan', 'autopilot'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory: () => {},
    },
    sdkSessionImportService: null,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    isSha256: () => false,
    ...(remoteRelayInbound ? { remoteRelayInbound } : {}),
  });

  const call = async (key, { body = {}, headers = {}, params = {}, query = {} } = {}) => {
    const handler = app.routes.get(key);
    assert.ok(handler, `${key} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      set() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body, headers, query, params, socket: {} }, res);
    return captured;
  };

  const bootstrap = (body = {}, headers = {}) => call('POST /api/conversation/bootstrap', {
    body: { title: 'report builder follow-up', relayMode: 'agent', ...body },
    headers,
  });
  const insertMessage = (id, conversationId, role, text, origin = null) => {
    stmts.insertMsg.run(id, conversationId, role, text, 'gpt-5.4-mini', 'agent', null, NOW, null, null, null);
    if (origin) repository.setMessageOrigin(id, origin);
  };
  return { db, stmts, repository, inboundState, emitted, call, bootstrap, insertMessage };
}

test('a conversation another relay\'s agent bootstraps keeps its origin and exposes it everywhere', async () => {
  const fx = setup();
  const created = await fx.bootstrap({ origin: ORIGIN }, agentHeaders);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const conversationId = created.body.conversationId;
  assert.deepEqual(created.body.origin, STORED_ORIGIN);
  assert.deepEqual(fx.repository.getConversationOrigin(conversationId), STORED_ORIGIN);

  const list = await fx.call('GET /api/conversations');
  const listed = list.body.conversations.find((entry) => entry.id === conversationId);
  assert.deepEqual(listed.origin, STORED_ORIGIN);

  const header = withRemotePromptHeader('draft the summary', ORIGIN);
  fx.insertMessage('msg-user-1', conversationId, 'user', header, ORIGIN);
  fx.insertMessage('msg-assistant-1', conversationId, 'assistant', 'Here is the summary.');
  const single = await fx.call('GET /api/conversation/:id', { params: { id: conversationId } });
  assert.equal(single.status, 200);
  assert.deepEqual(single.body.origin, STORED_ORIGIN);
  const byId = new Map(single.body.messages.map((message) => [message.id, message]));
  const userMessage = byId.get('msg-user-1');
  const assistantMessage = byId.get('msg-assistant-1');
  assert.deepEqual(userMessage.origin, STORED_ORIGIN);
  // The header stays in the text: the browser hides it when origin is set.
  assert.equal(userMessage.text, header);
  assert.equal('origin' in assistantMessage, false);
});

test('conversations and messages the user made carry no origin', async () => {
  const fx = setup();
  const created = await fx.bootstrap();
  assert.equal(created.status, 200);
  assert.equal(created.body.origin, null);
  fx.insertMessage('msg-user-1', created.body.conversationId, 'user', 'hello');

  const list = await fx.call('GET /api/conversations');
  assert.equal(list.body.conversations[0].origin, null);
  const single = await fx.call('GET /api/conversation/:id', { params: { id: created.body.conversationId } });
  assert.equal(single.body.origin, null);
  assert.equal('origin' in single.body.messages[0], false);
});

test('a bootstrap with only the header records a minimal origin', async () => {
  const fx = setup();
  const created = await fx.bootstrap({}, { 'x-oar-remote-origin': 'relay-id-win', 'x-oar-remote-hops': '2' });
  assert.equal(created.status, 200);
  assert.equal(created.body.origin.relayId, 'relay-id-win');
  assert.equal(created.body.origin.hops, 2);
});

test('with the inbound switch off, an agent cannot bootstrap and nothing is created; the user can', async () => {
  const fx = setup();
  fx.inboundState.enabled = false;
  const refused = await fx.bootstrap({ origin: ORIGIN }, agentHeaders);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, {
    error: 'This relay does not accept prompts from other relays\' agents',
    code: 'REMOTE_INBOUND_DISABLED',
  });
  const headerOnly = await fx.bootstrap({}, agentHeaders);
  assert.equal(headerOnly.status, 403);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get().n, 0);

  const human = await fx.bootstrap();
  assert.equal(human.status, 200);
});

test('with the inbound switch off, an agent cannot archive; the user still can', async () => {
  const fx = setup();
  const created = await fx.bootstrap();
  const conversationId = created.body.conversationId;
  fx.inboundState.enabled = false;

  const refused = await fx.call('POST /api/conversation/:id/archive', { params: { id: conversationId }, headers: agentHeaders });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'REMOTE_INBOUND_DISABLED');
  assert.equal(fx.db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(conversationId).archived, 0);

  const archived = await fx.call('POST /api/conversation/:id/archive', { params: { id: conversationId } });
  assert.equal(archived.status, 200);
  assert.equal(fx.db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(conversationId).archived, 1);
});

test('with the inbound switch on, an agent may archive', async () => {
  const fx = setup();
  const created = await fx.bootstrap({ origin: ORIGIN }, agentHeaders);
  const archived = await fx.call('POST /api/conversation/:id/archive', {
    params: { id: created.body.conversationId },
    headers: agentHeaders,
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.ok, true);
});

test('without the remote relay deps an origin is ignored and nothing is refused', async () => {
  const fx = setup({ withRemoteRelays: false });
  const created = await fx.bootstrap({ origin: ORIGIN }, agentHeaders);
  assert.equal(created.status, 200);
  assert.equal(created.body.origin, null);
  assert.equal(fx.repository.getConversationOrigin(created.body.conversationId), null);
});

test('a public share shows the badge facts but not the other relay\'s address or ids', async () => {
  const fx = setup();
  const created = await fx.bootstrap({ origin: ORIGIN }, agentHeaders);
  const conversationId = created.body.conversationId;
  fx.insertMessage('msg-user-1', conversationId, 'user', withRemotePromptHeader('draft the summary', ORIGIN), ORIGIN);
  const token = 'a'.repeat(64);
  fx.db.prepare(`
    INSERT INTO conversation_shares (token, conversation_id, created_at, last_accessed_at, revoked_at)
    VALUES (?, ?, ?, ?, NULL)
  `).run(token, conversationId, NOW, NOW);

  const shared = await fx.call('GET /api/shared/:token', { params: { token } });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const [message] = shared.body.messages;
  assert.deepEqual(message.origin, {
    ...STORED_ORIGIN,
    relayId: '',
    relayUrl: '',
    conversationId: '',
  });
  assert.equal(JSON.stringify(shared.body).includes('relay-a.example.test'), false);
});

test('deleting a conversation forgets its remote relay unlocks', async () => {
  const fx = setup();
  const created = await fx.bootstrap();
  const conversationId = created.body.conversationId;
  fx.repository.recordUnlock(conversationId, 'r-linux', 'msg-1');
  fx.repository.recordUnlock('conv-other', 'r-linux', 'msg-2');

  const deleted = await fx.call('DELETE /api/conversation/:id', { params: { id: conversationId } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(fx.repository.listUnlocks(conversationId), []);
  assert.equal(fx.repository.listUnlocks('conv-other').length, 1);
});
