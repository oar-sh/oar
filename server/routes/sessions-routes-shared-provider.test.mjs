import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// The shared payload names the provider the conversation is bound to (and
// nothing else of its runtime session), so the shared view does not mark
// every reply of a non-Copilot conversation as having run elsewhere.

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

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const emitted = [];
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    hydrateAttachment: (v) => v,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pending: 0, processing: 0 }),
    getModelCatalogState: () => ({}),
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
    ensureSessionId: () => true,
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'plan'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: '',
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
  });

  const call = async (routeKey, { params = {}, body = {}, query = {} } = {}) => {
    const handler = app.routes.get(routeKey);
    assert.ok(handler, `${routeKey} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body, headers: {}, query, params, socket: {}, protocol: 'http', get: () => 'relay.example.test' }, res);
    return captured;
  };

  const insertConversation = (id, status = 'active') => {
    db.prepare(`
      INSERT INTO conversations (id, title, created_at, status, updated_at)
      VALUES (?, 'Provider test', '2026-10-05T09:00:00.000Z', ?, '2026-10-05T09:00:00.000Z')
    `).run(id, status);
  };
  const insertMessage = (conversationId, id, role, text, timestamp, extra = {}) => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, attachments, hidden_from_shares, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, text, extra.attachments || null, extra.hidden ? 1 : 0, timestamp);
  };
  const bindProvider = (conversationId, providerType) => db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, 'demo-model', ?, 'active', '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z')
  `).run(`rs-${conversationId}`, conversationId, `sdk-${conversationId}`, `key-${conversationId}`, providerType);
  const markExecuted = (messageId, provider) => db.prepare(`UPDATE messages SET executed_provider = ? WHERE id = ?`).run(provider, messageId);

  return { db, call, bindProvider, markExecuted, insertConversation, insertMessage };
}

async function loadShared(fx, conversationId) {
  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: conversationId } });
  assert.equal(share.status, 200);
  const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });
  assert.equal(shared.status, 200);
  return shared.body;
}

function seedTurn(fx, conversationId) {
  fx.insertConversation(conversationId);
  fx.insertMessage(conversationId, `${conversationId}-user`, 'user', 'Summarise the report builder.', '2026-10-16T10:00:00.000Z');
  fx.insertMessage(conversationId, `${conversationId}-reply`, 'assistant', 'It builds the nightly report.', '2026-10-16T10:00:05.000Z');
}

test('the shared payload carries the bound provider, and the reply the provider it ran on', async () => {
  const fx = setup();
  seedTurn(fx, 'conv-claude');
  fx.bindProvider('conv-claude', 'Claude');
  fx.markExecuted('conv-claude-reply', 'claude');

  const body = await loadShared(fx, 'conv-claude');

  assert.equal(body.runtimeProviderType, 'claude');
  assert.equal(body.messages.find((message) => message.id === 'conv-claude-reply').executedProvider, 'claude');
  // The rest of the runtime session stays private.
  assert.equal(body.runtimeSession, null);
  assert.doesNotMatch(JSON.stringify(body), /sdk-conv-claude|rs-conv-claude|key-conv-claude|demo-model/);
});

test('a conversation without a bound provider says so with null, not with a guess', async () => {
  const fx = setup();
  seedTurn(fx, 'conv-unbound');
  fx.markExecuted('conv-unbound-reply', 'cursor');

  const body = await loadShared(fx, 'conv-unbound');

  assert.equal('runtimeProviderType' in body, true);
  assert.equal(body.runtimeProviderType, null);
});
