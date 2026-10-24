import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { RELAY_ASK_COLUMNS, migrateRelayAsks, relayAsksTableProblem } from './0023-relay-asks.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db) => db.prepare(`PRAGMA table_info(relay_asks)`).all().map((column) => column.name);
const indexes = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'relay_asks'`).all().map((row) => row.name);

test('creates the table and its indexes once', () => {
  const db = new Database(':memory:');
  assert.equal(relayAsksTableProblem(db), 'no relay_asks table');
  assert.deepEqual(migrateRelayAsks(db), { applied: true, tablesAdded: 1 });
  assert.deepEqual(columns(db), [...RELAY_ASK_COLUMNS]);
  for (const name of ['idx_relay_asks_status', 'idx_relay_asks_conversation', 'idx_relay_asks_creator', 'idx_relay_asks_remote']) {
    assert.ok(indexes(db).includes(name), name);
  }
  assert.equal(relayAsksTableProblem(db), '');
  assert.deepEqual(migrateRelayAsks(db), { applied: false, tablesAdded: 0 });
});

test('a status, an urgency and a mirror without its remote id are checked', () => {
  const db = new Database(':memory:');
  migrateRelayAsks(db);
  const insert = db.prepare(`
    INSERT INTO relay_asks (id, relay_id, remote_id, conversation_id, question, urgency, status, created_at, updated_at)
    VALUES (?, ?, ?, 'conv-a', 'Q?', ?, ?, '2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z')
  `);
  insert.run('ask_a', 'self', null, 'normal', 'pending');
  insert.run('ask_b', 'relay-lab', 'ask_there', 'now', 'answered');
  assert.throws(() => insert.run('ask_c', 'self', null, 'soon', 'pending'), /CHECK/);
  assert.throws(() => insert.run('ask_d', 'self', null, 'normal', 'open'), /CHECK/);
  assert.throws(() => insert.run('ask_e', 'relay-lab', null, 'normal', 'pending'), /CHECK/);
  assert.throws(() => insert.run('ask_f', 'relay-lab', 'ask_there', 'normal', 'pending'), /UNIQUE/);
  const row = db.prepare(`SELECT relay_id, urgency, status FROM relay_asks WHERE id = 'ask_a'`).get();
  assert.deepEqual({ ...row }, { relay_id: 'self', urgency: 'normal', status: 'pending' });
});

test('a table of that name with other columns is reported, and the schema boot applies the migration', () => {
  const odd = new Database(':memory:');
  odd.exec(`CREATE TABLE relay_asks (id TEXT PRIMARY KEY, conversation_id TEXT)`);
  assert.match(relayAsksTableProblem(odd), /lacks relay_id/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(relayAsksTableProblem(db), '');
});
