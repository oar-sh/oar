'use strict';

/**
 * Migration: a queue row names the billing it runs on (the Claude billing
 * switch, services/claude-billing-switch-service.mjs).
 *
 * `queue.provider`: the provider the row was queued under, written at every
 * insert from the chat's `runtime_sessions.provider_type`. A Claude chat can
 * move between `claude` (the subscription) and `claude-api` (the saved API
 * key); the switch re-stamps the chat's rows that have not started, and every
 * requeue re-stamps to the chat's billing of that moment. The relay hands a
 * row only to a worker of that kind, so a turn never runs on a billing nobody
 * asked for. NULL (a row from before this column) means the chat's billing.
 *
 * Two triggers keep the stamp without every writer having to know it:
 * - `queue_provider_after_insert`: a row inserted without a provider (the
 *   send route, schedules, events, restart-resume, the board, the usage-limit
 *   follow-up) takes its chat's provider when the chat is a Claude or Claude
 *   API one. A writer that names one (a continuation: the kind of the worker
 *   that runs it) keeps it.
 * - `queue_provider_after_requeue`: a row going back from processing to
 *   pending or parked (the stale sweep, dead-worker recovery, a hand-back) is
 *   a new turn, and takes the chat's provider of that moment.
 *
 * The back-fill gives the unfinished rows of Claude and Claude API chats
 * (pending, parked, processing) their chat's provider. It touches only rows
 * without one, so it is idempotent; finished rows stay NULL.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0031-queue-provider.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const QUEUE_PROVIDER_COLUMN = 'provider';
export const QUEUE_PROVIDER_TRIGGERS = Object.freeze(['queue_provider_after_insert', 'queue_provider_after_requeue']);

// The chat's billing, when it is a Claude one: NULL for every other provider.
const chatClaudeBillingSql = (conversationIdSql) => `(
  SELECT LOWER(TRIM(rs.provider_type)) FROM runtime_sessions rs
  WHERE rs.conversation_id = ${conversationIdSql}
    AND LOWER(TRIM(rs.provider_type)) IN ('claude', 'claude-api')
)`;

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the relay from stamping rows: '' when nothing does. */
export function queueProviderProblem(db) {
  if (!tableExists(db, 'queue')) return 'no queue table';
  if (!columnNames(db, 'queue').has(QUEUE_PROVIDER_COLUMN)) return 'queue lacks provider';
  const triggers = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'queue'`).all().map((row) => row.name));
  const missing = QUEUE_PROVIDER_TRIGGERS.filter((name) => !triggers.has(name));
  if (missing.length) return `queue lacks the trigger ${missing.join(', ')}`;
  return '';
}

export function migrateQueueProvider(db) {
  if (!tableExists(db, 'queue')) return { applied: false, columnsAdded: 0, triggersAdded: 0, rowsFilled: 0 };
  // The triggers and the back-fill read provider_type: a table without it
  // waits for the schema boot to add it.
  if (!tableExists(db, 'runtime_sessions') || !columnNames(db, 'runtime_sessions').has('provider_type')) {
    return { applied: false, columnsAdded: 0, triggersAdded: 0, rowsFilled: 0 };
  }
  let columnsAdded = 0;
  if (!columnNames(db, 'queue').has(QUEUE_PROVIDER_COLUMN)) {
    db.exec(`ALTER TABLE queue ADD COLUMN ${QUEUE_PROVIDER_COLUMN} TEXT`);
    columnsAdded += 1;
  }
  const present = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'queue'`).all().map((row) => row.name));
  let triggersAdded = 0;
  if (!present.has('queue_provider_after_insert')) {
    db.exec(`
      CREATE TRIGGER queue_provider_after_insert
      AFTER INSERT ON queue
      WHEN NEW.provider IS NULL
      BEGIN
        UPDATE queue SET provider = ${chatClaudeBillingSql('NEW.conversation_id')} WHERE id = NEW.id;
      END
    `);
    triggersAdded += 1;
  }
  if (!present.has('queue_provider_after_requeue')) {
    db.exec(`
      CREATE TRIGGER queue_provider_after_requeue
      AFTER UPDATE OF status ON queue
      WHEN OLD.status = 'processing' AND NEW.status IN ('pending', 'parked')
      BEGIN
        UPDATE queue SET provider = COALESCE(${chatClaudeBillingSql('NEW.conversation_id')}, NEW.provider) WHERE id = NEW.id;
      END
    `);
    triggersAdded += 1;
  }
  const rowsFilled = db.prepare(`
    UPDATE queue
    SET provider = ${chatClaudeBillingSql('queue.conversation_id')}
    WHERE provider IS NULL
      AND status IN ('pending', 'parked', 'processing')
      AND ${chatClaudeBillingSql('queue.conversation_id')} IS NOT NULL
  `).run().changes;
  return { applied: columnsAdded > 0 || triggersAdded > 0 || rowsFilled > 0, columnsAdded, triggersAdded, rowsFilled };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateQueueProvider(db);
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
    console.log(`Migration 0031 on ${dbPath}`);
    console.log(result.applied
      ? `  queue provider: columns added ${result.columnsAdded}, triggers added ${result.triggersAdded}, rows filled ${result.rowsFilled}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0031 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
