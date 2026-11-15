import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  buildDequeuedRelayMessage,
  dequeuePendingMessage,
} from './messages-routes.mjs';
import { registerAskUserRoutes } from './ask-user-routes.mjs';
import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { questionExpiresAt } from '../../shared/question-timeout.mjs';
import { applySchema } from '../db-schema.mjs';

// Queue attempt fencing, end to end against the REAL routes and REAL SQLite
// schema. The invariant under test: one processing attempt = one attempt_id,
// minted on every pending->processing claim and cleared by every requeue, so a
// worker that lost its row (stale sweep, manual requeue, crash recovery) can
// never finalize, requeue, stream into, or open question cards on the attempt
// that superseded it. Writers that send no attemptId (the extension engine,
// mid-rollout workers) deliberately keep the old semantics.
//
// Boot pattern mirrors claude-session-process.routes-integration.test.mjs:
// the shared route harness with a real better-sqlite3 database carrying the
// production schema (applySchema) and the real repositories for stmts. The
// ask-user routes are registered alongside the messages routes on the same
// deps so /api/relay-question runs against the same queue rows.

const CONV = 'conv-fence-1';
const RUNTIME_SESSION_ID = 'rs-fence-1';
const MODEL = 'claude-sonnet-5';
const NOW = '2026-01-01T00:00:00.000Z';

function makeDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function seedConversation(db) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(CONV, 'Attempt fencing', CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)
  `).run(RUNTIME_SESSION_ID, CONV, CONV, `runtime-key-${RUNTIME_SESSION_ID}`, MODEL, MODEL, NOW, NOW);
}

// parseQuestionRequest / the sanitizers live in server-runtime.mjs (which
// boots a live server on import), so the ask-user routes get minimal faithful
// stand-ins: the fencing behavior under test never depends on their content.
function makeAskUserDeps() {
  return {
    questionExpiresAt,
    sanitizeRelayQuestionPrompt: ({ prompt }) => String(prompt || '').trim(),
    sanitizeRelayQuestionRequest: () => null,
    sanitizeRelayQuestionContext: () => null,
    parseQuestionRequest: (raw) => {
      if (!raw) return null;
      if (typeof raw === 'object') return raw;
      try { return JSON.parse(raw); } catch { return null; }
    },
    normalizeQuestionChoices: (choices) => (Array.isArray(choices) ? choices.map((c) => String(c)) : []),
    // Shared with messages-routes: cancelPendingRelayQuestionsForMessage only
    // emits relay_question_updated when deps.formatQuestionRow exists.
    formatQuestionRow: (row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status,
      attemptId: row.attempt_id || null,
      prompt: row.prompt,
    }),
    runtimeState: {},
  };
}

function bootFencedRoutes() {
  const db = makeDb();
  seedConversation(db);
  // Same composition (and override order) as server-runtime.mjs `stmts`.
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const emitted = [];
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
    ensureSessionId: () => 'client-fence-1',
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
    getClaudeProviderSettings: () => ({ enabled: true, model: MODEL, models: [MODEL] }),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: (event, payload) => emitted.push({ event, payload }),
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 4000),
    relayActivityForResponse: (responseId) => stmts.listActivityByResponse.all(responseId),
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    ...makeAskUserDeps(),
  });
  const routes = captureRoutes(deps);
  for (const [key, handler] of captureRoutes(deps, registerAskUserRoutes)) {
    routes.set(key, handler);
  }
  // Every worker-side call carries the bridge identity header the live worker
  // sends, so provenance resolves quietly through the real runtime row.
  const post = (routePath, body) => invokeRoute(routes, 'POST', routePath, {
    body,
    headers: { 'x-relay-session-id': CONV },
  });
  const rowOf = (id) => stmts.findQById.get(id);
  const assistantCount = () => db
    .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ? AND role = 'assistant'`)
    .get(CONV).cnt;
  return { db, stmts, deps, post, emitted, rowOf, assistantCount };
}

async function enqueueMessage(post, text = 'hello') {
  const { status, body } = await post('/api/message', {
    clientId: 'client-fence-1',
    conversationId: CONV,
    text,
    model: MODEL,
    relayMode: 'agent',
  });
  assert.equal(status, 200, `enqueue should succeed: ${JSON.stringify(body)}`);
  return body.messageId;
}

