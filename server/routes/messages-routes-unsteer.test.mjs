import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  buildDequeuedRelayMessage,
  dequeuePendingMessage,
} from './messages-routes.mjs';
import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { applySchema } from '../db-schema.mjs';

// Un-steer for the queued lane (docs/plans/copilot-sdk-steering-background-
// parity.md, decision 8) against the REAL routes and REAL SQLite schema:
//
//   heartbeat `steering.{supported,cancellableIds}` → session worker registry
//   cancel-queued-turn on a processing row the owner lists → worker control
//   POST /api/queue-cancelled (owner/attempt-fenced) → row ends cancelled
//
// Boot pattern mirrors messages-routes-attempt-fencing.test.mjs: the shared
// route harness with a real better-sqlite3 database carrying the production
// schema (applySchema), the real repositories for stmts, and a real session
// worker registry. Foreign keys are ON like production (server-runtime sets
// the pragma), so a deleted queue row cascades to its cards.

const CONV = 'conv-unsteer-1';
const OTHER_CONV = 'conv-unsteer-2';
const MODEL = 'gpt-5.4-mini';
const NOW = '2026-01-01T00:00:00.000Z';

// better-sqlite3 enforces foreign keys by default and server-runtime pins the
// pragma ON; the OFF variant exists only to show the route cancels the cards
// itself rather than leaning on the cascade.
function makeDb({ foreignKeys = true } = {}) {
  const db = new Database(':memory:');
  db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  applySchema(db);
  return db;
}

function seedConversation(db, conversationId) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(conversationId, 'Un-steer', conversationId, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'github', ?, 'active', ?, ?)
  `).run(`rs-${conversationId}`, conversationId, conversationId, `runtime-key-${conversationId}`, MODEL, MODEL, NOW, NOW);
}

function boot({ foreignKeys = true } = {}) {
  const db = makeDb({ foreignKeys });
  seedConversation(db, CONV);
  seedConversation(db, OTHER_CONV);
  // Same composition (and override order) as server-runtime.mjs `stmts`.
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const emitted = [];
  const controls = [];
  const control = { deliverable: true };
  const registry = createSessionWorkerRegistry();
  const upserts = [];
  const rawUpsert = registry.upsertWorker;
  registry.upsertWorker = (state) => {
    upserts.push(state);
    return rawUpsert(state);
  };
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
    MAX_REQUEUE_RETRIES: 5,
    ensureSessionId: () => 'client-unsteer-1',
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: 0 }),
    attachmentSummary: () => '',
    parseAttachments: (raw) => {
      try {
        return JSON.parse(raw || '[]') || [];
      } catch {
        return [];
      }
    },
    hydrateAttachment: (value) => value,
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    // A Copilot (github-bound) conversation resolves its model against the
    // hosted catalog; the un-steer routes never look at the model.
    resolveRequestedModel: (model) => ({ ok: true, model: String(model || MODEL), available: [MODEL] }),
    resolveRequestedReasoningEffort: (_model, effort) => ({ ok: true, effort: effort || null, supported: ['none', 'medium'] }),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: (event, payload) => emitted.push({ event, payload }),
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 4000),
    relayActivityForResponse: (responseId) => stmts.listActivityByResponse.all(responseId),
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId, conversationId } = {}) => {
        const normalized = String(sessionId || '').trim();
        return normalized ? { sessionId: normalized, conversationId: String(conversationId || '').trim() || null } : null;
      },
    },
    sessionWorkerRegistry: registry,
    // The worker socket: records what the relay pushed; `deliverable` models
    // whether a live socket exists for the session.
    sendWorkerControl: (sessionId, payload) => {
      controls.push({ sessionId, control: payload });
      return control.deliverable;
    },
    // cancelPendingRelayQuestionsForMessage only broadcasts a flipped card
    // when deps.formatQuestionRow exists (as it does in production).
    formatQuestionRow: (row) => ({ id: row.id, conversationId: row.conversation_id, status: row.status }),
  });
  const routes = captureRoutes(deps);
  const post = (routePath, body, { headers = {}, params = {} } = {}) => invokeRoute(routes, 'POST', routePath, { body, headers, params });
  const asWorker = (sessionId = CONV) => ({ headers: { 'x-relay-session-id': sessionId } });
  const rowOf = (id) => stmts.findQById.get(id);
  return { db, stmts, deps, emitted, controls, control, registry, upserts, post, asWorker, rowOf };
}

async function enqueueMessage(fx, text = 'steer me', conversationId = CONV) {
  const { status, body } = await fx.post('/api/message', {
    clientId: 'client-unsteer-1',
    conversationId,
    text,
    model: MODEL,
    relayMode: 'agent',
  });
  assert.equal(status, 200, `enqueue should succeed: ${JSON.stringify(body)}`);
  return body.messageId;
}

// The worker loop's delivery leg via the real exported helpers: the row goes
// processing with a minted attempt. Ownership is then pinned the way the
// worker-lease claim records it.
function dequeueOwnedBy(fx, owner = CONV) {
  const row = dequeuePendingMessage({ db: fx.db, stmts: fx.stmts, nowIso: new Date().toISOString() });
  if (!row) return null;
  const delivered = buildDequeuedRelayMessage({
    msg: row,
    stmts: fx.stmts,
    parseAttachments: fx.deps.parseAttachments,
    hydrateAttachment: fx.deps.hydrateAttachment,
    ensureRuntimeSessionBinding: fx.deps.ensureRuntimeSessionBinding,
    configuredConversationSessionMode: fx.deps.configuredConversationSessionMode,
    normalizeRelayMode: fx.deps.normalizeRelayMode,
    defaultRelayMode: fx.deps.DEFAULT_RELAY_MODE,
    defaultModel: MODEL,
  });
  if (owner) {
    fx.db.prepare(`UPDATE queue SET owner_sdk_session_id = ?, owner_last_claimed_at = ? WHERE id = ?`).run(owner, NOW, delivered.id);
  }
  return delivered;
}

function seedWorker(fx, { sdkSessionId = CONV, steering = null } = {}) {
  fx.registry.upsertWorker({
    sdkSessionId,
    workerId: `worker-${sdkSessionId}`,
    conversationId: sdkSessionId,
    pid: 4242,
    status: 'processing',
    ...(steering ? { steering } : {}),
  });
  fx.upserts.length = 0;
}

function insertPendingCard(fx, { id, queueId, attemptId = null }) {
  fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at, attempt_id)
    VALUES (?, ?, ?, ?, 'Which one?', 'pending', ?, '2999-01-01T00:00:00.000Z', ?)
  `).run(id, queueId, CONV, queueId, NOW, attemptId);
}

