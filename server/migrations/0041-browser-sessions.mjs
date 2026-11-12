'use strict';

/**
 * Migration: the browser_sessions table (agent auth, browser sessions).
 *
 * One row per signed-in browser. The browser's cookie `copilot_auth` holds
 * an `oars1_…` secret; the table keeps only its SHA-256 (`secret_hash`), so
 * the database never holds a usable credential. `id` ('bs_' + 12 random
 * base64url characters) is what the Security settings show and revoke by.
 * `device_id` is the client's `copilot_device_id`, the same value the push
 * subscriptions carry: revoking a session drops that device's push rows.
 *
 * `proof_hash` is the SHA-256 of the session's proof key: a second secret the
 * relay hands the page once, in the sign-in answer, and the page sends back
 * on every API request (`X-OAR-Session-Proof`). A cookie is sent to every
 * port of the host, the key is not (it lives in the origin's own storage),
 * so a page on another port that gets the cookie still is not signed in.
 * An empty value (a row made before the key) never matches: that browser
 * signs in again. The column came after the table was first made, so `up`
 * adds it to a table that lacks it (the services reach it through
 * browser-session-service.mjs only).
 *
 * `expires_at` slides (last seen + 30 days idle); `absolute_expires_at` does
 * not (created + 400 days, the browsers' own cookie cap). The service
 * (services/browser-session-service.mjs) deletes expired rows at boot and
 * hourly, and keeps at most 50.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores the table (its browsers sign in again).
 *
 * Usage: node server/migrations/0041-browser-sessions.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const BROWSER_SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS browser_sessions (
    id                  TEXT PRIMARY KEY,
    secret_hash         TEXT NOT NULL UNIQUE,
    label               TEXT NOT NULL DEFAULT '',
    user_agent          TEXT NOT NULL DEFAULT '',
    device_id           TEXT NOT NULL DEFAULT '',
    auth_method         TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    last_ip             TEXT NOT NULL DEFAULT '',
    expires_at          TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    proof_hash          TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_browser_sessions_device
    ON browser_sessions(device_id);
`;

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function indexExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

export function hasBrowserSessionsTable(db) {
  try {
    return tableExists(db, 'browser_sessions');
  } catch {
    return false;
  }
}

export function migrateBrowserSessions(db) {
  const hadTable = tableExists(db, 'browser_sessions');
  const hadIndex = indexExists(db, 'idx_browser_sessions_device');
  const hadProof = hadTable && columnExists(db, 'browser_sessions', 'proof_hash');
  if (hadTable && hadIndex && hadProof) return { applied: false, created: false };
  db.exec(BROWSER_SESSIONS_SCHEMA);
  // A table made before the proof key: its rows keep '' and never match.
  if (hadTable && !hadProof) db.exec(`ALTER TABLE browser_sessions ADD COLUMN proof_hash TEXT NOT NULL DEFAULT ''`);
  return { applied: true, created: !hadTable };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateBrowserSessions(db);
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
    console.log(`Migration 0041 on ${dbPath}`);
    console.log(result.applied ? `  browser sessions: ${result.created ? 'table created' : 'brought up to date'}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0041 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
