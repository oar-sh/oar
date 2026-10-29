'use strict';

/**
 * Migration: relay event subscriptions.
 *
 * 1. `relay_event_subscriptions` — what a conversation (the watcher) asked
 *    the relay to tell it about: which sessions (listed ids or all), which
 *    events, one-shot or not. A row stays after it ended (`ended_at`), so
 *    list_subscriptions can say why one is gone. `heartbeat_minutes` (NULL =
 *    off) and `last_heartbeat_at` drive the heartbeat while work runs.
 * 2. `relay_events` — events recorded for a watcher and not yet written into
 *    its conversation (`delivered_at` NULL), then the ones that were, for a
 *    couple of hours. The relay rebuilds its flush timers from the
 *    undelivered rows at boot.
 *
 * `relay_id` names the relay a watched session lives on: 'self' today, a
 * paired relay's registry id once events cross relays.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0011-relay-event-subscriptions.mjs [path/to/oar.db]
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

export function migrateRelayEventSubscriptions(db) {
  let tablesAdded = 0;
  if (!tableExists(db, 'relay_event_subscriptions')) {
    db.exec(`
      CREATE TABLE relay_event_subscriptions (
        id                      TEXT PRIMARY KEY,
        watcher_conversation_id TEXT NOT NULL,
        relay_id                TEXT NOT NULL DEFAULT 'self',
        scope                   TEXT NOT NULL,
        session_ids_json        TEXT,
        events_json             TEXT NOT NULL,
        once                    INTEGER NOT NULL DEFAULT 0,
        match                   TEXT,
        stalled_minutes         INTEGER NOT NULL DEFAULT 15,
        heartbeat_minutes       INTEGER,
        last_heartbeat_at       TEXT,
        created_at              TEXT NOT NULL,
        ended_at                TEXT,
        end_reason              TEXT,
        fired_count             INTEGER NOT NULL DEFAULT 0,
        last_event_at           TEXT
      )
    `);
    tablesAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_event_subscriptions_watcher
    ON relay_event_subscriptions(watcher_conversation_id)
    WHERE ended_at IS NULL
  `);
  if (!tableExists(db, 'relay_events')) {
    db.exec(`
      CREATE TABLE relay_events (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id         TEXT NOT NULL,
        watcher_conversation_id TEXT NOT NULL,
        relay_id                TEXT NOT NULL DEFAULT 'self',
        session_id              TEXT NOT NULL,
        type                    TEXT NOT NULL,
        urgent                  INTEGER NOT NULL DEFAULT 0,
        payload_json            TEXT NOT NULL,
        created_at              TEXT NOT NULL,
        delivered_at            TEXT,
        message_id              TEXT
      )
    `);
    tablesAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_events_undelivered
    ON relay_events(watcher_conversation_id, created_at)
    WHERE delivered_at IS NULL
  `);
  // Delivered events are pruned by age (relay-event-service pruneDelivered).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relay_events_delivered
    ON relay_events(delivered_at)
    WHERE delivered_at IS NOT NULL
  `);
  return { applied: tablesAdded > 0, tablesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateRelayEventSubscriptions(db);
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
    console.log(`Migration 0011 on ${dbPath}`);
    console.log(result.applied
      ? `  relay event subscriptions: tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0011 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
