import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applySchema } from '../db-schema.mjs';
import { createMessageRepository, settleFailedRowControlsAndCards } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createStaleTurnRecovery } from './stale-turn-recovery.mjs';

const NOW_MS = Date.now();
const MINUTE_MS = 60_000;
const MAX_REQUEUE_RETRIES = 5;

function isoAgo(ms) {
  return new Date(NOW_MS - ms).toISOString();
}

// As the runtime's failRecoveredRowTerminally writes a failure: compare-and-set
// on the row, and the row's Stops and question cards end in the same
// transaction (the runtime's own is pinned in server-runtime-failed-row.test.mjs).
function failLikeRuntime(db, stmts, row) {
  db.transaction(() => {
    if (stmts.setFailed.run('{}', row.id).changes === 0) return;
    settleFailedRowControlsAndCards(stmts, row.id, new Date().toISOString());
  })();
}

function createFixture({ wrapStmts = (stmts) => stmts } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const repo = { ...createMessageRepository(db), ...createQuestionRepository(db) };
  const stmts = wrapStmts(repo, db);
  const emitted = [];
  const failed = [];
  const failureOptions = new Map();
  const outcomes = [];
  const recovery = createStaleTurnRecovery({
    db,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    maxRequeueRetries: MAX_REQUEUE_RETRIES,
    failRecoveredRowTerminally: (row, reason, options) => {
      failed.push({ id: row.id, reason });
      if (options) failureOptions.set(row.id, options);
      failLikeRuntime(db, repo, row);
    },
    failConsumedRowTerminally: (row, reason) => {
      failed.push({ id: row.id, reason });
      failLikeRuntime(db, repo, row);
    },
    noteRestartTurnOutcome: (row, outcome) => outcomes.push([row.id, outcome]),
    warn: () => {},
  });
  const insertTurn = db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, timestamp, processing_at, owner_sdk_session_id, owner_last_claimed_at, retry_count)
    VALUES (@id, 'conv-1', 'processing', 'prompt', @startedAt, @startedAt, 'session-1', @lastClaimedAt, @retryCount)
  `);
  return {
    db,
    repo,
    recovery,
    emitted,
    failed,
    failureOptions,
    outcomes,
    // Heartbeating: only the ceiling can catch these turns.
    addTurn({ id, startedMsAgo, retryCount = 0 }) {
      insertTurn.run({ id, startedAt: isoAgo(startedMsAgo), lastClaimedAt: isoAgo(5_000), retryCount });
    },
    answerQuestion(queueId, answeredMsAgo, suffix = '') {
      db.prepare(`INSERT INTO relay_questions (id, queue_id, status, conversation_id, message_id, prompt, created_at, expires_at, answered_at) VALUES (?, ?, 'answered', 'conv-1', 'm-1', 'Question?', ?, ?, ?)`)
        .run(`question-${queueId}${suffix}`, queueId, isoAgo(answeredMsAgo + MINUTE_MS), isoAgo(-8 * 60 * MINUTE_MS), isoAgo(answeredMsAgo));
    },
    // Inactivity 10 min, ceiling 60 min: the sweep the runtime runs.
    sweep() {
      return recovery.recoverProcessingOlderThan(isoAgo(10 * MINUTE_MS), isoAgo(0), { ceilingBeforeIso: isoAgo(60 * MINUTE_MS) })
        .map((row) => row.id);
    },
    row(id) {
      return db.prepare(`SELECT status, retry_count, processing_at FROM queue WHERE id = ?`).get(id);
    },
    statusEvents() {
      return emitted.filter((entry) => entry.event === 'message_status').map((entry) => [entry.payload.messageId, entry.payload.status]);
    },
  };
}

test('the ceiling sweep requeues only the listed rows, not a turn whose question was just answered', () => {
  const fixture = createFixture();
  // Started three hours ago, but the human answered a question five minutes
  // ago: the ceiling counts from the answer, so it is not due. Its retry
  // budget is spent, so a requeue that skipped the budget check would show.
  fixture.addTurn({ id: 'q-watched', startedMsAgo: 3 * 60 * MINUTE_MS, retryCount: MAX_REQUEUE_RETRIES - 1 });
  fixture.answerQuestion('q-watched', 5 * MINUTE_MS);
  // Genuinely over the ceiling.
  fixture.addTurn({ id: 'q-hung', startedMsAgo: 3 * 60 * MINUTE_MS });

  assert.deepEqual(fixture.sweep(), ['q-hung']);

  assert.equal(fixture.row('q-hung').status, 'pending');
  assert.equal(fixture.row('q-hung').retry_count, 1);
  const watched = fixture.row('q-watched');
  assert.equal(watched.status, 'processing', 'the answered turn keeps running');
  assert.equal(watched.retry_count, MAX_REQUEUE_RETRIES - 1);
  assert.notEqual(watched.processing_at, null);

  assert.deepEqual(fixture.statusEvents(), [['q-hung', 'pending']]);
  assert.deepEqual(fixture.outcomes, [['q-hung', 'requeued']]);
  assert.deepEqual(fixture.failed, []);
});

test('the over-ceiling row goes through the retry budget; the answered one is left alone', () => {
  const fixture = createFixture();
  fixture.addTurn({ id: 'q-watched', startedMsAgo: 3 * 60 * MINUTE_MS });
  fixture.answerQuestion('q-watched', 5 * MINUTE_MS);
  fixture.addTurn({ id: 'q-hung', startedMsAgo: 3 * 60 * MINUTE_MS, retryCount: MAX_REQUEUE_RETRIES - 1 });
  // A third row keeps the requeue step running after q-hung has failed.
  fixture.addTurn({ id: 'q-hung-2', startedMsAgo: 2 * 60 * MINUTE_MS });

  assert.deepEqual(fixture.sweep(), ['q-hung-2']);

  assert.deepEqual(fixture.failed, [{ id: 'q-hung', reason: 'stale-recovery' }]);
  assert.equal(fixture.row('q-hung').status, 'failed');
  assert.equal(fixture.row('q-watched').status, 'processing');
  assert.equal(fixture.row('q-watched').retry_count, 0);
  assert.deepEqual(fixture.statusEvents(), [['q-hung-2', 'pending']]);
});

// The sweep is synchronous, so in production nothing changes between the
// listing and the requeue; this pins the UPDATE's re-check as a safeguard.
test('safeguard: a row that stops qualifying after the listing is neither requeued nor announced', () => {
  let answerLate = () => {};
  const fixture = createFixture({
    wrapStmts: (stmts) => ({
      ...stmts,
      listRecoverableProcessing: {
        all: (params) => {
          const rows = stmts.listRecoverableProcessing.all(params);
          answerLate();
          return rows;
        },
      },
    }),
  });
  fixture.addTurn({ id: 'q-late', startedMsAgo: 3 * 60 * MINUTE_MS });
  fixture.addTurn({ id: 'q-hung', startedMsAgo: 3 * 60 * MINUTE_MS });
  answerLate = () => fixture.answerQuestion('q-late', 0, '-late');

  assert.deepEqual(fixture.sweep(), ['q-hung']);
  assert.equal(fixture.row('q-late').status, 'processing');
  assert.equal(fixture.row('q-late').retry_count, 0);
  assert.deepEqual(fixture.statusEvents(), [['q-hung', 'pending']]);
});

// A turn the archive left running (another session's live process, a probe
// that did not answer) goes stale later: requeued, it would wait unclaimed
// in the archived chat for good, so it fails as the archive ends a dead turn.
test("a stale turn of an archived chat fails instead of going back to the queue; a live chat's is requeued", () => {
  const fixture = createFixture();
  const at = isoAgo(0);
  fixture.db.prepare(`INSERT INTO conversations (id, title, archived, created_at, updated_at) VALUES ('conv-1', 'Archived', 1, ?, ?), ('conv-2', 'Live', 0, ?, ?)`)
    .run(at, at, at, at);
  fixture.addTurn({ id: 'q-archived', startedMsAgo: 3 * 60 * MINUTE_MS });
  fixture.db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, timestamp, processing_at, owner_sdk_session_id, owner_last_claimed_at, retry_count)
    VALUES ('q-live', 'conv-2', 'processing', 'prompt', ?, ?, 'session-2', ?, 0)
  `).run(isoAgo(3 * 60 * MINUTE_MS), isoAgo(3 * 60 * MINUTE_MS), isoAgo(5_000));

  assert.deepEqual(fixture.sweep(), ['q-live']);
  assert.equal(fixture.row('q-archived').status, 'failed');
  assert.equal(fixture.row('q-live').status, 'pending');
  assert.deepEqual(fixture.failed, [{ id: 'q-archived', reason: 'conversation-archived' }]);
  const { failureRecord, failureText } = fixture.failureOptions.get('q-archived');
  assert.equal(failureRecord.code, 'conversation-archived');
  assert.equal(failureText, 'This chat was archived while this reply was not finished. Error code: relay.conversation-archived. Unarchive the chat and send the message again to continue.');
  assert.deepEqual(fixture.outcomes, [['q-archived', 'failed'], ['q-live', 'requeued']]);
  assert.deepEqual(fixture.statusEvents(), [['q-live', 'pending']]);
});

