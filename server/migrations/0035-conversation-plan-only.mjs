'use strict';

/**
 * Migration: a conversation that is plan-only.
 *
 * `plan_only` is 1 when the session is locked in plan mode: agents cannot
 * switch it to another mode (a relay_tool send or update_session naming one
 * is refused), while the owner still can. NULL or 0 means not plan-only. It
 * is set only when asked: relay_tool create_session or update_session with
 * `planOnly`, or the owner's toggle. Plan mode alone never sets it.
 *
 * Also the index `idx_queue_conversation_status` on queue(conversation_id,
 * status, timestamp), which the queue claim's plan-boundary hold reads.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores the column and the lock with it.
 *
 * Usage: node server/migrations/0035-conversation-plan-only.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const QUEUE_CONVERSATION_STATUS_INDEX = 'idx_queue_conversation_status';

function indexExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name);
}

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function migrateConversationPlanOnly(db) {
  if (!tableExists(db, 'conversations')) {
    throw new Error('conversations is missing (the base schema has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(conversations)`).all().map((column) => column.name));
  let columnsAdded = 0;
  if (!present.has('plan_only')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN plan_only INTEGER`);
    columnsAdded = 1;
  }
  // The queue claim's plan-boundary hold looks up one conversation's pending
  // and processing rows in send order (message-repository.mjs,
  // planBoundaryHoldSql); without this index it walked every conversation's.
  let indexesAdded = 0;
  if (tableExists(db, 'queue') && !indexExists(db, QUEUE_CONVERSATION_STATUS_INDEX)) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${QUEUE_CONVERSATION_STATUS_INDEX} ON queue(conversation_id, status, timestamp)`);
    indexesAdded = 1;
  }
  return { applied: columnsAdded + indexesAdded > 0, columnsAdded, indexesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateConversationPlanOnly(db);
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
    console.log(`Migration 0035 on ${dbPath}`);
    console.log(result.applied
      ? `  plan only: columns added ${result.columnsAdded}, indexes added ${result.indexesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0035 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
