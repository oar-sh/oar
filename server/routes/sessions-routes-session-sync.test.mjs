import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { createSdkSessionImportService } from '../services/sdk-session-import-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// Route-level coverage for POST /api/session-sync and
// POST /api/conversation/:id/refresh-history.
//
// Audit #21: a binding conflict must veto the request BEFORE workspace
// learning creates or mutates any row — a 409 leaves every table untouched.
// Audit #22: a placeholder→real rekey must migrate every live queue row and
// the in-memory worker-registry entry atomically with the binding.
// Audit #19: refresh-history must report relay ownership precisely instead of
// the misleading "already in progress".

const WORKSPACE_ROOT = '/home/dev/project';

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

// Mirrors the import-relevant behavior of server-runtime's
// ensureRuntimeSessionBinding: reuse the conversation's binding or create one.
function makeEnsureRuntimeSessionBinding(db) {
  const getByConversation = db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ?`);
  const insert = db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id)
    VALUES (?, ?, 'isolated', ?, ?, 'active', ?, ?, ?)
  `);
  return (conversationId, model, nowIso, sdkSessionId = null) => {
    const existing = getByConversation.get(conversationId);
    if (existing?.id) return existing;
    const id = `rs-${conversationId}`;
    insert.run(id, conversationId, id, model || null, nowIso, nowIso, sdkSessionId);
    return getByConversation.get(conversationId);
  };
}

// Mirrors the table writes of server-runtime's learnConversationWorkspaceRoot,
// so the rollback test exercises the same mutations production performs (the
// conversation auto-create is the state audit #21 saw leak past a 409).
function makeLearnConversationWorkspaceRoot(db, stmts) {
  return ({ sdkSessionId = '', conversationId = '', rootPath = '' } = {}) => {
    const convId = String(conversationId || '').trim();
    const sid = String(sdkSessionId || '').trim();
    const nowIso = new Date().toISOString();
    if (convId && !db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(convId)) {
      stmts.insertConv.run(convId, 'Session', nowIso, nowIso);
      if (sid) stmts.setConvSdkSessionIdIfMissing.run(sid, nowIso, convId);
    }
    const row = convId ? db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId) : null;
    if (!row) return { ok: false, learned: false, changed: false, error: 'Conversation not found' };
    stmts.updateConvRuntimeWorkspaceRoot.run(rootPath, nowIso, row.id);
    stmts.seedConvConfiguredWorkspaceRootIfMissing.run(rootPath, nowIso, row.id);
    stmts.upsertRecentWorkspaceRoot.run(rootPath.toLowerCase(), rootPath, nowIso);
    return {
      ok: true,
      state: {
        conversationId: row.id,
        sdkSessionId: sid || null,
        runtimeWorkspaceRootPath: rootPath,
        currentWorkspaceRootPath: rootPath,
      },
    };
  };
}

function setup({ eventsBySession = {} } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  // Mirror the runtime's stmts composition (server-runtime.mjs): message
  // statements come from message-repository, not session-repository.
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const emitted = [];
  const app = createMockApp();
  const sessionWorkerRegistry = createSessionWorkerRegistry();

  const client = {
    async listSessions() {
      return Object.keys(eventsBySession).map((sessionId) => ({
        sessionId,
        metadata: { title: `Title ${sessionId}` },
      }));
    },
    async resumeSession(sessionId) {
      return {
        async getEvents() { return eventsBySession[sessionId]; },
        async disconnect() {},
      };
    },
  };
  const replaceRetrievableHistory = (conversationId, messages) => {
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    const insert = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const [index, message] of messages.entries()) {
      insert.run(message.id, conversationId, message.role, message.text, `2026-07-01T10:00:0${index}.000Z`);
    }
  };
  const sdkSessionImportService = createSdkSessionImportService({
    db,
    stmts,
    createClient: async () => ({ client, async dispose() {} }),
    parseSessionEventsToMessages: (events) => events.map((event) => ({ id: event.id, role: event.role, text: event.text })),
    replaceRetrievableHistory,
    ensureRuntimeSessionBinding: makeEnsureRuntimeSessionBinding(db),
    hasRelayExecutionSignal: (sdkSessionId) => !!sessionWorkerRegistry.getWorker(sdkSessionId),
    logger: { info() {} },
  });

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
    learnConversationWorkspaceRoot: makeLearnConversationWorkspaceRoot(db, stmts),
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
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry,
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory,
    },
    sdkSessionImportService,
  });

  const call = async (routeKey, { body = {}, params = {}, query = {} } = {}) => {
    const handler = app.routes.get(routeKey);
    assert.ok(handler, `${routeKey} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body, headers: {}, query, params, socket: {} }, res);
    return captured;
  };

  const snapshotTables = () => ({
    conversations: db.prepare('SELECT * FROM conversations ORDER BY id').all(),
    runtimeSessions: db.prepare('SELECT * FROM runtime_sessions ORDER BY id').all(),
    queue: db.prepare('SELECT * FROM queue ORDER BY id').all(),
    recentWorkspaceRoots: db.prepare('SELECT * FROM recent_workspace_roots ORDER BY path_key').all(),
    imports: db.prepare('SELECT * FROM sdk_session_imports ORDER BY sdk_session_id').all(),
  });

  return { db, stmts, call, emitted, sessionWorkerRegistry, sdkSessionImportService, snapshotTables, eventsBySession };
}

test('a sync rejected with 409 leaves every table exactly as it found it', async () => {
  const { db, call, snapshotTables } = setup();
  const nowIso = '2026-07-01T10:00:00.000Z';
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, sdk_session_id, status, updated_at)
    VALUES ('conv-owner', 'Owner', ?, 'sdk-taken', 'active', ?)
  `).run(nowIso, nowIso);
  const before = snapshotTables();

  const response = await call('POST /api/session-sync', {
    body: {
      sdk_session_id: 'sdk-taken',
      conversation_id: 'conv-new',
      workspace_root_path: WORKSPACE_ROOT,
    },
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'binding-conflict');
  // Workspace learning would have created 'conv-new' and a recent-root row;
  // the validate-first transaction must roll all of it back (audit #21).
  assert.deepEqual(snapshotTables(), before);
});

