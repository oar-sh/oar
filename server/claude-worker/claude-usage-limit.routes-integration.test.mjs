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
  userReplay,
  assistantText,
  backgroundTasksMessage,
  taskNotificationMessage,
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
import {
  buildUsageLimitResumePrompt,
  createUsageLimitPauseService,
} from '../services/usage-limit-pause-service.mjs';

// Integration: a Claude turn the CLI refuses at the subscription's usage
// limit, driven through the real session runner, the real messages routes and
// a real SQLite queue. The stream below is what CLI 2.1.283 sent at the limit
// (shared/claude-usage-limit.mjs), with invented ids.

const CONV = 'conv-usage-limit-1';
const RUNTIME_SESSION_ID = 'rs-usage-limit-1';
const MODEL = 'claude-sonnet-5';
const NOW = '2026-01-01T00:00:00.000Z';
const LIMIT_TEXT = "You've hit your session limit · resets 10pm (UTC)";

function rejectedEvent(resetsAtMs, rateLimitType = 'five_hour') {
  const resetsAt = Math.round(resetsAtMs / 1000);
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      resetsAt,
      rateLimitType,
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: { [rateLimitType]: { utilization: 1, resetsAt } },
    },
  };
}

function warningEvent(resetsAtMs) {
  const resetsAt = Math.round(resetsAtMs / 1000);
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt,
      rateLimitType: 'five_hour',
      utilization: 0.96,
      surpassedThreshold: 0.9,
      isUsingOverage: false,
    },
  };
}

function syntheticLimitMessage() {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg-synthetic-1', model: '<synthetic>', content: [{ type: 'text', text: LIMIT_TEXT }] },
    error: 'rate_limit',
    is_api_error_message: true,
  };
}

