'use strict';

/**
 * Migration: a runtime session remembers its last billing switch (the Claude
 * billing switch, services/claude-billing-switch-service.mjs).
 *
 * `runtime_sessions` gains two columns:
 * - `billing_switched_at`: when the chat last moved between `claude` (the
 *   subscription) and `claude-api` (the saved API key); NULL for a chat that
 *   never did. A worker started before the switch existed reports no kind, and
 *   on a chat with this set the relay cannot assume the kind from
 *   `provider_type`: it replaces that worker once, when it is idle. A chat
 *   never switched has had one billing, which also settles whose turns its
 *   older messages are.
 * - `billing_switched_by`: who asked: `user` (the toggle), `agent` (an
 *   agent's `send` with a provider) or `usage-limit` (the button on the
 *   usage-limit note).
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0032-runtime-session-billing-switch.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

// Added to runtime_sessions, with their DDL.
export const RUNTIME_SESSION_BILLING_SWITCH_COLUMNS = Object.freeze([
  ['billing_switched_at', 'TEXT'],
  ['billing_switched_by', 'TEXT'],
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the switch from recording itself: '' when nothing does. */
export function runtimeSessionBillingSwitchProblem(db) {
  if (!tableExists(db, 'runtime_sessions')) return 'no runtime_sessions table';
  const present = columnNames(db, 'runtime_sessions');
  const missing = RUNTIME_SESSION_BILLING_SWITCH_COLUMNS.map(([name]) => name).filter((name) => !present.has(name));
  if (missing.length) return `runtime_sessions lacks ${missing.join(', ')}`;
  return '';
}

export function migrateRuntimeSessionBillingSwitch(db) {
  if (!tableExists(db, 'runtime_sessions')) return { applied: false, columnsAdded: 0 };
  let columnsAdded = 0;
  const present = columnNames(db, 'runtime_sessions');
  for (const [name, ddl] of RUNTIME_SESSION_BILLING_SWITCH_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN ${name} ${ddl}`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateRuntimeSessionBillingSwitch(db);
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
    console.log(`Migration 0032 on ${dbPath}`);
    console.log(result.applied
      ? `  runtime session billing switch: columns added ${result.columnsAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0032 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
