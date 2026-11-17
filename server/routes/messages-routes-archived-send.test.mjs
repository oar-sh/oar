import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { dequeuePendingMessage } from './messages-worker-claim-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createClaudeBillingSwitchService } from '../services/claude-billing-switch-service.mjs';
import { createClaudeApiUsageService } from '../services/claude-api-usage-service.mjs';
import { agentPrincipal } from '../services/relay-principal-test-harness.mjs';

// A message an agent or the API sends into an archived chat brings the chat
// back and runs, as one the user sends does: POST /api/message and the
// billing route with a message unarchive the chat in the send's transaction,
// announce it once with the unarchive route's event (and bring a Claude
// Cloud chat's cloud session back), and the row is claimed.

const CONV = 'conv-archived-send-1';
const RS = 'rs-archived-send-1';
const MODEL = 'claude-sonnet-5-5';
const NOW = '2026-11-16T09:00:00.000Z';

function boot({ archived = 1 } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, archived, created_at, updated_at)
    VALUES (?, 'Archived send', ?, 'active', ?, ?, ?)
  `).run(CONV, CONV, archived, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)
  `).run(RS, CONV, CONV, `key-${RS}`, MODEL, MODEL, NOW, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const emitted = [];
  const cloudUnarchives = [];
  const claudeSettings = { enabled: true, model: MODEL, models: [MODEL], availableModels: [MODEL], effortsByModel: {} };
  const claudeApiSettings = { enabled: true, configured: true, model: MODEL, models: [MODEL], availableModels: [MODEL], effortsByModel: {} };
  const claudeBillingSwitchService = createClaudeBillingSwitchService({
    db,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    getClaudeProviderSettings: () => claudeSettings,
    getClaudeApiProviderSettings: () => claudeApiSettings,
    logger: { log() {}, warn() {} },
  });
  const deps = baseRouteDeps({
    db,
    stmts,
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) },
    },
    uuidv4: () => crypto.randomUUID(),
    ts: () => new Date().toISOString(),
    MAX_UPLOAD_ATTACHMENTS: 4,
    ensureSessionId: () => 'client-1',
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: 0 }),
    attachmentSummary: () => '',
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    getClaudeProviderSettings: () => claudeSettings,
    getClaudeApiProviderSettings: () => claudeApiSettings,
    resolveRequestedReasoningEffort: (_model, effort) => ({ ok: true, effort: effort || null, supported: ['none'] }),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: (event, payload) => emitted.push({ event, payload }),
    claudeBillingSwitchService,
    claudeApiUsageService: createClaudeApiUsageService({ db, timeZone: 'UTC', logger: { log() {}, warn() {} } }),
    claudeCloudSessionService: {
      unarchiveSessionInBackground: (args) => { cloudUnarchives.push(args); return false; },
    },
    runtimeState: {},
    remoteRelayInbound: { inboundEnabled: () => true },
  });
  const routes = captureRoutes(deps);
  const post = (routePath, body, { params = {}, principal } = {}) => invokeRoute(routes, 'POST', routePath, { body, params, principal });
  const send = (extra = {}, options = {}) => post('/api/message', {
    clientId: 'client-1',
    conversationId: CONV,
    text: `hello ${crypto.randomUUID()}`,
    model: MODEL,
    relayMode: 'agent',
    ...extra,
  }, options);
  const archivedFlag = () => db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(CONV).archived;
  const unarchiveEvents = () => emitted.filter((entry) => entry.event === 'conversation_archived');
  // A worker of the row's billing claims it (claudeBillingFence).
  const claim = (workerKind = 'claude') => dequeuePendingMessage({ db, stmts, nowIso: new Date().toISOString(), requesterSessionId: CONV, workerKind });
  return { db, stmts, emitted, cloudUnarchives, post, send, archivedFlag, unarchiveEvents, claim };
}

function assertUnarchivedOnceBeforeTheMessage(app) {
  assert.equal(app.archivedFlag(), 0);
  assert.deepEqual(app.unarchiveEvents().map((entry) => entry.payload), [{ conversationId: CONV, archived: false }]);
  const events = app.emitted.map((entry) => entry.event);
  assert.ok(events.indexOf('conversation_archived') < events.indexOf('user_message'), events.join(','));
  assert.equal(app.cloudUnarchives.length, 1);
  assert.equal(app.cloudUnarchives[0].conversationId, CONV);
  assert.equal(app.cloudUnarchives[0].runtimeSession?.id, RS);
}

