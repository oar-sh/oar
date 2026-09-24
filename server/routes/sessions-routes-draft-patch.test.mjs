import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { MAX_CONVERSATION_DRAFT_LENGTH, registerSessionsRoutes } from './sessions-routes.mjs';
import { MAX_DRAFT_TEXT_LENGTH, draftTextForSync } from '../public/app/conversation-draft-sync.mjs';

// Route-level coverage for PATCH /api/conversation/:id/draft's version check.
// From a client that declares the versioned protocol (draftSyncVersion: 2),
// an explicit `baseDraftUpdatedAt: null` means "this client has seen no draft"
// and must conflict with a versioned server draft. Older tabs send that same
// explicit null after every keystroke, so without the marker (or with no base
// at all) the save stays unconditional.

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
  });

  const patchDraft = async (conversationId, body) => {
    const handler = app.routes.get('PATCH /api/conversation/:id/draft');
    assert.ok(handler, 'the draft route should be registered');
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body, headers: {}, query: {}, params: { id: conversationId }, socket: {} }, res);
    return captured;
  };

  const insertConversation = (id, { draftText = null, draftUpdatedAt = null } = {}) => {
    const nowIso = '2026-09-24T10:00:00.000Z';
    db.prepare(`
      INSERT INTO conversations (id, title, created_at, status, updated_at, draft_text, draft_updated_at)
      VALUES (?, 'Draft test', ?, 'active', ?, ?, ?)
    `).run(id, nowIso, nowIso, draftText, draftUpdatedAt);
  };

  const readDraft = (id) => db.prepare(`SELECT draft_text, draft_updated_at FROM conversations WHERE id = ?`).get(id);

  return { patchDraft, insertConversation, readDraft, emitted };
}

const SERVER_VERSION = '2026-09-24T10:05:00.000Z';

test('an explicit null base conflicts with a versioned server draft and leaves it untouched', async () => {
  const { patchDraft, insertConversation, readDraft, emitted } = setup();
  insertConversation('conv-null-base', { draftText: 'typed on the phone', draftUpdatedAt: SERVER_VERSION });

  const response = await patchDraft('conv-null-base', { draftText: '', clientId: 'laptop', draftSyncVersion: 2, baseDraftUpdatedAt: null });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'draft-version-conflict');
  assert.equal(response.body.draftText, 'typed on the phone');
  assert.equal(response.body.draftUpdatedAt, SERVER_VERSION);
  assert.deepEqual(response.body.draftAttachments, []);
  assert.equal(readDraft('conv-null-base').draft_text, 'typed on the phone');
  assert.equal(emitted.length, 0, 'a rejected save broadcasts nothing');
});

test('the snake_case null base is conflict-checked the same way', async () => {
  const { patchDraft, insertConversation } = setup();
  insertConversation('conv-snake', { draftText: 'kept', draftUpdatedAt: SERVER_VERSION });

  const response = await patchDraft('conv-snake', { draftText: 'x', draftSyncVersion: 2, base_draft_updated_at: null });

  assert.equal(response.status, 409);
});

test('an explicit null base saves when the server has never versioned a draft', async () => {
  const { patchDraft, insertConversation, readDraft } = setup();
  insertConversation('conv-fresh');

  const response = await patchDraft('conv-fresh', { draftText: 'first words', clientId: 'laptop', draftSyncVersion: 2, baseDraftUpdatedAt: null });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(readDraft('conv-fresh').draft_text, 'first words');
  assert.ok(response.body.draftUpdatedAt, 'the save returns the new version');
});

test('a matching base saves; a stale base conflicts', async () => {
  const { patchDraft, insertConversation, readDraft } = setup();
  insertConversation('conv-versioned', { draftText: 'v1', draftUpdatedAt: SERVER_VERSION });

  const stale = await patchDraft('conv-versioned', { draftText: 'stale', baseDraftUpdatedAt: '2026-09-24T10:00:00.000Z' });
  assert.equal(stale.status, 409);

  const current = await patchDraft('conv-versioned', { draftText: 'v2', baseDraftUpdatedAt: SERVER_VERSION });
  assert.equal(current.status, 200);
  assert.equal(readDraft('conv-versioned').draft_text, 'v2');
});

test('an old tab\'s request shape (explicit null base, no protocol marker) still saves unconditionally', async () => {
  const { patchDraft, insertConversation, readDraft } = setup();
  insertConversation('conv-old-tab', { draftText: 'server text', draftUpdatedAt: SERVER_VERSION });

  // Exactly what pre-versioning clients send: JSON keeps the null.
  const response = await patchDraft('conv-old-tab', JSON.parse(JSON.stringify({
    draftText: 'typed in an old tab',
    clientId: 'old-tab',
    baseDraftUpdatedAt: null,
  })));

  assert.equal(response.status, 200, 'an old tab must not be 409ed into reverting its typing');
  assert.equal(readDraft('conv-old-tab').draft_text, 'typed in an old tab');
});

test('an old tab\'s non-null base is still version-checked, as before', async () => {
  const { patchDraft, insertConversation } = setup();
  insertConversation('conv-old-stale', { draftText: 'server text', draftUpdatedAt: SERVER_VERSION });

  const response = await patchDraft('conv-old-stale', {
    draftText: 'stale', clientId: 'old-tab', baseDraftUpdatedAt: '2026-09-24T10:00:00.000Z',
  });

  assert.equal(response.status, 409);
});

test('the web client caps drafts at exactly the server\'s truncation length', () => {
  assert.equal(MAX_DRAFT_TEXT_LENGTH, MAX_CONVERSATION_DRAFT_LENGTH);
});

test('a draft over the limit is stored truncated to exactly what the client compares against', async () => {
  const { patchDraft, insertConversation, readDraft } = setup();
  insertConversation('conv-long');
  const longText = 'y'.repeat(MAX_CONVERSATION_DRAFT_LENGTH + 250);

  const response = await patchDraft('conv-long', { draftText: longText, draftSyncVersion: 2, baseDraftUpdatedAt: null });

  assert.equal(response.status, 200);
  assert.equal(response.body.draftText, draftTextForSync(longText));
  assert.equal(readDraft('conv-long').draft_text.length, MAX_CONVERSATION_DRAFT_LENGTH);
});

test('an absent base (legacy client) still saves unconditionally', async () => {
  const { patchDraft, insertConversation, readDraft } = setup();
  insertConversation('conv-legacy', { draftText: 'server text', draftUpdatedAt: SERVER_VERSION });

  const response = await patchDraft('conv-legacy', { draftText: 'legacy overwrite', clientId: 'old-client' });

  assert.equal(response.status, 200);
  assert.equal(readDraft('conv-legacy').draft_text, 'legacy overwrite');
});
