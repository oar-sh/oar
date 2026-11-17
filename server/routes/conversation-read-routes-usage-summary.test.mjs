import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// `sessionUsageSummary` on GET /api/conversation/:id and on
// POST /api/conversation/:id/refresh-history: the sum of the conversation's
// usage snapshots, read by conversation id. A conversation whose SDK session
// id differs still gets its own snapshots; one with none gets null.

const CONV = 'conv-usage-fixture';
const SDK_SESSION = 'sdk-session-usage-fixture';
const BARE = 'conv-usage-bare';
const at = (n) => new Date(Date.UTC(2026, 2, 1) + n * 1000).toISOString();

function seed(db) {
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, 'Widget usage', ?, ?, ?)`).run(CONV, SDK_SESSION, at(0), at(0));
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'No usage', ?, ?)`).run(BARE, at(0), at(0));
  const snapshots = [
    { plan: 2, premium: 1 },
    { plan: 3, premium: null },
  ];
  snapshots.forEach(({ plan, premium }, turn) => {
    const reply = `reply-${turn}`;
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, mode, timestamp) VALUES (?, ?, 'assistant', ?, 'agent', ?)`).run(reply, CONV, `Done with step ${turn}.`, at(turn * 10 + 5));
    db.prepare(`INSERT INTO message_usage_snapshots (response_message_id, conversation_id, plan_delta_used, plan_entitlement, premium_delta_used, captured_at) VALUES (?, ?, ?, 50, ?, ?)`)
      .run(reply, CONV, plan, premium, at(turn * 10 + 6));
  });
}

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  seed(db);
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
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
    subagentRunsForResponse: () => [],
    workflowRunsForResponse: () => [],
    previewCardsForResponse: () => [],
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
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
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
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory: () => {},
    },
    sdkSessionImportService: { refreshConversation: async () => ({ status: 'completed' }) },
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
  });
  const call = async (key, id) => {
    const handler = app.routes.get(key);
    assert.ok(handler, key);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body: {}, headers: {}, query: {}, params: { id }, socket: {}, protocol: 'http', get: () => 'relay.example.test' }, res);
    assert.equal(captured.status, 200, JSON.stringify(captured.body));
    return captured.body;
  };
  return { call };
}

const ROUTES = ['GET /api/conversation/:id', 'POST /api/conversation/:id/refresh-history'];

for (const route of ROUTES) {
  test(`${route}: the summary sums the conversation's snapshots, whatever its SDK session id`, async () => {
    const { call } = setup();
    const summary = (await call(route, CONV)).sessionUsageSummary;
    assert.equal(summary?.source, 'usage-snapshots');
    assert.equal(summary.planCreditsUsed, 5);
    assert.equal(summary.planEntitlement, 50);
    assert.equal(summary.planMonthlyPercentUsed, 10);
    assert.equal(summary.premiumCreditsUsed, 1);
    assert.equal(summary.premiumRequestEstimate, 1);
    assert.equal(summary.aicUsed, 5);
    assert.equal(summary.capturedAt, at(16));
  });

  test(`${route}: a conversation with no snapshots has no summary`, async () => {
    const { call } = setup();
    assert.equal((await call(route, BARE)).sessionUsageSummary, null);
  });
}
