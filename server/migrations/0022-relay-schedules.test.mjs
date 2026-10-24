import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { RELAY_SCHEDULE_COLUMNS, migrateRelaySchedules, relaySchedulesTableProblem } from './0022-relay-schedules.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const indexes = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'relay_schedules'`).all().map((row) => row.name);

test('creates the table and its indexes once', () => {
  const db = new Database(':memory:');
  assert.equal(relaySchedulesTableProblem(db), 'no relay_schedules table');
  assert.deepEqual(migrateRelaySchedules(db), { applied: true, tablesAdded: 1, columnsAdded: 0 });
  assert.deepEqual(columns(db, 'relay_schedules'), [...RELAY_SCHEDULE_COLUMNS]);
  for (const name of ['idx_relay_schedules_active', 'idx_relay_schedules_conversation', 'idx_relay_schedules_creator']) {
    assert.ok(indexes(db).includes(name), name);
  }
  assert.equal(relaySchedulesTableProblem(db), '');
  assert.deepEqual(migrateRelaySchedules(db), { applied: false, tablesAdded: 0, columnsAdded: 0 });
});

test('a table of the first form gets the provenance and hold columns', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE relay_schedules (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_by_conversation_id TEXT NOT NULL, title TEXT,
      text TEXT NOT NULL, at TEXT, every_minutes INTEGER, once INTEGER NOT NULL DEFAULT 1, next_fire_at TEXT,
      last_fired_at TEXT, fired_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0,
      last_message_id TEXT, created_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT
    )
  `);
  assert.equal(relaySchedulesTableProblem(db), 'relay_schedules lacks origin_json, held_since');
  assert.deepEqual(migrateRelaySchedules(db), { applied: true, tablesAdded: 0, columnsAdded: 2 });
  assert.equal(relaySchedulesTableProblem(db), '');
});

test('a repeating schedule needs its interval, and the interval is positive', () => {
  const db = new Database(':memory:');
  migrateRelaySchedules(db);
  const insert = db.prepare(`
    INSERT INTO relay_schedules (id, conversation_id, created_by_conversation_id, text, every_minutes, once, next_fire_at, created_at)
    VALUES (?, 'conv-a', 'conv-a', 'x', ?, ?, '2026-03-02T10:00:00.000Z', '2026-03-02T09:00:00.000Z')
  `);
  insert.run('sch_once', null, 1);
  insert.run('sch_every', 10, 0);
  assert.throws(() => insert.run('sch_bad', null, 0), /CHECK/);
  assert.throws(() => insert.run('sch_zero', 0, 0), /CHECK/);
  assert.throws(() => insert.run('sch_flag', 10, 2), /CHECK/);
  const row = db.prepare(`SELECT fired_count, skipped_count, ended_at FROM relay_schedules WHERE id = 'sch_every'`).get();
  assert.deepEqual({ ...row }, { fired_count: 0, skipped_count: 0, ended_at: null });
});

test('a table of that name with other columns is reported, and the schema boot applies the migration', () => {
  const odd = new Database(':memory:');
  odd.exec(`CREATE TABLE relay_schedules (id TEXT PRIMARY KEY, conversation_id TEXT)`);
  assert.match(relaySchedulesTableProblem(odd), /lacks created_by_conversation_id/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(relaySchedulesTableProblem(db), '');
});