function refusedResult(sessionId) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    terminal_reason: 'api_error',
    result: LIMIT_TEXT,
    session_id: sessionId,
    num_turns: 1,
    duration_api_ms: 0,
  };
}

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(CONV, 'Usage limit integration', CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)
  `).run(RUNTIME_SESSION_ID, CONV, CONV, `runtime-key-${RUNTIME_SESSION_ID}`, MODEL, MODEL, NOW, NOW);
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const emitted = [];
  const usageLimitPauseService = createUsageLimitPauseService({
    db,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    formatResetTime: (iso) => iso,
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
    ensureSessionId: () => 'client-usage-limit-1',
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
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId } = {}) => {
        const normalized = String(sessionId || '').trim();
        return normalized ? { sessionId: normalized } : null;
      },
    },
    usageLimitPauseService,
  });
  const captured = captureRoutes(deps);
  const api = makeApi(captured, { headers: { 'x-relay-session-id': CONV } });
  return { db, stmts, deps, api, emitted, usageLimitPauseService };
}

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

function makeRunner(t, { api, turn }) {
  const cwd = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'claude-usage-limit-'));
  t.after(() => { fsSync.rmSync(cwd, { recursive: true, force: true }); });
  return createClaudeSessionRunner({
    api,
    sdkSessionId: CONV,
    cwd,
    startClaudeSessionImpl: () => turn,
    relocateTranscriptImpl: noopRelocate,
    continuationRetryDelayMs: 10,
    lifecyclePollMs: 10,
  });
}

async function sendAndDeliver(ctx, text) {
  const enqueued = await ctx.api('POST', '/api/message', {
    clientId: 'client-usage-limit-1',
    conversationId: CONV,
    text,
    model: MODEL,
    relayMode: 'agent',
  });
  const delivered = dequeueForWorker(ctx);
  assert.equal(delivered?.id, enqueued.messageId);
  return delivered;
}

test('a turn refused at the 5-hour limit is paused and carries on after the reset', async (t) => {
  const ctx = boot();
  const { db, stmts, api, emitted, usageLimitPauseService } = ctx;
  const resetsAtMs = Date.now() + 90 * 60 * 1000;

  const delivered = await sendAndDeliver(ctx, 'refactor the parser');
  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  const first = runner.handlePendingPayload({ message: delivered });
  turn.emit(initMessage('native-limit-1'));
  turn.emit(rejectedEvent(resetsAtMs));
  turn.emit(syntheticLimitMessage());
  turn.emit(refusedResult('native-limit-1'));
  assert.equal(await first, true);

  // The refused row ends like an answered one, with the note as its reply.
  const refused = stmts.findQById.get(delivered.id);
  assert.equal(refused.status, 'done');
  const note = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(refused.response_message_id);
  assert.match(note.text, /^⏸ Paused: the Claude 5-hour limit is reached\. The turn carries on by itself at /);
  assert.equal(note.role, 'assistant');
  assert.equal(
    emitted.some((entry) => entry.event === 'message_status' && entry.payload.status === 'failed'),
    false,
    'nothing was reported as failed',
  );

  // The follow-up is queued and held until a minute after the reset.
  const held = db.prepare(`SELECT * FROM queue WHERE usage_limit_pause IS NOT NULL`).get();
  assert.equal(held.status, 'pending');
  assert.equal(held.conversation_id, CONV);
  // It quotes what was refused: a bare "continue" did not make the model
  // take the refused prompt up again.
  const resumePrompt = buildUsageLimitResumePrompt({ prompts: ['refactor the parser'] });
  assert.match(resumePrompt, /^Automatic message from OAR: the work was paused at the Claude usage limit\.\n\nThis request was refused at the limit:\n\n> refactor the parser\n\nContinue where you left off/);
  assert.equal(held.text, resumePrompt);
  assert.equal(held.model, MODEL);
  const expectedResetIso = new Date(Math.round(resetsAtMs / 1000) * 1000).toISOString();
  assert.equal(held.next_attempt_at, new Date(Date.parse(expectedResetIso) + 60_000).toISOString());
  const heldMessage = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(held.id);
  assert.equal(heldMessage.role, 'user');
  assert.equal(heldMessage.text, resumePrompt);

  const pause = usageLimitPauseService.getPause(CONV);
  assert.equal(pause.messageId, held.id);
  assert.equal(pause.auto, true);
  assert.equal(pause.rateLimitType, 'five_hour');
  assert.equal(pause.resetsAt, expectedResetIso);
  const pauseEvent = emitted.filter((entry) => entry.event === 'usage_limit_pause').at(-1);
  assert.equal(pauseEvent.payload.conversationId, CONV);
  assert.equal(pauseEvent.payload.pause.messageId, held.id);

  // The rejected report reached the relay as the account's state.
  await waitFor(() => usageLimitPauseService.getAccountState()?.status === 'rejected', { label: 'rejected report recorded' });

  // Held: the worker is handed nothing, and the row counts as no queued work.
  assert.equal(dequeueForWorker(ctx), null);
  assert.deepEqual(stmts.countStatus.all(), []);
  assert.deepEqual(stmts.listPendingWorkerOwnerSessionIds.all(25), []);

  // Resumed by hand: the follow-up is delivered and its turn answers.
  assert.equal(usageLimitPauseService.resumeNow({ conversationId: CONV }).resumed, true);
  assert.equal(usageLimitPauseService.getPause(CONV), null);
  const followUp = dequeueForWorker(ctx);
  assert.equal(followUp?.id, held.id);
  assert.equal(followUp.text, resumePrompt);

  const second = runner.handlePendingPayload({ message: followUp });
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: 'follow-up pushed' });
  turn.emit(initMessage('native-limit-1'));
  turn.emit(userReplay(resumePrompt));
  turn.emit(assistantText('the parser is refactored'));
  turn.emit(resultMessage('the parser is refactored', 'native-limit-1'));
  assert.equal(await second, true);
  const answered = stmts.findQById.get(held.id);
  assert.equal(answered.status, 'done');
  assert.equal(answered.response, 'the parser is refactored');

  turn.endInput();
  await settled(runner);
});

test('a weekly limit days away holds the follow-up until the user resumes it', async (t) => {
  const ctx = boot();
  const { db, api, usageLimitPauseService } = ctx;
  const resetsAtMs = Date.now() + 3 * 24 * 60 * 60 * 1000;

  const delivered = await sendAndDeliver(ctx, 'write the release notes');
  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  const first = runner.handlePendingPayload({ message: delivered });
  turn.emit(initMessage('native-limit-2'));
  turn.emit(rejectedEvent(resetsAtMs, 'seven_day'));
  turn.emit(syntheticLimitMessage());
  turn.emit(refusedResult('native-limit-2'));
  assert.equal(await first, true);

  const held = db.prepare(`SELECT * FROM queue WHERE usage_limit_pause IS NOT NULL`).get();
  assert.equal(held.status, 'pending');
  assert.ok(held.next_attempt_at.startsWith('9999-'), 'held until resumed by hand');
  const pause = usageLimitPauseService.getPause(CONV);
  assert.equal(pause.auto, false);
  assert.equal(pause.resumeAt, null);
  assert.equal(pause.label, 'weekly limit');
  const note = db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant'`).get(CONV);
  assert.match(note.text, /^⏸ Paused: the Claude weekly limit is reached and resets .+\. Resume the turn once it has\.$/);

  assert.equal(usageLimitPauseService.cancel({ conversationId: CONV }).cancelled, true);
  assert.equal(usageLimitPauseService.getPause(CONV), null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE status = 'pending'`).get().cnt, 0);
  // The relay's own message goes with the row; the user's request and the
  // note stay.
  assert.deepEqual(
    db.prepare(`SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY timestamp, rowid`).all(CONV).map((row) => [row.role, row.text.slice(0, 23)]),
    [['user', 'write the release notes'], ['assistant', '⏸ Paused: the Claude we']],
  );

  turn.endInput();
  await settled(runner);
});

test('a limit reached in the middle of a turn pauses it, with what the turn had done kept', async (t) => {
  const ctx = boot();
  const { db, stmts, api, usageLimitPauseService } = ctx;
  const resetsAtMs = Date.now() + 25 * 60 * 1000;

  const delivered = await sendAndDeliver(ctx, 'rename the module');
  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  // The turn begins under a warning, works, and is refused on a later
  // request without a report of its own.
  const first = runner.handlePendingPayload({ message: delivered });
  turn.emit(initMessage('native-limit-7'));
  turn.emit(warningEvent(resetsAtMs));
  turn.emit(userReplay('rename the module'));
  // The real CLI streams what the model writes before the complete message.
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Renaming the module now.' } },
  });
  turn.emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: 'msg-work-1',
      content: [
        { type: 'text', text: 'Renaming the module now.' },
        { type: 'tool_use', id: 'toolu_rename_1', name: 'Bash', input: { command: 'git mv old.mjs new.mjs' } },
      ],
    },
  });
  turn.emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rename_1', content: 'ok' }] },
  });
  turn.emit(syntheticLimitMessage());
  turn.emit(refusedResult('native-limit-7'));
  assert.equal(await first, true);

  const refused = stmts.findQById.get(delivered.id);
  assert.equal(refused.status, 'done');
  const note = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(refused.response_message_id);
  // What the turn had said stays, the CLI's own line about the limit does
  // not, and the note follows.
  assert.match(note.text, /^Renaming the module now\.\n\n⏸ Paused: the Claude 5-hour limit is reached\./);
  assert.doesNotMatch(note.text, /hit your session limit/);
  const activities = stmts.listActivityByResponse.all(note.id).map((row) => row.text);
  assert.ok(activities.some((text) => text.includes('git mv old.mjs new.mjs')), 'the tool call stays with the note');

  const pause = usageLimitPauseService.getPause(CONV);
  assert.equal(pause.auto, true);
  assert.equal(pause.resetsAt, new Date(Math.round(resetsAtMs / 1000) * 1000).toISOString());

  turn.endInput();
  await settled(runner);
});

test('a refusal right after the reset is tried again shortly, and waits for the user in the end', async (t) => {
  const ctx = boot();
  const { db, api, usageLimitPauseService } = ctx;
  // The CLI still names the reset that has just passed.
  const passedResetMs = Date.now() - 60 * 1000;

  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  let delivered = await sendAndDeliver(ctx, 'carry on with the migration');
  for (let round = 1; round <= 7; round += 1) {
    const before = Date.now();
    const handled = runner.handlePendingPayload({ message: delivered });
    if (round > 1) await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: `round ${round} pushed` });
    turn.emit(initMessage('native-limit-6'));
    turn.emit(rejectedEvent(passedResetMs));
    turn.emit(syntheticLimitMessage());
    turn.emit(refusedResult('native-limit-6'));
    assert.equal(await handled, true);

    assert.equal(db.prepare(`SELECT status FROM queue WHERE id = ?`).get(delivered.id).status, 'done', `round ${round} ends with a note, not a failure`);
    const held = db.prepare(`SELECT * FROM queue WHERE usage_limit_pause IS NOT NULL AND status = 'pending'`).all();
    assert.equal(held.length, 1);
    assert.equal(JSON.parse(held[0].usage_limit_pause).retries, round);
    // A refused follow-up stands for what it quoted, not for itself.
    assert.equal(held[0].text, buildUsageLimitResumePrompt({ prompts: ['carry on with the migration'] }));
    if (round === 7) {
      assert.ok(held[0].next_attempt_at.startsWith('9999-'), 'after six tries the follow-up waits for the user');
      assert.equal(usageLimitPauseService.getPause(CONV).auto, false);
      break;
    }
    const heldUntil = Date.parse(held[0].next_attempt_at);
    assert.ok(heldUntil >= before + 5 * 60 * 1000 && heldUntil <= Date.now() + 5 * 60 * 1000, 'tried again five minutes later');
    assert.equal(usageLimitPauseService.getPause(CONV).resetsAt, null);

    // Its time has come: the follow-up is delivered, and refused again.
    assert.equal(usageLimitPauseService.resumeNow({ conversationId: CONV }).resumed, true);
    delivered = dequeueForWorker(ctx);
    assert.equal(delivered?.id, held[0].id);
  }

  turn.endInput();
  await settled(runner);
});

test('a second refusal before the reset moves the follow-up instead of adding one', async (t) => {
  const ctx = boot();
  const { db, api } = ctx;
  const resetsAtMs = Date.now() + 40 * 60 * 1000;

  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  const one = await sendAndDeliver(ctx, 'first request');
  const first = runner.handlePendingPayload({ message: one });
  turn.emit(initMessage('native-limit-3'));
  turn.emit(rejectedEvent(resetsAtMs));
  turn.emit(syntheticLimitMessage());
  turn.emit(refusedResult('native-limit-3'));
  assert.equal(await first, true);

  const two = await sendAndDeliver(ctx, 'second request');
  const second = runner.handlePendingPayload({ message: two });
  await waitFor(() => runner._getProcess()?.pendingDelivered?.length === 1, { label: 'second request pushed' });
  turn.emit(initMessage('native-limit-3'));
  turn.emit(rejectedEvent(resetsAtMs + 5 * 60 * 1000));
  turn.emit(syntheticLimitMessage());
  turn.emit(refusedResult('native-limit-3'));
  assert.equal(await second, true);

  const held = db.prepare(`SELECT * FROM queue WHERE usage_limit_pause IS NOT NULL AND status = 'pending'`).all();
  assert.equal(held.length, 1);
  const movedTo = new Date(Math.round((resetsAtMs + 5 * 60 * 1000) / 1000) * 1000 + 60_000).toISOString();
  assert.equal(held[0].next_attempt_at, movedTo);
  assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE status = 'done'`).get().cnt, 2);
  // The follow-up moved behind the second request, in the transcript too.
  const secondRequest = db.prepare(`SELECT timestamp FROM messages WHERE id = ?`).get(two.id);
  const followUp = db.prepare(`SELECT timestamp FROM messages WHERE id = ?`).get(held[0].id);
  assert.ok(followUp.timestamp >= secondRequest.timestamp, 'the follow-up is not above the message sent during the pause');
  assert.ok(held[0].timestamp >= secondRequest.timestamp);
  // It quotes both refused requests, in the order they were sent.
  const bothQuoted = buildUsageLimitResumePrompt({ prompts: ['first request', 'second request'] });
  assert.match(bothQuoted, /These requests were refused at the limit, in this order:\n\n> first request\n\n> second request\n\n/);
  assert.equal(held[0].text, bothQuoted);
  assert.equal(db.prepare(`SELECT text FROM messages WHERE id = ?`).get(held[0].id).text, bothQuoted);

  turn.endInput();
  await settled(runner);
});

