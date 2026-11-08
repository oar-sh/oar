import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { hasImageSessionDefaultsColumn, hasQueueImageOptionsColumn, migrateImageSessionDefaults } from './0040-image-session-defaults.mjs';
import { applySchema, SCHEMA_SQL } from '../db-schema.mjs';
import { createImageConversationRepository } from '../repositories/image-conversation-repository.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => `${column.name}:${column.type}`).sort();

// A database from before 0040: the full schema with both columns taken away
// again (SQLite 3.35+ drops a column).
function before0040(db) {
  applySchema(db);
  db.exec(`ALTER TABLE image_sessions DROP COLUMN defaults_json`);
  db.exec(`ALTER TABLE queue DROP COLUMN image_options_json`);
  return db;
}

test('adds image_sessions.defaults_json and queue.image_options_json once; old rows read null', () => {
  const db = before0040(new Database(':memory:'));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO image_sessions (id, conversation_id, origin, created_at, updated_at) VALUES ('img-session-a', 'conv-a', 'native', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  assert.equal(hasImageSessionDefaultsColumn(db), false);
  assert.equal(hasQueueImageOptionsColumn(db), false);

  assert.deepEqual(migrateImageSessionDefaults(db), { applied: true, columnsAdded: 2 });
  assert.deepEqual(migrateImageSessionDefaults(db), { applied: false, columnsAdded: 0 });
  assert.equal(hasImageSessionDefaultsColumn(db), true);
  assert.equal(hasQueueImageOptionsColumn(db), true);
  assert.equal(db.prepare(`SELECT defaults_json FROM image_sessions`).get().defaults_json, null);
});

test('only the missing column is added', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.exec(`ALTER TABLE queue DROP COLUMN image_options_json`);
  assert.deepEqual(migrateImageSessionDefaults(db), { applied: true, columnsAdded: 1 });
  assert.ok(columns(db, 'queue').includes('image_options_json:TEXT'));
});

test('creates the image tables first when they are missing; nothing without a relay\'s queue', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.pragma('foreign_keys = OFF');
  for (const table of ['image_operation_assets', 'image_edges', 'image_nodes', 'image_operations', 'image_sessions']) db.exec(`DROP TABLE IF EXISTS ${table}`);
  assert.deepEqual(migrateImageSessionDefaults(db), { applied: true, columnsAdded: 1 });
  assert.ok(columns(db, 'image_sessions').includes('defaults_json:TEXT'));
  assert.deepEqual(migrateImageSessionDefaults(new Database(':memory:')), { applied: false, columnsAdded: 0 });
});

test('the image schema setup itself adds neither column; SCHEMA_SQL names neither', () => {
  assert.doesNotMatch(SCHEMA_SQL, /defaults_json|image_options_json/);
  const db = before0040(new Database(':memory:'));
  // What runs before the migrations on every boot leaves them to 0040.
  db.exec(SCHEMA_SQL);
  assert.equal(hasQueueImageOptionsColumn(db), false);
});

test('a fresh and an upgraded database end the same', () => {
  const fresh = new Database(':memory:');
  applySchema(fresh);
  const upgraded = before0040(new Database(':memory:'));
  applySchema(upgraded);
  for (const table of ['image_sessions', 'queue']) assert.deepEqual(columns(upgraded, table), columns(fresh, table), table);
  assert.ok(columns(fresh, 'image_sessions').includes('defaults_json:TEXT'));
  assert.ok(columns(fresh, 'queue').includes('image_options_json:TEXT'));
});

test('without the column the repository keeps no turn options and does not throw', () => {
  const db = before0040(new Database(':memory:'));
  const repository = createImageConversationRepository(db);
  assert.equal(repository.setQueueImageOptions.run('{"count":2}', 'q-1'), undefined);
  migrateImageSessionDefaults(db);
  // Prepared on first use: a repository made after the migration keeps them.
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-1', 'conv-a', 'x', 'pending', '2026-01-01T00:00:00.000Z')`).run();
  assert.equal(createImageConversationRepository(db).setQueueImageOptions.run('{"count":2}', 'q-1').changes, 1);
});

test('the CLI entry point migrates a database file', async () => {
  const { migrate } = await import('./0040-image-session-defaults.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-0040-'));
  try {
    const file = path.join(dir, 'fixture.db');
    before0040(new Database(file)).close();
    assert.deepEqual(migrate(file), { applied: true, columnsAdded: 2 });
    assert.deepEqual(migrate(file), { applied: false, columnsAdded: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
