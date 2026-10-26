import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateQueueProvider, queueProviderProblem } from './0031-queue-provider.mjs';
import { applySchema } from '../db-schema.mjs';

const at = '2026-10-25T12:00:00.000Z';

// The two tables as an older relay left them: no provider on the queue.
function olderDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runtime_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, provider_type TEXT NOT NULL DEFAULT 'github');
    CREATE TABLE queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', timestamp TEXT NOT NULL);
  `);
  const session = db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, provider_type) VALUES (?, ?, ?)`);
  session.run('rs-claude', 'conv-claude', 'claude');
  session.run('rs-api', 'conv-api', 'Claude-API');
  session.run('rs-copilot', 'conv-copilot', 'github');
  const row = db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'hi', ?, ?)`);
  row.run('q-claude-pending', 'conv-claude', 'pending', at);
  row.run('q-claude-processing', 'conv-claude', 'processing', at);
  row.run('q-claude-done', 'conv-claude', 'done', at);
  row.run('q-api-parked', 'conv-api', 'parked', at);
  row.run('q-copilot-pending', 'conv-copilot', 'pending', at);
  row.run('q-orphan-pending', 'conv-gone', 'pending', at);
  return db;
}

const providers = (db) => Object.fromEntries(
  db.prepare(`SELECT id, provider FROM queue ORDER BY id`).all().map((row) => [row.id, row.provider]),
);

test('adds the column and gives the unfinished rows of Claude chats their provider', () => {
  const db = olderDatabase();
  assert.equal(queueProviderProblem(db), 'queue lacks provider');
  assert.deepEqual(migrateQueueProvider(db), { applied: true, columnsAdded: 1, triggersAdded: 2, rowsFilled: 3 });
  assert.equal(queueProviderProblem(db), '');
  assert.deepEqual(providers(db), {
    'q-api-parked': 'claude-api',
    'q-claude-done': null,
    'q-claude-pending': 'claude',
    'q-claude-processing': 'claude',
    'q-copilot-pending': null,
    'q-orphan-pending': null,
  });
});

test('runs again without changing anything, and never overwrites a stamp', () => {
  const db = olderDatabase();
  migrateQueueProvider(db);
  // A switch re-stamped this one after the first run.
  db.prepare(`UPDATE queue SET provider = 'claude-api' WHERE id = 'q-claude-pending'`).run();
  assert.deepEqual(migrateQueueProvider(db), { applied: false, columnsAdded: 0, triggersAdded: 0, rowsFilled: 0 });
  assert.equal(providers(db)['q-claude-pending'], 'claude-api');
});

test('a database without a queue table is left alone', () => {
  const db = new Database(':memory:');
  assert.equal(queueProviderProblem(db), 'no queue table');
  assert.deepEqual(migrateQueueProvider(db), { applied: false, columnsAdded: 0, triggersAdded: 0, rowsFilled: 0 });
});

test('a row inserted without a provider takes its Claude chat\'s; a named one is kept; others stay NULL', () => {
  const db = olderDatabase();
  migrateQueueProvider(db);
  const insert = db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'hi', ?, ?)`);
  insert.run('new-claude', 'conv-claude', 'pending', at);
  insert.run('new-api', 'conv-api', 'pending', at);
  insert.run('new-copilot', 'conv-copilot', 'pending', at);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, provider) VALUES ('new-continuation', 'conv-api', 'hi', 'processing', ?, 'claude')`).run(at);
  const after = providers(db);
  assert.deepEqual(
    [after['new-claude'], after['new-api'], after['new-copilot'], after['new-continuation']],
    ['claude', 'claude-api', null, 'claude'],
  );
});

test('a requeued row takes the chat\'s billing of that moment; a finished one keeps its stamp', () => {
  const db = olderDatabase();
  migrateQueueProvider(db);
  // The chat moved to the API key while its row was running.
  db.prepare(`UPDATE runtime_sessions SET provider_type = 'claude-api' WHERE conversation_id = 'conv-claude'`).run();
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'q-claude-processing'`).run();
  assert.equal(providers(db)['q-claude-processing'], 'claude');
  db.prepare(`UPDATE queue SET status = 'processing', provider = 'claude' WHERE id = 'q-claude-pending'`).run();
  db.prepare(`UPDATE queue SET status = 'pending' WHERE id = 'q-claude-pending'`).run();
  assert.equal(providers(db)['q-claude-pending'], 'claude-api');
  // A chat that is no Claude chat (any more) leaves a stamp as it was.
  db.prepare(`UPDATE runtime_sessions SET provider_type = 'github' WHERE conversation_id = 'conv-api'`).run();
  db.prepare(`UPDATE queue SET status = 'processing' WHERE id = 'q-api-parked'`).run();
  db.prepare(`UPDATE queue SET status = 'parked' WHERE id = 'q-api-parked'`).run();
  assert.equal(providers(db)['q-api-parked'], 'claude-api');
});

test('waits for runtime_sessions.provider_type', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', timestamp TEXT NOT NULL)`);
  assert.deepEqual(migrateQueueProvider(db), { applied: false, columnsAdded: 0, triggersAdded: 0, rowsFilled: 0 });
  assert.equal(queueProviderProblem(db), 'queue lacks provider');
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(queueProviderProblem(db), '');
});
