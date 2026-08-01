'use strict';

/**
 * Migration: add a case-normalized dedupe key to recent_workspace_roots.
 *
 * The table's primary key used to be the raw `path`, which is case-sensitive.
 * On Windows that means "C:\Git\Repo" and "c:\git\repo" are two rows for one
 * directory: they burn through the 12-row cap and the UI then silently hides
 * the duplicates (the client dedupes case-insensitively). This adds
 *
 *   path_key TEXT PRIMARY KEY   -- normalizeWorkspaceRootKey(path)
 *   path     TEXT NOT NULL      -- most recently seen casing, for display
 *
 * and collapses existing rows, keeping the newest last_seen_at for each
 * directory. The grouping is done in JS, not SQL, because SQLite's LOWER() and
 * COLLATE NOCASE are ASCII-only and would also fold on POSIX, where paths
 * really are case-sensitive.
 *
 * Idempotent: re-running once path_key exists is a no-op.
 *
 * Usage: node server/migrations/0002-recent-workspace-roots-path-key.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { normalizeWorkspaceRootKey } from '../services/workspace-root-path-policy.mjs';

/**
 * Rebuild against an already-open database handle.
 * server-runtime.mjs calls this at startup so an existing database is upgraded
 * before any prepared statement references path_key; the CLI entry point below
 * wraps it for offline runs. Both paths therefore execute the same code.
 */
export function rebuildRecentWorkspaceRootsTable(db, { platform = process.platform } = {}) {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_workspace_roots'`)
    .get();
  if (!tableExists) {
    return { applied: false, reason: 'recent_workspace_roots table not found', rowsBefore: 0, rowsAfter: 0 };
  }
  const columns = new Set(
    db.prepare(`PRAGMA table_info(recent_workspace_roots)`).all().map((column) => String(column.name)),
  );
  if (columns.has('path_key')) {
    return { applied: false, reason: 'path_key already present', rowsBefore: 0, rowsAfter: 0 };
  }

  const rows = db.prepare(`SELECT path, last_seen_at FROM recent_workspace_roots`).all();
  const byKey = new Map();
  for (const row of rows) {
    const rawPath = String(row?.path || '').trim();
    if (!rawPath) continue;
    const key = normalizeWorkspaceRootKey(rawPath, platform);
    if (!key) continue;
    const lastSeenAt = String(row?.last_seen_at || '');
    const existing = byKey.get(key);
    // Newest last_seen_at wins, and with it the casing shown in the picker.
    if (!existing || lastSeenAt > existing.lastSeenAt) {
      byKey.set(key, { key, path: rawPath, lastSeenAt });
    }
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE recent_workspace_roots__new (
        path_key     TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO recent_workspace_roots__new (path_key, path, last_seen_at)
      VALUES (?, ?, ?)
    `);
    for (const entry of byKey.values()) insert.run(entry.key, entry.path, entry.lastSeenAt);
    db.exec(`DROP INDEX IF EXISTS idx_recent_workspace_roots_last_seen`);
    db.exec(`DROP TABLE recent_workspace_roots`);
    db.exec(`ALTER TABLE recent_workspace_roots__new RENAME TO recent_workspace_roots`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recent_workspace_roots_last_seen
        ON recent_workspace_roots(last_seen_at DESC)
    `);
  })();

  return { applied: true, rowsBefore: rows.length, rowsAfter: byKey.size };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath);
  try {
    return rebuildRecentWorkspaceRootsTable(db, options);
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
    console.log(`Migration 0002 on ${dbPath}`);
    if (result.applied) {
      console.log(`  rebuilt: ${result.rowsBefore} row(s) -> ${result.rowsAfter} distinct directory/ies`);
    } else {
      console.log(`  skipped: ${result.reason}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0002 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