// A Stop aimed at a turn the sweep fails can never be carried out: no worker
// takes the row again, so the Stop is settled with it, as a requeue's is.
test('a Stop pending on a row the sweep fails is settled; one on a row it leaves running stays pending', () => {
  const fixture = createFixture();
  const at = isoAgo(0);
  fixture.db.prepare(`INSERT INTO conversations (id, title, archived, created_at, updated_at) VALUES ('conv-1', 'Live', 0, ?, ?), ('conv-2', 'Archived', 1, ?, ?)`)
    .run(at, at, at, at);
  fixture.db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, timestamp, processing_at, owner_sdk_session_id, owner_last_claimed_at, retry_count)
    VALUES ('q-archived', 'conv-2', 'processing', 'prompt', ?, ?, 'session-2', ?, 0)
  `).run(isoAgo(3 * 60 * MINUTE_MS), isoAgo(3 * 60 * MINUTE_MS), isoAgo(5_000));
  fixture.addTurn({ id: 'q-over-budget', startedMsAgo: 3 * 60 * MINUTE_MS, retryCount: MAX_REQUEUE_RETRIES - 1 });
  fixture.addTurn({ id: 'q-consumed', startedMsAgo: 3 * 60 * MINUTE_MS });
  fixture.db.prepare(`UPDATE queue SET consumed_at = ? WHERE id = 'q-consumed'`).run(isoAgo(2 * 60 * MINUTE_MS));
  fixture.addTurn({ id: 'q-watched', startedMsAgo: 3 * 60 * MINUTE_MS });
  fixture.answerQuestion('q-watched', 5 * MINUTE_MS);
  const insertControl = fixture.db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertControl.run('stop-archived', 'abort_turn', 'conv-2', 'q-archived', 'pending', at, at);
  insertControl.run('stop-over-budget', 'abort_subagent', 'conv-1', 'q-over-budget', 'processing', at, at);
  insertControl.run('stop-consumed', 'abort_turn', 'conv-1', 'q-consumed', 'pending', at, at);
  insertControl.run('stop-watched', 'abort_turn', 'conv-1', 'q-watched', 'pending', at, at);

  assert.deepEqual(fixture.sweep(), []);
  assert.deepEqual(fixture.failed.map((entry) => entry.id).sort(), ['q-archived', 'q-consumed', 'q-over-budget']);

  const controls = Object.fromEntries(fixture.db.prepare(`SELECT id, status, error, completed_at FROM relay_control_requests`).all()
    .map((row) => [row.id, row]));
  for (const id of ['stop-archived', 'stop-over-budget', 'stop-consumed']) {
    assert.equal(controls[id].status, 'failed', id);
    assert.equal(controls[id].error, 'queue-failed', id);
    assert.notEqual(controls[id].completed_at, null, id);
  }
  assert.equal(controls['stop-watched'].status, 'pending');
  assert.equal(controls['stop-watched'].completed_at, null);
});

// The dead-worker sweep (server-runtime.mjs) asks per row: a dead owner's
// rows span chats, and only the archived chat's row fails.
test("failIfArchived fails an archived chat's turn and settles its Stop; a live chat's turn is left alone", () => {
  const fixture = createFixture();
  const at = isoAgo(0);
  fixture.db.prepare(`INSERT INTO conversations (id, title, archived, created_at, updated_at) VALUES ('conv-1', 'Live', 0, ?, ?), ('conv-2', 'Archived', 1, ?, ?)`)
    .run(at, at, at, at);
  fixture.addTurn({ id: 'q-live', startedMsAgo: MINUTE_MS });
  fixture.db.prepare(`
    INSERT INTO queue (id, conversation_id, status, text, timestamp, processing_at, owner_sdk_session_id, owner_last_claimed_at, retry_count)
    VALUES ('q-archived', 'conv-2', 'processing', 'prompt', ?, ?, 'session-1', ?, 0)
  `).run(isoAgo(MINUTE_MS), isoAgo(MINUTE_MS), isoAgo(5_000));
  fixture.db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, status, created_at, updated_at)
    VALUES ('stop-archived', 'abort_turn', 'conv-2', 'q-archived', 'pending', ?, ?)
  `).run(at, at);
  const { recovery } = fixture;
  const readRow = (id) => fixture.db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);

  assert.equal(recovery.failIfArchived(readRow('q-live'), 'worker-died-sweep'), false);
  assert.equal(recovery.failIfArchived(readRow('q-archived'), 'worker-died-sweep'), true);

  assert.equal(fixture.row('q-live').status, 'processing');
  assert.equal(fixture.row('q-archived').status, 'failed');
  assert.deepEqual(fixture.failed, [{ id: 'q-archived', reason: 'conversation-archived' }]);
  const { failureRecord, failureText } = fixture.failureOptions.get('q-archived');
  assert.equal(failureRecord.stableCode, 'relay.conversation-archived');
  assert.equal(failureRecord.reason, 'worker-died-sweep');
  assert.equal(failureText, 'This chat was archived while this reply was not finished. Error code: relay.conversation-archived. Unarchive the chat and send the message again to continue.');
  const stop = fixture.db.prepare(`SELECT status, error FROM relay_control_requests WHERE id = 'stop-archived'`).get();
  assert.deepEqual({ ...stop }, { status: 'failed', error: 'queue-failed' });
  assert.deepEqual(fixture.outcomes, [['q-archived', 'failed']]);
});

