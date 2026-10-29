import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  DB_FILE_NAME,
  LEGACY_DB_FILE_NAME,
  STARTUP_SETTING_KEYS,
  STARTUP_TABLES,
  checkDatabaseFile,
  cliDbPath,
  defaultCliDbPath,
  holdsStartupOnly,
  renameWithRetry,
  resolveDatabaseFile,
  settleDatabaseFile,
  sideFiles,
} from './database-file.mjs';

const NOW = new Date('2026-11-03T09:15:00.000Z');
const STAMP = '2026-11-03T09-15-00-000Z';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oar-database-file-'));
}

// The production schema, and one conversation, message and setting changed
// at the times given (null: no row of that kind). `filler` puts a table first
// whose page `corrupt` can break without touching the stamped tables.
function writeDatabase(file, { marker = 'x', conversation = null, message = null, setting = null, filler = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    if (filler) {
      db.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT)');
      const insert = db.prepare('INSERT INTO filler (body) VALUES (?)');
      for (let i = 0; i < 400; i += 1) insert.run('x'.repeat(200));
    }
    applySchema(db);
    if (setting) db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('relay_name', ?, ?)").run(marker, setting);
    if (conversation || message) {
      const at = conversation || message;
      db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(`c-${marker}`, marker, at, conversation || at);
      if (message) db.prepare("INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', ?, ?)").run(`m-${marker}`, `c-${marker}`, marker, message);
    }
  } finally {
    db.close();
  }
}

// A database whose last change is only in its -wal: written through a
// connection that never checkpoints, and copied while it is open.
function writeHotWalDatabase(file, options, lateSetting) {
  const scratch = tempDir();
  try {
    const source = path.join(scratch, 'source.db');
    writeDatabase(source, options);
    const db = new Database(source);
    try {
      db.pragma('wal_autocheckpoint = 0');
      db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('late', 'in the wal', ?)").run(lateSetting);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(source, file);
      fs.copyFileSync(`${source}-wal`, `${file}-wal`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.ok(fs.statSync(`${file}-wal`).size > 0, 'the fixture has a hot -wal');
}

function corrupt(file) {
  const db = new Database(file);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'filler'").get().rootpage;
  const pageSize = db.pragma('page_size', { simple: true });
  db.close();
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(64, 0xa5), 0, 64, (root - 1) * pageSize + 8);
  fs.closeSync(fd);
}

function setting(file, key) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
  } finally {
    db.close();
  }
}

// Every file in a folder with its sha256: what "nothing changed" compares.
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'dir'];
  }));
}

function settle(dataDir, overrides = {}) {
  const logs = [];
  const result = settleDatabaseFile({
    dataDir,
    Database,
    now: () => NOW,
    sleep: () => {},
    logger: { log: (line) => logs.push(line) },
    ...overrides,
  });
  return { result, logs };
}

// The real Database for the copies, a stand-in for the original copilot.db:
// a real checkpoint would remove the side files a test puts there.
function noCheckpoint(dir) {
  return function Stub(file, options) {
    if (path.resolve(file) === path.resolve(copilot(dir))) return { pragma: () => [{ busy: 0, log: -1, checkpointed: -1 }], close() {} };
    return new Database(file, options);
  };
}

const oar = (dir) => path.join(dir, DB_FILE_NAME);
const copilot = (dir) => path.join(dir, LEGACY_DB_FILE_NAME);
const asideName = `${LEGACY_DB_FILE_NAME}.older-${STAMP}`;

// ─── The resolver ────────────────────────────────────────────────────────────

test('the names: oar.db for new databases, copilot.db before 0.9.20, each with its -wal and -shm', () => {
  assert.equal(DB_FILE_NAME, 'oar.db');
  assert.equal(LEGACY_DB_FILE_NAME, 'copilot.db');
  assert.deepEqual(sideFiles('oar.db'), ['oar.db', 'oar.db-wal', 'oar.db-shm']);
});

