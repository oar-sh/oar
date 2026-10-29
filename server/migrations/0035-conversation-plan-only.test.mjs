import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { QUEUE_CONVERSATION_STATUS_INDEX, migrateConversationPlanOnly } from './0035-conversation-plan-only.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the plan_only column once, NULL (not plan-only) on existing conversations', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture', 'Sample chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  // No queue table in this fixture: the column alone.
  assert.deepEqual(migrateConversationPlanOnly(db), { applied: true, columnsAdded: 1, indexesAdded: 0 });
  assert.ok(columns(db, 'conversations').includes('plan_only'));
  assert.deepEqual(migrateConversationPlanOnly(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  assert.equal(db.prepare(`SELECT plan_only FROM conversations WHERE id = 'conv-fixture'`).get().plan_only, null);
});

test('refuses to run without the base schema, and the schema boot applies it', () => {
  assert.throws(() => migrateConversationPlanOnly(new Database(':memory:')), /conversations is missing/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'conversations').includes('plan_only'));
});

test('stays idempotent on a database whose schema already went further', () => {
  // Every later migration (0036 and on) has run: the boot again, then 0035
  // once more, change nothing.
  const db = new Database(':memory:');
  applySchema(db);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((row) => row.name);
  applySchema(db);
  assert.deepEqual(migrateConversationPlanOnly(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((row) => row.name), tables);
});

test('the CLI entry point migrates a database file', async () => {
  const { migrate } = await import('./0035-conversation-plan-only.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-0035-'));
  try {
    const file = path.join(dir, 'fixture.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.close();
    assert.deepEqual(migrate(file), { applied: true, columnsAdded: 1, indexesAdded: 0 });
    assert.deepEqual(migrate(file), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('adds the queue index once, also to a database that has the column already', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const indexes = () => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queue'`).all().map((row) => row.name);
  assert.ok(indexes().includes(QUEUE_CONVERSATION_STATUS_INDEX), 'the schema boot adds it');
  db.exec(`DROP INDEX ${QUEUE_CONVERSATION_STATUS_INDEX}`);
  assert.deepEqual(migrateConversationPlanOnly(db), { applied: true, columnsAdded: 0, indexesAdded: 1 });
  assert.deepEqual(migrateConversationPlanOnly(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  assert.deepEqual(db.prepare(`PRAGMA index_info(${QUEUE_CONVERSATION_STATUS_INDEX})`).all().map((row) => row.name), ['conversation_id', 'status', 'timestamp']);
});

test('the claim\'s plan-boundary hold reads the queue through that index', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createMessageRepository(db);
  for (const name of ['findPending', 'findPendingForLegacyRelay', 'findPendingForSessionAffinity', 'findPendingForWorker']) {
    const source = repository[name].source;
    const params = (source.match(/\?/g) || []).map(() => 'x');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params).map((row) => row.detail);
    // Every lookup of the subquery's queue rows (held, live) goes through it;
    // none scans or takes another index.
    const lookups = plan.filter((detail) => /\b(held|live)\b/.test(detail));
    assert.ok(lookups.some((detail) => /\bheld\b/.test(detail)) && lookups.some((detail) => /\blive\b/.test(detail)), `${name}: ${plan.join(' | ')}`);
    for (const detail of lookups) {
      assert.match(detail, /^SEARCH (held|live) USING (COVERING )?INDEX idx_queue_conversation_status \(conversation_id=\? AND status=\?/, `${name}: ${detail}`);
    }
  }
});