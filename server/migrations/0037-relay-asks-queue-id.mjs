'use strict';

/**
 * Migration: the turn an ask was made in.
 *
 * `relay_asks.queue_id`: the queue row of the turn that was live in the
 * asking conversation when its agent asked (services/relay-ask-service.mjs
 * create), so the browser can show the ask in that turn's bubble. NULL for
 * an ask made on behalf of another session, one a paired relay's agent made
 * here, a mirror, and every ask from before this migration. No index: it is
 * read with the row, never looked up by.
 *
 * Not one of RELAY_ASK_COLUMNS (0023): the ask service works without it and
 * then stores nothing.
 *
 * Additive and idempotent. Safe to run on every boot; nothing to do while
 * there is no relay_asks table (0023 not run yet). Rolling back needs no
 * data change: older code ignores the column.
 *
 * Usage: node server/migrations/0037-relay-asks-queue-id.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function migrateRelayAsksQueueId(db) {
  if (!tableExists(db, 'relay_asks')) return { applied: false, columnsAdded: 0 };
  const present = new Set(db.prepare(`PRAGMA table_info(relay_asks)`).all().map((column) => column.name));
  if (present.has('queue_id')) return { applied: false, columnsAdded: 0 };
  db.exec(`ALTER TABLE relay_asks ADD COLUMN queue_id TEXT`);
  return { applied: true, columnsAdded: 1 };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateRelayAsksQueueId(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    // The given path, else the database in server/data (oar.db, else the
    // name before 0.9.20); never a new one.
    const dbPath = cliDbPath(process.argv[2], new URL('..', import.meta.url));
    const result = migrate(dbPath);
    console.log(`Migration 0037 on ${dbPath}`);
    console.log(result.applied ? `  relay asks: columns added ${result.columnsAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0037 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
