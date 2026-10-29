'use strict';

/**
 * Migration: relay event subscriptions across paired relays.
 *
 * The watching relay (it holds the watcher) and the watched relay (it holds
 * the sessions) both keep a row in `relay_event_subscriptions`:
 *
 * - On the watching relay `relay_id` is the paired relay's registry id,
 *   `remote_subscription_id` that relay's id for the subscription,
 *   `remote_meta_json` the watched sessions' titles, and `remote_sync` says
 *   that an end still has to reach the other relay ('unsubscribe').
 * - On the watched relay `subscriber_relay_id` is the watching relay's own
 *   id (as it states it), `subscriber_watcher_id` / `_title` name its
 *   watcher, `last_pull_at` is its last fetch and `dropped_count` the events
 *   not kept for it since then.
 *
 * `relay_event_links` (watching relay): per paired relay the cursor of the
 * events fetched there and the link's health, so a gap is noticed across
 * restarts.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0012-cross-relay-event-subscriptions.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

const SUBSCRIPTION_COLUMNS = Object.freeze([
  ['remote_subscription_id', 'TEXT'],
  ['remote_meta_json', 'TEXT'],
  ['remote_sync', 'TEXT'],
  ['subscriber_relay_id', 'TEXT'],
  ['subscriber_relay_name', 'TEXT'],
  ['subscriber_watcher_id', 'TEXT'],
  ['subscriber_watcher_title', 'TEXT'],
  ['last_pull_at', 'TEXT'],
  ['dropped_count', 'INTEGER NOT NULL DEFAULT 0'],
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function migrateCrossRelayEventSubscriptions(db) {
  if (!tableExists(db, 'relay_event_subscriptions')) {
    throw new Error('relay_event_subscriptions is missing (migration 0011 has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(relay_event_subscriptions)`).all().map((column) => column.name));
  let columnsAdded = 0;
  for (const [name, type] of SUBSCRIPTION_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE relay_event_subscriptions ADD COLUMN ${name} ${type}`);
    columnsAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_event_subscriptions_remote
    ON relay_event_subscriptions(relay_id, remote_subscription_id)
    WHERE remote_subscription_id IS NOT NULL
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_event_subscriptions_subscriber
    ON relay_event_subscriptions(subscriber_relay_id)
    WHERE subscriber_relay_id IS NOT NULL
  `);
  let tablesAdded = 0;
  if (!tableExists(db, 'relay_event_links')) {
    db.exec(`
      CREATE TABLE relay_event_links (
        relay_id      TEXT PRIMARY KEY,
        cursor        INTEGER NOT NULL DEFAULT 0,
        last_ok_at    TEXT,
        first_fail_at TEXT,
        lost_at       TEXT,
        last_error    TEXT
      )
    `);
    tablesAdded += 1;
  }
  return { applied: columnsAdded > 0 || tablesAdded > 0, columnsAdded, tablesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateCrossRelayEventSubscriptions(db);
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
    console.log(`Migration 0012 on ${dbPath}`);
    console.log(result.applied
      ? `  cross-relay event subscriptions: columns added ${result.columnsAdded}, tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0012 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
