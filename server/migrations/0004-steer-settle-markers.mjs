'use strict';

/**
 * Migration: give steering settle stubs a durable shape the transcript can
 * render on reload.
 *
 * 1. `messages.source_message_id` — the user message an assistant row answers.
 *    The link used to live only in `queue.response_message_id`, and the queue
 *    keeps just the newest 200 finished rows, so older assistant rows lost
 *    their anchor and fell back to response-time ordering: an absorbed
 *    (handed-off) reply then sorted below the steered message it hands off to,
 *    and the merge never applied. Backfilled from whatever queue rows remain.
 * 2. Fold stubs saved as kind='absorbed' become kind='folded'. 'absorbed'
 *    tells the client the reply continues through the NEXT user message, so
 *    the next ordinary message after a fold was styled as steered.
 *
 * Idempotent: the column is added once, the backfill only fills NULLs, and the
 * kind rewrite matches nothing once applied. Safe to run on every boot.
 *
 * Usage: node server/migrations/0004-steer-settle-markers.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { STEER_FOLDED_TEXT } from '../../shared/steer-settle-markers.mjs';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
}

export function migrateSteerSettleMarkers(db) {
  if (!tableExists(db, 'messages')) {
    return { applied: false, reason: 'messages table not found', sourceLinksBackfilled: 0, foldStubsRekinded: 0 };
  }
  let columns = columnNames(db, 'messages');
  let columnAdded = false;
  if (!columns.has('source_message_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN source_message_id TEXT`);
    columnAdded = true;
    columns = columnNames(db, 'messages');
  }
  let sourceLinksBackfilled = 0;
  let foldStubsRekinded = 0;
  db.transaction(() => {
    // Walk the (small, pruned) queue rather than correlating every message
    // against it.
    if (tableExists(db, 'queue') && columnNames(db, 'queue').has('response_message_id')) {
      const link = db.prepare(`
        UPDATE messages SET source_message_id = ?
        WHERE id = ? AND role = 'assistant' AND source_message_id IS NULL
      `);
      const rows = db.prepare(`
        SELECT id, response_message_id FROM queue
        WHERE response_message_id IS NOT NULL AND response_message_id != ''
      `).all();
      for (const row of rows) {
        sourceLinksBackfilled += link.run(String(row.id), String(row.response_message_id)).changes;
      }
    }
    if (columns.has('kind')) {
      foldStubsRekinded = db.prepare(`
        UPDATE messages SET kind = 'folded'
        WHERE role = 'assistant' AND kind = 'absorbed' AND TRIM(text) = ?
      `).run(STEER_FOLDED_TEXT).changes;
    }
  })();
  return {
    applied: columnAdded || sourceLinksBackfilled > 0 || foldStubsRekinded > 0,
    columnAdded,
    sourceLinksBackfilled,
    foldStubsRekinded,
  };
}

export function migrate(dbPath) {
  const db = new Database(dbPath);
  try {
    return migrateSteerSettleMarkers(db);
  } finally {
    db.close();
  }
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0004 on ${dbPath}`);
    console.log(result.applied
      ? `  column added: ${result.columnAdded}; source links backfilled: ${result.sourceLinksBackfilled}; fold stubs re-kinded: ${result.foldStubsRekinded}`
      : `  skipped: ${result.reason || 'nothing to change'}`);
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0004 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