function insertPendingAbortControl(fx, { id, queueId }) {
  fx.db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, sdk_session_id, status, request, created_at, updated_at)
    VALUES (?, 'abort_turn', ?, ?, ?, 'pending', '{}', ?, ?)
  `).run(id, CONV, queueId, CONV, NOW, NOW);
}

// ---------------------------------------------------------------------------
// Heartbeat → registry
// ---------------------------------------------------------------------------

test('the heartbeat persists supported and cancellableIds flips, and quiet heartbeats stay write-free', async () => {
  const fx = boot();
  seedWorker(fx);
  const beat = (steering) => fx.post('/api/heartbeat', { steering }, fx.asWorker());

  // The Copilot SDK worker's first snapshot.
  const first = await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: true, cancellableIds: ['m-2', 'm-3'] });
  assert.equal(first.status, 200);
  assert.deepEqual(fx.registry.getWorker(CONV).steering, {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: true, cancellableIds: ['m-2', 'm-3'],
  });
  assert.equal(fx.upserts.length, 1);

  // Identical snapshot: no registry write.
  await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: true, cancellableIds: ['m-2', 'm-3'] });
  assert.equal(fx.upserts.length, 1, 'an unchanged snapshot is not re-upserted');

  // Only the un-steerable set changed (a row got consumed): persisted.
  await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: true, cancellableIds: ['m-3'] });
  assert.equal(fx.upserts.length, 2);
  assert.deepEqual(fx.registry.getWorker(CONV).steering.cancellableIds, ['m-3']);

  // Same ids in a different order count as a change (the client keys its
  // hash on the joined list too).
  await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: true, cancellableIds: ['m-3', 'm-4'] });
  assert.equal(fx.upserts.length, 3);

  // Only the opt-in flag changed: persisted.
  await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: false, cancellableIds: ['m-3', 'm-4'] });
  assert.equal(fx.upserts.length, 4);
  assert.equal(fx.registry.getWorker(CONV).steering.supported, false);

  // The Claude worker's 4-field snapshot against a stored 6-field one:
  // normalized before comparing, so it converges instead of re-upserting on
  // every beat.
  await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1' });
  assert.equal(fx.upserts.length, 5, 'dropping the ids is one change');
  await beat({ turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1' });
  assert.equal(fx.upserts.length, 5, 'and then quiet');
  assert.deepEqual(fx.registry.getWorker(CONV).steering, {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'q-1', supported: false, cancellableIds: [],
  });
});

// ---------------------------------------------------------------------------
// cancel-queued-turn on a processing row
// ---------------------------------------------------------------------------

test('cancel-queued-turn on a processing row the owner lists as cancellable asks the worker to pull it', async (t) => {
  const logs = t.mock.method(console, 'log', () => {});
  const fx = boot();
  const msgId = await enqueueMessage(fx);
  const delivered = dequeueOwnedBy(fx);
  assert.equal(fx.rowOf(msgId).status, 'processing');
  seedWorker(fx, { steering: { turnActive: true, canSteer: true, supported: true, cancellableIds: [msgId] } });

  const { status, body } = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: msgId }, { params: { conversationId: CONV } });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    ok: true,
    cancelled: false,
    acknowledgement: 'cancel-requested',
    requestedMessageId: msgId,
    status: 'processing',
  });
  assert.deepEqual(fx.controls, [{
    sessionId: CONV,
    control: { type: 'cancel_pushed_message', messageId: msgId, conversationId: CONV },
  }]);
  // The relay does not touch the row itself: the worker settles it through
  // /api/queue-cancelled once the runtime confirmed the removal.
  assert.equal(fx.rowOf(msgId).status, 'processing');
  assert.equal(fx.rowOf(msgId).attempt_id, delivered.attemptId);
  assert.equal(fx.emitted.filter((entry) => entry.event === 'message_status' && entry.payload.status === 'cancelled').length, 0);
  assert.ok(
    logs.mock.calls.some((call) => /UNSTEER REQ/.test(String(call.arguments[0] || ''))),
    'the request is logged like BG-TASK STOP',
  );
});

test('cancel-queued-turn resolves the worker through the conversation binding when the row carries no owner', async () => {
  const fx = boot();
  const msgId = await enqueueMessage(fx);
  dequeueOwnedBy(fx, null);
  assert.equal(fx.rowOf(msgId).owner_sdk_session_id, null);
  seedWorker(fx, { steering: { turnActive: true, canSteer: true, supported: true, cancellableIds: [msgId] } });

  const { body } = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: msgId }, { params: { conversationId: CONV } });
  assert.equal(body.acknowledgement, 'cancel-requested');
  assert.equal(fx.controls.length, 1);
  assert.equal(fx.controls[0].sessionId, CONV);
});

test('cancel-queued-turn answers already-processing when the id is not cancellable or no worker socket is live', async () => {
  const fx = boot();
  const msgId = await enqueueMessage(fx);
  dequeueOwnedBy(fx);

  // No steering snapshot at all (an extension worker, or a worker that has
  // not heartbeated yet).
  seedWorker(fx);
  let { body } = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: msgId }, { params: { conversationId: CONV } });
  assert.equal(body.acknowledgement, 'already-processing');
  assert.equal(body.cancelled, false);
  assert.equal(fx.controls.length, 0, 'nothing is pushed to a worker that never listed the id');

  // A snapshot that lists other ids only (this one was consumed already).
  seedWorker(fx, { steering: { turnActive: true, canSteer: true, supported: true, cancellableIds: ['some-other-id'] } });
  ({ body } = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: msgId }, { params: { conversationId: CONV } }));
  assert.equal(body.acknowledgement, 'already-processing');
  assert.equal(fx.controls.length, 0);

  // Listed, but the worker socket is gone: the push fails and the row keeps
  // its ordinary path.
  seedWorker(fx, { steering: { turnActive: true, canSteer: true, supported: true, cancellableIds: [msgId] } });
  fx.control.deliverable = false;
  ({ body } = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: msgId }, { params: { conversationId: CONV } }));
  assert.equal(body.acknowledgement, 'already-processing');
  assert.equal(fx.controls.length, 1, 'the push was attempted');
  assert.equal(fx.rowOf(msgId).status, 'processing');

  // A pending row still takes the plain cancel, whatever the worker lists.
  fx.control.deliverable = true;
  const pendingId = await enqueueMessage(fx, 'still queued');
  ({ body } = await fx.post('/api/conversation/:conversationId/cancel-queued-turn', { messageId: pendingId }, { params: { conversationId: CONV } }));
  assert.equal(body.acknowledgement, 'cancelled');
  assert.equal(fx.rowOf(pendingId), undefined);
  assert.equal(fx.controls.length, 1, 'no control for a row the relay cancels itself');
});

// ---------------------------------------------------------------------------
// POST /api/queue-cancelled
// ---------------------------------------------------------------------------

test('/api/queue-cancelled settles the row like a pending cancel: deleted, cards gone, Stop controls failed, message_status cancelled', async (t) => {
  const logs = t.mock.method(console, 'log', () => {});
  const fx = boot();
  const msgId = await enqueueMessage(fx);
  const delivered = dequeueOwnedBy(fx);
  insertPendingCard(fx, { id: 'card-1', queueId: msgId, attemptId: delivered.attemptId });
  insertPendingAbortControl(fx, { id: 'ctl-1', queueId: msgId });
  const assistantRows = () => fx.db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND role = 'assistant'`).get(CONV).cnt;
  fx.emitted.length = 0;

  const { status, body } = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId, attemptId: delivered.attemptId }, fx.asWorker());
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, cancelled: true });

  assert.equal(fx.rowOf(msgId), undefined, 'the queue row is deleted, not failed');
  assert.equal(assistantRows(), 0, 'no assistant row: the message was never answered');
  assert.equal(
    fx.db.prepare(`SELECT COUNT(*) AS cnt FROM relay_questions WHERE message_id = ? AND status = 'pending'`).get(msgId).cnt,
    0,
    'no pending card survives the row (cascade with foreign keys on)',
  );
  const control = fx.db.prepare(`SELECT status, error FROM relay_control_requests WHERE id = 'ctl-1'`).get();
  assert.deepEqual(control, { status: 'failed', error: 'queue-cancelled' }, 'an open Stop on the row is failed so nobody waits on it');
  assert.deepEqual(
    fx.emitted.filter((entry) => entry.event === 'message_status').map((entry) => entry.payload),
    [{ messageId: msgId, conversationId: CONV, status: 'cancelled' }],
  );
  assert.ok(logs.mock.calls.some((call) => /UNSTEERED/.test(String(call.arguments[0] || ''))));

  // Idempotent from the worker's side: a repeat finds nothing.
  const repeat = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId, attemptId: delivered.attemptId }, fx.asWorker());
  assert.equal(repeat.status, 404);
  assert.equal(repeat.body.error, 'not-found');
});