test('an ordinary failed turn is still failed', async (t) => {
  const ctx = boot();
  const { db, stmts, api } = ctx;

  const delivered = await sendAndDeliver(ctx, 'hello');
  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  const first = runner.handlePendingPayload({ message: delivered });
  turn.emit(initMessage('native-limit-4'));
  turn.emit({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: 'The request failed.', session_id: 'native-limit-4', num_turns: 1, duration_api_ms: 50,
  });
  assert.equal(await first, true);

  assert.equal(stmts.findQById.get(delivered.id).status, 'failed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM queue WHERE usage_limit_pause IS NOT NULL`).get().cnt, 0);

  turn.endInput();
  await settled(runner);
});

test('a warning before the limit reaches the relay as the account state', async (t) => {
  const ctx = boot();
  const { api, emitted, usageLimitPauseService } = ctx;
  const resetsAtMs = Date.now() + 96 * 60 * 1000;

  const delivered = await sendAndDeliver(ctx, 'hello');
  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  const first = runner.handlePendingPayload({ message: delivered });
  turn.emit(initMessage('native-limit-5'));
  turn.emit(warningEvent(resetsAtMs));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('hi'));
  turn.emit(resultMessage('hi', 'native-limit-5'));
  assert.equal(await first, true);

  await waitFor(() => usageLimitPauseService.getAccountState()?.status === 'allowed_warning', { label: 'warning recorded' });
  const state = usageLimitPauseService.getAccountState();
  assert.equal(state.utilization, 0.96);
  assert.equal(state.rateLimitType, 'five_hour');
  assert.equal(state.resetsAt, new Date(Math.round(resetsAtMs / 1000) * 1000).toISOString());
  assert.ok(emitted.some((entry) => entry.event === 'claude_usage_limit' && entry.payload?.status === 'allowed_warning'));
  assert.equal(usageLimitPauseService.getPause(CONV), null);

  turn.endInput();
  await settled(runner);
});

