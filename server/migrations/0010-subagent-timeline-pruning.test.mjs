import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateSubagentTimelinePruning, PRUNABLE_INDEX_NAME } from './0010-subagent-timeline-pruning.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const indexExists = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);

test('adds the pruned marker and the sweep index once and keeps the entries', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE subagent_timeline (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT, text TEXT, updated_at TEXT)`);
  db.prepare(`INSERT INTO subagent_timeline (run_id, kind, text, updated_at) VALUES ('toolu_fixture_alpha', 'tool_result', 'ok', '2026-01-01T00:00:00.000Z')`).run();
  const first = migrateSubagentTimelinePruning(db);
  assert.deepEqual(first, { applied: true, columnsAdded: 1, indexesAdded: 1 });
  assert.ok(columns(db, 'subagent_timeline').includes('pruned_at'));
  assert.ok(indexExists(db, PRUNABLE_INDEX_NAME));
  assert.equal(db.prepare(`SELECT text FROM subagent_timeline`).get().text, 'ok');
  assert.equal(migrateSubagentTimelinePruning(db).applied, false);
});

test('without the timeline table there is nothing to do', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateSubagentTimelinePruning(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
});

test('the schema boot applies it', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'subagent_timeline').includes('pruned_at'));
  assert.ok(indexExists(db, PRUNABLE_INDEX_NAME));
});