test('/api/queue-cancelled with foreign keys off still cancels the pending cards explicitly and broadcasts them', async () => {
  const fx = boot({ foreignKeys: false });
  const msgId = await enqueueMessage(fx);
  const delivered = dequeueOwnedBy(fx);
  insertPendingCard(fx, { id: 'card-2', queueId: msgId, attemptId: delivered.attemptId });
  fx.emitted.length = 0;

  const { status } = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId }, fx.asWorker());
  assert.equal(status, 200);
  assert.equal(fx.stmts.getQuestion.get('card-2').status, 'cancelled');
  const cardUpdates = fx.emitted.filter((entry) => entry.event === 'relay_question_updated');
  assert.equal(cardUpdates.length, 1);
  assert.equal(cardUpdates[0].payload.question.id, 'card-2');
  assert.equal(cardUpdates[0].payload.question.status, 'cancelled');
});

test('/api/queue-cancelled is fenced: worker identity, existence, conversation, status, owner, attempt', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const fx = boot();
  const msgId = await enqueueMessage(fx);
  const delivered = dequeueOwnedBy(fx);
  const attempt = () => fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId, attemptId: delivered.attemptId }, fx.asWorker());
  const untouched = () => {
    const row = fx.rowOf(msgId);
    assert.equal(row?.status, 'processing');
    assert.equal(row?.attempt_id, delivered.attemptId);
    assert.equal(fx.emitted.filter((entry) => entry.event === 'message_status' && entry.payload.status === 'cancelled').length, 0);
  };

  // No bridge identity: not a worker.
  let res = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId });
  assert.equal(res.status, 403);
  untouched();

  // Missing fields.
  res = await fx.post('/api/queue-cancelled', { conversationId: CONV }, fx.asWorker());
  assert.equal(res.status, 400);

  // Unknown row.
  res = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: 'nope' }, fx.asWorker());
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not-found');

  // Wrong conversation for the row.
  res = await fx.post('/api/queue-cancelled', { conversationId: OTHER_CONV, messageId: msgId }, fx.asWorker());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'conversation-mismatch');
  untouched();

  // Another worker session (not the owner).
  res = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId, attemptId: delivered.attemptId }, fx.asWorker('some-other-session'));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'not-owned');
  untouched();

  // A superseded attempt (the row was requeued and re-claimed since).
  res = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId, attemptId: crypto.randomUUID() }, fx.asWorker());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'stale_attempt');
  untouched();

  // A pending row (not pushed anywhere) is not the worker's to cancel.
  const pendingId = await enqueueMessage(fx, 'queued behind');
  res = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: pendingId }, fx.asWorker());
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'not-processing');
  assert.equal(fx.rowOf(pendingId).status, 'pending');

  // The owner on the current attempt: settles.
  res = await attempt();
  assert.equal(res.status, 200);
  assert.equal(fx.rowOf(msgId), undefined);
});

test('/api/queue-cancelled without an attempt id (older worker) is accepted for the owner', async () => {
  const fx = boot();
  const msgId = await enqueueMessage(fx);
  dequeueOwnedBy(fx);
  const res = await fx.post('/api/queue-cancelled', { conversationId: CONV, messageId: msgId }, fx.asWorker());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, cancelled: true });
  assert.equal(fx.rowOf(msgId), undefined);
});