test('placeholder rekey migrates live queue rows and the registry entry atomically', async () => {
  const { db, call, sessionWorkerRegistry } = setup();
  const nowIso = '2026-07-01T10:00:00.000Z';
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, sdk_session_id, status, updated_at)
    VALUES ('conv-p', 'Placeholder', ?, 'conv-p', 'active', ?)
  `).run(nowIso, nowIso);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, status, strategy, runtime_key, model, created_at, last_used_at)
    VALUES ('rt-p', 'conv-p', 'conv-p', 'active', 'isolated', 'rt-p', NULL, ?, ?)
  `).run(nowIso, nowIso);
  const insertQueueRow = db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, attempt_id, text, timestamp)
    VALUES (?, 'conv-p', ?, 'conv-p', ?, 'prompt', ?)
  `);
  insertQueueRow.run('q-pending', 'pending', 'attempt-1', nowIso);
  insertQueueRow.run('q-processing', 'processing', 'attempt-2', nowIso);
  insertQueueRow.run('q-parked', 'parked', 'attempt-3', nowIso);
  sessionWorkerRegistry.upsertWorker({
    sdkSessionId: 'conv-p',
    conversationId: 'conv-p',
    workerId: 'worker-p',
    runtimeSessionId: 'rt-p',
    status: 'processing',
    pid: 4242,
  });

  const response = await call('POST /api/session-sync', {
    body: {
      sdk_session_id: 'sdk-real',
      conversation_id: 'conv-p',
      workspace_root_path: WORKSPACE_ROOT,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.session.sdkSessionId, 'sdk-real');
  assert.equal(db.prepare(`SELECT sdk_session_id FROM conversations WHERE id = 'conv-p'`).get().sdk_session_id, 'sdk-real');
  assert.equal(db.prepare(`SELECT sdk_session_id FROM runtime_sessions WHERE id = 'rt-p'`).get().sdk_session_id, 'sdk-real');
  // Every live row migrated; attempt fences untouched (Phase 1 fencing).
  assert.deepEqual(
    db.prepare(`SELECT id, owner_sdk_session_id, attempt_id FROM queue ORDER BY id`).all(),
    [
      { id: 'q-parked', owner_sdk_session_id: 'sdk-real', attempt_id: 'attempt-3' },
      { id: 'q-pending', owner_sdk_session_id: 'sdk-real', attempt_id: 'attempt-1' },
      { id: 'q-processing', owner_sdk_session_id: 'sdk-real', attempt_id: 'attempt-2' },
    ],
  );
  // Exactly one registry entry, keyed by the real id, reachable through every
  // secondary index — the placeholder entry must not linger.
  const workers = sessionWorkerRegistry.listWorkers();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].sdkSessionId, 'sdk-real');
  assert.equal(workers[0].pid, 4242);
  assert.equal(sessionWorkerRegistry.getWorker('conv-p'), null);
  assert.equal(sessionWorkerRegistry.getWorkerByWorkerId('worker-p')?.sdkSessionId, 'sdk-real');
  assert.equal(sessionWorkerRegistry.getWorkerByConversationId('conv-p')?.sdkSessionId, 'sdk-real');
  assert.equal(sessionWorkerRegistry.getWorkerByRuntimeSessionId('rt-p')?.sdkSessionId, 'sdk-real');
});

test('refresh-history re-imports an imported-only conversation from changed source events', async () => {
  const { call, sdkSessionImportService, eventsBySession } = setup({
    eventsBySession: { 'imp-1': [{ id: 'm1', role: 'user', text: 'original' }] },
  });
  await sdkSessionImportService.runStartupImport();
  eventsBySession['imp-1'] = [{ id: 'm2', role: 'user', text: 'updated upstream' }];

  const response = await call('POST /api/conversation/:id/refresh-history', {
    params: { id: 'imp-1' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.refreshed, true);
  assert.deepEqual(
    response.body.messages.map((message) => message.text),
    ['updated upstream'],
  );
});

test('refresh-history reports relay ownership precisely instead of "already in progress"', async () => {
  const { db, call, sdkSessionImportService } = setup({
    eventsBySession: { 'imp-1': [{ id: 'm1', role: 'user', text: 'original' }] },
  });
  await sdkSessionImportService.runStartupImport();
  // The user continued the imported conversation in the relay.
  db.prepare(`
    INSERT INTO queue (id, conversation_id, status, owner_sdk_session_id, text, timestamp)
    VALUES ('q-1', 'imp-1', 'pending', 'imp-1', 'go on', '2026-07-02T10:00:00.000Z')
  `).run();

  const response = await call('POST /api/conversation/:id/refresh-history', {
    params: { id: 'imp-1' },
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'relay-owned');
  assert.match(response.body.error, /owned by the relay/);
});
