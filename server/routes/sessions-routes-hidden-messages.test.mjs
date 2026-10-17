import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// Route-level coverage for the hidden-messages list: the owner payload's
// `hiddenMessages`, the share-visibility routes' answers and broadcasts, the
// unhide-all route, and the list's absence from the shared payload.

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
      VALUES (?, 'Hidden list test', '2026-10-05T09:00:00.000Z', ?, '2026-10-05T09:00:00.000Z')
    `).run(id, status);
  };
  const insertMessage = (conversationId, id, role, text, timestamp, extra = {}) => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, attachments, hidden_from_shares, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, text, extra.attachments || null, extra.hidden ? 1 : 0, timestamp);
  };
  const setHidden = (conversationId, messageId, hiddenFromShares) => call('PATCH /api/conversation/:id/message/:messageId/share-visibility', {
    params: { id: conversationId, messageId },
    body: { hiddenFromShares },
  });
  const unhideAll = (conversationId) => call('POST /api/conversation/:id/share-visibility/unhide-all', {
    params: { id: conversationId },
  });
  const hiddenFlag = (id) => db.prepare(`SELECT hidden_from_shares FROM messages WHERE id = ?`).get(id)?.hidden_from_shares;
  const startTurn = (conversationId, queueId, responseMessageId = null) => db.prepare(`
    INSERT INTO queue (id, conversation_id, response_message_id, text, status, timestamp)
    VALUES (?, ?, ?, 'still working', 'processing', '2026-10-16T10:02:00.000Z')
  `).run(queueId, conversationId, responseMessageId);

  return { db, call, setHidden, unhideAll, hiddenFlag, startTurn, insertConversation, insertMessage, emitted };
}

function seedTwoTurns(fx, conversationId = 'conv-1') {
  fx.insertConversation(conversationId);
  fx.insertMessage(conversationId, 'user-1', 'user', 'Where is the staging token?', '2026-10-16T10:00:00.000Z');
  fx.insertMessage(conversationId, 'reply-1', 'assistant', '## Token\n\nIt is in the **vault**.', '2026-10-16T10:00:05.000Z');
  fx.insertMessage(conversationId, 'user-2', 'user', 'And the report builder?', '2026-10-16T10:01:00.000Z');
  fx.insertMessage(conversationId, 'reply-2', 'assistant', 'It runs nightly.', '2026-10-16T10:01:05.000Z');
}

const hiddenEvents = (fx) => fx.emitted.filter(([event]) => event === 'conversation_hidden_messages_updated');

test('hiding answers with the whole hidden list and tells every client', async () => {
  const fx = setup();
  seedTwoTurns(fx);

  const response = await fx.setHidden('conv-1', 'reply-1', true);

  assert.equal(response.status, 200);
  assert.equal(response.body.hiddenFromShares, true);
  assert.deepEqual(response.body.hiddenMessages.map((item) => item.messageId), ['reply-1']);
  assert.equal(response.body.hiddenMessages[0].preview, 'Token It is in the vault.');
  assert.equal(response.body.hiddenMessages[0].role, 'assistant');
  assert.match(String(response.body.hiddenMessages[0].hiddenAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fx.emitted, [['conversation_hidden_messages_updated', {
    conversationId: 'conv-1',
    hiddenMessages: response.body.hiddenMessages,
    revision: response.body.hiddenMessagesRevision,
  }]]);
});

test('every change gets a higher revision, a repeat none, and a load carries the current one', async () => {
  const fx = setup();
  seedTwoTurns(fx);

  const before = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: {} });
  const first = await fx.setHidden('conv-1', 'user-1', true);
  const second = await fx.setHidden('conv-1', 'reply-2', true);
  const repeated = await fx.setHidden('conv-1', 'reply-2', true);
  const third = await fx.setHidden('conv-1', 'user-1', false);
  const after = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: {} });

  assert.ok(Number.isFinite(before.body.hiddenMessagesRevision) && before.body.hiddenMessagesRevision > 0);
  assert.deepEqual(before.body.hiddenMessages, []);
  assert.ok(first.body.hiddenMessagesRevision > before.body.hiddenMessagesRevision);
  assert.ok(second.body.hiddenMessagesRevision > first.body.hiddenMessagesRevision, 'also within one millisecond');
  assert.equal(repeated.body.hiddenMessagesRevision, second.body.hiddenMessagesRevision, 'no change, no new revision');
  assert.ok(third.body.hiddenMessagesRevision > second.body.hiddenMessagesRevision);
  assert.equal(after.body.hiddenMessagesRevision, third.body.hiddenMessagesRevision);
  assert.deepEqual(after.body.hiddenMessages.map((item) => item.messageId), ['reply-2']);
  assert.deepEqual(hiddenEvents(fx).map(([, payload]) => payload.revision), [
    first.body.hiddenMessagesRevision,
    second.body.hiddenMessagesRevision,
    third.body.hiddenMessagesRevision,
  ]);
});

test('the owner payload lists hidden messages outside the loaded page too', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.setHidden('conv-1', 'user-1', true);
  await fx.setHidden('conv-1', 'reply-2', true);

  const page = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: { limit: '1' } });

  assert.equal(page.status, 200);
  assert.deepEqual(page.body.messages.map((message) => message.id), ['reply-2']);
  assert.deepEqual(page.body.hiddenMessages.map((item) => item.messageId), ['user-1', 'reply-2']);
});

test('hiding a pinned message also refreshes the pin list, whose rows carry the mark', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.call('PATCH /api/conversation/:id/message/:messageId/pin', { params: { id: 'conv-1', messageId: 'reply-1' }, body: { pinned: true } });
  fx.emitted.length = 0;

  await fx.setHidden('conv-1', 'reply-1', true);
  const pinEvent = fx.emitted.find(([event]) => event === 'conversation_pins_updated');
  assert.ok(pinEvent, 'the pin list goes out again');
  assert.equal(pinEvent[1].pins[0].hiddenFromShares, true);

  fx.emitted.length = 0;
  await fx.setHidden('conv-1', 'user-2', true);
  assert.equal(fx.emitted.some(([event]) => event === 'conversation_pins_updated'), false, 'an unpinned message leaves the pins alone');
});

test('unhide all shows every hidden message again and broadcasts once', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.setHidden('conv-1', 'user-1', true);
  await fx.setHidden('conv-1', 'reply-2', true);
  fx.emitted.length = 0;

  const response = await fx.unhideAll('conv-1');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.unhidden, ['user-1', 'reply-2']);
  assert.deepEqual(response.body.skipped, []);
  assert.deepEqual(response.body.hiddenMessages, []);
  assert.equal(fx.hiddenFlag('user-1'), 0);
  assert.equal(fx.hiddenFlag('reply-2'), 0);
  assert.deepEqual(fx.emitted, [['conversation_hidden_messages_updated', {
    conversationId: 'conv-1',
    hiddenMessages: [],
    revision: response.body.hiddenMessagesRevision,
  }]]);

  const again = await fx.unhideAll('conv-1');
  assert.deepEqual(again.body.unhidden, []);
  assert.equal(again.body.hiddenMessagesRevision, response.body.hiddenMessagesRevision);
  assert.equal(fx.emitted.length, 1, 'nothing changed, nothing broadcast');
});

test('a message of a running turn stays hidden: refused alone, skipped by unhide all', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.setHidden('conv-1', 'user-1', true);
  await fx.setHidden('conv-1', 'reply-2', true);
  fx.startTurn('conv-1', 'queue-run', 'reply-2');

  const single = await fx.setHidden('conv-1', 'reply-2', false);
  assert.equal(single.status, 409);
  assert.equal(fx.hiddenFlag('reply-2'), 1);

  const response = await fx.unhideAll('conv-1');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.unhidden, ['user-1']);
  assert.deepEqual(response.body.skipped, [{ messageId: 'reply-2', reason: 'active-turn' }]);
  assert.deepEqual(response.body.hiddenMessages.map((item) => item.messageId), ['reply-2']);
  assert.equal(fx.hiddenFlag('user-1'), 0);
  assert.equal(fx.hiddenFlag('reply-2'), 1);
});

test('unhide all refuses a missing or deleted conversation', async () => {
  const fx = setup();
  fx.insertConversation('conv-gone', 'deleted');
  assert.equal((await fx.unhideAll('conv-none')).status, 404);
  assert.equal((await fx.unhideAll('conv-gone')).status, 404);
});

test('the shared payload says nothing about the hidden list', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.setHidden('conv-1', 'reply-1', true);

  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });
  assert.equal(share.status, 200);
  const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });

  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.messages.map((message) => message.id), ['user-1', 'user-2', 'reply-2']);
  assert.equal('hiddenMessages' in shared.body, false);
  assert.equal('hiddenMessagesRevision' in shared.body, false);
  assert.doesNotMatch(JSON.stringify(shared.body), /vault/);
});

test('the unhide-all route sits behind auth', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /app\.post\('\/api\/conversation\/:id\/share-visibility\/unhide-all', auth/);
});
