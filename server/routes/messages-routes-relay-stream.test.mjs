import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerMessagesRoutes } from './messages-routes.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

// Minimal replica of the runtime schema the stream/thought routes touch,
// including the constraints the writers rely on: UNIQUE(queue_message_id, seq)
// on both tables and the partial unique index on (queue_message_id, reasoning_id).
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      response_message_id TEXT
    );
    CREATE TABLE relay_questions (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      relay_mode TEXT,
      prompt TEXT,
      choices TEXT,
      request TEXT,
      request_schema TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      structured_answer TEXT,
      sdk_session_id TEXT,
      owner_worker_id TEXT,
      continuation_id TEXT,
      continuation_question_id TEXT,
      created_at TEXT,
      answered_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE relay_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT,
      response_message_id TEXT,
      conversation_id TEXT,
      relay_mode TEXT,
      text TEXT,
      created_at TEXT,
      subagent_run_id TEXT
    );
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY,
      queue_message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      parent_subagent_id TEXT,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE relay_boards (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      board_type TEXT,
      relay_mode TEXT,
      title TEXT,
      body TEXT,
      actions_json TEXT,
      recommended_action TEXT,
      context_json TEXT,
      status TEXT,
      selected_action TEXT,
      acted_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE relay_stream_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id    TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id     TEXT NOT NULL,
      relay_mode          TEXT NOT NULL DEFAULT 'agent',
      seq                 INTEGER NOT NULL,
      text                TEXT NOT NULL DEFAULT '',
      done                INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      subagent_run_id     TEXT,
      UNIQUE(queue_message_id, seq)
    );
    CREATE TABLE relay_thought (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id    TEXT NOT NULL,
      response_message_id TEXT,
      conversation_id     TEXT NOT NULL,
      relay_mode          TEXT NOT NULL DEFAULT 'agent',
      reasoning_id        TEXT,
      seq                 INTEGER NOT NULL,
      text                TEXT NOT NULL,
      done                INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      subagent_run_id     TEXT,
      UNIQUE(queue_message_id, seq)
    );
    CREATE UNIQUE INDEX idx_relay_thought_queue_reasoning
      ON relay_thought(queue_message_id, reasoning_id)
      WHERE reasoning_id IS NOT NULL AND reasoning_id != '';
  `);
  return db;
}

function insertQueueMessage(db, { id = 'q-1', conversationId = 'conv-1', responseMessageId = null } = {}) {
  db.prepare(`INSERT INTO queue (id, conversation_id, response_message_id) VALUES (?, ?, ?)`)
    .run(id, conversationId, responseMessageId);
}

// Stand-ins for the deps server-runtime.mjs injects. server-runtime boots a
// server on import, so the deps are reproduced here rather than imported.
function makeRouteDeps(db, { emitted = [] } = {}) {
  return {
    auth: (_req, _res, next) => next(),
    // Registration eagerly prepares statements for many routes this test never
    // exercises, against tables it does not create — stub those out, but keep
    // real transaction semantics for the writers under test.
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
    touchCli: () => {},
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'agent',
    MAX_UPLOAD_BYTES: 1024 * 1024,
    featureFlags: {},
  };
}

function postHandler(routePath, deps) {
  let handler = null;
  const app = {
    post(registeredPath, ...handlers) {
      if (registeredPath === routePath) handler = handlers[handlers.length - 1];
    },
    get() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, `${routePath} should be registered`);
  return handler;
}

async function invokePost(handler, body) {
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await handler({ body, headers: {}, query: {} }, res);
  return captured;
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
    const { status, body } = await invokePost(handler, {
      messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', text, done: false,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Number(body.seq) >= 1);
  }
  await invokePost(handler, {
    messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', text: 'sub reply', done: false, subagentRunId: 'toolu_sub',
  });
  await invokePost(handler, {
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
    const { body } = await invokePost(handler, {
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

  await invokePost(handler, { messageId: 'q-1', conversationId: 'conv-1', text: 'final text', done: true });
  await invokePost(handler, { messageId: 'q-1', conversationId: 'conv-1', text: 'stale snapshot', done: false });

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

  await invokePost(handler, { messageId: 'q-1', conversationId: 'conv-1', text: 'a', done: false });
  await invokePost(handler, { messageId: 'q-1', conversationId: 'conv-1', text: 'ab', done: false });

  const streams = emitted.filter((entry) => entry.event === 'relay_stream');
  assert.equal(streams.length, 2);
  assert.deepEqual(streams.map((entry) => entry.payload.text), ['a', 'ab']);
});

test('streamed thought frames and the complete republish share one row per reasoningId', async () => {
  const db = makeDb();
  insertQueueMessage(db);
  const handler = postHandler('/api/thought', makeRouteDeps(db));

  await invokePost(handler, {
    messageId: 'q-1', conversationId: 'conv-1', reasoningId: 'claude-thought-main-1-0', text: 'half a thought', done: false,
  });
  await invokePost(handler, {
    messageId: 'q-1', conversationId: 'conv-1', reasoningId: 'claude-thought-main-1-0', text: 'half a thought, now whole', done: true,
  });
  // The complete assistant message republishes with the SAME id and can land
  // after the streamed done frame; it must update in place, never insert.
  await invokePost(handler, {
    messageId: 'q-1', conversationId: 'conv-1', reasoningId: 'claude-thought-main-1-0', text: 'half a thought, now whole', done: true,
  });

  const rows = db.prepare(`SELECT reasoning_id, seq, text, done FROM relay_thought WHERE queue_message_id = ?`).all('q-1');
  assert.equal(rows.length, 1, 'one row per (queue message, reasoningId)');
  assert.equal(rows[0].text, 'half a thought, now whole');
  assert.equal(rows[0].done, 1);
});
