import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import osModule from 'node:os';
import nodePathModule from 'node:path';
import Database from 'better-sqlite3';

import { createClaudeSessionRunner } from './claude-session-process.mjs';
import { buildSteerSettleFailure, STEER_SETTLE_FAILED_TEXT } from './claude-turn-publisher.mjs';
import { failSettlingRowsOnShutdown } from './claude-worker-link-wiring.mjs';
import { buildRelayStopFailure } from '../../shared/relay-stop-failure.mjs';
import { STEER_FOLDED_TEXT } from '../../shared/steer-settle-markers.mjs';
import {
  noopRelocate,
  waitFor,
  scriptedTurn,
  initMessage,
  resultMessage,
  backgroundTasksMessage,
  taskNotificationMessage,
  userReplay,
  assistantText,
  settled,
} from './claude-session-test-harness.mjs';
import {
  buildDequeuedRelayMessage,
  dequeuePendingMessage,
} from '../routes/messages-routes.mjs';
import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  makeApi,
} from '../routes/messages-routes-test-harness.mjs';
import { buildConversationMessages } from '../routes/sessions-routes.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { applySchema } from '../db-schema.mjs';

// Integration: the Claude session runner's absorbed-steering handoff, driven
// against the REAL messages-routes handlers and REAL SQLite queue state — not
// the unit suite's api stub. The unit tests (claude-session-process.test.mjs,
// "a message absorbed into a running continuation completes on that turn
// result" and neighbors) prove the runner calls the right endpoints; this file
// proves those endpoints, run for real, leave the queue in the right state:
// the absorbed message's row goes `done` with the turn's answer, and the
// handed-off continuation row is requeue-dropped to `failed` instead of
// sitting `processing` forever (the 2026-08-18 deadlock).
//
// Boot pattern: the shared in-process route harness the route suites use
// (messages-routes-test-harness.mjs), with a real better-sqlite3 database
// carrying the REAL runtime schema (applySchema from db-schema.mjs — the same
// DDL and migrations production boot runs) and the real repositories for
// stmts. The runner's `api(method, path, body)` dispatches straight into the
// captured handlers via the harness's makeApi.

const CONV = 'conv-claude-int-1';
const RUNTIME_SESSION_ID = 'rs-claude-int-1';
const MODEL = 'claude-sonnet-5';
const NOW = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Real database: the production schema and migrations via applySchema
// (db-schema.mjs), so the columns the repositories probe via PRAGMA table_info
// (queue.kind, queue.image_operation_id, messages.kind/executed_provider, the
// runtime_sessions provider/native-session columns, the *.subagent_run_id
// columns) exist exactly as they do on a live database — message-repository
// only prepares the image-aware 17-parameter insertQ the /api/message handler
// binds when queue.image_operation_id exists.

function makeDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function seedClaudeConversation(db) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(CONV, 'Absorbed steering integration', CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)
  `).run(RUNTIME_SESSION_ID, CONV, CONV, `runtime-key-${RUNTIME_SESSION_ID}`, MODEL, MODEL, NOW, NOW);
}

// ---------------------------------------------------------------------------
// Route harness. The shared baseline (messages-routes-test-harness.mjs)
// carries the generic server-runtime stand-ins; the overrides here are the
// deps this integration exercises for real — db and stmts are fully real —
// plus the Claude-provider wiring and the activity/finalize helpers the
// /api/response path needs.

function makeRouteDeps({ db, stmts, emitted }) {
  return baseRouteDeps({
    db,
    stmts,
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) },
    },
    uuidv4: () => crypto.randomUUID(),
    ts: () => new Date().toISOString(),
    MAX_UPLOAD_ATTACHMENTS: 4,
    ensureSessionId: () => 'client-int-1',
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
    // The session worker's HTTP bridge names its session via headers; routes
    // resolve executed-provider provenance through this identity.
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId } = {}) => {
        const normalized = String(sessionId || '').trim();
        return normalized ? { sessionId: normalized } : null;
      },
    },
  });
}

function bootRelayRoutes() {
  const db = makeDb();
  seedClaudeConversation(db);
  // Same composition (and override order) as server-runtime.mjs `stmts`.
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const emitted = [];
  const deps = makeRouteDeps({ db, stmts, emitted });
  // The runner's api(method, path, body): dispatch into the captured real
  // handlers with the same bridge identity header the live worker sends;
  // makeApi surfaces non-2xx as a rejection like the worker's HTTP client does.
  const captured = captureRoutes(deps);
  const api = makeApi(captured, { headers: { 'x-relay-session-id': CONV } });

  return { db, stmts, deps, api, emitted, captured };
}

// The worker loop's delivery leg, via the same exported helpers the real loop
// runs: claim the pending row (marking it processing) and build the relay
// message payload the worker receives.
function dequeueForWorker({ db, stmts, deps }) {
  const row = dequeuePendingMessage({
    db,
    stmts,
    nowIso: new Date().toISOString(),
    routingEnabled: false,
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

// ---------------------------------------------------------------------------
// The scripted SDK stream and SDK message builders come from the shared
// harness (claude-session-test-harness.mjs), same as the unit suite.
// ---------------------------------------------------------------------------

test('an absorbed steering turn settles the real queue rows through the real routes', async (t) => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  // cwd is only threaded through (transcript relocation is stubbed like the
  // unit suite does, keeping the test off the host ~/.claude entirely).
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-int-'));
  t.after(() => {
    fsSync.rmSync(cwd, { recursive: true, force: true });
  });

  // -- Message 1 enters through the real enqueue route and the real dequeue.
  const enqueue1 = await api('POST', '/api/message', {
    clientId: 'client-int-1',
    conversationId: CONV,
    text: 'hello',
    model: MODEL,
    relayMode: 'agent',
  });
  assert.equal(enqueue1.ok, true);
  assert.equal(enqueue1.runtimeProviderType, 'claude');
  const msg1Id = enqueue1.messageId;
  assert.equal(stmts.findQById.get(msg1Id).status, 'pending');

  const delivered1 = dequeueForWorker({ db, stmts, deps });
  assert.equal(delivered1?.id, msg1Id);
  assert.equal(delivered1.providerType, 'claude');
  assert.equal(stmts.findQById.get(msg1Id).status, 'processing');

  const turn = scriptedTurn();
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: () => turn,
    relocateTranscriptImpl: noopRelocate,
    continuationRetryDelayMs: 10,
    lifecyclePollMs: 10,
  });

  // -- (a) Turn 1: init + user replay + a background task + the result.
  const first = runner.handlePendingPayload({ message: delivered1 });
  turn.emit(initMessage('native-int-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'background job' }]));
  turn.emit(resultMessage('dispatched', 'native-int-1'));
  assert.equal(await first, true);

  const row1 = stmts.findQById.get(msg1Id);
  assert.equal(row1.status, 'done', 'message 1 queue row completes through the real /api/response');
  assert.equal(row1.response, 'dispatched');
  const assistant1 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(row1.response_message_id);
  assert.equal(assistant1?.text, 'dispatched');
  assert.equal(assistant1?.role, 'assistant');
  // The bridge identity resolved through the real runtime_sessions row.
  assert.equal(assistant1?.executed_provider, 'claude');
  // The init's native session id landed through the real persist route.
  await waitFor(
    () => stmts.getRuntimeSessionByConversation.get(CONV)?.claude_native_session_id === 'native-int-1',
    { label: 'native session id persisted via /api/claude-native-session' },
  );

  // -- (b) The task settles and the CLI opens its own continuation turn; the
  // runner registers it through the REAL /api/continuation-turn, which births
  // a processing queue row of kind 'continuation'.
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(assistantText('checking what the agent produced'));
  const contRow = await waitFor(
    () => db.prepare(`SELECT * FROM queue WHERE kind = 'continuation'`).get(),
    { label: 'continuation row registered' },
  );
  assert.equal(contRow.status, 'processing');
  assert.equal(contRow.conversation_id, CONV);
  assert.equal(contRow.owner_sdk_session_id, CONV);
  assert.equal(contRow.text, '[background continuation]');

  // -- (c) Message 2 arrives mid-continuation, is claimed and delivered, and
  // the CLI absorbs its pushed replay into the RUNNING continuation turn
  // (steering): replay mid-turn, then ONE result for the whole turn.
  const enqueue2 = await api('POST', '/api/message', {
    clientId: 'client-int-1',
    conversationId: CONV,
    text: 'quick question',
    model: MODEL,
    relayMode: 'agent',
  });
  const msg2Id = enqueue2.messageId;
  const delivered2 = dequeueForWorker({ db, stmts, deps });
  assert.equal(delivered2?.id, msg2Id);
  assert.equal(stmts.findQById.get(msg2Id).status, 'processing');

  const second = runner.handlePendingPayload({ message: delivered2 });
  await waitFor(
    () => runner._getProcess()?.pendingDelivered?.length === 1,
    { label: 'message 2 pushed into the live process' },
  );
  turn.emit(userReplay('quick question'));
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-int-1'));

  // -- (d) The delivered row owns the turn's single result; the handed-off
  // continuation must not stay processing (its empty turn is requeue-dropped,
  // which the real route turns into a quiet 'failed' for continuations).
  assert.equal(await second, true, 'handlePendingPayload resolved the absorbed message as handled');
  const row2 = stmts.findQById.get(msg2Id);
  assert.equal(row2.status, 'done', 'the absorbed message queue row is done in the real DB');
  assert.equal(row2.response, 'here is the answer');
  const assistant2 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(row2.response_message_id);
  assert.equal(assistant2?.text, 'here is the answer');

  const contAfter = await waitFor(() => {
    const row = stmts.findQById.get(contRow.id);
    return row && row.status !== 'processing' ? row : null;
  }, { label: 'continuation row released' });
  assert.equal(contAfter.status, 'failed', 'the requeue-dropped continuation fails over quietly');
  assert.equal(contAfter.response_message_id, null, 'the continuation never swallowed the answer as its response');

  assert.equal(
    db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE status = 'processing'`).get().cnt,
    0,
    'no queue row is left processing',
  );
  assert.equal(runner._getProcess().pendingDelivered.length, 0);

  turn.endInput();
  await settled(runner);
});