// The worker loop's delivery leg via the same exported helpers the real loop
// runs: the worker-lease claim statement, which must mint an attempt.
function dequeueForWorker({ db, stmts, deps }, { nowIso = new Date().toISOString() } = {}) {
  const row = dequeuePendingMessage({
    db,
    stmts,
    nowIso,
    requesterSessionId: CONV,
  });
  if (!row) return null;
  return buildDequeuedRelayMessage({
    msg: row,
    stmts,
    parseAttachments: deps.parseAttachments,
    hydrateAttachment: deps.hydrateAttachment,
    ensureRuntimeSessionBinding: deps.ensureRuntimeSessionBinding,
    configuredConversationSessionMode: deps.configuredConversationSessionMode,
    normalizeRelayMode: deps.normalizeRelayMode,
    defaultRelayMode: deps.DEFAULT_RELAY_MODE,
    defaultModel: MODEL,
  });
}

// Requeues push next_attempt_at to "now"; claim from slightly in the future so
// the re-dequeue never races the backoff timestamp.
const futureIso = () => new Date(Date.now() + 60_000).toISOString();

test('a claim mints an attempt id, a requeue clears it, and the next claim mints a fresh one', async () => {
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  assert.equal(fx.rowOf(msgId).attempt_id, null, 'a pending row carries no attempt');

  const delivered = dequeueForWorker(fx);
  assert.equal(delivered?.id, msgId);
  assert.ok(delivered.attemptId, 'the delivered payload exposes the minted attemptId');
  assert.equal(fx.rowOf(msgId).attempt_id, delivered.attemptId, 'row and payload agree on the attempt');

  // A legacy (unfenced) requeue clears the attempt with the processing state.
  const requeue = await fx.post('/api/requeue', { messageId: msgId });
  assert.equal(requeue.status, 200);
  const requeued = fx.rowOf(msgId);
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attempt_id, null, 'requeue must clear attempt_id');
  assert.equal(requeued.retry_count, 1);

  // The next claim mints a DIFFERENT attempt.
  const redelivered = dequeueForWorker(fx, { nowIso: futureIso() });
  assert.equal(redelivered?.id, msgId);
  assert.ok(redelivered.attemptId);
  assert.notEqual(redelivered.attemptId, delivered.attemptId, 'each claim is its own attempt');
  assert.equal(fx.rowOf(msgId).attempt_id, redelivered.attemptId);
});

test('a fenced response from a superseded attempt can never finalize the row', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;

  // The row is swept back to pending while execution A is still running.
  await fx.post('/api/requeue', { messageId: msgId });
  assert.equal(fx.rowOf(msgId).status, 'pending');

  // A's late answer must bounce off the requeued row and leave it deliverable.
  const staleOnPending = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'stale answer', model: MODEL, mode: 'agent', attemptId: attemptA,
  });
  assert.equal(staleOnPending.status, 409);
  assert.equal(staleOnPending.body.error, 'stale_attempt');
  assert.equal(fx.rowOf(msgId).status, 'pending', 'the refused response leaves the row pending');
  assert.equal(fx.assistantCount(), 0, 'no assistant message may be minted for a superseded attempt');
  assert.ok(
    warns.mock.calls.some((call) => /STALE ATTEMPT/.test(String(call.arguments[0] || ''))),
    'the fence names the refusal in the log',
  );

  // Attempt B claims the row; A is still fenced out, B finalizes.
  const attemptB = dequeueForWorker(fx, { nowIso: futureIso() }).attemptId;
  const staleOnProcessing = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'stale answer', model: MODEL, mode: 'agent', attemptId: attemptA,
  });
  assert.equal(staleOnProcessing.status, 409);
  assert.equal(staleOnProcessing.body.error, 'stale_attempt');

  const winner = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'the real answer', model: MODEL, mode: 'agent', attemptId: attemptB,
  });
  assert.equal(winner.status, 200);
  assert.equal(winner.body.ok, true);
  const finalRow = fx.rowOf(msgId);
  assert.equal(finalRow.status, 'done');
  assert.equal(finalRow.response, 'the real answer');
  assert.equal(fx.assistantCount(), 1);
});

