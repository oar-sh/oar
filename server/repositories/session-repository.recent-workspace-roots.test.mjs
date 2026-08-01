import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrate } from '../migrations/0002-recent-workspace-roots-path-key.mjs';
import { normalizeWorkspaceRootKey } from '../services/workspace-root-path-policy.mjs';

const SCHEMA = `
  CREATE TABLE recent_workspace_roots (
    path_key     TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
`;

const UPSERT = `
  INSERT INTO recent_workspace_roots (path_key, path, last_seen_at)
  VALUES (?, ?, ?)
  ON CONFLICT(path_key) DO UPDATE SET
    path = excluded.path,
    last_seen_at = excluded.last_seen_at
`;

const PRUNE = `
  DELETE FROM recent_workspace_roots
  WHERE path_key NOT IN (
    SELECT path_key FROM recent_workspace_roots ORDER BY last_seen_at DESC LIMIT ?
  )
`;

function newDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function remember(db, rootPath, lastSeenAt, platform) {
  db.prepare(UPSERT).run(normalizeWorkspaceRootKey(rootPath, platform), rootPath, lastSeenAt);
}

test('win32: casing variants collapse to one row and the newest casing wins', () => {
  const db = newDb();
  remember(db, 'C:\\Git\\Repo', '2026-01-01T00:00:00.000Z', 'win32');
  remember(db, 'c:\\git\\repo', '2026-01-02T00:00:00.000Z', 'win32');
  remember(db, 'C:\\git\\repo\\', '2026-01-03T00:00:00.000Z', 'win32');

  const rows = db.prepare(`SELECT path, last_seen_at FROM recent_workspace_roots`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'C:\\git\\repo\\');
  assert.equal(rows[0].last_seen_at, '2026-01-03T00:00:00.000Z');
  db.close();
});

test('posix: paths differing only by case stay distinct', () => {
  const db = newDb();
  remember(db, '/srv/A', '2026-01-01T00:00:00.000Z', 'linux');
  remember(db, '/srv/a', '2026-01-02T00:00:00.000Z', 'linux');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM recent_workspace_roots`).get().n, 2);
  db.close();
});

test('prune keeps the newest 12 distinct directories', () => {
  const db = newDb();
  for (let index = 0; index < 20; index += 1) {
    remember(db, `C:\\repo${index}`, `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, 'win32');
  }
  // Casing variants must not consume slots.
  remember(db, 'c:\\REPO19', '2026-01-01T00:00:59.000Z', 'win32');
  db.prepare(PRUNE).run(12);

  const rows = db.prepare(`SELECT path FROM recent_workspace_roots ORDER BY last_seen_at DESC`).all();
  assert.equal(rows.length, 12);
  assert.equal(rows[0].path, 'c:\\REPO19');
  db.close();
});

test('migration 0002 collapses legacy rows and is idempotent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-roots-'));
  const dbPath = path.join(tempDir, 'copilot.db');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE recent_workspace_roots (
      path         TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX idx_recent_workspace_roots_last_seen ON recent_workspace_roots(last_seen_at DESC);
  `);
  const insert = seed.prepare(`INSERT INTO recent_workspace_roots (path, last_seen_at) VALUES (?, ?)`);
  insert.run('C:\\Git\\Repo', '2026-01-01T00:00:00.000Z');
  insert.run('c:\\git\\repo', '2026-01-03T00:00:00.000Z');
  insert.run('C:\\GIT\\REPO', '2026-01-02T00:00:00.000Z');
  insert.run('C:\\other', '2026-01-04T00:00:00.000Z');
  seed.close();

  const first = migrate(dbPath, { platform: 'win32' });
  assert.equal(first.applied, true);
  assert.equal(first.rowsBefore, 4);
  assert.equal(first.rowsAfter, 2);

  const db = new Database(dbPath);
  const columns = new Set(db.prepare(`PRAGMA table_info(recent_workspace_roots)`).all().map((c) => c.name));
  assert.ok(columns.has('path_key'));
  const collapsed = db.prepare(
    `SELECT path, last_seen_at FROM recent_workspace_roots WHERE path_key = ?`,
  ).get('c:\\git\\repo');
  assert.equal(collapsed.path, 'c:\\git\\repo', 'the newest last_seen_at wins');
  assert.equal(collapsed.last_seen_at, '2026-01-03T00:00:00.000Z');
  db.close();

  const second = migrate(dbPath, { platform: 'win32' });
  assert.equal(second.applied, false);
  assert.match(second.reason, /already present/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('migration 0002 is a no-op when the table does not exist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-roots-empty-'));
  const dbPath = path.join(tempDir, 'copilot.db');
  new Database(dbPath).close();
  const result = migrate(dbPath);
  assert.equal(result.applied, false);
  assert.match(result.reason, /not found/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