test('a steered delivered turn persists kind=absorbed on the interrupted reply', async (t) => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-absorb-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });

  const enqueue1 = await api('POST', '/api/message', {
    clientId: 'client-absorb-1',
    conversationId: CONV,
    text: 'first',
    model: MODEL,
    relayMode: 'agent',
  });
  const msg1Id = enqueue1.messageId;
  const delivered1 = dequeueForWorker({ db, stmts, deps });
  assert.equal(delivered1?.id, msg1Id);

  const turn = scriptedTurn();
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: () => turn,
    relocateTranscriptImpl: noopRelocate,
    continuationRetryDelayMs: 10,
    lifecyclePollMs: 10,
  });

  // Turn 1 streams before it is absorbed, so its row keeps that text.
  const first = runner.handlePendingPayload({ message: delivered1 });
  turn.emit(initMessage('native-absorb-1'));
  turn.emit(userReplay('first'));
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'starting the first thing' } },
  });
  await waitFor(
    () => db.prepare(`SELECT COUNT(*) AS cnt FROM relay_stream_events WHERE queue_message_id = ?`).get(msg1Id).cnt > 0,
    { label: 'turn 1 streamed before absorption' },
  );

  // Message 2 arrives mid-turn and the CLI absorbs it (steering).
  const enqueue2 = await api('POST', '/api/message', {
    clientId: 'client-absorb-1',
    conversationId: CONV,
    text: 'and also this',
    model: MODEL,
    relayMode: 'agent',
  });
  const msg2Id = enqueue2.messageId;
  const delivered2 = dequeueForWorker({ db, stmts, deps });
  assert.equal(delivered2?.id, msg2Id);

  const second = runner.handlePendingPayload({ message: delivered2 });
  await waitFor(
    () => runner._getProcess()?.pendingDelivered?.length === 1,
    { label: 'message 2 pushed into the live turn' },
  );
  turn.emit(userReplay('and also this'));
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'did both things' } },
  });
  turn.emit(resultMessage('did both things', 'native-absorb-1'));

  assert.equal(await first, true);
  assert.equal(await second, true);

  const row1 = stmts.findQById.get(msg1Id);
  assert.equal(row1.status, 'done', 'the interrupted row completes (never requeued — the CLI consumed it)');
  const assistant1 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(row1.response_message_id);
  assert.equal(assistant1?.kind, 'absorbed', 'the interrupted reply is stamped kind=absorbed');
  assert.equal(assistant1?.text, 'starting the first thing');

  const row2 = stmts.findQById.get(msg2Id);
  assert.equal(row2.status, 'done');
  const assistant2 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(row2.response_message_id);
  assert.equal(assistant2?.text, 'did both things');
  assert.notEqual(assistant2?.kind, 'absorbed', 'the steered row owns the real answer, not the merge marker');

  assert.equal(
    db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE status = 'processing'`).get().cnt,
    0,
    'no queue row is left processing',
  );
  turn.endInput();
  await settled(runner);
});

test('a message sent while a question card is open is requeued penalty-free and the card survives', async (t) => {
  const { db, stmts, deps, api: routeApi } = bootRelayRoutes();
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-held-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });

  // The question routes live outside messages-routes; this stand-in keeps the
  // card in the REAL relay_questions table (FK + ON DELETE CASCADE on the
  // owning queue row), which is what a wrong row transition would destroy.
  const api = async (method, routePath, body) => {
    if (method === 'POST' && routePath === '/api/relay-question') {
      db.prepare(`
        INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, prompt, status, created_at, expires_at)
        VALUES ('rq-int', ?, ?, ?, ?, 'pending', ?, ?)
      `).run(body.queueId, body.conversationId, body.messageId, body.prompt, NOW, '2099-01-01T00:00:00.000Z');
      return { question: { id: 'rq-int' } };
    }
    if (method === 'GET' && routePath === '/api/relay-question/rq-int') {
      const row = db.prepare(`SELECT * FROM relay_questions WHERE id = 'rq-int'`).get();
      return { question: row ? { id: row.id, status: row.status, answer: row.answer } : null };
    }
    return routeApi(method, routePath, body);
  };
  const cardRow = () => db.prepare(`SELECT * FROM relay_questions WHERE id = 'rq-int'`).get();

  const msg1Id = (await api('POST', '/api/message', {
    clientId: 'client-held-1', conversationId: CONV, text: 'first', model: MODEL, relayMode: 'agent',
  })).messageId;
  const delivered1 = dequeueForWorker({ db, stmts, deps });
  const turn = scriptedTurn();
  let canUseTool = null;
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: (params) => { canUseTool = params.canUseTool; return turn; },
    relocateTranscriptImpl: noopRelocate,
    continuationRetryDelayMs: 10,
    lifecyclePollMs: 10,
    steeredFoldGraceMs: 60_000,
    askUserBridgeOptions: { questionPollMs: 5 },
  });

  const first = runner.handlePendingPayload({ message: delivered1 });
  turn.emit(initMessage('native-held-1'));
  turn.emit(userReplay('first'));
  turn.emit(assistantText('one question first'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'turn 1 is live' });
  const decision = canUseTool('AskUserQuestion', {
    questions: [{ question: 'Proceed?', options: [{ label: 'option A' }] }],
  }, {});
  await waitFor(() => cardRow()?.status === 'pending', { label: 'the card is open' });
  assert.equal(cardRow().queue_id, msg1Id);

  // Message 2 is claimed and delivered while the card is open.
  const msg2Id = (await api('POST', '/api/message', {
    clientId: 'client-held-1', conversationId: CONV, text: 'second', model: MODEL, relayMode: 'agent',
  })).messageId;
  const delivered2 = dequeueForWorker({ db, stmts, deps });
  assert.equal(delivered2?.id, msg2Id);
  assert.equal(await runner.handlePendingPayload({ message: delivered2 }), false);

  const held = stmts.findQById.get(msg2Id);
  assert.equal(held.status, 'pending', 'handed back to the queue');
  assert.equal(Number(held.retry_count || 0), 0, 'no retry penalty');
  assert.equal(held.next_attempt_at, null, 'no backoff: eligible the moment the worker is ready');
  assert.equal(held.attempt_id, null);
  assert.equal(cardRow()?.status, 'pending', 'the card is neither cancelled, timed out nor deleted');
  assert.equal(stmts.findQById.get(msg1Id).status, 'processing', 'the card-owning row is untouched');

  db.prepare(`UPDATE relay_questions SET status = 'answered', answer = 'option A', answered_at = ? WHERE id = 'rq-int'`).run(NOW);
  assert.equal((await decision).behavior, 'allow');

  // Re-delivered after the answer: it steers into the resumed turn.
  const redelivered = dequeueForWorker({ db, stmts, deps });
  assert.equal(redelivered?.id, msg2Id);
  const second = runner.handlePendingPayload({ message: redelivered });
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: 'message 2 steered in' });
  turn.emit(userReplay('second'));
  turn.emit(resultMessage('did A, then the second thing', 'native-held-1'));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(stmts.findQById.get(msg2Id).status, 'done');
  assert.equal(stmts.findQById.get(msg2Id).response, 'did A, then the second thing');
  assert.equal(cardRow()?.status, 'answered', 'the card kept its answer');
  turn.endInput();
  await settled(runner);
});

test('steers cut off by Stop persist kind=stopped and reload with it', async (t) => {
  const { db, stmts, deps, api, emitted } = bootRelayRoutes();
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-stopped-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });

  await api('POST', '/api/message', { clientId: 'client-stop-1', conversationId: CONV, text: 'first', model: MODEL, relayMode: 'agent' });
  const delivered1 = dequeueForWorker({ db, stmts, deps });
  const turn = scriptedTurn();
  let abortTurn = null;
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: () => turn,
    relocateTranscriptImpl: noopRelocate,
    controlPoller: {
      start: ({ queueMessageId, onAbortTurn }) => {
        if (queueMessageId === delivered1.id) abortTurn = onAbortTurn;
        return {};
      },
      stop: () => {},
    },
    lifecyclePollMs: 10,
    steeredFoldGraceMs: 30,
  });

  const first = runner.handlePendingPayload({ message: delivered1 });
  turn.emit(initMessage('native-stop-1'));
  turn.emit(userReplay('first'));
  turn.emit(assistantText('working'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'turn 1 is live' });
  const msg2Id = (await api('POST', '/api/message', {
    clientId: 'client-stop-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent',
  })).messageId;
  const second = runner.handlePendingPayload({ message: dequeueForWorker({ db, stmts, deps }) });
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: 'the steer is pushed' });

  await abortTurn();
  turn.emit({ ...resultMessage('', 'native-stop-1'), is_interrupt: true });
  await first;
  assert.equal(await second, true);

  const row2 = stmts.findQById.get(msg2Id);
  assert.equal(row2.status, 'done', 'settled, never requeued');
  assert.equal(Number(row2.retry_count || 0), 0);
  const stub = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(row2.response_message_id);
  assert.equal(stub.kind, 'stopped');
  assert.match(stub.text, /Stopped with the turn — not answered/);
  const live = emitted.find((entry) => entry.event === 'assistant_message' && entry.payload.sourceMessageId === msg2Id);
  assert.equal(live.payload.message.kind, 'stopped', 'the live append carries the kind');

  // The conversation reload payload serves the kind from the DB.
  const reloaded = buildConversationMessages({
    dbMessages: stmts.getMessages.all(CONV),
    responseMessageToSourceId: new Map([[row2.response_message_id, msg2Id]]),
  });
  assert.equal(reloaded.find((message) => message.id === row2.response_message_id)?.kind, 'stopped');
  assert.equal(stub.source_message_id, msg2Id, 'the marker keeps its prompt link beyond the queue');
  assert.equal(live.payload.message.sourceMessageId, msg2Id, 'the live append names its prompt, as a reload does');

  // Resend: the same text is normally a duplicate of the original for ten
  // minutes; naming the stopped original exempts it — once.
  const plainRepeat = await api('POST', '/api/message', {
    clientId: 'client-stop-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent',
  });
  assert.equal(plainRepeat.duplicate, true, 'without the resend link it is still a duplicate');
  const resent = await api('POST', '/api/message', {
    clientId: 'client-stop-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent',
    resendOfMessageId: msg2Id,
  });
  assert.notEqual(resent.duplicate, true, 'a Resend of the stopped steer is accepted');
  assert.equal(stmts.findQById.get(resent.messageId).status, 'pending');
  const resentAgain = await api('POST', '/api/message', {
    clientId: 'client-stop-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent',
    resendOfMessageId: msg2Id,
  });
  assert.equal(resentAgain.duplicate, true, 'a second Resend collides with the first');
  turn.endInput();
  await settled(runner);
});

test('a resend link to a message that was not stopped does not bypass the duplicate guard', async () => {
  const { stmts, api } = bootRelayRoutes();
  const original = await api('POST', '/api/message', {
    clientId: 'client-resend-2', conversationId: CONV, text: 'answered already', model: MODEL, relayMode: 'agent',
  });
  assert.equal(stmts.findQById.get(original.messageId).status, 'pending');
  const repeat = await api('POST', '/api/message', {
    clientId: 'client-resend-2', conversationId: CONV, text: 'answered already', model: MODEL, relayMode: 'agent',
    resendOfMessageId: original.messageId,
  });
  assert.equal(repeat.duplicate, true);
});

test('a folded steer persists kind=folded, and reloads anchored to its prompt after the queue row is pruned', async (t) => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-folded-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });

  const msg1Id = (await api('POST', '/api/message', {
    clientId: 'client-fold-1', conversationId: CONV, text: 'first', model: MODEL, relayMode: 'agent',
  })).messageId;
  const delivered1 = dequeueForWorker({ db, stmts, deps });
  const turn = scriptedTurn();
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: () => turn,
    relocateTranscriptImpl: noopRelocate,
    lifecyclePollMs: 10,
    steeredFoldGraceMs: 30,
  });
  const first = runner.handlePendingPayload({ message: delivered1 });
  turn.emit(initMessage('native-fold-1'));
  turn.emit(userReplay('first'));
  turn.emit(assistantText('working'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'turn 1 is live' });
  const msg2Id = (await api('POST', '/api/message', {
    clientId: 'client-fold-1', conversationId: CONV, text: 'and this too', model: MODEL, relayMode: 'agent',
  })).messageId;
  const second = runner.handlePendingPayload({ message: dequeueForWorker({ db, stmts, deps }) });
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: 'the steer is pushed' });
  // The CLI folds the steer into the turn: one result, no replay.
  turn.emit(resultMessage('did both', 'native-fold-1'));
  assert.equal(await first, true);
  assert.equal(await second, true);

  const stub = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(stmts.findQById.get(msg2Id).response_message_id);
  assert.equal(stub.kind, 'folded', 'a fold is never stamped absorbed');
  assert.equal(stub.source_message_id, msg2Id);

  // The queue keeps only the newest finished rows; once these are pruned the
  // message column alone must anchor each reply under its prompt.
  db.prepare(`DELETE FROM queue`).run();
  const reloaded = buildConversationMessages({ dbMessages: stmts.getMessages.all(CONV) });
  assert.equal(reloaded.find((message) => message.id === stub.id)?.sourceMessageId, msg2Id);
  const answer = reloaded.find((message) => message.role === 'assistant' && message.text === 'did both');
  assert.equal(answer?.sourceMessageId, msg1Id);
  turn.endInput();
  await settled(runner);
});

test('a fold stub from a worker still on the old kind is stored as folded', async () => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  const msgId = (await api('POST', '/api/message', {
    clientId: 'client-fold-legacy', conversationId: CONV, text: 'steered earlier', model: MODEL, relayMode: 'agent',
  })).messageId;
  const delivered = dequeueForWorker({ db, stmts, deps });
  await api('POST', '/api/response', {
    messageId: msgId,
    conversationId: CONV,
    text: STEER_FOLDED_TEXT,
    model: MODEL,
    absorbed: true,
    attemptId: delivered.attemptId,
  });
  const stub = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(stmts.findQById.get(msgId).response_message_id);
  assert.equal(stub.kind, 'folded');
});

test('a steer-settle failure fails the row terminally with the resend-only-if-unanswered wording', async () => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  await api('POST', '/api/message', { clientId: 'client-settle-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent' });
  const delivered = dequeueForWorker({ db, stmts, deps });

  // Exactly what publishSettleMarker sends after its retry budget is spent.
  await api('POST', '/api/response', {
    messageId: delivered.id,
    conversationId: CONV,
    text: STEER_SETTLE_FAILED_TEXT,
    terminalError: buildSteerSettleFailure(delivered),
    attemptId: delivered.attemptId,
  });

  const row = stmts.findQById.get(delivered.id);
  assert.equal(row.status, 'failed', 'terminal — nothing requeues it');
  assert.equal(Number(row.retry_count || 0), 0);
  assert.match(row.response, /already sent to Claude — check the reply above/);
  assert.match(row.response, /relay\.steer-settle-failed/);
  assert.match(row.response, /Resend it only if it went unanswered/);
  // A late requeue from anywhere cannot revive it.
  await api('POST', '/api/requeue', { messageId: delivered.id });
  assert.equal(stmts.findQById.get(delivered.id).status, 'failed');
});

test('a steer pending when its turn finishes is marked consumed, and no recovery path re-runs it', async (t) => {
  // At-most-once must survive the worker: SIGKILL/OOM or a relay restart
  // between the turn's result and the fold settle used to hand the steer to
  // recovery, which requeued it and ran it twice.
  const { db, stmts, deps, api } = bootRelayRoutes();
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-consumed-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });

  await api('POST', '/api/message', { clientId: 'client-c-1', conversationId: CONV, text: 'first', model: MODEL, relayMode: 'agent' });
  const delivered1 = dequeueForWorker({ db, stmts, deps });
  const turn = scriptedTurn();
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: () => turn,
    relocateTranscriptImpl: noopRelocate,
    lifecyclePollMs: 10,
    steeredFoldGraceMs: 60_000, // the worker "dies" before it settles the fold
  });
  const first = runner.handlePendingPayload({ message: delivered1 });
  turn.emit(initMessage('native-c-1'));
  turn.emit(userReplay('first'));
  turn.emit(assistantText('working'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'turn 1 is live' });
  const steerIds = [];
  for (const text of ['steer one', 'steer two']) {
    steerIds.push((await api('POST', '/api/message', {
      clientId: 'client-c-1', conversationId: CONV, text, model: MODEL, relayMode: 'agent',
    })).messageId);
    void runner.handlePendingPayload({ message: dequeueForWorker({ db, stmts, deps }) });
  }
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 2, { label: 'both steers pushed' });
  turn.emit(resultMessage('did it all', 'native-c-1'));
  assert.equal(await first, true);

  for (const id of steerIds) {
    const row = stmts.findQById.get(id);
    assert.equal(row.status, 'processing');
    assert.ok(row.consumed_at, 'marked consumed in the same commit as the turn that took it');
  }

  // Heartbeat owner recovery (the worker stopped reporting the row).
  db.prepare(`UPDATE queue SET owner_sdk_session_id = ?, owner_last_claimed_at = ?, processing_at = ? WHERE id = ?`)
    .run(CONV, NOW, NOW, steerIds[0]);
  await api('POST', '/api/heartbeat', {});
  const recovered = stmts.findQById.get(steerIds[0]);
  assert.equal(recovered.status, 'failed', 'failed terminally, not requeued');
  assert.match(recovered.response, /relay\.steer-settle-failed/);

  // A plain requeue (crash guard of an older worker, a stray caller).
  await api('POST', '/api/requeue', { messageId: steerIds[1] });
  const requeued = stmts.findQById.get(steerIds[1]);
  assert.equal(requeued.status, 'failed');
  assert.match(requeued.response, /already sent to Claude/);
  assert.equal(Number(requeued.retry_count || 0), 0);

  turn.endInput();
  await settled(runner);
});

test('a consumed steer that gets its own replayed turn is un-marked and settles with its answer', async (t) => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  // Owned by this worker session, as with session-worker routing on.
  const ownedDelivery = () => {
    const message = dequeueForWorker({ db, stmts, deps });
    db.prepare(`UPDATE queue SET owner_sdk_session_id = ? WHERE id = ?`).run(CONV, message.id);
    return message;
  };
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-routes-consumed-own-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });

  await api('POST', '/api/message', { clientId: 'client-c-2', conversationId: CONV, text: 'first', model: MODEL, relayMode: 'agent' });
  const turn = scriptedTurn();
  const runner = createClaudeSessionRunner({
    api, sdkSessionId: CONV, cwd, startClaudeSessionImpl: () => turn, relocateTranscriptImpl: noopRelocate,
    lifecyclePollMs: 10, steeredFoldGraceMs: 60_000,
  });
  const first = runner.handlePendingPayload({ message: ownedDelivery() });
  turn.emit(initMessage('native-c-2'));
  turn.emit(userReplay('first'));
  turn.emit(assistantText('working'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'turn 1 is live' });
  const steerId = (await api('POST', '/api/message', {
    clientId: 'client-c-2', conversationId: CONV, text: 'queued steer', model: MODEL, relayMode: 'agent',
  })).messageId;
  const second = runner.handlePendingPayload({ message: ownedDelivery() });
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: 'steer pushed' });
  turn.emit(resultMessage('first answer', 'native-c-2'));
  assert.equal(await first, true);
  assert.ok(stmts.findQById.get(steerId).consumed_at);

  // Replayed within the grace as its own turn: an ordinary in-flight row
  // again (a worker death now must not fail it with "check the reply above"),
  // and answered normally.
  turn.emit(userReplay('queued steer'));
  await waitFor(() => stmts.findQById.get(steerId).consumed_at === null, { label: 'the consumed mark cleared on attach' });
  turn.emit(resultMessage('the steer’s own answer', 'native-c-2'));
  assert.equal(await second, true);
  const row = stmts.findQById.get(steerId);
  assert.equal(row.status, 'done');
  assert.equal(row.response, 'the steer’s own answer');
  turn.endInput();
  await settled(runner);
});

test('the heartbeat fails the settle-failed rows a worker hands over', async () => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  await api('POST', '/api/message', { clientId: 'client-sf-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent' });
  const delivered = dequeueForWorker({ db, stmts, deps });
  const terminalError = buildSteerSettleFailure(delivered, { variant: 'stopped' });

  // Unowned, or owned by another worker: never failed on this worker's word.
  const unowned = await api('POST', '/api/heartbeat', {
    activeQueueMessageIds: [delivered.id],
    settleFailed: [{ id: delivered.id, attemptId: delivered.attemptId, terminalError }],
  });
  assert.equal(unowned.settleFailedHandled, undefined);
  assert.deepEqual(unowned.settleFailedSkipped, [delivered.id], 'acknowledged as skipped so the worker lets go');
  assert.equal(stmts.findQById.get(delivered.id).status, 'processing');
  db.prepare(`UPDATE queue SET owner_sdk_session_id = 'someone-else' WHERE id = ?`).run(delivered.id);
  const otherOwner = await api('POST', '/api/heartbeat', { settleFailed: [{ id: delivered.id, attemptId: delivered.attemptId, terminalError }] });
  assert.deepEqual(otherOwner.settleFailedSkipped, [delivered.id]);
  assert.equal(stmts.findQById.get(delivered.id).status, 'processing');
  db.prepare(`UPDATE queue SET owner_sdk_session_id = ? WHERE id = ?`).run(CONV, delivered.id);

  const stale = await api('POST', '/api/heartbeat', {
    activeQueueMessageIds: [delivered.id],
    settleFailed: [{ id: delivered.id, attemptId: 'attempt-not-current', terminalError }],
  });
  assert.deepEqual(stale.settleFailedHandled, [delivered.id], 'a superseded attempt is acknowledged, not failed');
  assert.equal(stmts.findQById.get(delivered.id).status, 'processing');

  const response = await api('POST', '/api/heartbeat', {
    activeQueueMessageIds: [delivered.id],
    settleFailed: [{ id: delivered.id, attemptId: delivered.attemptId, terminalError }],
  });
  assert.deepEqual(response.settleFailedHandled, [delivered.id]);
  const row = stmts.findQById.get(delivered.id);
  assert.equal(row.status, 'failed');
  assert.match(row.response, /just before you stopped the turn/, 'the worker’s path-accurate wording is kept');
  assert.match(row.response, /relay\.steer-settle-failed/);
});

test('/api/queue-consumed only lets the owning worker mark or clear, fenced on the attempt', async () => {
  const { db, stmts, deps, api, captured } = bootRelayRoutes();
  await api('POST', '/api/message', { clientId: 'client-qc-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent' });
  const delivered = dequeueForWorker({ db, stmts, deps });
  const consumedAt = () => stmts.findQById.get(delivered.id).consumed_at;
  const entries = [{ id: delivered.id, attemptId: delivered.attemptId }];

  // Anonymous callers (no worker identity) are refused outright.
  const anonymous = makeApi(captured);
  await assert.rejects(() => anonymous('POST', '/api/queue-consumed', { conversationId: CONV, entries }), /403/);

  db.prepare(`UPDATE queue SET owner_sdk_session_id = 'someone-else' WHERE id = ?`).run(delivered.id);
  assert.equal((await api('POST', '/api/queue-consumed', { conversationId: CONV, entries })).changed, 0, 'not the owner');
  db.prepare(`UPDATE queue SET owner_sdk_session_id = ? WHERE id = ?`).run(CONV, delivered.id);
  assert.equal((await api('POST', '/api/queue-consumed', {
    conversationId: CONV, entries: [{ id: delivered.id, attemptId: 'attempt-stale' }],
  })).changed, 0, 'a superseded attempt');
  assert.equal(consumedAt(), null);

  assert.equal((await api('POST', '/api/queue-consumed', { conversationId: CONV, entries })).changed, 1);
  assert.ok(consumedAt());
  assert.equal((await api('POST', '/api/queue-consumed', { conversationId: CONV, entries, consumed: false })).changed, 1);
  assert.equal(consumedAt(), null, 'replayed as its own turn: an ordinary in-flight row again');
});

test('a superseded attempt’s late error result cannot mark steers consumed', async () => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  await api('POST', '/api/message', { clientId: 'client-st-1', conversationId: CONV, text: 'host', model: MODEL, relayMode: 'agent' });
  const host = dequeueForWorker({ db, stmts, deps });
  await api('POST', '/api/message', { clientId: 'client-st-1', conversationId: CONV, text: 'steer', model: MODEL, relayMode: 'agent' });
  const steer = dequeueForWorker({ db, stmts, deps });

  await assert.rejects(() => api('POST', '/api/response', {
    messageId: host.id,
    conversationId: CONV,
    text: 'Claude turn failed (error_during_execution).',
    terminalError: { code: 'error_during_execution', stableCode: 'claude.error_during_execution', message: 'failed' },
    consumedSteerIds: [{ id: steer.id, attemptId: steer.attemptId }],
    attemptId: 'attempt-superseded',
  }), /409/);
  assert.equal(stmts.findQById.get(steer.id).consumed_at, null, 'nothing marked outside the fenced write');

  await api('POST', '/api/response', {
    messageId: host.id,
    conversationId: CONV,
    text: 'Claude turn failed (error_during_execution).',
    terminalError: { code: 'error_during_execution', stableCode: 'claude.error_during_execution', message: 'failed' },
    consumedSteerIds: [{ id: steer.id, attemptId: steer.attemptId }],
    attemptId: host.attemptId,
  });
  assert.equal(stmts.findQById.get(host.id).status, 'failed');
  assert.ok(stmts.findQById.get(steer.id).consumed_at, 'the current attempt’s errored turn does mark it');
});

test('a worker dying before its abort ack lands fails the stopped row with the Stop wording, never requeues it', async () => {
  const { db, stmts, deps, api } = bootRelayRoutes();
  await api('POST', '/api/message', { clientId: 'client-stop-crash', conversationId: CONV, text: 'long task', model: MODEL, relayMode: 'agent' });
  const delivered = dequeueForWorker({ db, stmts, deps });
  // Exactly what the crash guard / SIGTERM send for a lingering stopped row.
  const entry = { id: delivered.id, attemptId: delivered.attemptId, terminalError: buildRelayStopFailure() };
  const calls = [];
  await failSettlingRowsOnShutdown({
    api: async (method, routePath, body) => { calls.push(body); return api(method, routePath, body); },
    runner: { getActiveQueueMessageIds: () => [entry] },
  });
  assert.equal(calls.length, 1);
  const row = stmts.findQById.get(delivered.id);
  assert.equal(row.status, 'failed', 'not pending: the stopped prompt is never re-run');
  assert.equal(Number(row.retry_count || 0), 0);
  assert.match(row.response, /stopped from the relay UI before completion/);
  assert.match(row.response, /relay\.turn-aborted/);
});

// ---------------------------------------------------------------------------
// Idempotent continuation registration. The worker mints one operationId
// before its first POST and repeats it on retries, so a retry whose previous
// request committed but lost its HTTP response must resolve to the row it
// already created — never mint a twin row nobody will ever settle.

test('repeating a continuation registration with one operation id resolves to the same row', async () => {
  const { db, api } = bootRelayRoutes();

  const first = await api('POST', '/api/continuation-turn', {
    conversationId: CONV,
    operationId: 'op-cont-repeat-1',
  });
  assert.equal(first.ok, true);
  assert.ok(first.messageId, 'registration returns the minted row id');
  assert.ok(first.attemptId, 'a continuation is born with its processing attempt');
  assert.notEqual(first.existing, true, 'the first registration is not a reuse');

  // The retry: same operation id, same conversation — same row back.
  const second = await api('POST', '/api/continuation-turn', {
    conversationId: CONV,
    operationId: 'op-cont-repeat-1',
  });
  assert.equal(second.ok, true);
  assert.equal(second.messageId, first.messageId, 'the retry resolves to the original row');
  assert.equal(second.existing, true, 'the retry is flagged as a reuse');
  assert.equal(second.attemptId, first.attemptId, 'the reused row keeps its birth attempt');

  const rows = db.prepare(`SELECT * FROM queue WHERE kind = 'continuation' AND continuation_op_id = ?`).all('op-cont-repeat-1');
  assert.equal(rows.length, 1, 'exactly one continuation row exists for the operation id');
  assert.equal(rows[0].id, first.messageId);
  assert.equal(rows[0].status, 'processing');
  assert.equal(rows[0].attempt_id, first.attemptId);
});

test('distinct continuation operation ids mint distinct rows', async () => {
  const { db, api } = bootRelayRoutes();

  const first = await api('POST', '/api/continuation-turn', {
    conversationId: CONV,
    operationId: 'op-cont-a',
  });
  const second = await api('POST', '/api/continuation-turn', {
    conversationId: CONV,
    operationId: 'op-cont-b',
  });
  assert.notEqual(second.messageId, first.messageId, 'each operation id owns its own row');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE kind = 'continuation'`).get().cnt,
    2,
  );
});