test('a fenced terminal failure after the same attempt already succeeded is idempotent', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;

  const success = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'answered', model: MODEL, mode: 'agent', attemptId: attemptA,
  });
  assert.equal(success.status, 200);
  assert.equal(fx.rowOf(msgId).status, 'done');

  // The same attempt racing its own success with a terminal failure (e.g. the
  // worker's crash guard firing after the response landed) is a no-op.
  const duplicateTerminal = await fx.post('/api/response', {
    messageId: msgId,
    conversationId: CONV,
    terminalError: { code: 'quota_exceeded', message: 'quota exhausted' },
    attemptId: attemptA,
  });
  assert.equal(duplicateTerminal.status, 200);
  assert.equal(duplicateTerminal.body.ignored, 'already_done');
  assert.equal(fx.rowOf(msgId).status, 'done');
  assert.equal(fx.rowOf(msgId).response, 'answered', 'the settled response is untouched');
  assert.equal(fx.assistantCount(), 1, 'exactly one assistant message exists');

  // A different (stale) attempt is refused outright rather than ignored.
  const staleTerminal = await fx.post('/api/response', {
    messageId: msgId,
    conversationId: CONV,
    terminalError: { code: 'quota_exceeded', message: 'quota exhausted' },
    attemptId: crypto.randomUUID(),
  });
  assert.equal(staleTerminal.status, 409);
  assert.equal(staleTerminal.body.error, 'stale_attempt');
});

test('a duplicate fenced terminal failure settles once and leaves one assistant message', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;

  const first = await fx.post('/api/response', {
    messageId: msgId,
    conversationId: CONV,
    terminalError: { code: 'quota_exceeded', message: 'quota exhausted' },
    attemptId: attemptA,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.terminal, true);
  const failedRow = fx.rowOf(msgId);
  assert.equal(failedRow.status, 'failed');
  assert.equal(failedRow.attempt_id, attemptA, 'the settling attempt stays on the terminal row for forensics');
  assert.equal(fx.assistantCount(), 1);

  // The retry of the same terminal report (worker retrying a lost HTTP
  // response) must be a 200 no-op, not a second failure card.
  const second = await fx.post('/api/response', {
    messageId: msgId,
    conversationId: CONV,
    terminalError: { code: 'quota_exceeded', message: 'quota exhausted' },
    attemptId: attemptA,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.ignored, 'already_failed');
  assert.equal(fx.assistantCount(), 1, 'still exactly one assistant message');
});

test('a legacy unfenced response still finalizes processing and pending rows', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();

  // Processing row, no attemptId in the response: the extension engine's path.
  const processingId = await enqueueMessage(fx.post, 'first turn');
  dequeueForWorker(fx);
  const processingDone = await fx.post('/api/response', {
    messageId: processingId, conversationId: CONV, text: 'legacy answer', model: MODEL, mode: 'agent',
  });
  assert.equal(processingDone.status, 200);
  assert.equal(fx.rowOf(processingId).status, 'done');

  // A PENDING row (requeued mid-flight by the stale sweep) must ALSO
  // finalize for legacy writers — that conditional is the deliberate old
  // semantics fenced writers give up.
  const pendingId = await enqueueMessage(fx.post, 'second turn');
  assert.equal(fx.rowOf(pendingId).status, 'pending');
  const pendingDone = await fx.post('/api/response', {
    messageId: pendingId, conversationId: CONV, text: 'late legacy answer', model: MODEL, mode: 'agent',
  });
  assert.equal(pendingDone.status, 200);
  assert.equal(fx.rowOf(pendingId).status, 'done');
  assert.equal(fx.rowOf(pendingId).response, 'late legacy answer');
});

