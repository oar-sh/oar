import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { BROWSER_SESSIONS_SCHEMA, hasBrowserSessionsTable, migrateBrowserSessions } from './0041-browser-sessions.mjs';
import { applySchema, SCHEMA_SQL } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => `${column.name}:${column.type}:${column.notnull}`).sort();
const indexes = (db, table) => db.prepare(`PRAGMA index_list(${table})`).all().map((index) => index.name).sort();

function before0041(db) {
  applySchema(db);
  db.exec('DROP TABLE IF EXISTS browser_sessions');
  return db;
}

test('0041 creates browser_sessions once (idempotent); rows survive a second run', () => {
  const db = before0041(new Database(':memory:'));
  assert.equal(hasBrowserSessionsTable(db), false);
  assert.deepEqual(migrateBrowserSessions(db), { applied: true, created: true });
  db.prepare(`INSERT INTO browser_sessions (id, secret_hash, auth_method, created_at, last_seen_at, expires_at, absolute_expires_at)
    VALUES ('bs_a', 'h1', 'token', 't', 't', 't', 't')`).run();
  assert.deepEqual(migrateBrowserSessions(db), { applied: false, created: false });
  assert.deepEqual(migrateBrowserSessions(db), { applied: false, created: false });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 1);
  const row = db.prepare('SELECT * FROM browser_sessions').get();
  assert.deepEqual({ label: row.label, ua: row.user_agent, device: row.device_id, ip: row.last_ip }, { label: '', ua: '', device: '', ip: '' });
});

test('the schema: columns, the unique secret hash, the device index', () => {
  const db = before0041(new Database(':memory:'));
  migrateBrowserSessions(db);
  assert.deepEqual(columns(db, 'browser_sessions'), [
    'absolute_expires_at:TEXT:1',
    'auth_method:TEXT:1',
    'created_at:TEXT:1',
    'device_id:TEXT:1',
    'expires_at:TEXT:1',
    'id:TEXT:0',
    'label:TEXT:1',
    'last_ip:TEXT:1',
    'last_seen_at:TEXT:1',
    'proof_hash:TEXT:1',
    'secret_hash:TEXT:1',
    'user_agent:TEXT:1',
  ]);
  assert.ok(indexes(db, 'browser_sessions').includes('idx_browser_sessions_device'));
  const insert = db.prepare(`INSERT INTO browser_sessions (id, secret_hash, auth_method, created_at, last_seen_at, expires_at, absolute_expires_at)
    VALUES (?, ?, 'token', 't', 't', 't', 't')`);
  insert.run('bs_a', 'same');
  assert.throws(() => insert.run('bs_b', 'same'), /UNIQUE/);
});

test('a missing index alone is added back', () => {
  const db = before0041(new Database(':memory:'));
  migrateBrowserSessions(db);
  db.exec('DROP INDEX idx_browser_sessions_device');
  assert.deepEqual(migrateBrowserSessions(db), { applied: true, created: false });
  assert.ok(indexes(db, 'browser_sessions').includes('idx_browser_sessions_device'));
});

test('a table made before the proof key gets the column; its rows keep an empty proof hash; a second run changes nothing', () => {
  const db = before0041(new Database(':memory:'));
  db.exec(`CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '', auth_method TEXT NOT NULL,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_ip TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_browser_sessions_device ON browser_sessions(device_id);`);
  db.prepare(`INSERT INTO browser_sessions (id, secret_hash, auth_method, created_at, last_seen_at, expires_at, absolute_expires_at)
    VALUES ('bs_old', 'h1', 'token', 't', 't', 't', 't')`).run();
  assert.deepEqual(migrateBrowserSessions(db), { applied: true, created: false });
  assert.ok(columns(db, 'browser_sessions').includes('proof_hash:TEXT:1'));
  assert.equal(db.prepare(`SELECT proof_hash FROM browser_sessions WHERE id = 'bs_old'`).get().proof_hash, '');
  assert.deepEqual(migrateBrowserSessions(db), { applied: false, created: false });
});

// 0041 as it first shipped, before the proof key: kept verbatim, so a
// database made by that version is what the next test boots.
const ORIGINAL_0041_SCHEMA = `
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
    absolute_expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_browser_sessions_device
    ON browser_sessions(device_id);
`;

test('a database with the original 0041 table (no proof_hash) gains the column at boot and keeps its rows; a second boot changes nothing', () => {
  const db = before0041(new Database(':memory:'));
  db.exec(ORIGINAL_0041_SCHEMA);
  assert.equal(columns(db, 'browser_sessions').some((column) => column.startsWith('proof_hash:')), false);
  const insert = db.prepare(`INSERT INTO browser_sessions
    (id, secret_hash, label, user_agent, device_id, auth_method, created_at, last_seen_at, last_ip, expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('bs_one', 'hash-one', 'Laptop', 'UA one', 'dev-1', 'token', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '198.51.100.7', '2026-12-02T00:00:00.000Z', '2027-12-06T00:00:00.000Z');
  insert.run('bs_two', 'hash-two', '', '', '', 'upgrade', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z', '', '2026-12-03T00:00:00.000Z', '2027-12-08T00:00:00.000Z');
  const before = db.prepare('SELECT * FROM browser_sessions ORDER BY id').all();

  applySchema(db);

  const fresh = new Database(':memory:');
  applySchema(fresh);
  assert.deepEqual(columns(db, 'browser_sessions'), columns(fresh, 'browser_sessions'));
  assert.ok(indexes(db, 'browser_sessions').includes('idx_browser_sessions_device'));
  const after = db.prepare('SELECT * FROM browser_sessions ORDER BY id').all();
  assert.deepEqual(after, before.map((row) => ({ ...row, proof_hash: '' })), 'every row kept as it was; none has a key (it signs in again)');
  applySchema(db);
  assert.deepEqual(db.prepare('SELECT * FROM browser_sessions ORDER BY id').all(), after);
  assert.deepEqual(migrateBrowserSessions(db), { applied: false, created: false });
});

test('boot runs it: a fresh and an upgraded database end the same; SCHEMA_SQL leaves it to 0041', () => {
  assert.doesNotMatch(SCHEMA_SQL, /browser_sessions/);
  const fresh = new Database(':memory:');
  applySchema(fresh);
  assert.equal(hasBrowserSessionsTable(fresh), true);
  const upgraded = before0041(new Database(':memory:'));
  applySchema(upgraded);
  assert.deepEqual(columns(upgraded, 'browser_sessions'), columns(fresh, 'browser_sessions'));
  assert.match(BROWSER_SESSIONS_SCHEMA, /CREATE TABLE IF NOT EXISTS browser_sessions/);
});

test('the CLI entry point migrates a database file', async () => {
  const { migrate } = await import('./0041-browser-sessions.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-0041-'));
  try {
    const file = path.join(dir, 'fixture.db');
    before0041(new Database(file)).close();
    assert.deepEqual(migrate(file), { applied: true, created: true });
    assert.deepEqual(migrate(file), { applied: false, created: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
