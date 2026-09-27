import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { migrate, migrateRemoteRelays } from './0005-remote-relays.mjs';
import { applySchema } from '../db-schema.mjs';

function legacyDb(filename = ':memory:') {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO conversations (id, title) VALUES ('c-1', 'report builder')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-1', 'c-1', 'user', 'hi', '2026-09-20T10:00:00.000Z')`).run();
  return db;
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the origin columns and the unlock table, keeping existing rows', () => {
  const db = legacyDb();
  const result = migrateRemoteRelays(db);
  assert.deepEqual(result, { applied: true, columnsAdded: 2, unlocksTableCreated: true });
  assert.ok(columns(db, 'messages').includes('origin_json'));
  assert.ok(columns(db, 'conversations').includes('origin_json'));
  assert.deepEqual(columns(db, 'conversation_remote_relay_unlocks'), ['conversation_id', 'remote_relay_id', 'message_id', 'created_at']);
  assert.equal(db.prepare(`SELECT origin_json FROM messages WHERE id = 'm-1'`).get().origin_json, null);
});

test('is idempotent', () => {
  const db = legacyDb();
  migrateRemoteRelays(db);
  db.prepare(`INSERT INTO conversation_remote_relay_unlocks VALUES ('c-1', 'r-1', 'm-1', '2026-09-20T10:00:00.000Z')`).run();
  assert.deepEqual(migrateRemoteRelays(db), { applied: false, columnsAdded: 0, unlocksTableCreated: false });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM conversation_remote_relay_unlocks`).get().n, 1);
});

test('one unlock per conversation and relay', () => {
  const db = legacyDb();
  migrateRemoteRelays(db);
  const insert = db.prepare(`INSERT INTO conversation_remote_relay_unlocks VALUES (?, ?, ?, ?)`);
  insert.run('c-1', 'r-1', 'm-1', '2026-09-20T10:00:00.000Z');
  assert.throws(() => insert.run('c-1', 'r-1', 'm-2', '2026-09-20T10:01:00.000Z'), /UNIQUE|PRIMARY/);
});

test('the offline entry point migrates a database file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-migration-0005-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'relay.db');
  legacyDb(file).close();
  assert.equal(migrate(file).columnsAdded, 2);
  const db = new Database(file);
  const has = columns(db, 'messages').includes('origin_json');
  db.close();
  assert.equal(has, true);
});

test('production boot (applySchema) carries the columns and the table on a fresh database', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'messages').includes('origin_json'));
  assert.ok(columns(db, 'conversations').includes('origin_json'));
  assert.ok(columns(db, 'conversation_remote_relay_unlocks').length > 0);
  applySchema(db);
});
