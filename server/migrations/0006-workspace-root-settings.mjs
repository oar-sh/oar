'use strict';

/**
 * Migration: per-folder settings (`workspace_root_settings`).
 *
 * The first setting a repo folder can carry is the commit attribution mode
 * of its Claude sessions (shared/claude-attribution.mjs): a repo that forbids
 * co-author trailers, or wants its own, overrides the provider setting for
 * every session that runs in it. Keyed like `recent_workspace_roots`
 * (`normalizeWorkspaceRootKey`), but its own table: the MRU list is pruned.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0006-workspace-root-settings.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function migrateWorkspaceRootSettings(db) {
  const existed = tableExists(db, 'workspace_root_settings');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_root_settings (
      path_key         TEXT PRIMARY KEY,
      path             TEXT NOT NULL,
      attribution_mode TEXT,
      updated_at       TEXT NOT NULL
    )
  `);
  return { applied: !existed, tableCreated: !existed };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateWorkspaceRootSettings(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0006 on ${dbPath}`);
    console.log(result.applied ? '  workspace_root_settings table created' : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0006 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
