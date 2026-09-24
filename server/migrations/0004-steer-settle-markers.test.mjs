import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { migrate, migrateSteerSettleMarkers } from './0004-steer-settle-markers.mjs';
import { applySchema } from '../db-schema.mjs';
import { STEER_FOLDED_TEXT, STEER_STOPPED_TEXT } from '../../shared/steer-settle-markers.mjs';

// A database as 0.9.2 left it: messages carry `kind` but no source link, and
// fold stubs were stamped 'absorbed'.
function legacyDb(filename = ':memory:') {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, timestamp TEXT NOT NULL, kind TEXT
    );
    CREATE TABLE queue (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, text TEXT,
      status TEXT, timestamp TEXT, response_message_id TEXT
    );
  `);
  const insertMessage = db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES (?, 'conv-1', ?, ?, ?, ?)`);
  insertMessage.run('u-1', 'user', 'first', '2026-09-20T10:00:00.000Z', null);
  insertMessage.run('u-2', 'user', 'steered in', '2026-09-20T10:00:05.000Z', null);
  insertMessage.run('a-1', 'assistant', 'the reply', '2026-09-20T10:00:30.000Z', null);
  insertMessage.run('a-2', 'assistant', STEER_FOLDED_TEXT, '2026-09-20T10:00:31.000Z', 'absorbed');
  // A real handoff: its own partial reply, genuinely absorbed.
  insertMessage.run('a-3', 'assistant', 'started on it', '2026-09-20T10:01:00.000Z', 'absorbed');
  insertMessage.run('a-4', 'assistant', STEER_STOPPED_TEXT, '2026-09-20T10:02:00.000Z', 'stopped');
  // Only u-2's row survived the queue prune; u-1's link is gone for good.
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, response_message_id) VALUES ('u-2', 'conv-1', 'steered in', 'done', '2026-09-20T10:00:05.000Z', 'a-2')`).run();
  return db;
}

const messageRow = (db, id) => db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);

test('fold stubs stamped absorbed become folded; handoffs and stops keep their kind', () => {
  const db = legacyDb();
  const result = migrateSteerSettleMarkers(db);
  assert.equal(result.foldStubsRekinded, 1);
  assert.equal(messageRow(db, 'a-2').kind, 'folded');
  assert.equal(messageRow(db, 'a-3').kind, 'absorbed', 'a real handoff still continues through the next message');
  assert.equal(messageRow(db, 'a-4').kind, 'stopped');
  assert.equal(messageRow(db, 'a-1').kind, null);
});

test('the source link is added and backfilled from the surviving queue rows', () => {
  const db = legacyDb();
  const result = migrateSteerSettleMarkers(db);
  assert.equal(result.columnAdded, true);
  assert.equal(result.sourceLinksBackfilled, 1);
  assert.equal(messageRow(db, 'a-2').source_message_id, 'u-2');
  assert.equal(messageRow(db, 'a-1').source_message_id, null, 'a pruned link cannot be recovered');
  assert.equal(messageRow(db, 'u-2').source_message_id, null, 'user rows never get a source');
});

test('the migration is idempotent and never overwrites an existing link', () => {
  const db = legacyDb();
  migrateSteerSettleMarkers(db);
  db.prepare(`UPDATE messages SET source_message_id = 'u-kept' WHERE id = 'a-2'`).run();
  const again = migrateSteerSettleMarkers(db);
  assert.equal(again.applied, false);
  assert.equal(again.columnAdded, false);
  assert.equal(again.sourceLinksBackfilled, 0);
  assert.equal(again.foldStubsRekinded, 0);
  assert.equal(messageRow(db, 'a-2').source_message_id, 'u-kept');
  assert.equal(messageRow(db, 'a-2').kind, 'folded');
});

test('the migration is a no-op without a messages table', () => {
  const db = new Database(':memory:');
  assert.equal(migrateSteerSettleMarkers(db).applied, false);
});

test('the offline entry point migrates a database file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-migration-0004-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'relay.db');
  legacyDb(file).close();
  assert.equal(migrate(file).foldStubsRekinded, 1);
  // Closed before the directory is removed: Windows cannot delete an open file.
  const db = new Database(file);
  const kind = messageRow(db, 'a-2').kind;
  db.close();
  assert.equal(kind, 'folded');
});

test('production boot (applySchema) carries the column on a fresh database', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const columns = db.prepare(`PRAGMA table_info(messages)`).all().map((column) => column.name);
  assert.ok(columns.includes('source_message_id'));
  // Re-running the whole boot sequence stays safe.
  applySchema(db);
});

test('the resend link column is added alongside the source link', () => {
  const db = legacyDb();
  migrateSteerSettleMarkers(db);
  const columns = db.prepare(`PRAGMA table_info(messages)`).all().map((column) => column.name);
  assert.ok(columns.includes('resend_of_message_id'));
});

test('a failing 0004 migration does not keep the relay from booting', (t) => {
  const real = new Database(':memory:');
  const db = new Proxy(real, {
    get(target, key) {
      if (key === 'exec') {
        return (sql) => {
          if (/ALTER TABLE messages ADD COLUMN source_message_id/.test(sql)) {
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          }
          return target.exec(sql);
        };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const warnings = [];
  t.mock.method(console, 'warn', (message) => { warnings.push(String(message)); });
  assert.doesNotThrow(() => applySchema(db));
  assert.ok(warnings.some((message) => /migration 0004 failed/.test(message)));
});
