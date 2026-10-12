import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateSubagentTimeline, SUBAGENT_RUN_HEADER_COLUMNS } from './0009-subagent-timeline.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const tableExists = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const indexExists = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);

function createOldDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE subagent_runs (
      id TEXT PRIMARY KEY, queue_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      parent_subagent_id TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
  `);
  return db;
}

test('adds the header columns, the timeline table and its indexes once and keeps the runs', () => {
  const db = createOldDb();
  db.prepare(`INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at)
    VALUES ('toolu_fixture_alpha', 'q-1', 'conv-1', 'Survey the widget parser', 'completed', '2026-10-10T10:00:00.000Z', '2026-10-10T10:01:00.000Z')`).run();

  const first = migrateSubagentTimeline(db);
  assert.equal(first.applied, true);
  assert.equal(first.tablesAdded, 1);
  assert.equal(first.columnsAdded, SUBAGENT_RUN_HEADER_COLUMNS.length);
  for (const [name] of SUBAGENT_RUN_HEADER_COLUMNS) assert.ok(columns(db, 'subagent_runs').includes(name), name);
  assert.ok(tableExists(db, 'subagent_timeline'));
  assert.ok(indexExists(db, 'idx_subagent_timeline_conversation'));
  assert.ok(indexExists(db, 'idx_subagent_runs_parent'));

  const run = db.prepare(`SELECT display_name, background, truncated, model FROM subagent_runs WHERE id = 'toolu_fixture_alpha'`).get();
  assert.deepEqual(run, { display_name: 'Survey the widget parser', background: 0, truncated: 0, model: null });

  assert.deepEqual(migrateSubagentTimeline(db), { applied: false, tablesAdded: 0, columnsAdded: 0, indexesAdded: 0 });
});

test('the timeline keeps one entry per key and one per seq within a run', () => {
  const db = createOldDb();
  migrateSubagentTimeline(db);
  db.prepare(`INSERT INTO conversations (id) VALUES ('conv-1')`).run();
  const insert = db.prepare(`INSERT INTO subagent_timeline (run_id, conversation_id, entry_key, seq, kind, text, created_at, updated_at)
    VALUES (?, 'conv-1', ?, ?, 'thought', 'x', 'now', 'now')`);
  insert.run('run-a', 'k1', 1);
  assert.throws(() => insert.run('run-a', 'k1', 2), /UNIQUE/);
  assert.throws(() => insert.run('run-a', 'k2', 1), /UNIQUE/);
  insert.run('run-b', 'k1', 1);
});

test('a database without the runs table is left alone', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateSubagentTimeline(db), { applied: false, tablesAdded: 0, columnsAdded: 0, indexesAdded: 0 });
  assert.equal(tableExists(db, 'subagent_timeline'), false);
});

test('a fresh schema carries the table and the header columns', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(tableExists(db, 'subagent_timeline'));
  for (const [name] of SUBAGENT_RUN_HEADER_COLUMNS) assert.ok(columns(db, 'subagent_runs').includes(name), name);
});
