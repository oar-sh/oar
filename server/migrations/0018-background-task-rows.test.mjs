import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { backgroundTaskRowsTableProblem, migrateBackgroundTaskRows } from './0018-background-task-rows.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the table once', () => {
  const db = new Database(':memory:');
  assert.equal(backgroundTaskRowsTableProblem(db), 'no background_task_rows table');
  assert.deepEqual(migrateBackgroundTaskRows(db), { applied: true, tablesAdded: 1 });
  assert.deepEqual(columns(db, 'background_task_rows'), ['store_key', 'task_id', 'state', 'row_json', 'ended_at', 'updated_at']);
  assert.equal(backgroundTaskRowsTableProblem(db), '');
  assert.deepEqual(migrateBackgroundTaskRows(db), { applied: false, tablesAdded: 0 });
});

test('a row is one per key and task, in one of two states', () => {
  const db = new Database(':memory:');
  migrateBackgroundTaskRows(db);
  const insert = db.prepare(`INSERT INTO background_task_rows (store_key, task_id, state, row_json, ended_at, updated_at) VALUES (?, ?, ?, '{}', NULL, 1)`);
  insert.run('sess-1', 't1', 'live');
  assert.throws(() => insert.run('sess-1', 't1', 'ended'), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => insert.run('sess-1', 't2', 'running'), /CHECK/);
});

test('a table of that name with other columns is reported, and the schema boot applies the migration', () => {
  const odd = new Database(':memory:');
  odd.exec(`CREATE TABLE background_task_rows (id INTEGER PRIMARY KEY)`);
  assert.match(backgroundTaskRowsTableProblem(odd), /lacks store_key/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(backgroundTaskRowsTableProblem(db), '');
});
