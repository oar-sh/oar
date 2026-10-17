import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateShareAccessLog } from './0016-share-access-log.mjs';
import { applySchema } from '../db-schema.mjs';
import { createShareRepository } from '../repositories/share-repository.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const hasTable = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

function preShareLogDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE conversation_shares (token TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL,
      last_accessed_at TEXT, revoked_at TEXT);
  `);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture', 'Sample chat', '2026-01-01', '2026-01-01')`).run();
  db.prepare(`INSERT INTO conversation_shares (token, conversation_id, created_at) VALUES (?, 'conv-fixture', '2026-01-02T00:00:00.000Z')`).run('d'.repeat(64));
  return db;
}

test('adds the lineage column and the log table once; existing shares start their own lineage', () => {
  const db = preShareLogDb();
  assert.deepEqual(migrateShareAccessLog(db), { applied: true, columnsAdded: 1, tablesAdded: 1, lineagesSet: 1 });
  assert.ok(columns(db, 'conversation_shares').includes('lineage_id'));
  assert.deepEqual(columns(db, 'conversation_share_opens'), [
    'id', 'lineage_id', 'conversation_id', 'opened_at', 'ip', 'user_agent', 'country', 'viewer_key',
  ]);
  assert.equal(db.prepare(`SELECT lineage_id FROM conversation_shares`).get().lineage_id, 'd'.repeat(64));
  assert.deepEqual(migrateShareAccessLog(db), { applied: false, columnsAdded: 0, tablesAdded: 0, lineagesSet: 0 });
});

test('every run gives a lineage to a share an older build created without one', () => {
  const db = preShareLogDb();
  migrateShareAccessLog(db);
  db.prepare(`INSERT INTO conversation_shares (token, conversation_id, created_at) VALUES (?, 'conv-fixture', '2026-01-03T00:00:00.000Z')`).run('e'.repeat(64));
  assert.equal(migrateShareAccessLog(db).lineagesSet, 1);
});

test('refuses to run without the base schema, and the schema boot applies it', () => {
  assert.throws(() => migrateShareAccessLog(new Database(':memory:')), /conversation_shares is missing/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'conversation_shares').includes('lineage_id'));
  assert.equal(hasTable(db, 'conversation_share_opens'), true);
});

test('the share repository works on a schema without the migration, logging nothing', () => {
  const db = preShareLogDb();
  const shares = createShareRepository(db);
  assert.equal(shares.logAvailable, false);
  const live = shares.findLiveShare('d'.repeat(64));
  assert.equal(live.lineageId, 'd'.repeat(64), 'a share without a lineage is its own');
  const renewed = shares.renewShare('conv-fixture', () => 'f'.repeat(64), '2026-01-04T00:00:00.000Z');
  assert.equal(renewed.share.token, 'f'.repeat(64));
  assert.equal(shares.findLiveShare('d'.repeat(64)), null);
  assert.equal(shares.recordOpen({ lineageId: 'x', conversationId: 'conv-fixture', openedAt: 'now', viewerKey: 'k' }), false);
  assert.deepEqual(shares.listOpens('x'), { opens: [], total: 0, limit: 200 });
  assert.equal(shares.listActiveShares()[0].openCount, 0);
  assert.deepEqual(shares.stopSharing('conv-fixture', '2026-01-05T00:00:00.000Z'), { revokedCount: 1, opensDeleted: 0 });
});
