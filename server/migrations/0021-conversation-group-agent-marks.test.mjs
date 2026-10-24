import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateConversationGroupAgentMarks } from './0021-conversation-group-agent-marks.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds agent_made and kept_empty_at to conversation_groups once, NULL on existing groups', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversation_groups (id TEXT PRIMARY KEY, name TEXT, parent_conversation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO conversation_groups (id, name, created_at, updated_at) VALUES ('grp_fixture', 'Sample batch', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateConversationGroupAgentMarks(db), { applied: true, columnsAdded: 2 });
  assert.ok(columns(db, 'conversation_groups').includes('agent_made'));
  assert.ok(columns(db, 'conversation_groups').includes('kept_empty_at'));
  assert.deepEqual(migrateConversationGroupAgentMarks(db), { applied: false, columnsAdded: 0 });
  const row = db.prepare(`SELECT agent_made, kept_empty_at FROM conversation_groups WHERE id = 'grp_fixture'`).get();
  assert.deepEqual({ ...row }, { agent_made: null, kept_empty_at: null });
});

test('refuses to run without the groups table, and the schema boot applies it', () => {
  assert.throws(() => migrateConversationGroupAgentMarks(new Database(':memory:')), /conversation_groups is missing/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'conversation_groups').includes('kept_empty_at'));
});