test('the resolver in each state, and it never creates or opens a file', () => {
  const dir = tempDir();
  try {
    const none = resolveDatabaseFile(dir);
    assert.deepEqual(
      { path: none.path, name: none.name, legacy: none.legacy, both: none.both, created: none.created },
      { path: oar(dir), name: 'oar.db', legacy: false, both: false, created: true },
    );
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing created');

    fs.writeFileSync(copilot(dir), '');
    const legacy = resolveDatabaseFile(dir);
    assert.deepEqual([legacy.path, legacy.legacy, legacy.both, legacy.created], [copilot(dir), true, false, false]);

    fs.writeFileSync(oar(dir), '');
    const both = resolveDatabaseFile(dir);
    assert.deepEqual([both.path, both.legacy, both.both, both.created], [oar(dir), false, true, false]);

    fs.rmSync(copilot(dir));
    const current = resolveDatabaseFile(dir);
    assert.deepEqual([current.path, current.legacy, current.both, current.created], [oar(dir), false, false, false]);
    assert.deepEqual(fs.readdirSync(dir), ['oar.db'], 'no -shm or -wal appeared');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing data folder reads as no database, and is not made', () => {
  const dir = path.join(tempDir(), 'not-there');
  const file = resolveDatabaseFile(dir);
  assert.equal(file.created, true);
  assert.equal(file.path, oar(dir));
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a -wal or -shm without its database does not count as one, and is reported, never touched', () => {
  const dir = tempDir();
  try {
    // A hand rename that missed the -wal: oar.db there, copilot.db-wal left.
    fs.writeFileSync(oar(dir), '');
    fs.writeFileSync(`${copilot(dir)}-wal`, 'left behind');
    const file = resolveDatabaseFile(dir);
    assert.equal(file.path, oar(dir));
    assert.equal(file.both, false);
    assert.deepEqual(file.orphans, [`${copilot(dir)}-wal`]);
    assert.equal(settle(dir).result.status, 'single');
    assert.equal(fs.readFileSync(`${copilot(dir)}-wal`, 'utf8'), 'left behind');

    // And the other way round: only side files of oar.db, no database at all.
    fs.rmSync(oar(dir));
    fs.writeFileSync(`${oar(dir)}-shm`, '');
    const none = resolveDatabaseFile(dir);
    assert.equal(none.created, true);
    assert.deepEqual(none.orphans.sort(), [`${copilot(dir)}-wal`, `${oar(dir)}-shm`].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database name that is a link to nothing is reported, not taken for no database', { skip: process.platform === 'win32' }, () => {
  const serverDir = tempDir();
  const dir = path.join(serverDir, 'data');
  try {
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(dir, 'gone', 'oar.db'), oar(dir));
    const file = resolveDatabaseFile(dir);
    assert.equal(file.created, false, 'never "create a new one" through the link');
    assert.deepEqual(file.dangling, [oar(dir)]);
    assert.throws(() => defaultCliDbPath(serverDir), /No database/);
    assert.equal(fs.existsSync(path.join(dir, 'gone')), false);
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

// ─── defaultCliDbPath ────────────────────────────────────────────────────────

test('defaultCliDbPath: oar.db, else copilot.db, else an error, and never a new file', () => {
  const serverDir = tempDir();
  const dataDir = path.join(serverDir, 'data');
  try {
    assert.throws(() => defaultCliDbPath(serverDir), (error) => {
      assert.match(error.message, /No database in .*data \(neither oar\.db nor copilot\.db\); pass the path/);
      return true;
    });
    assert.equal(fs.existsSync(dataDir), false);
    fs.mkdirSync(dataDir);
    assert.throws(() => defaultCliDbPath(serverDir), /No database/);
    assert.deepEqual(fs.readdirSync(dataDir), []);
    fs.writeFileSync(copilot(dataDir), '');
    assert.equal(defaultCliDbPath(serverDir), copilot(dataDir));
    fs.writeFileSync(oar(dataDir), '');
    assert.equal(defaultCliDbPath(serverDir), oar(dataDir), 'both there: oar.db, as the relay');
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

test('cliDbPath: a given path must be a database file; none given: the server folder\'s, as a path or a file: URL', () => {
  const serverDir = tempDir();
  const dataDir = path.join(serverDir, 'data');
  try {
    assert.throws(() => cliDbPath(path.join(serverDir, 'typo.db'), serverDir), /No database at .*typo\.db; a script never creates one\./);
    assert.throws(() => cliDbPath(serverDir, serverDir), /No database at/, 'a folder is no database');
    assert.throws(() => cliDbPath('', pathToFileURL(`${serverDir}${path.sep}`)), /No database in/);
    fs.mkdirSync(dataDir);
    fs.writeFileSync(oar(dataDir), '');
    assert.equal(cliDbPath(undefined, pathToFileURL(`${serverDir}${path.sep}`)), oar(dataDir));
    assert.equal(cliDbPath(oar(dataDir), '/home/dev/elsewhere'), oar(dataDir));
    assert.deepEqual(fs.readdirSync(serverDir).sort(), ['data']);
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

// ─── settleDatabaseFile: both there ──────────────────────────────────────────

test('one database or none: nothing is read or changed', () => {
  const dir = tempDir();
  try {
    let opened = 0;
    const Spy = function Spy(...args) { opened += 1; return new Database(...args); };
    assert.equal(settle(dir, { Database: Spy }).result.status, 'none');
    writeDatabase(copilot(dir), { setting: '2026-10-01T00:00:00.000Z' });
    const before = snapshot(dir);
    assert.equal(settle(dir, { Database: Spy }).result.status, 'single');
    assert.equal(opened, 0);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oar.db newer: copilot.db with its -wal and -shm is set aside as copilot.db.older-<time>, oar.db untouched', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { marker: 'current', conversation: '2026-11-01T00:00:00.000Z', message: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' });
    writeHotWalDatabase(copilot(dir), { marker: 'old', conversation: '2026-10-01T00:00:00.000Z', message: '2026-10-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' }, '2026-10-02T00:00:00.000Z');
    fs.writeFileSync(`${copilot(dir)}-shm`, Buffer.alloc(32768));
    const oarBefore = fs.readFileSync(oar(dir));
    const { result, logs } = settle(dir);
    assert.equal(result.status, 'set-aside');
    assert.equal(result.renamedTo, path.join(dir, asideName));
    assert.deepEqual(fs.readFileSync(oar(dir)), oarBefore);
    for (const name of sideFiles(LEGACY_DB_FILE_NAME)) assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} gone`);
    // Its -wal went into its main file before the move: the late row is there.
    assert.equal(setting(path.join(dir, asideName), 'late'), 'in the wal');
    assert.equal(resolveDatabaseFile(dir).orphans.length, 0, 'no -wal left without its database');
    assert.equal(logs.filter((line) => line.includes('set it aside')).length, 1);
    assert.match(logs.at(-1), /^\[data\] .*copilot\.db is not newer than .*oar\.db: set it aside as .*copilot\.db\.older-2026-11-03T09-15-00-000Z; the relay runs on .*oar\.db\.$/);
    assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.database-file-check-')), false, 'no copies left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same latest changes, two identical files, or a copilot.db without a single stamp: set aside', () => {
  for (const variant of ['same', 'identical', 'schema-only', 'zero-bytes', 'neither-has-stamps']) {
    const dir = tempDir();
    try {
      const at = '2026-10-01T00:00:00.000Z';
      if (variant === 'neither-has-stamps') writeDatabase(oar(dir));
      else writeDatabase(oar(dir), { marker: 'current', conversation: at, message: at, setting: at });
      if (variant === 'same') writeDatabase(copilot(dir), { marker: 'other', conversation: at, message: at, setting: at });
      if (variant === 'identical') fs.copyFileSync(oar(dir), copilot(dir));
      if (variant === 'schema-only' || variant === 'neither-has-stamps') writeDatabase(copilot(dir));
      if (variant === 'zero-bytes') fs.writeFileSync(copilot(dir), '');
      const { result } = settle(dir);
      assert.equal(result.status, 'set-aside', variant);
      assert.ok(fs.existsSync(path.join(dir, asideName)), variant);
      assert.equal(fs.existsSync(copilot(dir)), false, variant);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('copilot.db newer, each newer somewhere, or its newest rows only in its -wal: no start, every byte as it was, no -shm made', () => {
  const variants = {
    'copilot newer': () => ({
      oarOptions: { marker: 'a', conversation: '2026-10-01T00:00:00.000Z', message: '2026-10-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' },
      copilotOptions: { marker: 'b', conversation: '2026-11-01T00:00:00.000Z', message: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' },
      pattern: /copilot\.db has changes newer than .*oar\.db\. To go on with oar\.db, move copilot\.db, copilot\.db-wal, copilot\.db-shm into a folder of your own; to go on with copilot\.db, move oar\.db, oar\.db-wal, oar\.db-shm\. Then start again\./,
    }),
    'each newer somewhere': () => ({
      oarOptions: { marker: 'a', conversation: '2026-11-01T00:00:00.000Z', message: '2026-11-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' },
      copilotOptions: { marker: 'b', conversation: '2026-10-01T00:00:00.000Z', message: '2026-10-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' },
      pattern: /each of .*copilot\.db and .*oar\.db has changes newer than the other's\./,
    }),
    'newest only in the -wal': () => ({
      oarOptions: { marker: 'a', conversation: '2026-10-05T00:00:00.000Z', message: '2026-10-05T00:00:00.000Z', setting: '2026-10-05T00:00:00.000Z' },
      copilotOptions: { marker: 'b', conversation: '2026-10-01T00:00:00.000Z', message: '2026-10-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' },
      hotWal: '2026-11-01T00:00:00.000Z',
      pattern: /each of .*has changes newer than the other's/,
    }),
  };
  for (const [name, make] of Object.entries(variants)) {
    const dir = tempDir();
    try {
      const { oarOptions, copilotOptions, hotWal, pattern } = make();
      writeDatabase(oar(dir), oarOptions);
      if (hotWal) writeHotWalDatabase(copilot(dir), copilotOptions, hotWal);
      else writeDatabase(copilot(dir), copilotOptions);
      const before = snapshot(dir);
      const { result } = settle(dir);
      assert.equal(result.status, 'refused', name);
      assert.match(result.error, /^\[data\] Not starting: /, name);
      assert.match(result.error, pattern, name);
      assert.match(result.error, /Both .*copilot\.db and .*oar\.db are there; nothing was changed in either\.$/, name);
      assert.deepEqual(snapshot(dir), before, `${name}: the same files with the same bytes, no -shm or -wal made`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a 0-byte oar.db beside a copilot.db with data: copilot.db is newer, so no start (the rule as planned)', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(oar(dir), '');
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' });
    assert.equal(settle(dir).result.status, 'refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// What a start of 0.9.19 on an empty folder leaves (seen on a real start):
// no conversation or message, but the push keys at boot, relay_last_exit at
// stop, the model catalog and the restart orchestrator's row. Its times are
// newer than oar.db's last ones; it is set aside all the same ("Downgrade
// and rollback": nothing was done on the old version).
function writeStartupOnlyDatabase(file, { extraKey = false, pushSubscription = false } = {}) {
  writeDatabase(file);
  const db = new Database(file);
  try {
    const insert = db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)');
    insert.run('push_vapid_public_key', 'k', '2026-11-02T10:00:00.000Z');
    insert.run('push_vapid_private_key', 'k', '2026-11-02T10:00:00.000Z');
    insert.run('relay_last_exit', '{}', '2026-11-02T10:05:00.000Z');
    if (extraKey) insert.run('relay_name', 'renamed on the old version', '2026-11-02T10:01:00.000Z');
    db.prepare("INSERT INTO model_selector_state (id, source, updated_at) VALUES (1, 'bootstrap', '2026-11-02T10:00:00.000Z')").run();
    db.prepare("INSERT INTO model_variants (variant_id, base_model_id, provider, label, updated_at) VALUES ('m', 'm', 'github', 'M', '2026-11-02T10:00:00.000Z')").run();
    db.exec("CREATE TABLE IF NOT EXISTS relay_restart_orchestrator (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL DEFAULT 'idle', updated_at TEXT)");
    db.prepare("INSERT INTO relay_restart_orchestrator (id, updated_at) VALUES (1, '2026-11-02T10:00:00.000Z')").run();
    if (pushSubscription) {
      const columns = db.prepare('PRAGMA table_info(push_subscriptions)').all().filter((column) => column.notnull && column.dflt_value === null);
      db.prepare(`INSERT INTO push_subscriptions (${columns.map((column) => column.name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((column) => (/INT/i.test(column.type) ? 1 : `${column.name}-value`)));
    }
  } finally {
    db.close();
  }
}

const usedOar = (dir) => writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z', message: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' });

test('(a) a copilot.db only an earlier version\'s start wrote, beside a used oar.db: set aside, said so', () => {
  const dir = tempDir();
  try {
    usedOar(dir);
    writeStartupOnlyDatabase(copilot(dir));
    const { result, logs } = settle(dir);
    assert.equal(result.status, 'set-aside');
    assert.equal(result.startupOnly, true);
    assert.equal(result.renamedTo, path.join(dir, asideName));
    assert.equal(fs.existsSync(copilot(dir)), false);
    assert.match(logs.at(-1), /^\[data\] .*copilot\.db holds start-up settings only and no chats \(an earlier version started on this folder\): set it aside as .*copilot\.db\.older-2026-11-03T09-15-00-000Z; the relay runs on .*oar\.db\.$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('(b) the same plus one more setting, (c) plus one push subscription: refused, both named, nothing changed', () => {
  for (const variant of [{ extraKey: true }, { pushSubscription: true }]) {
    const dir = tempDir();
    try {
      usedOar(dir);
      writeStartupOnlyDatabase(copilot(dir), variant);
      const before = snapshot(dir);
      const { result } = settle(dir);
      assert.equal(result.status, 'refused', JSON.stringify(variant));
      assert.match(result.error, /has changes newer than|each of .* has changes newer/);
      assert.match(result.error, /Both .*copilot\.db and .*oar\.db are there/);
      assert.deepEqual(snapshot(dir), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('(d) a copilot.db with only start-up settings and no oar.db: nothing changes, the relay runs on it', () => {
  const dir = tempDir();
  try {
    writeStartupOnlyDatabase(copilot(dir));
    const before = snapshot(dir);
    assert.equal(settle(dir).result.status, 'single');
    assert.deepEqual(snapshot(dir), before);
    assert.equal(resolveDatabaseFile(dir).path, copilot(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the start-up allowlist is the keys and tables a real start writes, and nothing a user makes', () => {
  assert.deepEqual([...STARTUP_SETTING_KEYS].sort(), ['push_vapid_private_key', 'push_vapid_public_key', 'relay_last_exit']);
  assert.deepEqual([...STARTUP_TABLES].sort(), ['model_selector_state', 'model_variants', 'relay_restart_orchestrator']);
  const dir = tempDir();
  try {
    writeStartupOnlyDatabase(copilot(dir));
    assert.equal(holdsStartupOnly(Database, copilot(dir)), true);
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    assert.equal(holdsStartupOnly(Database, oar(dir)), false, 'a conversation');
    fs.writeFileSync(path.join(dir, 'junk.db'), crypto.randomBytes(4096));
    assert.equal(holdsStartupOnly(Database, path.join(dir, 'junk.db')), false, 'unreadable says no');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('either database failing its check, or not a database at all: no start, nothing changed', () => {
  for (const variant of ['copilot broken', 'oar broken', 'not a database']) {
    const dir = tempDir();
    try {
      writeDatabase(oar(dir), { filler: variant === 'oar broken', conversation: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' });
      if (variant === 'not a database') fs.writeFileSync(copilot(dir), crypto.randomBytes(8192));
      else writeDatabase(copilot(dir), { filler: variant === 'copilot broken', conversation: '2026-10-01T00:00:00.000Z' });
      if (variant === 'copilot broken') corrupt(copilot(dir));
      if (variant === 'oar broken') corrupt(oar(dir));
      const before = snapshot(dir);
      const { result } = settle(dir);
      assert.equal(result.status, 'refused', variant);
      if (variant === 'not a database') assert.match(result.error, /could not be copied and read \(.*not a database/);
      else assert.match(result.error, new RegExp(`${variant === 'oar broken' ? 'oar' : 'copilot'}\\.db failed its check`), variant);
      assert.deepEqual(snapshot(dir), before, variant);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a copy that fails (a full disk, or a file Windows holds open): no start, the copies are gone, nothing changed', () => {
  for (const code of ['ENOSPC', 'EBUSY']) {
    const dir = tempDir();
    try {
      writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
      writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
      const before = snapshot(dir);
      let copies = 0;
      const fsImpl = {
        ...fs,
        copyFileSync: (from, to, mode) => {
          copies += 1;
          if (copies === 2) throw Object.assign(new Error(`${code}: copy failed`), { code });
          return fs.copyFileSync(from, to, mode);
        },
      };
      const { result } = settle(dir, { fsImpl });
      assert.equal(result.status, 'refused', code);
      assert.match(result.error, new RegExp(`could not be copied and read \\(${code}`));
      assert.deepEqual(snapshot(dir), before, `${code}: the copies are removed, the files as they were`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('copies a kill left are removed at the next start; the earlier-database service never sees them as its own', () => {
  const dir = tempDir();
  try {
    const left = path.join(dir, '.database-file-check-2026-11-01T00-00-00-000Z', 'copilot.db');
    fs.mkdirSync(left, { recursive: true });
    fs.writeFileSync(path.join(left, 'copilot.db'), 'copy');
    settle(dir);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('while both are read, a progress file names the pid for `oar start`; it is gone afterwards', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
    const progressFile = path.join(dir, 'earlier-database-progress.json');
    const seen = [];
    const Spy = function Spy(...args) {
      if (fs.existsSync(progressFile)) seen.push(JSON.parse(fs.readFileSync(progressFile, 'utf8')));
      return new Database(...args);
    };
    settle(dir, { Database: Spy, progressFile, pid: 4242 });
    assert.ok(seen.length >= 2);
    assert.equal(seen[0].pid, 4242);
    assert.equal(seen[0].task, 'compare');
    assert.equal(seen[0].from, copilot(dir));
    assert.equal(fs.existsSync(progressFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file held for a moment (EBUSY twice) is set aside after the retries', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
    let failures = 0;
    const sleeps = [];
    const fsImpl = {
      ...fs,
      renameSync: (from, to) => {
        if (failures < 2) { failures += 1; throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); }
        return fs.renameSync(from, to);
      },
    };
    const { result } = settle(dir, { fsImpl, sleep: (ms) => sleeps.push(ms) });
    assert.equal(result.status, 'set-aside');
    assert.deepEqual(sleeps, [50, 100]);
    assert.ok(fs.existsSync(path.join(dir, asideName)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the main file moves last, and a rename that keeps failing puts back what moved: no start', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
    // Side files a reader left (the checkpoint takes the -wal's rows, a -shm
    // may stay): each one moves before the main file.
    const order = [];
    const rename = (from, to) => {
      order.push(path.basename(from));
      if (path.basename(from) === LEGACY_DB_FILE_NAME) throw Object.assign(new Error('EBUSY: still held'), { code: 'EBUSY' });
      fs.renameSync(from, to);
    };
    fs.writeFileSync(`${copilot(dir)}-shm`, Buffer.alloc(32768));
    const { result } = settle(dir, { rename, Database: noCheckpoint(dir) });
    assert.equal(result.status, 'refused');
    assert.match(result.error, /could not be set aside \(EBUSY: still held\); it is back as it was\./);
    assert.equal(order[0], 'copilot.db-shm');
    assert.equal(order[1], 'copilot.db', 'main last');
    assert.equal(order[2], `${asideName}-shm`, 'then the -shm back');
    assert.ok(fs.existsSync(`${copilot(dir)}-shm`));
    assert.ok(fs.existsSync(copilot(dir)));
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.older-')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rename back that fails too says where each file is now', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
    fs.writeFileSync(`${copilot(dir)}-shm`, Buffer.alloc(32768));
    let calls = 0;
    const rename = (from, to) => {
      calls += 1;
      if (calls === 1) return fs.renameSync(from, to);
      throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' });
    };
    const { result } = settle(dir, { rename, Database: noCheckpoint(dir) });
    assert.equal(result.status, 'refused');
    assert.match(result.error, /moving it back failed too: .*copilot\.db-shm is now .*copilot\.db\.older-2026-11-03T09-15-00-000Z-shm\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a kill between the renames (the -shm moved, the main file not): the next start sets the rest aside, no stray -wal', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(dir, 'copilot.db.older-2026-11-02T00-00-00-000Z-shm'), Buffer.alloc(32768));
    const { result } = settle(dir);
    assert.equal(result.status, 'set-aside');
    const file = resolveDatabaseFile(dir);
    assert.equal(file.both, false);
    assert.deepEqual(file.orphans, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a set-aside name already taken gets -2: nothing is ever renamed over a file', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    writeDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(dir, `${asideName}-wal`), 'an earlier one');
    const targets = [];
    const rename = (from, to) => {
      assert.equal(fs.existsSync(to), false, `${to} is free`);
      targets.push(path.basename(to));
      fs.renameSync(from, to);
    };
    const { result } = settle(dir, { rename });
    assert.equal(result.status, 'set-aside');
    assert.equal(result.renamedTo, path.join(dir, `${asideName}-2`));
    assert.equal(fs.readFileSync(path.join(dir, `${asideName}-wal`), 'utf8'), 'an earlier one');
    assert.ok(targets.includes(`${asideName}-2`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renameWithRetry waits out EBUSY, EPERM and EACCES, and gives up on anything else at once', () => {
  const sleeps = [];
  let tries = 0;
  const fsImpl = { renameSync: () => { tries += 1; if (tries < 3) throw Object.assign(new Error('x'), { code: tries === 1 ? 'EPERM' : 'EACCES' }); } };
  renameWithRetry(fsImpl, 'a', 'b', (ms) => sleeps.push(ms));
  assert.deepEqual(sleeps, [50, 100]);
  assert.throws(() => renameWithRetry({ renameSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }, 'a', 'b', () => {}), /gone/);
});

test('a copilot.db with a hot -wal: the checkpoint empties it before the move, no <aside>-wal stays', () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' });
    writeHotWalDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' }, '2026-10-02T00:00:00.000Z');
    const { result } = settle(dir);
    assert.equal(result.status, 'set-aside');
    assert.equal(fs.existsSync(`${result.renamedTo}-wal`), false, 'no -wal beside the set-aside file');
    assert.equal(setting(result.renamedTo, 'late'), 'in the wal', 'its rows are in the main file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkpoint another reader blocks (busy) sets nothing aside: no start, nothing renamed', () => {
  const dir = tempDir();
  const reader = { db: null };
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' });
    writeHotWalDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z' }, '2026-10-02T00:00:00.000Z');
    // A reader in an open transaction keeps the -wal from being emptied.
    reader.db = new Database(copilot(dir), { readonly: true });
    reader.db.prepare('BEGIN').run();
    reader.db.prepare('SELECT COUNT(*) FROM app_settings').get();
    const { result } = settle(dir);
    assert.equal(result.status, 'refused');
    assert.match(result.error, /could not be set aside \(another program has it open, so its -wal could not be emptied\); it is back as it was\./);
    assert.ok(fs.existsSync(copilot(dir)));
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.older-')), false);
  } finally {
    try { reader.db?.prepare('COMMIT').run(); reader.db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The checker's scenario: a relay on oar.db stopped uncleanly, oar.db
// renamed back to copilot.db for a downgrade without its -wal, work done on
// copilot.db; a later rename forward would replay the stray -wal.
test('an oar.db-wal or -shm without oar.db stops the start, whatever name the relay runs on; other strays are warned about', () => {
  const dir = tempDir();
  try {
    writeDatabase(copilot(dir), { conversation: '2026-11-01T00:00:00.000Z' });
    fs.writeFileSync(`${oar(dir)}-wal`, 'frames of an earlier oar.db');
    const check = checkDatabaseFile(resolveDatabaseFile(dir));
    assert.match(check.refusal, /^\[data\] Not starting: .*oar\.db-wal is there without .*oar\.db\. A database renamed to oar\.db \(or a new one\) would take those pages in, and the rows written since would be lost\. Move it into a folder of your own \(it is not part of .*copilot\.db\), then start again\.$/);
    fs.rmSync(`${oar(dir)}-wal`);
    fs.writeFileSync(`${oar(dir)}-shm`, '');
    assert.match(checkDatabaseFile(resolveDatabaseFile(dir)).refusal, /oar\.db-shm is there without/);
    fs.rmSync(`${oar(dir)}-shm`);

    fs.writeFileSync(`${copilot(dir)}-wal`, 'x');
    fs.renameSync(copilot(dir), oar(dir));
    const warned = checkDatabaseFile(resolveDatabaseFile(dir));
    assert.equal(warned.refusal, null);
    assert.match(warned.warnings[0], /copilot\.db-wal is there without its database; it is not used\. .*move it away before anything is renamed to that name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database name that is a link to nothing stops the start', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  try {
    fs.symlinkSync(path.join(dir, 'gone.db'), oar(dir));
    assert.match(checkDatabaseFile(resolveDatabaseFile(dir)).refusal, /is a link to a file that is not there/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real kill during the set-aside (after its first rename): no -wal is left over, no row lost, the next start goes on', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  try {
    writeDatabase(oar(dir), { conversation: '2026-11-01T00:00:00.000Z', setting: '2026-11-01T00:00:00.000Z' });
    writeHotWalDatabase(copilot(dir), { conversation: '2026-10-01T00:00:00.000Z', setting: '2026-10-01T00:00:00.000Z' }, '2026-10-02T00:00:00.000Z');
    // The relay process, killed (SIGKILL) right after its first rename. The
    // checkpoint before it left nothing but the main file to move.
    const script = `
      import fs from 'node:fs';
      import Database from ${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))};
      import { settleDatabaseFile } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'database-file.mjs')).href)};
      settleDatabaseFile({ dataDir: ${JSON.stringify(dir)}, Database, logger: {}, rename: (from, to) => {
        fs.renameSync(from, to);
        process.kill(process.pid, 'SIGKILL');
      } });
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const names = fs.readdirSync(dir);
    assert.deepEqual(names.filter((name) => name.startsWith('copilot.db')).filter((name) => /-(wal|shm)$/.test(name)), [], 'no side file left anywhere');
    const aside = names.find((name) => /^copilot\.db\.older-[0-9T-]+Z$/.test(name));
    assert.ok(aside, names.join(', '));
    assert.equal(setting(path.join(dir, aside), 'late'), 'in the wal', 'its -wal rows went into the main file first');
    assert.equal(settle(dir).result.status, 'single', 'the next start runs on oar.db');
    assert.deepEqual(resolveDatabaseFile(dir).orphans, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