test("an agent's send into an archived chat unarchives it, says so once, and the row is claimed", async () => {
  const app = boot();
  const { status, body } = await app.send({}, { principal: agentPrincipal('conv-sender') });
  assert.equal(status, 200, JSON.stringify(body));
  assertUnarchivedOnceBeforeTheMessage(app);
  const claimed = app.claim();
  assert.equal(claimed?.id, body.messageId);
  assert.equal(app.stmts.findQById.get(body.messageId).status, 'processing');
});

test("the owner's API send into an archived chat does the same", async () => {
  const app = boot();
  const { status, body } = await app.send();
  assert.equal(status, 200, JSON.stringify(body));
  assertUnarchivedOnceBeforeTheMessage(app);
  assert.equal(app.claim()?.id, body.messageId);
});

test('the billing route with a message into an archived chat switches, unarchives and queues in one send', async () => {
  const app = boot();
  const { status, body } = await app.post('/api/conversation/:id/billing', {
    to: 'claude-api',
    by: 'agent',
    message: { clientId: 'agent-1', text: 'continue on the key', model: MODEL, relayMode: 'agent' },
  }, { params: { id: CONV }, principal: agentPrincipal('conv-sender') });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.billingSwitched, true);
  assertUnarchivedOnceBeforeTheMessage(app);
  assert.equal(app.claim('claude-api')?.id, body.messageId);
});

test('a send into a live chat announces no unarchive', async () => {
  const app = boot({ archived: 0 });
  const { status, body } = await app.send();
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(app.unarchiveEvents(), []);
  assert.deepEqual(app.cloudUnarchives, []);
  assert.equal(app.claim()?.id, body.messageId);
});

test('a send that is refused inside its transaction leaves the chat archived and announces nothing', async () => {
  const app = boot({ archived: 0 });
  assert.equal((await app.send({ messageId: 'm-dup' })).status, 200);
  app.db.prepare(`DELETE FROM queue`).run();
  app.db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(CONV);
  const replay = await app.send({ messageId: 'm-dup' });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, 'DUPLICATE_MESSAGE_ID');
  assert.equal(app.archivedFlag(), 1);
  assert.deepEqual(app.unarchiveEvents(), []);
  assert.deepEqual(app.cloudUnarchives, []);
});

// An OpenAI image session's send writes its image operation after the row,
// in the same transaction: an operation that fails there undoes the
// unarchive the row's write made, and nothing is announced.
test('a send that fails after its row brought the chat back leaves it archived and announces nothing', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, archived, created_at, updated_at)
    VALUES (?, 'Poster', ?, 'active', 1, ?, ?)
  `).run(CONV, CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, 'gpt-image-2', 'openai', 'gpt-image-2', 'active', ?, ?)
  `).run(RS, CONV, CONV, `key-${RS}`, NOW, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const emitted = [];
  const cloudUnarchives = [];
  let unarchivedWhenItFailed = null;
  const deps = baseRouteDeps({
    db,
    stmts,
    io: { emit: (event, payload) => emitted.push({ event, payload }), volatile: { emit() {} } },
    uuidv4: () => crypto.randomUUID(),
    ts: () => NOW,
    MAX_UPLOAD_ATTACHMENTS: 4,
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, model: 'gpt-image-2', models: ['gpt-image-2', 'gpt-5'] }),
    resolveRequestedModel: (value) => ({ ok: true, model: String(value || 'gpt-image-2'), available: ['gpt-image-2'] }),
    resolveRequestedReasoningEffort: (_model, effort) => ({ ok: true, effort: effort || null, supported: ['none'] }),
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: [] }),
    attachmentSummary: () => '',
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0 }),
    emitToClientsExceptSessionId: (event, payload) => emitted.push({ event, payload }),
    imageOperationService: {
      createEnqueuedOperation: () => {
        unarchivedWhenItFailed = db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(CONV).archived === 0;
        throw new Error('image operation store failed');
      },
    },
    claudeCloudSessionService: {
      unarchiveSessionInBackground: (args) => { cloudUnarchives.push(args); return false; },
    },
  });
  const routes = captureRoutes(deps);
  await assert.rejects(
    () => invokeRoute(routes, 'POST', '/api/message', {
      body: { clientId: 'client-1', conversationId: CONV, text: 'make the sky purple', relayMode: 'agent' },
      principal: agentPrincipal('conv-sender'),
    }),
    /image operation store failed/,
  );
  // The row's write had brought the chat back when the operation failed.
  assert.equal(unarchivedWhenItFailed, true);
  assert.equal(db.prepare(`SELECT archived FROM conversations WHERE id = ?`).get(CONV).archived, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM queue`).get().n, 0);
  assert.deepEqual(emitted.filter((entry) => entry.event === 'conversation_archived'), []);
  assert.deepEqual(cloudUnarchives, []);
});