// A dead worker's turn that the user had stopped is not replayed: it ends as
// the Stop's own completion ends it. A sub-agent's Stop does not end the turn.
test('failIfStopRequested ends a turn with a pending Stop as stopped; a sub-agent Stop leaves it to the requeue', () => {
  const fixture = createFixture();
  const at = isoAgo(0);
  fixture.addTurn({ id: 'q-stopped', startedMsAgo: MINUTE_MS });
  fixture.addTurn({ id: 'q-subagent-stop', startedMsAgo: MINUTE_MS });
  fixture.addTurn({ id: 'q-no-stop', startedMsAgo: MINUTE_MS });
  const insertControl = fixture.db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, status, created_at, updated_at)
    VALUES (?, ?, 'conv-1', ?, ?, ?, ?)
  `);
  insertControl.run('stop-turn', 'abort_turn', 'q-stopped', 'processing', at, at);
  insertControl.run('stop-subagent', 'abort_subagent', 'q-subagent-stop', 'pending', at, at);
  insertControl.run('stop-done', 'abort_turn', 'q-no-stop', 'done', at, at);
  const { recovery } = fixture;
  const readRow = (id) => fixture.db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);

  assert.equal(recovery.failIfStopRequested(readRow('q-stopped'), 'worker-died-socket-close'), true);
  assert.equal(recovery.failIfStopRequested(readRow('q-subagent-stop'), 'worker-died-socket-close'), false);
  assert.equal(recovery.failIfStopRequested(readRow('q-no-stop'), 'worker-died-socket-close'), false);

  assert.deepEqual(fixture.failed, [{ id: 'q-stopped', reason: 'worker-died-socket-close' }]);
  const { failureRecord, failureText } = fixture.failureOptions.get('q-stopped');
  assert.equal(failureRecord.stableCode, 'relay.turn-aborted');
  assert.equal(failureText, 'System note: This turn was stopped from the relay UI before completion. Error code: relay.turn-aborted. Send a new message to continue when you are ready.');
  const controls = Object.fromEntries(fixture.db.prepare(`SELECT id, status FROM relay_control_requests`).all().map((row) => [row.id, row.status]));
  assert.deepEqual(controls, { 'stop-turn': 'failed', 'stop-subagent': 'pending', 'stop-done': 'done' });
  assert.equal(fixture.row('q-subagent-stop').status, 'processing');
  assert.deepEqual(fixture.outcomes, [['q-stopped', 'failed']]);
});

// The replay would run the prompt the user stopped: the stale turn ends as
// stopped. A sub-agent's Stop does not end the turn; it is settled with the requeue.
test('a stale turn with the user\'s Stop pending ends as stopped instead of going back to the queue', () => {
  const fixture = createFixture();
  const at = isoAgo(0);
  fixture.addTurn({ id: 'q-stopped', startedMsAgo: 3 * 60 * MINUTE_MS });
  fixture.addTurn({ id: 'q-subagent-stop', startedMsAgo: 3 * 60 * MINUTE_MS });
  const insertControl = fixture.db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, status, created_at, updated_at)
    VALUES (?, ?, 'conv-1', ?, 'pending', ?, ?)
  `);
  insertControl.run('stop-turn', 'abort_turn', 'q-stopped', at, at);
  insertControl.run('stop-subagent', 'abort_subagent', 'q-subagent-stop', at, at);

  assert.deepEqual(fixture.sweep(), ['q-subagent-stop']);
  assert.equal(fixture.row('q-stopped').status, 'failed');
  assert.equal(fixture.row('q-stopped').retry_count, 0, 'not requeued');
  assert.equal(fixture.row('q-subagent-stop').status, 'pending');
  assert.deepEqual(fixture.failed, [{ id: 'q-stopped', reason: 'stale-recovery' }]);
  const { failureRecord, failureText } = fixture.failureOptions.get('q-stopped');
  assert.equal(failureRecord.stableCode, 'relay.turn-aborted');
  assert.equal(failureText, 'System note: This turn was stopped from the relay UI before completion. Error code: relay.turn-aborted. Send a new message to continue when you are ready.');
  const controls = Object.fromEntries(fixture.db.prepare(`SELECT id, status, error FROM relay_control_requests`).all()
    .map((row) => [row.id, `${row.status}:${row.error}`]));
  assert.deepEqual(controls, { 'stop-turn': 'failed:queue-failed', 'stop-subagent': 'failed:queue-recovered' });
  assert.deepEqual(fixture.outcomes, [['q-stopped', 'failed'], ['q-subagent-stop', 'requeued']]);
  assert.deepEqual(fixture.statusEvents(), [['q-subagent-stop', 'pending']]);
});

