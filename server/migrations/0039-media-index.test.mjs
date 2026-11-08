import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { MEDIA_INDEX_TRIGGERS, migrateMediaIndex } from './0039-media-index.mjs';
import { applySchema } from '../db-schema.mjs';
import { MEDIA_EXTRACTOR_VERSION } from '../services/media-extract.mjs';

const NOW = '2026-11-01T10:00:00.000Z';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

function addConversation(db, id = 'conv-fixture') {
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Fixture', ?, ?)`).run(id, NOW, NOW);
}

function addMessage(db, id, { conv = 'conv-fixture', role = 'assistant', text = 'hello', attachments = null } = {}) {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, attachments, timestamp) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, conv, role, text, attachments, NOW);
}

const queue = (db) => db.prepare(`SELECT message_id AS id, seq FROM media_index_queue ORDER BY rowid`).all();

test('applySchema creates the tables, both triggers and the extractor version', () => {
  const db = freshDb();
  for (const table of ['media_items', 'media_index_queue', 'media_index_meta']) {
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table), table);
  }
  for (const name of MEDIA_INDEX_TRIGGERS) {
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name), name);
  }
  assert.equal(db.prepare(`SELECT value FROM media_index_meta WHERE key = 'extractor_version'`).get().value, String(MEDIA_EXTRACTOR_VERSION));
  assert.deepEqual(migrateMediaIndex(db), { applied: false, tablesCreated: 0, triggersCreated: 0, seeded: 0 });
});

test('inserts and changes of watched columns queue the message id; other updates do not', () => {
  const db = freshDb();
  addConversation(db);
  addMessage(db, 'm1');
  assert.deepEqual(queue(db), [{ id: 'm1', seq: 0 }]);
  db.prepare(`UPDATE messages SET text = 'changed ![a](/tmp/a.png)' WHERE id = 'm1'`).run();
  db.prepare(`UPDATE messages SET attachments = '[]' WHERE id = 'm1'`).run();
  db.prepare(`UPDATE messages SET timestamp = '2026-11-02T00:00:00.000Z' WHERE id = 'm1'`).run();
  db.prepare(`UPDATE messages SET kind = 'note' WHERE id = 'm1'`).run();
  db.prepare(`UPDATE messages SET origin_json = '{}' WHERE id = 'm1'`).run();
  assert.deepEqual(queue(db), [{ id: 'm1', seq: 5 }], 'one row; seq counts the re-queues');
  db.prepare(`UPDATE messages SET pinned_at = ? WHERE id = 'm1'`).run(NOW);
  db.prepare(`UPDATE messages SET hidden_from_shares = 1 WHERE id = 'm1'`).run();
  assert.deepEqual(queue(db), [{ id: 'm1', seq: 5 }]);
});

test('deleting a message or a conversation removes its queue rows and media rows', () => {
  const db = freshDb();
  addConversation(db, 'c1');
  addConversation(db, 'c2');
  addMessage(db, 'm1', { conv: 'c1' });
  addMessage(db, 'm2', { conv: 'c2' });
  const insert = db.prepare(`INSERT INTO media_items (message_id, conversation_id, ordinal, role, sender, origin, locator_kind, locator,
    identity_key, category, media_kind, message_ts) VALUES (?, ?, 0, 'assistant', 'agent', 'embedded', 'local_path', '/tmp/a.png', 'path:/tmp/a.png', 'media', 'image', ?)`);
  insert.run('m1', 'c1', NOW);
  insert.run('m2', 'c2', NOW);
  db.prepare(`DELETE FROM messages WHERE id = 'm1'`).run();
  db.prepare(`DELETE FROM conversations WHERE id = 'c2'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM media_items`).get().n, 0);
  assert.deepEqual(queue(db), []);
});

test('an existing database is seeded once; a later boot seeds nothing; a new extractor version seeds again', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  addConversation(db);
  // A database from before 0039: messages exist, the media schema does not.
  for (const name of MEDIA_INDEX_TRIGGERS) db.exec(`DROP TRIGGER ${name}`);
  db.exec(`DROP TABLE media_index_queue; DROP TABLE media_items; DROP TABLE media_index_meta;`);
  for (let i = 0; i < 25; i += 1) addMessage(db, `old-${i}`);

  const first = migrateMediaIndex(db);
  assert.deepEqual(first, { applied: true, tablesCreated: 3, triggersCreated: 2, seeded: 25 });
  db.exec(`DELETE FROM media_index_queue`); // as if drained
  assert.equal(migrateMediaIndex(db).seeded, 0, 'a drained queue is not refilled on the next boot');

  db.prepare(`UPDATE media_index_meta SET value = '0' WHERE key = 'extractor_version'`).run();
  assert.equal(migrateMediaIndex(db).seeded, 25);
  assert.equal(db.prepare(`SELECT value FROM media_index_meta WHERE key = 'extractor_version'`).get().value, String(MEDIA_EXTRACTOR_VERSION));
});

test('a missing or altered trigger is re-created on the next boot', () => {
  const db = freshDb();
  db.exec(`DROP TRIGGER media_index_on_insert`);
  db.exec(`DROP TRIGGER media_index_on_update`);
  db.exec(`CREATE TRIGGER media_index_on_update AFTER UPDATE OF text ON messages BEGIN SELECT 1; END`);
  assert.equal(migrateMediaIndex(db).triggersCreated, 2);
  addConversation(db);
  addMessage(db, 'm1');
  db.prepare(`UPDATE messages SET attachments = '[]' WHERE id = 'm1'`).run();
  assert.deepEqual(queue(db), [{ id: 'm1', seq: 1 }]);
});

test('the queue trigger works inside an immediate transaction and with bulk inserts', () => {
  const db = freshDb();
  addConversation(db);
  db.transaction(() => {
    for (let i = 0; i < 500; i += 1) addMessage(db, `bulk-${i}`);
  }).immediate();
  assert.equal(queue(db).length, 500);
});

test('a database without messages is left alone', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateMediaIndex(db), { applied: false, tablesCreated: 0, triggersCreated: 0, seeded: 0 });
});
