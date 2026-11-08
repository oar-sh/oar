'use strict';

/**
 * Migration: the media gallery index.
 *
 * `media_items`: one row per picture, video or attached file of a message
 * (services/media-extract.mjs decides what counts). Rows go with their
 * message or conversation (foreign keys, ON DELETE CASCADE). `message_ts`
 * copies the message time so the gallery pages by an index.
 *
 * `media_index_queue`: the ids of messages to (re)index. Two triggers on
 * `messages` put a row id here on insert and when a column the index reads
 * changes; they never parse anything, so the write path pays one small
 * insert. The indexer (services/media-index-service.mjs) drains the queue in
 * batches. `seq` grows on every re-queue, so a drain only removes the queue
 * row it actually indexed.
 *
 * `media_index_meta`: the extractor version the queue was seeded for. When
 * it is missing (first run) or older than MEDIA_EXTRACTOR_VERSION, every
 * message is queued once and the version is stored; later boots seed nothing.
 *
 * Not in SCHEMA_SQL (db-schema.mjs): the triggers name columns that older
 * migrations add. The triggers are checked on every boot and re-created when
 * missing or different, like the FTS triggers.
 *
 * Additive and idempotent. Rolling back: drop the triggers first, then the
 * tables (a trigger left pointing at a dropped table breaks message inserts):
 *   DROP TRIGGER IF EXISTS media_index_on_insert;
 *   DROP TRIGGER IF EXISTS media_index_on_update;
 *   DROP TABLE IF EXISTS media_index_queue; DROP TABLE IF EXISTS media_items;
 *   DROP TABLE IF EXISTS media_index_meta;
 *
 * Usage: node server/migrations/0039-media-index.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';
import { MEDIA_EXTRACTOR_VERSION } from '../services/media-extract.mjs';

export const MEDIA_INDEX_TRIGGERS = Object.freeze(['media_index_on_insert', 'media_index_on_update']);
// Columns the index reads; a change to one re-queues the message.
const WATCHED_COLUMNS = Object.freeze(['text', 'attachments', 'timestamp', 'role', 'kind', 'origin_json', 'conversation_id']);

const QUEUE_UPSERT = `INSERT INTO media_index_queue (message_id, seq) VALUES (NEW.id, 0)
    ON CONFLICT(message_id) DO UPDATE SET seq = seq + 1;`;

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

export function mediaIndexTriggerSql(messageColumns) {
  const watched = WATCHED_COLUMNS.filter((column) => messageColumns.includes(column));
  return {
    media_index_on_insert: `CREATE TRIGGER media_index_on_insert AFTER INSERT ON messages BEGIN
    ${QUEUE_UPSERT}
  END`,
    media_index_on_update: `CREATE TRIGGER media_index_on_update AFTER UPDATE OF ${watched.join(', ')} ON messages BEGIN
    ${QUEUE_UPSERT}
  END`,
  };
}

export function migrateMediaIndex(db) {
  if (!tableExists(db, 'messages') || !tableExists(db, 'conversations')) {
    return { applied: false, tablesCreated: 0, triggersCreated: 0, seeded: 0 };
  }
  let tablesCreated = 0;
  let triggersCreated = 0;
  let seeded = 0;
  const run = db.transaction(() => {
    if (!tableExists(db, 'media_items')) {
      db.exec(`
        CREATE TABLE media_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          role TEXT NOT NULL,
          sender TEXT NOT NULL,
          origin TEXT NOT NULL,
          locator_kind TEXT NOT NULL,
          locator TEXT NOT NULL,
          identity_key TEXT NOT NULL,
          category TEXT NOT NULL,
          media_kind TEXT NOT NULL,
          mime TEXT,
          name TEXT,
          alt TEXT,
          size_bytes INTEGER,
          message_ts TEXT NOT NULL,
          UNIQUE (message_id, ordinal)
        );
        CREATE INDEX idx_media_items_conv ON media_items(conversation_id, category, message_ts DESC, id DESC);
        CREATE INDEX idx_media_items_all ON media_items(category, message_ts DESC, id DESC);
        CREATE INDEX idx_media_items_identity ON media_items(identity_key);
      `);
      tablesCreated += 1;
    }
    if (!tableExists(db, 'media_index_queue')) {
      db.exec(`
        CREATE TABLE media_index_queue (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL DEFAULT 0
        )
      `);
      tablesCreated += 1;
    }
    if (!tableExists(db, 'media_index_meta')) {
      db.exec(`CREATE TABLE media_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      tablesCreated += 1;
    }

    const expected = mediaIndexTriggerSql(columnsOf(db, 'messages'));
    for (const name of MEDIA_INDEX_TRIGGERS) {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name);
      if (row?.sql === expected[name]) continue;
      if (row) db.exec(`DROP TRIGGER ${name}`);
      db.exec(expected[name]);
      triggersCreated += 1;
    }

    const version = db.prepare(`SELECT value FROM media_index_meta WHERE key = 'extractor_version'`).get()?.value;
    if (String(version || '') !== String(MEDIA_EXTRACTOR_VERSION)) {
      seeded = db.prepare(`
        INSERT INTO media_index_queue (message_id, seq)
        SELECT id, 0 FROM messages WHERE true
        ON CONFLICT(message_id) DO UPDATE SET seq = seq + 1
      `).run().changes;
      db.prepare(`INSERT INTO media_index_meta (key, value) VALUES ('extractor_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(MEDIA_EXTRACTOR_VERSION));
    }
  });
  run();
  return { applied: tablesCreated + triggersCreated + seeded > 0, tablesCreated, triggersCreated, seeded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateMediaIndex(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const dbPath = cliDbPath(process.argv[2], new URL('..', import.meta.url));
    const result = migrate(dbPath);
    console.log(`Migration 0039 on ${dbPath}`);
    console.log(result.applied
      ? `  media index: tables created ${result.tablesCreated}, triggers created ${result.triggersCreated}, messages queued ${result.seeded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0039 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
