import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createQuestionRepository } from './question-repository.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
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
    CREATE TABLE relay_stream_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT,
      response_message_id TEXT,
      conversation_id TEXT,
      relay_mode TEXT,
      seq INTEGER,
      text TEXT,
      done INTEGER,
      created_at TEXT,
      subagent_run_id TEXT
    );
    CREATE TABLE relay_thought (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_message_id TEXT,
      response_message_id TEXT,
      conversation_id TEXT,
      relay_mode TEXT,
      reasoning_id TEXT,
      seq INTEGER,
      text TEXT,
      done INTEGER,
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
    CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      response_message_id TEXT
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
  `);
  return db;
}

test('cancelPendingQuestionsByMessage only closes pending rows for the target message', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, status, created_at, expires_at)
    VALUES
      ('q-pending-1', 'queue-1', 'conv-1', 'msg-1', 'agent', 'First', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'),
      ('q-pending-2', 'queue-2', 'conv-1', 'msg-1', 'agent', 'Second', 'pending', '2026-01-01T00:01:00Z', '2026-01-01T01:01:00Z'),
      ('q-answered', 'queue-3', 'conv-1', 'msg-1', 'agent', 'Done', 'answered', '2026-01-01T00:02:00Z', '2026-01-01T01:02:00Z'),
      ('q-other', 'queue-4', 'conv-1', 'msg-2', 'agent', 'Other', 'pending', '2026-01-01T00:03:00Z', '2026-01-01T01:03:00Z')
  `).run();

  const result = repo.cancelPendingQuestionsByMessage.run('2026-01-01T02:00:00Z', 'msg-1');
  assert.equal(result.changes, 2);

  const rows = db.prepare(`
    SELECT id, status, answered_at
    FROM relay_questions
    ORDER BY id
  `).all();

  assert.deepEqual(rows, [
    { id: 'q-answered', status: 'answered', answered_at: null },
    { id: 'q-other', status: 'pending', answered_at: null },
    { id: 'q-pending-1', status: 'cancelled', answered_at: '2026-01-01T02:00:00Z' },
    { id: 'q-pending-2', status: 'cancelled', answered_at: '2026-01-01T02:00:00Z' },
  ]);
});

test('updateThoughtByQueueAndReasoning updates snapshot without changing seq', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  repo.insertThought.run(
    'msg-1',
    null,
    'conv-1',
    'agent',
    'reason-1',
    1,
    'first',
    0,
    '2026-01-01T00:00:00Z',
    'sub-1',
  );

  const thoughtBefore = repo.getThoughtByQueueAndReasoning.get('msg-1', 'reason-1');
  assert.equal(Number(thoughtBefore?.seq || 0), 1);

  repo.updateThoughtByQueueAndReasoning.run(
    'resp-1',
    'conv-1',
    'agent',
    'second',
    1,
    '2026-01-01T00:00:01Z',
    null,
    'msg-1',
    'reason-1',
  );

  const row = db.prepare(`
    SELECT response_message_id, seq, text, done, created_at, subagent_run_id
    FROM relay_thought
    WHERE queue_message_id = 'msg-1' AND reasoning_id = 'reason-1'
  `).get();
  assert.deepEqual(row, {
    response_message_id: 'resp-1',
    seq: 1,
    text: 'second',
    done: 1,
    created_at: '2026-01-01T00:00:01Z',
    subagent_run_id: 'sub-1',
  });
});
