import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateRelayAsksQueueId } from './0037-relay-asks-queue-id.mjs';
import { migrateRelayAsks, relayAsksTableProblem } from './0023-relay-asks.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db) => db.prepare(`PRAGMA table_info(relay_asks)`).all().map((column) => column.name);

test('adds the queue_id column once; existing asks read null', () => {
  const db = new Database(':memory:');
  migrateRelayAsks(db);
  db.prepare(`
    INSERT INTO relay_asks (id, relay_id, conversation_id, question, created_at, updated_at)
    VALUES ('ask_fixture', 'self', 'conv-fixture', 'Which colour?', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  assert.ok(!columns(db).includes('queue_id'));
  assert.deepEqual(migrateRelayAsksQueueId(db), { applied: true, columnsAdded: 1 });
  assert.ok(columns(db).includes('queue_id'));
  assert.deepEqual(migrateRelayAsksQueueId(db), { applied: false, columnsAdded: 0 });
  assert.equal(db.prepare(`SELECT queue_id FROM relay_asks WHERE id = 'ask_fixture'`).get().queue_id, null);
  // 0023's availability check still passes with the extra column.
  assert.equal(relayAsksTableProblem(db), '');
});

test('nothing to do without the relay_asks table', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateRelayAsksQueueId(db), { applied: false, columnsAdded: 0 });
  assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_asks'`).get(), undefined);
});

test('the schema boot applies it, and a second boot changes nothing', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db).includes('queue_id'));
  applySchema(db);
  assert.deepEqual(migrateRelayAsksQueueId(db), { applied: false, columnsAdded: 0 });
});

test('the CLI entry point migrates a database file', async () => {
  const { migrate } = await import('./0037-relay-asks-queue-id.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-0037-'));
  try {
    const file = path.join(dir, 'fixture.db');
    const db = new Database(file);
    migrateRelayAsks(db);
    db.close();
    assert.deepEqual(migrate(file), { applied: true, columnsAdded: 1 });
    assert.deepEqual(migrate(file), { applied: false, columnsAdded: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
