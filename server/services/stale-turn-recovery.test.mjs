import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createStaleTurnRecovery } from './stale-turn-recovery.mjs';

const NOW_MS = Date.now();
const MINUTE_MS = 60_000;
const MAX_REQUEUE_RETRIES = 5;

function isoAgo(ms) {
  return new Date(NOW_MS - ms).toISOString();
}

function createFixture({ wrapStmts = (stmts) => stmts } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const repo = createMessageRepository(db);
  const stmts = wrapStmts(repo, db);
  const emitted = [];
  const failed = [];
  const outcomes = [];
  const recovery = createStaleTurnRecovery({
    db,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    maxRequeueRetries: MAX_REQUEUE_RETRIES,
    failRecoveredRowTerminally: (row, reason) => {
      failed.push({ id: row.id, reason });
      repo.setFailed.run('{}', row.id);
    },
    failConsumedRowTerminally: (row, reason) => {
      failed.push({ id: row.id, reason });
      repo.setFailed.run('{}', row.id);
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
    emitted,
    failed,
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
