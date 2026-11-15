'use strict';

/**
 * Migration: late replies (columns on 0019's `relay_event_own_prompts`).
 *
 * A prompt a conversation sent with send or create_session and whose reply
 * it was no longer waiting for is delivered to it later as a late reply
 * (services/relay-late-reply-service.mjs). The ledger row says where that
 * stands:
 *
 * - `late_state`: NULL while the row is open (owed a late reply), else
 *   `returned` (a wait gave the agent a final outcome), `delivered`, `ack`
 *   (an ack-only reply, riding along with the next event message),
 *   `target_gone`, `undeliverable` (the sender is gone), `gave_up` (7 days,
 *   or the pairing was removed), `before_upgrade`.
 * - `late_at`: when it got that state.
 * - `late_next_at`: when an open row is due for its next check.
 *
 * Rows from before this migration: a received reply is `returned`; a row
 * older than an hour is `before_upgrade`, which keeps today's behaviour (no
 * late reply, its turn_end still goes), so an upgrade floods nobody with old
 * replies. Only the last hour's sends can still get one.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores the columns.
 *
 * Usage: node server/migrations/0042-late-replies.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const LATE_REPLY_COLUMNS = Object.freeze([
  ['late_state', 'TEXT'],
  ['late_at', 'TEXT'],
  ['late_next_at', 'TEXT'],
]);

const BEFORE_UPGRADE_AGE_MS = 60 * 60_000;

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function migrateLateReplies(db, { now = Date.now() } = {}) {
  if (!tableExists(db, 'relay_event_own_prompts')) {
    throw new Error('relay_event_own_prompts is missing (migration 0019 has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(relay_event_own_prompts)`).all().map((column) => column.name));
  const missing = LATE_REPLY_COLUMNS.filter(([name]) => !present.has(name));
  let marked = 0;
  db.transaction(() => {
    for (const [name, type] of missing) db.exec(`ALTER TABLE relay_event_own_prompts ADD COLUMN ${name} ${type}`);
    // Only when the columns are new: from then on the service owns the state.
    if (missing.some(([name]) => name === 'late_state')) {
      const at = new Date(now).toISOString();
      marked += db.prepare(`UPDATE relay_event_own_prompts SET late_state = 'returned', late_at = ? WHERE received_at IS NOT NULL`).run(at).changes;
      marked += db.prepare(`
        UPDATE relay_event_own_prompts SET late_state = 'before_upgrade', late_at = ?
        WHERE late_state IS NULL AND created_at < ?
      `).run(at, new Date(now - BEFORE_UPGRADE_AGE_MS).toISOString()).changes;
      // The last hour's open rows are due at once.
      db.prepare(`UPDATE relay_event_own_prompts SET late_next_at = ? WHERE late_state IS NULL`).run(at);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relay_event_own_prompts_late
      ON relay_event_own_prompts(late_state, late_next_at)
    `);
  })();
  return { applied: missing.length > 0, columnsAdded: missing.length, marked };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateLateReplies(db);
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
    console.log(`Migration 0042 on ${dbPath}`);
    console.log(result.applied
      ? `  late replies: columns added ${result.columnsAdded}, earlier rows marked ${result.marked}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0042 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
