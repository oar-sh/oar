'use strict';

/**
 * Migration: options of relay event subscriptions.
 *
 * Columns on `relay_event_subscriptions` (all NULL = off, as before):
 *
 * - `digest_minutes`: the subscription's non-urgent events are held and
 *   delivered as one row every N minutes; `digest_last_at` is when its last
 *   such row went out (the next one is due N minutes after it).
 * - `quiet_hours_json`: `{ from, to, tz }`; non-urgent events in the window
 *   are held until it ends.
 * - `exclude_json`: session ids an "all" subscription leaves out.
 *
 * `relay_event_own_prompts`: the prompts a watcher sent through send or
 * create_session (`message_id` is the prompt's), and when it received the
 * finished reply (`received_at`): the turn_end of such a turn is not
 * delivered to it again. Rows go after a day.
 *
 * Held events are ordinary undelivered `relay_events` rows: they and the
 * timers rebuilt from them survive a restart without anything more here.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0019-relay-event-subscription-options.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

export const RELAY_EVENT_OPTION_COLUMNS = Object.freeze([
  ['digest_minutes', 'INTEGER'],
  ['digest_last_at', 'TEXT'],
  ['quiet_hours_json', 'TEXT'],
  ['exclude_json', 'TEXT'],
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function migrateRelayEventSubscriptionOptions(db) {
  if (!tableExists(db, 'relay_event_subscriptions')) {
    throw new Error('relay_event_subscriptions is missing (migration 0011 has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(relay_event_subscriptions)`).all().map((column) => column.name));
  let columnsAdded = 0;
  for (const [name, type] of RELAY_EVENT_OPTION_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE relay_event_subscriptions ADD COLUMN ${name} ${type}`);
    columnsAdded += 1;
  }
  let tablesAdded = 0;
  if (!tableExists(db, 'relay_event_own_prompts')) {
    db.exec(`
      CREATE TABLE relay_event_own_prompts (
        message_id              TEXT PRIMARY KEY,
        watcher_conversation_id TEXT NOT NULL,
        relay_id                TEXT NOT NULL DEFAULT 'self',
        session_id              TEXT NOT NULL,
        created_at              TEXT NOT NULL,
        received_at             TEXT
      )
    `);
    tablesAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_event_own_prompts_created
    ON relay_event_own_prompts(created_at)
  `);
  return { applied: columnsAdded > 0 || tablesAdded > 0, columnsAdded, tablesAdded };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateRelayEventSubscriptionOptions(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0019 on ${dbPath}`);
    console.log(result.applied
      ? `  relay event subscription options: columns added ${result.columnsAdded}, tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0019 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