test('a background continuation refused at the limit is paused like a delivered turn', async (t) => {
  // A background agent finishes after the limit was reached: the CLI opens a
  // turn of its own to report on it, and that turn is what gets refused. Its
  // row has no user prompt behind it and cannot be delivered again, so the
  // follow-up is the only thing that brings the report back.
  const ctx = boot();
  const { db, stmts, api, usageLimitPauseService } = ctx;
  const resetsAtMs = Date.now() + 50 * 60 * 1000;

  const delivered = await sendAndDeliver(ctx, 'start the long job');
  const turn = scriptedTurn();
  const runner = makeRunner(t, { api, turn });

  const first = runner.handlePendingPayload({ message: delivered });
  turn.emit(initMessage('native-limit-9'));
  turn.emit(userReplay('start the long job'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'long job' }]));
  turn.emit(resultMessage('started', 'native-limit-9'));
  assert.equal(await first, true);
  assert.equal(stmts.findQById.get(delivered.id).status, 'done');

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(rejectedEvent(resetsAtMs));
  turn.emit(syntheticLimitMessage());
  turn.emit(refusedResult('native-limit-9'));

  const held = await waitFor(
    () => db.prepare(`SELECT * FROM queue WHERE usage_limit_pause IS NOT NULL AND status = 'pending'`).get(),
    { label: 'follow-up queued for the refused continuation' },
  );
  assert.equal(held.conversation_id, CONV);
  // No prompt of the user's was refused: the follow-up says what was cut off.
  assert.equal(held.text, buildUsageLimitResumePrompt({ continuation: true }));
  assert.match(held.text, /A turn you had opened yourself after a background task finished was refused at the limit/);
  assert.doesNotMatch(held.text, /\[background continuation\]|^> /m);
  // An ordinary message, not a continuation: it has to be delivered.
  assert.notEqual(held.kind, 'continuation');
  assert.equal(usageLimitPauseService.getPause(CONV).auto, true);

  // The continuation's own row is settled, with the note or dropped quietly,
  // and nothing of it is left processing or failed loudly.
  const continuation = db.prepare(`SELECT * FROM queue WHERE kind = 'continuation'`).get();
  assert.ok(continuation, 'the continuation had a row');
  assert.notEqual(continuation.status, 'processing');
  const failures = db.prepare(`SELECT text FROM messages WHERE role = 'assistant' AND text LIKE '%Error code:%'`).all();
  assert.deepEqual(failures, []);

  turn.endInput();
  await settled(runner);
});
