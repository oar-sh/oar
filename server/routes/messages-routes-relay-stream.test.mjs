import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { applySchema } from '../db-schema.mjs';
import { makeRouteDeps as baseRouteDeps, postHandler } from './messages-routes-test-harness.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

// Real runtime schema (db-schema.mjs), so the constraints the writers rely on
// — UNIQUE(queue_message_id, seq) on both stream tables and the partial unique
// index on (queue_message_id, reasoning_id) — are the production ones.
function makeDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function insertQueueMessage(db, { id = 'q-1', conversationId = 'conv-1', responseMessageId = null } = {}) {
  // The real schema enforces NOT NULL on queue.text/timestamp and a foreign key
  // from the relay stream tables to conversations, so the fixture provides the
  // parent row and placeholder values the routes under test never read.
  db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Test conversation', ?, ?)`)
    .run(conversationId, NOW, NOW);
  db.prepare(`INSERT INTO queue (id, conversation_id, response_message_id, text, timestamp) VALUES (?, ?, ?, 'prompt', ?)`)
    .run(id, conversationId, responseMessageId, NOW);
}

// Suite-specific deps on top of the shared harness baseline: keep the stub db
// for the many statements registration prepares eagerly, but wire real
// transaction semantics and real question-repository statements for the
// writers under test.
function makeRouteDeps(db, { emitted = [] } = {}) {
  return baseRouteDeps({
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => db.transaction(fn),
    },
    stmts: {
      ...createQuestionRepository(db),
      findQById: db.prepare(`SELECT * FROM queue WHERE id = ?`),
    },
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) },
    },
    DEFAULT_RELAY_MODE: 'agent',
  });
}

function listStreamRows(db, queueMessageId) {
  return db.prepare(`
    SELECT seq, text, done, subagent_run_id FROM relay_stream_events
    WHERE queue_message_id = ? ORDER BY seq ASC, id ASC
  `).all(queueMessageId);
}

test('repeated stream snapshots keep one row per thread holding only the latest text', async () => {
  const db = makeDb();
  insertQueueMessage(db);
  const handler = postHandler('/api/stream', makeRouteDeps(db));

  // Every update carries the full reply-so-far (all workers send cumulative
  // snapshots), so persisting per-update rows would store the whole reply once
  // per update. The store must REPLACE the thread's snapshot instead.
  for (const text of ['Hel', 'Hello', 'Hello world.']) {
    const { status, body } = await handler({
      messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', text, done: false,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Number(body.seq) >= 1);
  }
  await handler({
    messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', text: 'sub reply', done: false, subagentRunId: 'toolu_sub',
  });
  await handler({
    messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', text: 'sub reply, longer', done: false, subagentRunId: 'toolu_sub',
  });

  const rows = listStreamRows(db, 'q-1');
  assert.equal(rows.length, 2, 'one row per thread (main + one subagent)');
  const main = rows.find((row) => !row.subagent_run_id);
  const sub = rows.find((row) => row.subagent_run_id === 'toolu_sub');
  assert.equal(main.text, 'Hello world.');
  assert.equal(sub.text, 'sub reply, longer');
});

test('stream seq stays monotonic across replacements so readers can pick the latest row', async () => {
  const db = makeDb();
  insertQueueMessage(db);
  const handler = postHandler('/api/stream', makeRouteDeps(db));

  const seqs = [];
  for (const text of ['a', 'ab', 'abc']) {
    const { body } = await handler({
      messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', text, done: false,
    });
    seqs.push(Number(body.seq));
  }
  assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], `seq must grow per update, got ${seqs.join(',')}`);
  const rows = listStreamRows(db, 'q-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, seqs[2]);
});

test('a done stream row stays done when a stale non-done update races in late', async () => {
  const db = makeDb();
  insertQueueMessage(db);
  const handler = postHandler('/api/stream', makeRouteDeps(db));

  await handler({ messageId: 'q-1', conversationId: 'conv-1', text: 'final text', done: true });
  await handler({ messageId: 'q-1', conversationId: 'conv-1', text: 'stale snapshot', done: false });

  const rows = listStreamRows(db, 'q-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].done, 1, 'done latches, mirroring the client stream state machine');
  assert.equal(rows[0].text, 'final text', 'the final snapshot is not overwritten by a stale one');
});

test('every stream update is still emitted live even though rows are replaced', async () => {
  const db = makeDb();
  insertQueueMessage(db);
  const emitted = [];
  const handler = postHandler('/api/stream', makeRouteDeps(db, { emitted }));

  await handler({ messageId: 'q-1', conversationId: 'conv-1', text: 'a', done: false });
  await handler({ messageId: 'q-1', conversationId: 'conv-1', text: 'ab', done: false });

  const streams = emitted.filter((entry) => entry.event === 'relay_stream');
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map((entry) => entry.payload.text), ['a', 'ab']);
});

test('streamed thought frames and the complete republish share one row per reasoningId', async () => {
  const db = makeDb();
  insertQueueMessage(db);
  const handler = postHandler('/api/thought', makeRouteDeps(db));

  await handler({
    messageId: 'q-1', conversationId: 'conv-1', reasoningId: 'claude-thought-main-1-0', text: 'half a thought', done: false,
  });
  await handler({
    messageId: 'q-1', conversationId: 'conv-1', reasoningId: 'claude-thought-main-1-0', text: 'half a thought, now whole', done: true,
  });
  // The complete assistant message republishes with the SAME id and can land
  // after the streamed done frame; it must update in place, never insert.
  await handler({
    messageId: 'q-1', conversationId: 'conv-1', reasoningId: 'claude-thought-main-1-0', text: 'half a thought, now whole', done: true,
  });

  const rows = db.prepare(`SELECT reasoning_id, seq, text, done FROM relay_thought WHERE queue_message_id = ?`).all('q-1');
  assert.equal(rows.length, 1, 'one row per (queue message, reasoningId)');
  assert.equal(rows[0].text, 'half a thought, now whole');
  assert.equal(rows[0].done, 1);
});
