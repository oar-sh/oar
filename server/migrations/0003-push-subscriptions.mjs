'use strict';

/**
 * Migration: add the push_subscriptions table for Web Push notifications.
 *
 * One row per subscribed browser installation. `endpoint` is unique because a
 * re-subscribe from the same browser must update in place, and `device_id` is
 * the durable per-device identity (localStorage `copilot_device_id`) that a
 * device keeps across subscription churn. `preferences_json` carries the whole
 * per-device notification preference set so it travels with the subscription.
 *
 * Idempotent: re-running once the table exists is a no-op. The main schema
 * block in server-runtime.mjs also has a CREATE TABLE IF NOT EXISTS for fresh
 * databases; this module exists so existing databases upgrade at startup and
 * so the migration can be run offline against a db file.
 *
 * Usage: node server/migrations/0003-push-subscriptions.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

export const PUSH_SUBSCRIPTIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id             TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL,
    device_label   TEXT,
    endpoint       TEXT NOT NULL UNIQUE,
    keys_json      TEXT NOT NULL,
    preferences_json TEXT NOT NULL,
    user_agent     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_success_at TEXT,
    last_error     TEXT,
    failure_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device
    ON push_subscriptions(device_id);
`;

/**
 * Ensure the table exists on an already-open database handle.
 * server-runtime.mjs calls this at startup; the CLI entry point below wraps it
 * for offline runs. Both paths execute the same code.
 */
export function ensurePushSubscriptionsTable(db) {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'`)
    .get();
  if (tableExists) {
    return { applied: false, reason: 'push_subscriptions already present' };
  }
  db.exec(PUSH_SUBSCRIPTIONS_SCHEMA);
  return { applied: true };
}

export function migrate(dbPath) {
  const db = new Database(dbPath);
  try {
    return ensurePushSubscriptionsTable(db);
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
    console.log(`Migration 0003 on ${dbPath}`);
    console.log(result.applied ? '  created push_subscriptions' : `  skipped: ${result.reason}`);
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0003 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
