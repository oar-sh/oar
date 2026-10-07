import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { MESSAGE_PIN_LIMIT } from '../services/message-pin-list.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// Route-level coverage for PATCH /api/conversation/:id/message/:messageId/pin,
// the pin list in the owner's conversation payload, and its absence from the
// shared one.

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
      VALUES (?, 'Pin test', '2026-10-05T09:00:00.000Z', ?, '2026-10-05T09:00:00.000Z')
    `).run(id, status);
  };
  const insertMessage = (conversationId, id, role, text, timestamp, extra = {}) => {
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, text, attachments, hidden_from_shares, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, role, text, extra.attachments || null, extra.hidden ? 1 : 0, timestamp);
  };
  const pin = (conversationId, messageId, pinned) => call('PATCH /api/conversation/:id/message/:messageId/pin', {
    params: { id: conversationId, messageId },
    body: { pinned },
  });
  const pinnedAt = (id) => db.prepare(`SELECT pinned_at FROM messages WHERE id = ?`).get(id)?.pinned_at ?? null;

  return { db, call, pin, pinnedAt, insertConversation, insertMessage, emitted };
}

function seedTwoTurns(fx, conversationId = 'conv-1') {
  fx.insertConversation(conversationId);
  fx.insertMessage(conversationId, 'user-1', 'user', 'How do I tag the build?', '2026-10-05T10:00:00.000Z');
  fx.insertMessage(conversationId, 'reply-1', 'assistant', '## Steps\n\n1. Run the tag script.', '2026-10-05T10:00:05.000Z');
  fx.insertMessage(conversationId, 'user-2', 'user', 'And the notes?', '2026-10-05T10:01:00.000Z');
  fx.insertMessage(conversationId, 'reply-2', 'assistant', 'Written to the changelog.', '2026-10-05T10:01:05.000Z');
}

test('pinning stores the time, answers with the list and tells every client', async () => {
  const fx = setup();
  seedTwoTurns(fx);

  const response = await fx.pin('conv-1', 'reply-2', true);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.pinned, true);
  assert.equal(response.body.messageId, 'reply-2');
  assert.deepEqual(response.body.pins.map((item) => item.messageId), ['reply-2']);
  assert.equal(response.body.pins[0].preview, 'Written to the changelog.');
  assert.equal(response.body.pins[0].role, 'assistant');
  assert.match(String(fx.pinnedAt('reply-2')), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fx.emitted, [['conversation_pins_updated', {
    conversationId: 'conv-1',
    pins: response.body.pins,
    revision: response.body.pinsRevision,
  }]]);
});

test('every change gets a higher revision, and a load carries the one it was built at', async () => {
  const fx = setup();
  seedTwoTurns(fx);

  const before = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: {} });
  const first = await fx.pin('conv-1', 'user-1', true);
  const second = await fx.pin('conv-1', 'reply-1', true);
  const repeated = await fx.pin('conv-1', 'reply-1', true);
  const third = await fx.pin('conv-1', 'user-1', false);
  const after = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: {} });

  assert.ok(Number.isFinite(before.body.pinsRevision) && before.body.pinsRevision > 0);
  assert.ok(first.body.pinsRevision > before.body.pinsRevision, 'a load from before the change is older');
  assert.ok(second.body.pinsRevision > first.body.pinsRevision, 'also within one millisecond');
  assert.equal(repeated.body.pinsRevision, second.body.pinsRevision, 'no change, no new revision');
  assert.ok(third.body.pinsRevision > second.body.pinsRevision);
  assert.equal(after.body.pinsRevision, third.body.pinsRevision);
  assert.deepEqual(fx.emitted.map(([, payload]) => payload.revision), [
    first.body.pinsRevision,
    second.body.pinsRevision,
    third.body.pinsRevision,
  ]);
});

test('the list is in conversation order, whatever the order of pinning', async () => {
  const fx = setup();
  seedTwoTurns(fx);

  await fx.pin('conv-1', 'reply-2', true);
  await fx.pin('conv-1', 'user-1', true);
  const response = await fx.pin('conv-1', 'reply-1', true);

  assert.deepEqual(response.body.pins.map((item) => item.messageId), ['user-1', 'reply-1', 'reply-2']);
  assert.equal(response.body.pins[1].preview, 'Steps Run the tag script.');
});

test('unpinning clears the mark and broadcasts the shorter list', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.pin('conv-1', 'user-1', true);
  await fx.pin('conv-1', 'reply-1', true);
  fx.emitted.length = 0;

  const response = await fx.pin('conv-1', 'user-1', false);

  assert.equal(response.status, 200);
  assert.equal(response.body.pinned, false);
  assert.deepEqual(response.body.pins.map((item) => item.messageId), ['reply-1']);
  assert.equal(fx.pinnedAt('user-1'), null);
  assert.equal(fx.emitted.length, 1);
  assert.deepEqual(fx.emitted[0][1].pins.map((item) => item.messageId), ['reply-1']);
});

test('a repeated request changes nothing and broadcasts nothing', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.pin('conv-1', 'user-1', true);
  const firstPinnedAt = fx.pinnedAt('user-1');
  fx.emitted.length = 0;

  const again = await fx.pin('conv-1', 'user-1', true);
  const neverPinned = await fx.pin('conv-1', 'reply-2', false);

  assert.equal(again.status, 200);
  assert.equal(again.body.pins.length, 1);
  assert.equal(fx.pinnedAt('user-1'), firstPinnedAt, 'the first pin time stays');
  assert.equal(neverPinned.status, 200);
  assert.equal(fx.emitted.length, 0);
});

test('a message of a running turn can be pinned: nothing public depends on it', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  fx.db.prepare(`INSERT INTO queue (id, conversation_id, status, text, timestamp) VALUES ('user-2', 'conv-1', 'processing', 'And the notes?', '2026-10-05T10:01:00.000Z')`).run();

  const response = await fx.pin('conv-1', 'user-2', true);

  assert.equal(response.status, 200);
  assert.equal(response.body.pinned, true);
});

test('bad requests are refused before anything is written', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  fx.insertConversation('conv-other');
  fx.insertMessage('conv-other', 'other-1', 'user', 'elsewhere', '2026-10-05T10:00:00.000Z');
  fx.insertConversation('conv-deleted', 'deleted');
  fx.insertMessage('conv-deleted', 'deleted-1', 'user', 'gone', '2026-10-05T10:00:00.000Z');

  assert.equal((await fx.pin('conv-1', 'user-1', 'yes')).status, 400);
  assert.equal((await fx.pin('conv-1', 'user-1', undefined)).status, 400);
  assert.equal((await fx.pin('', 'user-1', true)).status, 400);
  assert.equal((await fx.pin('conv-missing', 'user-1', true)).status, 404);
  assert.equal((await fx.pin('conv-1', 'msg-missing', true)).status, 404);
  assert.equal((await fx.pin('conv-1', 'other-1', true)).status, 404, 'a message of another conversation');
  assert.equal((await fx.pin('conv-deleted', 'deleted-1', true)).status, 404);

  assert.equal(fx.pinnedAt('user-1'), null);
  assert.equal(fx.pinnedAt('other-1'), null);
  assert.equal(fx.emitted.length, 0);
});

test('the pin after the limit is refused, and unpinning makes room again', async () => {
  const fx = setup();
  fx.insertConversation('conv-full');
  const insert = fx.db.prepare(`
    INSERT INTO messages (id, conversation_id, role, text, timestamp, pinned_at)
    VALUES (?, 'conv-full', 'user', ?, ?, ?)
  `);
  for (let index = 0; index < MESSAGE_PIN_LIMIT; index += 1) {
    const stamp = new Date(Date.UTC(2026, 9, 5, 10, 0, index)).toISOString();
    insert.run(`pinned-${index}`, `note ${index}`, stamp, stamp);
  }
  insert.run('one-more', 'one more', '2026-10-05T11:00:00.000Z', null);

  const refused = await fx.pin('conv-full', 'one-more', true);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'pin-limit');
  assert.equal(refused.body.limit, MESSAGE_PIN_LIMIT);
  assert.match(refused.body.error, /Unpin one first/);
  assert.equal(fx.pinnedAt('one-more'), null);
  assert.equal(fx.emitted.length, 0);

  assert.equal((await fx.pin('conv-full', 'pinned-0', false)).status, 200);
  const accepted = await fx.pin('conv-full', 'one-more', true);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.pins.length, MESSAGE_PIN_LIMIT);
});

test('the owner payload carries the whole pin list, also for pins outside the page', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.pin('conv-1', 'user-1', true);

  const page = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: { limit: '1' } });

  assert.equal(page.status, 200);
  assert.deepEqual(page.body.messages.map((message) => message.id), ['reply-2']);
  assert.equal(page.body.messages[0].pinned, false);
  assert.deepEqual(page.body.pins.map((item) => item.messageId), ['user-1']);

  const full = await fx.call('GET /api/conversation/:id', { params: { id: 'conv-1' }, query: { limit: '20' } });
  assert.equal(full.body.messages.find((message) => message.id === 'user-1').pinned, true);
});

test('the shared payload says nothing about pins', async () => {
  const fx = setup();
  seedTwoTurns(fx);
  await fx.pin('conv-1', 'user-1', true);
  await fx.pin('conv-1', 'reply-1', true);

  const share = await fx.call('POST /api/conversation/:id/share', { params: { id: 'conv-1' } });
  assert.equal(share.status, 200);
  const shared = await fx.call('GET /api/shared/:token', { params: { token: share.body.token }, query: {} });

  assert.equal(shared.status, 200);
  assert.equal(shared.body.messages.length, 4);
  assert.equal('pins' in shared.body, false);
  assert.equal('pinsRevision' in shared.body, false);
  for (const message of shared.body.messages) {
    assert.equal('pinned' in message, false, `message ${message.id} must not carry its pin`);
  }
  assert.doesNotMatch(JSON.stringify(shared.body), /pinned|"pins"/i);
});

test('the pin route sits behind auth', () => {
  const filePath = fileURLToPath(new URL('./sessions-routes.mjs', import.meta.url));
  const source = fs.readFileSync(filePath, 'utf8');
  assert.match(source, /app\.patch\('\/api\/conversation\/:id\/message\/:messageId\/pin', auth/);
});
