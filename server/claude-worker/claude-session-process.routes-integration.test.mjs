import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import osModule from 'node:os';
import nodePathModule from 'node:path';
import Database from 'better-sqlite3';

import { createClaudeSessionRunner } from './claude-session-process.mjs';
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
  const api = makeApi(captureRoutes(deps), { headers: { 'x-relay-session-id': CONV } });

  return { db, stmts, deps, api, emitted };
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