test('a fenced requeue is refused when stale and requeues cleanly for the owning attempt', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;
  const before = fx.rowOf(msgId);

  // A stale attempt trying to yank the row back gets a 409 and changes nothing.
  const stale = await fx.post('/api/requeue', { messageId: msgId, attemptId: crypto.randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale_attempt');
  const untouched = fx.rowOf(msgId);
  assert.equal(untouched.status, 'processing');
  assert.equal(untouched.attempt_id, attemptA);
  assert.equal(untouched.retry_count, 0);
  assert.equal(untouched.processing_at, before.processing_at);
  assert.ok(warns.mock.calls.some((call) => /STALE ATTEMPT/.test(String(call.arguments[0] || ''))));

  // The owning attempt requeues: pending, attempt cleared, retry burned.
  const current = await fx.post('/api/requeue', { messageId: msgId, attemptId: attemptA });
  assert.equal(current.status, 200);
  const requeued = fx.rowOf(msgId);
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attempt_id, null);
  assert.equal(requeued.retry_count, 1);
});

test('every live lane refuses stale-attempt writes and accepts the owning attempt', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;
  const staleAttempt = crypto.randomUUID();

  const lanes = [
    ['/api/stream', { messageId: msgId, conversationId: CONV, mode: 'agent', text: 'strea', done: false }],
    ['/api/thought', { messageId: msgId, conversationId: CONV, mode: 'agent', reasoningId: 'thought-1', text: 'pondering', done: false }],
    ['/api/activity', { messageId: msgId, conversationId: CONV, mode: 'agent', text: 'running a tool' }],
    ['/api/subagent-run', { messageId: msgId, conversationId: CONV, subagentRunId: 'toolu_fence_1', displayName: 'sub', status: 'running' }],
  ];
  for (const [routePath, body] of lanes) {
    const refused = await fx.post(routePath, { ...body, attemptId: staleAttempt });
    assert.equal(refused.status, 409, `${routePath} must fence a stale attempt`);
    assert.equal(refused.body.error, 'stale_attempt');
    assert.equal(refused.body.currentStatus, 'processing');

    const accepted = await fx.post(routePath, { ...body, attemptId: attemptA });
    assert.equal(accepted.status, 200, `${routePath} must accept the owning attempt`);
  }

  // The stale writes persisted nothing; the fenced ones each landed once.
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS cnt FROM relay_stream_events WHERE queue_message_id = ?`).get(msgId).cnt, 1);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS cnt FROM relay_thought WHERE queue_message_id = ?`).get(msgId).cnt, 1);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS cnt FROM relay_activity WHERE queue_message_id = ?`).get(msgId).cnt, 1);
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS cnt FROM subagent_runs WHERE queue_message_id = ?`).get(msgId).cnt, 1);
});

test('trailing same-attempt live writes after finalization still land', async () => {
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;

  await fx.post('/api/stream', {
    messageId: msgId, conversationId: CONV, mode: 'agent', text: 'partial', done: false, attemptId: attemptA,
  });
  const done = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'final answer', model: MODEL, mode: 'agent', attemptId: attemptA,
  });
  assert.equal(done.status, 200);

  // The worker's final stream snapshot and closing activity line routinely
  // race the finalize call; the fence keys on the attempt, not row status,
  // so these same-attempt stragglers must not start bouncing.
  const trailingStream = await fx.post('/api/stream', {
    messageId: msgId, conversationId: CONV, mode: 'agent', text: 'final answer', done: true, attemptId: attemptA,
  });
  assert.equal(trailingStream.status, 200);
  const trailingActivity = await fx.post('/api/activity', {
    messageId: msgId, conversationId: CONV, mode: 'agent', text: 'wrapped up', attemptId: attemptA,
  });
  assert.equal(trailingActivity.status, 200);

  const streamRow = fx.db.prepare(`SELECT text, done FROM relay_stream_events WHERE queue_message_id = ?`).get(msgId);
  assert.equal(streamRow.done, 1, 'the trailing done snapshot latched');
});

test('a relay question is fenced on creation and always stamped with the row attempt', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;

  const stale = await fx.post('/api/relay-question', {
    messageId: msgId, conversationId: CONV, prompt: 'Stale card?', attemptId: crypto.randomUUID(),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'stale_attempt');

  // An UNFENCED creator still gets the row's current attempt stamped onto the
  // card — that server-side stamp is what makes stale-question cleanup cover
  // legacy callers too.
  const created = await fx.post('/api/relay-question', {
    messageId: msgId, conversationId: CONV, prompt: 'Which way?',
  });
  assert.equal(created.status, 200);
  const questionRow = fx.db.prepare(`SELECT * FROM relay_questions WHERE id = ?`).get(created.body.question.id);
  assert.equal(questionRow.attempt_id, attemptA, 'the card carries the queue row\'s attempt, not the caller\'s claim');
});

