import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { migrate, migratePreviews, previewsTableProblem } from './0013-previews.mjs';
import { SCHEMA_SQL, applySchema } from '../db-schema.mjs';
import { createSqlitePreviewStore } from '../services/preview-store.mjs';

// The schema of a build before 0013: everything but the previews table.
const SCHEMA_WITHOUT_PREVIEWS = SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS previews \([^;]*\);/, '');

const hasTable = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const hasIndex = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'previews-0013-'));
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => [column.name, column.type, column.notnull, column.pk]);

const EXPECTED_COLUMNS = [
  'token', 'mode', 'conversation_id', 'label', 'target_host', 'target_port', 'root_dir',
  'created_at', 'last_hit_at', 'host_boot_id',
];

test('creates the previews table once and keeps its rows on a second run', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migratePreviews(db), { applied: true, tablesAdded: 1, compatible: true });
  assert.deepEqual(columns(db, 'previews').map(([name]) => name), EXPECTED_COLUMNS);
  db.prepare(`INSERT INTO previews (token, mode, label, root_dir, created_at) VALUES (?, 'static', 'site', '/home/dev/site', 1000)`)
    .run('a'.repeat(32));
  assert.deepEqual(migratePreviews(db), { applied: false, tablesAdded: 0, compatible: true });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM previews`).get().n, 1);
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_previews_conversation'`).get());
});

test('a fresh schema declares the same table as the migration', () => {
  const migrated = new Database(':memory:');
  migratePreviews(migrated);
  const fresh = new Database(':memory:');
  fresh.exec(SCHEMA_SQL);
  assert.deepEqual(columns(fresh, 'previews'), columns(migrated, 'previews'));
});

test('the schema boot applies it to an existing database without the table', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_WITHOUT_PREVIEWS);
  assert.equal(hasTable(db, 'previews'), false);
  applySchema(db);
  assert.deepEqual(columns(db, 'previews').map(([name]) => name), EXPECTED_COLUMNS);
  // The index is the migration's alone: it proves the migration ran.
  assert.equal(hasIndex(db, 'idx_previews_conversation'), true);
});

test('the command-line entry migrates an older database file and is idempotent', () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, 'relay.db');
    const old = new Database(dbPath);
    old.pragma('journal_mode = WAL');
    old.exec(SCHEMA_WITHOUT_PREVIEWS);
    old.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Old', '2026-01-01', '2026-01-01')`).run();
    // Another connection keeps the file open, as the running relay does.
    assert.deepEqual(migrate(dbPath), { applied: true, tablesAdded: 1, compatible: true });
    assert.equal(hasTable(old, 'previews'), true);
    assert.equal(hasIndex(old, 'idx_previews_conversation'), true);
    assert.equal(old.prepare(`SELECT COUNT(*) AS n FROM conversations`).get().n, 1);
    old.close();
    assert.deepEqual(migrate(dbPath), { applied: false, tablesAdded: 0, compatible: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command-line entry refuses a path with no database instead of creating one', () => {
  const dir = tempDir();
  try {
    const dbPath = path.join(dir, 'missing.db');
    assert.throws(() => migrate(dbPath), /no database at/);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a foreign previews table never stops the boot; previews then run without persistence', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_WITHOUT_PREVIEWS);
  db.exec(`CREATE TABLE previews (id INTEGER PRIMARY KEY, url TEXT NOT NULL)`);
  assert.doesNotThrow(() => applySchema(db));
  const result = migratePreviews(db);
  assert.equal(result.compatible, false);
  assert.match(result.problem, /lacks column\(s\) token, mode/);
  assert.equal(hasIndex(db, 'idx_previews_conversation'), false);

  const warnings = [];
  const store = createSqlitePreviewStore(db, { logger: { warn: (line) => warnings.push(line) } });
  assert.equal(store.available, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not persisted/);
  assert.deepEqual(store.list(), []);
  assert.equal(store.insert({ token: 'a'.repeat(32), mode: 'static', label: 'site', rootDir: '/home/dev/site', createdAt: 1 }), false);
});

test('a previews table with an extra required column is not compatible; an extra optional one is', () => {
  const required = new Database(':memory:');
  required.exec(`CREATE TABLE previews (token TEXT PRIMARY KEY, mode TEXT NOT NULL, conversation_id TEXT, label TEXT NOT NULL,
    target_host TEXT, target_port INTEGER, root_dir TEXT, created_at INTEGER NOT NULL, last_hit_at INTEGER, host_boot_id TEXT,
    owner TEXT NOT NULL)`);
  assert.match(previewsTableProblem(required), /required column\(s\) .*owner/);

  const optional = new Database(':memory:');
  migratePreviews(optional);
  optional.exec(`ALTER TABLE previews ADD COLUMN note TEXT`);
  assert.equal(previewsTableProblem(optional), '');
  assert.equal(createSqlitePreviewStore(optional, { logger: null }).available, true);
});
