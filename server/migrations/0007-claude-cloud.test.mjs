import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateClaudeCloud } from './0007-claude-cloud.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const columnType = (db, table, name) => db.prepare(`PRAGMA table_info(${table})`).all()
  .find((column) => column.name === name)?.type;

function createOldDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE runtime_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE, provider_type TEXT);
  `);
  return db;
}

test('adds the four claude cloud columns once and keeps the rows', () => {
  const db = createOldDb();
  db.prepare(`INSERT INTO conversations (id, title) VALUES ('conv-1', 'Demo')`).run();
  db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, provider_type) VALUES ('rs-1', 'conv-1', 'claude-cloud')`).run();

  assert.deepEqual(migrateClaudeCloud(db), { applied: true, columnsAdded: 4 });
  assert.equal(columnType(db, 'runtime_sessions', 'claude_cloud_session_id'), 'TEXT');
  assert.equal(columnType(db, 'runtime_sessions', 'claude_cloud_last_sequence'), 'TEXT');
  assert.equal(columnType(db, 'runtime_sessions', 'claude_cloud_cost_usd'), 'REAL');
  assert.equal(columnType(db, 'conversations', 'cloud_source_json'), 'TEXT');

  db.prepare(`UPDATE runtime_sessions SET claude_cloud_session_id = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa' WHERE id = 'rs-1'`).run();
  assert.deepEqual(migrateClaudeCloud(db), { applied: false, columnsAdded: 0 });
  assert.equal(
    db.prepare(`SELECT claude_cloud_session_id FROM runtime_sessions WHERE id = 'rs-1'`).get().claude_cloud_session_id,
    'cse_01EXAMPLEaaaaaaaaaaaaaaaa',
  );
  assert.equal(db.prepare(`SELECT cloud_source_json FROM conversations WHERE id = 'conv-1'`).get().cloud_source_json, null);
});

test('a database without the tables is left alone', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateClaudeCloud(db), { applied: false, columnsAdded: 0 });
});

test('a fresh schema carries the columns and the repository statements for them', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(columns(db, 'runtime_sessions').includes('claude_cloud_session_id'), true);
  assert.equal(columns(db, 'conversations').includes('cloud_source_json'), true);

  const stmts = createSessionRepository(db);
  const now = '2026-10-02T10:00:00.000Z';
  stmts.insertConv.run('conv-1', 'Demo', now, now);
  stmts.insertRuntimeSession.run('rs-1', 'conv-1', 'isolated', 'rs-1', 'claude-sonnet-5-5', now, now, 'conv-1', 'claude-cloud', 'claude-sonnet-5-5');

  stmts.updateConvCloudSource.run('{"repoUrl":"https://github.com/example-org/sample-repo"}', 'conv-1');
  stmts.updateRuntimeSessionClaudeCloudSession.run('cse_01EXAMPLEaaaaaaaaaaaaaaaa', '42', 0.25, now, 'conv-1');

  const runtime = stmts.getRuntimeSessionByConversation.get('conv-1');
  assert.equal(runtime.claude_cloud_session_id, 'cse_01EXAMPLEaaaaaaaaaaaaaaaa');
  assert.equal(runtime.claude_cloud_last_sequence, '42');
  assert.equal(runtime.claude_cloud_cost_usd, 0.25);
  assert.equal(stmts.getConvAnyStatus.get('conv-1').cloud_source_json, '{"repoUrl":"https://github.com/example-org/sample-repo"}');

  const listed = stmts.listConvs.all(0).find((row) => row.id === 'conv-1');
  assert.equal(listed.cloud_source_json, '{"repoUrl":"https://github.com/example-org/sample-repo"}');
  assert.equal(listed.runtime_claude_cloud_cost_usd, 0.25);
});