test('a row whose terminal failure did not take keeps its Stop pending', () => {
  const fixture = createFixture();
  fixture.addTurn({ id: 'q-over-budget', startedMsAgo: 3 * 60 * MINUTE_MS, retryCount: MAX_REQUEUE_RETRIES - 1 });
  const at = isoAgo(0);
  fixture.db.prepare(`
    INSERT INTO relay_control_requests (id, type, conversation_id, queue_message_id, status, created_at, updated_at)
    VALUES ('stop-1', 'abort_turn', 'conv-1', 'q-over-budget', 'pending', ?, ?)
  `).run(at, at);
  // The row settled between the listing and its terminal write (the runtime's
  // setFailed is compare-and-set): the row is done, not failed.
  const recovery = createStaleTurnRecovery({
    db: fixture.db,
    stmts: fixture.repo,
    emit: () => {},
    maxRequeueRetries: MAX_REQUEUE_RETRIES,
    failRecoveredRowTerminally: (row) => {
      fixture.db.prepare(`UPDATE queue SET status = 'done' WHERE id = ?`).run(row.id);
      failLikeRuntime(fixture.db, fixture.repo, row);
    },
    failConsumedRowTerminally: () => {},
    noteRestartTurnOutcome: () => {},
    warn: () => {},
  });
  recovery.recoverProcessingOlderThan(isoAgo(10 * MINUTE_MS), isoAgo(0), { ceilingBeforeIso: isoAgo(60 * MINUTE_MS) });
  assert.equal(fixture.row('q-over-budget').status, 'done');
  assert.equal(fixture.db.prepare(`SELECT status FROM relay_control_requests WHERE id = 'stop-1'`).get().status, 'pending');
});
