'use strict';

/**
 * Migration: the GitHub Copilot switch for relays that were in use before it.
 *
 * Copilot became a provider with a switch (app_settings `copilot_enabled`,
 * services/copilot-settings-service.mjs). A relay that was in use keeps
 * Copilot on: this writes `copilot_enabled = 'true'` when the database holds
 * a conversation, or an app_settings key that a bare start does not write
 * on its own (BARE_START_SETTING_KEYS). A new database is left unset: the
 * first read with the CLI detector decides it once.
 *
 * Only the keys a start writes by itself are left out of the test, so a new
 * relay's second boot, after its first one wrote them, is still new. A key
 * already there is never changed.
 *
 * Idempotent; safe to run on every boot. No schema change. Rolling back
 * needs no data change: older code ignores the key.
 *
 * Usage: node server/migrations/0043-copilot-enabled.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';
import { STARTUP_SETTING_KEYS } from '../services/database-file.mjs';
import { COPILOT_ENABLED_SETTING_KEY } from '../services/copilot-settings-service.mjs';

// The keys a bare start writes with no one's action: the start-up allowlist
// (which has copilot_enabled itself), the version that last ran
// (db-backup-service.mjs DB_LAST_RUN_SETTING_KEY), the agent SDK store's
// status (agent-sdk-store.mjs, store installs on Windows), and this relay's
// id, which a page load can mint (remote-relay-registry-service.mjs).
export const BARE_START_SETTING_KEYS = Object.freeze([
  ...STARTUP_SETTING_KEYS,
  'db_last_run',
  'agent_sdk_status',
  'relay_instance_id',
]);

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function migrateCopilotEnabled(db, { now = Date.now() } = {}) {
  if (!tableExists(db, 'app_settings')) throw new Error('app_settings is missing');
  if (db.prepare(`SELECT 1 FROM app_settings WHERE key = ?`).get(COPILOT_ENABLED_SETTING_KEY)) {
    return { applied: false, reason: 'set' };
  }
  const hasConversation = tableExists(db, 'conversations')
    && !!db.prepare(`SELECT 1 FROM conversations LIMIT 1`).get();
  const bareStart = new Set(BARE_START_SETTING_KEYS);
  const hasOwnSetting = db.prepare(`SELECT key FROM app_settings`).all().some((row) => !bareStart.has(row.key));
  if (!hasConversation && !hasOwnSetting) return { applied: false, reason: 'new' };
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'true', ?) ON CONFLICT(key) DO NOTHING`)
    .run(COPILOT_ENABLED_SETTING_KEY, new Date(now).toISOString());
  return { applied: true, reason: hasConversation ? 'conversations' : 'settings' };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateCopilotEnabled(db);
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
    console.log(`Migration 0043 on ${dbPath}`);
    console.log(result.applied
      ? `  Copilot switch: on (the database was in use: ${result.reason})`
      : `  skipped: ${result.reason === 'set' ? 'the switch is set already' : 'a new database, left to the first read'}`);
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0043 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