test('finalization cancels only the question cards of superseded attempts', async () => {
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  dequeueForWorker(fx);

  // A card opened under attempt A...
  const cardA = await fx.post('/api/relay-question', {
    messageId: msgId, conversationId: CONV, prompt: 'From attempt A?',
  });
  assert.equal(cardA.status, 200);
  const cardAId = cardA.body.question.id;

  // ...then the row is legacy-requeued and re-claimed as attempt B.
  await fx.post('/api/requeue', { messageId: msgId });
  const attemptB = dequeueForWorker(fx, { nowIso: futureIso() }).attemptId;

  // A card opened under B (different prompt so the retry-reuse path stays out
  // of the way), plus a pre-fencing NULL-attempt card seeded directly.
  const cardB = await fx.post('/api/relay-question', {
    messageId: msgId, conversationId: CONV, prompt: 'From attempt B?',
  });
  assert.equal(cardB.status, 200);
  const cardBId = cardB.body.question.id;
  fx.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at)
    VALUES ('q-legacy-null', ?, ?, ?, 'Pre-fencing card?', 'pending', ?, '2026-01-01T08:00:00.000Z')
  `).run(msgId, CONV, msgId, NOW);

  const finalize = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'settled by B', model: MODEL, mode: 'agent', attemptId: attemptB,
  });
  assert.equal(finalize.status, 200);

  const statusOf = (id) => fx.db.prepare(`SELECT status FROM relay_questions WHERE id = ?`).get(id).status;
  assert.equal(statusOf(cardAId), 'cancelled', 'the superseded attempt\'s card is cancelled');
  assert.equal(statusOf(cardBId), 'pending', 'the settling attempt\'s own card survives — its answer may be in flight');
  assert.equal(statusOf('q-legacy-null'), 'pending', 'NULL-attempt (pre-fencing) cards are deliberately left alone');

  // The cancellation is announced so open clients drop the dead card.
  const updates = fx.emitted.filter((entry) => entry.event === 'relay_question_updated');
  assert.ok(
    updates.some((entry) => entry.payload.question.id === cardAId && entry.payload.question.status === 'cancelled'),
    'relay_question_updated must announce the cancelled card',
  );
});

test('a terminal failure can never overwrite a row another attempt already settled', async () => {
  const fx = bootFencedRoutes();
  const msgId = await enqueueMessage(fx.post);
  const attemptA = dequeueForWorker(fx).attemptId;
  await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, text: 'settled', model: MODEL, mode: 'agent', attemptId: attemptA,
  });
  assert.equal(fx.rowOf(msgId).status, 'done');
  assert.equal(fx.assistantCount(), 1);

  // Legacy terminal report through /api/response: ignored, nothing minted.
  const viaResponse = await fx.post('/api/response', {
    messageId: msgId, conversationId: CONV, terminalError: { code: 'boom', message: 'late crash' },
  });
  assert.equal(viaResponse.status, 200);
  assert.equal(viaResponse.body.ignored, 'already_done');

  // Legacy terminal report through /api/requeue: same story.
  const viaRequeue = await fx.post('/api/requeue', {
    messageId: msgId, terminalError: { code: 'boom', message: 'late crash' },
  });
  assert.equal(viaRequeue.status, 200);

  // And the statement itself now refuses settled rows — this is the guard
  // that used to be missing (setFailed had no status condition at all).
  const direct = fx.stmts.setFailed.run(JSON.stringify({ kind: 'terminal' }), msgId);
  assert.equal(direct.changes, 0, 'setFailed must not touch a done row');

  const finalRow = fx.rowOf(msgId);
  assert.equal(finalRow.status, 'done');
  assert.equal(finalRow.response, 'settled');
  assert.equal(fx.assistantCount(), 1, 'no failure card was minted over the settled turn');
});