test('a continuation operation id bound to another conversation is refused', async () => {
  const { db, api } = bootRelayRoutes();
  // Second claude-bound conversation, same shape as the primary seed.
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES ('conv-cont-other', 'Other conversation', 'conv-cont-other', 'active', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES ('rs-cont-other', 'conv-cont-other', 'conv-cont-other', 'isolated', 'runtime-key-rs-cont-other', ?, 'claude', ?, 'active', ?, ?)
  `).run(MODEL, MODEL, NOW, NOW);

  const first = await api('POST', '/api/continuation-turn', {
    conversationId: CONV,
    operationId: 'op-cont-crossed',
  });
  assert.equal(first.ok, true);

  // A stale worker replaying the id against a different conversation must be
  // refused, not handed the other conversation's row.
  await assert.rejects(
    () => api('POST', '/api/continuation-turn', {
      conversationId: 'conv-cont-other',
      operationId: 'op-cont-crossed',
    }),
    /409.*another conversation/i,
  );
  // The refusal minted nothing for the other conversation.
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE conversation_id = 'conv-cont-other'`).get().cnt,
    0,
  );
});

test('the continuation gate admits copilot providers and fails closed otherwise', async () => {
  const { db, api } = bootRelayRoutes();
  const seed = (conv, provider) => {
    db.prepare(`
      INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(conv, `gate ${provider || 'unbound'}`, conv, NOW, NOW);
    if (provider) {
      db.prepare(`
        INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
        VALUES (?, ?, ?, 'isolated', ?, ?, ?, ?, 'active', ?, ?)
      `).run(`rs-${conv}`, conv, conv, `runtime-key-${conv}`, MODEL, provider, MODEL, NOW, NOW);
    }
  };

  // Both Copilot-CLI providers pass — the SDK worker's detached-shell
  // continuations depend on it (live burn-in session 10a1a9ad: the timer
  // wake-up had nowhere to land while the gate was claude-only).
  seed('conv-gate-github', 'github');
  assert.equal((await api('POST', '/api/continuation-turn', { conversationId: 'conv-gate-github' })).ok, true);
  seed('conv-gate-openai', 'openai');
  assert.equal((await api('POST', '/api/continuation-turn', { conversationId: 'conv-gate-openai' })).ok, true);

  // A provider with no continuation-capable worker is refused…
  seed('conv-gate-cursor', 'cursor');
  await assert.rejects(
    () => api('POST', '/api/continuation-turn', { conversationId: 'conv-gate-cursor' }),
    /not supported|409/i,
  );
  // …and an unbound conversation fails closed instead of defaulting to github.
  seed('conv-gate-unbound', null);
  await assert.rejects(
    () => api('POST', '/api/continuation-turn', { conversationId: 'conv-gate-unbound' }),
    /runtime session|404/i,
  );
});
