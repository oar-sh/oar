import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  BACKUP_MANIFEST_FILE,
  BACKUP_NAME_RE,
  BACKUP_PROGRESS_FILE,
  BACKUP_WAIT_FILE,
  DB_LAST_RUN_SETTING_KEY,
  backupHolderMayRun,
  backupDatabase,
  backupName,
  backupStamp,
  checkBackupSpace,
  configWarnings,
  describeBackups,
  describeNextBackup,
  listBackupDir,
  maybeBackupBeforeStart,
  normalizeKeep,
  readManifest,
  resolveBackupDir,
  rotateBackups,
  sanitizeReason,
  writeBackup,
  writeManifest,
} from './db-backup-service.mjs';

const NOW = new Date('2026-11-03T09:15:00.000Z');
const COMMIT = '1512900aaaabbbbccccddddeeeeffff000011112';
const OTHER_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const quiet = { log() {}, warn() {} };
// A disk with room: the real one (a small /tmp, say) may not pass the check.
const roomy = { ...fs, statfsSync: () => ({ bavail: 1e12, bsize: 1, blocks: 1e12 }) };

function tempDir(prefix = 'oar-db-backup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// An npm-style layout in a temp folder: state root, data folder, a database.
function makeInstall({ rows = 3 } = {}) {
  const root = tempDir();
  const install = {
    root,
    layout: { checkout: false, root: path.join(root, 'state') },
    serverDir: path.join(root, 'pkg', 'server'),
    dataDir: path.join(root, 'state', 'data'),
    backupDir: path.join(root, 'state', 'backups'),
    // Retries only as extra safety on Windows: tests close their databases
    // and wait for their child processes first.
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
  fs.mkdirSync(install.dataDir, { recursive: true });
  install.dbPath = path.join(install.dataDir, 'oar.db');
  const db = new Database(install.dbPath);
  db.pragma('journal_mode = WAL');
  applySchema(db);
  const insert = db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < rows; i += 1) insert.run(`c${i}`, `conversation ${i}`, NOW.toISOString(), NOW.toISOString());
  install.db = db;
  return install;
}

function lastRun(db) {
  const value = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DB_LAST_RUN_SETTING_KEY)?.value;
  return value ? JSON.parse(value) : null;
}

function setLastRun(db, value) {
  db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(DB_LAST_RUN_SETTING_KEY, JSON.stringify(value), NOW.toISOString());
}

function start(install, overrides = {}) {
  return maybeBackupBeforeStart({
    db: install.db,
    Database,
    dbPath: install.dbPath,
    dataDir: install.dataDir,
    layout: install.layout,
    serverDir: install.serverDir,
    config: {},
    runningVersion: '0.9.20',
    now: () => NOW,
    logger: quiet,
    sleep: () => {},
    fsImpl: roomy,
    ...overrides,
  });
}

const backupsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const conversationsIn = (file) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n; } finally { db.close(); }
};

// ─── Names ───────────────────────────────────────────────────────────────────

test('the name: oar-<version>-<UTC stamp>-<reason>.db, and only such names match', () => {
  assert.equal(backupStamp(new Date('2026-11-03T09:15:00.123Z')), '20261103-091500');
  assert.equal(backupName({ version: '0.9.20', at: NOW, reason: 'pre-update' }), 'oar-0.9.20-20261103-091500-pre-update.db');
  assert.equal(backupName({ version: '0.9.20', at: NOW, reason: 'pre-update-1512900' }), 'oar-0.9.20-20261103-091500-pre-update-1512900.db');
  for (const name of [
    'oar-0.9.20-20261103-091500-pre-update.db',
    'oar-0.9.20-beta.1-20261103-091500-manual.db',
    'oar-0.9.20-rc-2-20261103-091500-manual-2.db',
  ]) assert.match(name, BACKUP_NAME_RE, name);
  for (const name of [
    'oar-pre-update-2026-10-01.db', 'oar-pre-x.db', 'copilot-pre-0.9.18.db', 'main-0.9.19-20261020.db', 'oar.db',
    'oar-0.9.20-20261103-091500-manual.db.partial', 'oar-0.9.20-20261103-091500-manual.db-wal', 'MIGRATION.md',
    'copilot.db.older-2026-11-03T09-15-00-000Z',
  ]) assert.doesNotMatch(name, BACKUP_NAME_RE, name);
});

test('a reason is cut down to [a-z0-9-]{1,40}; nothing left is manual', () => {
  assert.equal(sanitizeReason('Pre Rename!'), 'pre-rename');
  assert.equal(sanitizeReason('  --a__b--  '), 'a-b');
  assert.equal(sanitizeReason('x'.repeat(39) + '-yyyy'), 'x'.repeat(39));
  assert.equal(sanitizeReason('ÄÖÜ'), 'manual');
  assert.equal(sanitizeReason(''), 'manual');
  assert.equal(sanitizeReason(undefined), 'manual');
});

test('keep: a whole number of at least 1; anything else is the default 2, said with the key\'s name', () => {
  assert.deepEqual([0, -1, 1.5, 3, '4', 'x', undefined, null].map(normalizeKeep), [2, 2, 2, 3, 2, 2, 2, 2]);
  assert.deepEqual(configWarnings({ dbBackups: { keep: 0, enabled: 'no' } }), [
    '[config] dbBackups.keep must be a whole number of at least 1 (it is 0); using 2.',
    '[config] dbBackups.enabled must be true or false (it is "no"); using true.',
  ]);
  assert.deepEqual(configWarnings({ dbBackups: { keep: 3, enabled: false } }), []);
  assert.deepEqual(configWarnings({}), []);
  assert.match(configWarnings({ dbBackups: 'yes' })[0], /dbBackups must be an object/);
});

test('a version with build metadata goes into the name and counts as the same version', async () => {
  assert.match('oar-0.9.20+build.5-20261103-091500-manual.db', BACKUP_NAME_RE);
  const install = makeInstall();
  try {
    setLastRun(install.db, { version: '0.9.20+build.5', commit: null, at: 'x' });
    assert.equal((await start(install, { runningVersion: '0.9.20+build.5' })).status, 'same');
    assert.equal((await start(install, { runningVersion: '0.9.21' })).file, 'oar-0.9.20+build.5-20261103-091500-pre-update.db');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

// ─── The folder ──────────────────────────────────────────────────────────────

test('the folder: the state root\'s backups (npm), server/backups (checkout), or an absolute dbBackups.dir', () => {
  const install = makeInstall();
  try {
    assert.equal(resolveBackupDir({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, config: {} }).dir, install.backupDir);
    assert.equal(resolveBackupDir({ layout: { checkout: true }, serverDir: install.serverDir, dataDir: path.join(install.serverDir, 'data'), config: {} }).dir, path.join(install.serverDir, 'backups'));
    const own = path.join(install.root, 'mine');
    assert.equal(resolveBackupDir({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, config: { dbBackups: { dir: own } } }).dir, own);
    const relative = resolveBackupDir({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, config: { dbBackups: { dir: 'backups' } } });
    assert.equal(relative.status, 'failed');
    assert.match(relative.reason, /dbBackups\.dir in config\.json must be an absolute path \(it is "backups"\)/);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a folder with a DO_NOT_TOUCH file, or the data folder itself, is never written to; inside the data folder is warned about', () => {
  const install = makeInstall();
  try {
    const guarded = path.join(install.root, 'server', 'data', 'backup');
    fs.mkdirSync(guarded, { recursive: true });
    fs.writeFileSync(path.join(guarded, 'DO_NOT_TOUCH.md'), 'mine');
    const refused = resolveBackupDir({ layout: install.layout, dataDir: install.dataDir, config: { dbBackups: { dir: guarded } } });
    assert.equal(refused.status, 'skipped');
    assert.match(refused.reason, /DO_NOT_TOUCH\.md guards .*backup: nothing is written there/);
    // A folder below a guarded one is guarded too.
    const below = resolveBackupDir({ layout: install.layout, dataDir: install.dataDir, config: { dbBackups: { dir: path.join(guarded, 'sub') } } });
    assert.equal(below.status, 'skipped');
    assert.equal(fs.existsSync(path.join(guarded, 'sub')), false, 'nothing made inside it');
    const same = resolveBackupDir({ layout: install.layout, dataDir: install.dataDir, config: { dbBackups: { dir: install.dataDir } } });
    assert.equal(same.status, 'skipped');
    assert.match(same.reason, /is the data folder itself/);
    const inside = resolveBackupDir({ layout: install.layout, dataDir: install.dataDir, config: { dbBackups: { dir: path.join(install.dataDir, 'bk') } } });
    assert.equal(inside.dir, path.join(install.dataDir, 'bk'));
    assert.match(inside.warnings[0], /is inside the data folder/);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a link to the data folder is the data folder: compared by real path', { skip: process.platform === 'win32' }, () => {
  const install = makeInstall();
  try {
    const link = path.join(install.root, 'link-to-data');
    fs.symlinkSync(install.dataDir, link);
    assert.equal(resolveBackupDir({ layout: install.layout, dataDir: install.dataDir, config: { dbBackups: { dir: link } } }).status, 'skipped');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('space: free − the database ≥ max(1 GiB, 5 % of the disk); unknown goes ahead', () => {
  const GIB = 1024 ** 3;
  const statfs = (free, total) => ({ ...fs, statfsSync: () => ({ bavail: free, bsize: 1, blocks: total }) });
  assert.equal(checkBackupSpace({ dir: os.tmpdir(), dbBytes: GIB, fsImpl: statfs(2 * GIB, 10 * GIB) }).ok, true, 'exactly 1 GiB left');
  assert.equal(checkBackupSpace({ dir: os.tmpdir(), dbBytes: GIB, fsImpl: statfs(2 * GIB - 1, 10 * GIB) }).ok, false);
  assert.equal(checkBackupSpace({ dir: os.tmpdir(), dbBytes: GIB, fsImpl: statfs(5 * GIB, 100 * GIB) }).ok, false, '5 % of a large disk');
  assert.equal(checkBackupSpace({ dir: os.tmpdir(), dbBytes: GIB, fsImpl: statfs(6 * GIB, 100 * GIB) }).ok, true);
  const unknown = checkBackupSpace({ dir: os.tmpdir(), dbBytes: GIB, fsImpl: { ...fs, statfsSync: undefined } });
  assert.deepEqual([unknown.ok, unknown.unknown], [true, true]);
  // A folder not made yet: its nearest parent's disk.
  let asked = null;
  checkBackupSpace({ dir: path.join(os.tmpdir(), 'not', 'there'), dbBytes: 0, fsImpl: { ...fs, statfsSync: (dir) => { asked = dir; return { bavail: 1, bsize: 1, blocks: 1 }; } } });
  assert.equal(asked, os.tmpdir());
});

// ─── Writing ─────────────────────────────────────────────────────────────────

test('a backup is one checked file: no -wal or -shm beside it, mode 600, its size measured after DELETE', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    const written = await writeBackup({ source: install.db, Database, dir: install.backupDir, name: 'oar-0.9.19-20261103-091500-pre-update.db' });
    assert.equal(written.ok, true);
    assert.deepEqual(backupsIn(install.backupDir), ['oar-0.9.19-20261103-091500-pre-update.db']);
    const file = path.join(install.backupDir, written.file);
    assert.equal(written.bytes, fs.statSync(file).size);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // host-platform: the real chmod; Windows files have no such mode
    const check = new Database(file, { readonly: true, fileMustExist: true });
    try {
      assert.equal(check.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(check.pragma('journal_mode', { simple: true }), 'delete');
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 3);
    } finally {
      check.close();
    }
    assert.deepEqual(backupsIn(install.backupDir), [written.file], 'opening it read-only leaves nothing either');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a copy that fails its check, or a rename that fails (EXDEV), leaves nothing behind, its side files neither', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    const Failing = function Failing(file, options) {
      const db = new Database(file, options);
      const pragma = db.pragma.bind(db);
      db.pragma = (text, opts) => (String(text).startsWith('quick_check') ? '*** in database main ***\nPage 7: btree broken' : pragma(text, opts));
      return db;
    };
    const failed = await writeBackup({ source: install.db, Database: Failing, dir: install.backupDir, name: 'oar-0.9.19-20261103-091500-x.db' });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /the copy failed its check \(\*\*\* in database main \*\*\* Page 7: btree broken\)/);
    assert.deepEqual(backupsIn(install.backupDir), []);

    // The .partial is written in the backup folder itself: the final name
    // is never taken across disks.
    const opened = [];
    const exdev = await writeBackup({
      source: install.db, Database, dir: install.backupDir, name: 'oar-0.9.19-20261103-091500-x.db',
      fsImpl: { ...fs, openSync: (file, ...rest) => { opened.push(file); return fs.openSync(file, ...rest); } },
      link: () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); },
    });
    assert.equal(exdev.ok, false);
    assert.match(exdev.reason, /EXDEV/);
    assert.equal(path.dirname(opened[0]), install.backupDir);
    assert.match(path.basename(opened[0]), /\.db\.partial$/);
    assert.deepEqual(backupsIn(install.backupDir), []);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a name taken (the same second, another relay in the folder) gets -2, -3; nothing is written over', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    const name = 'oar-0.9.19-20261103-091500-pre-update.db';
    fs.writeFileSync(path.join(install.backupDir, name), 'another relay\'s');
    fs.writeFileSync(path.join(install.backupDir, 'oar-0.9.19-20261103-091500-pre-update-2.db.partial'), 'being written');
    const written = await writeBackup({ source: install.db, Database, dir: install.backupDir, name });
    assert.equal(written.file, 'oar-0.9.19-20261103-091500-pre-update-3.db');
    assert.equal(fs.readFileSync(path.join(install.backupDir, name), 'utf8'), 'another relay\'s');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a backup finishes beside another process committing all the time, in one step after the first', { timeout: 120_000 }, async (t) => {
  const install = makeInstall({ rows: 0 });
  const writerScript = path.join(install.root, 'writer.cjs');
  let writer = null;
  let writerExited = Promise.resolve();
  // Whatever happens (a failure, a hang, the time limit), the writer dies.
  const killWriter = () => { try { writer?.kill('SIGKILL'); } catch {} };
  // The folder goes only once the writer has exited: on Windows a killed
  // process holds its files until then.
  t.after(async () => {
    killWriter();
    await writerExited;
    install.db.close();
    install.cleanup();
  });
  const insert = install.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)');
  // About 300 pages: a step-by-step copy (100 pages a step) takes several
  // steps, the one-step copy one. Small, so disk latency does not count.
  install.db.transaction(() => { for (let i = 0; i < 3000; i += 1) insert.run(`bulk-${i}`, 'x'.repeat(400), NOW.toISOString(), NOW.toISOString()); })();
  fs.writeFileSync(writerScript, `
    const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
    const db = new Database(${JSON.stringify(install.dbPath)});
    db.pragma('busy_timeout = 5000');
    // No fsync per commit, and a steady pace (one commit every 3 ms): neither
    // the disk nor the CPU sets how often it writes.
    db.pragma('synchronous = OFF');
    const insert = db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'w', 'x', 'x')");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let i = 0;
    // Commits until it is killed: the backup has to finish beside it.
    for (;;) {
      insert.run('w-' + process.pid + '-' + (i++));
      if (i === 1 || i % 10 === 0) process.stdout.write('n ' + i + '\\n');
      Atomics.wait(pause, 0, 0, 3);
    }
  `);
  writer = spawn(process.execPath, [writerScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  writerExited = new Promise((resolve) => writer.once('exit', resolve));
  const watchdog = setTimeout(killWriter, 90_000);
  watchdog.unref();
  let output = '';
  // Started once it has committed; it goes on until it is killed.
  await new Promise((resolve, reject) => {
    writer.stdout.on('data', (chunk) => { output += chunk; if (/n \d+/.test(output)) resolve(); });
    writer.once('exit', (code) => reject(new Error(`the writer ended (${code}) before it committed`)));
  });
  const before = output.length;
  fs.mkdirSync(install.backupDir);
  // A separate read-only connection as the source, as `oar backup` has.
  const source = new Database(install.dbPath, { readonly: true });
  const steps = [];
  const counted = { backup: (dest, options) => source.backup(dest, { progress: (info) => { steps.push({ ...info }); return options.progress(info); } }) };
  const written = await writeBackup({ source: counted, Database, dir: install.backupDir, name: 'oar-0.9.20-20261103-091500-manual.db' });
  source.close();
  clearTimeout(watchdog);
  assert.equal(written.ok, true, written.reason);
  for (let waited = 0; output.length <= before && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(output.length > before, 'the writer still commits after the backup');
  // A step-by-step copy reports pages left part way; the one-step copy never
  // does (a busy step or a restart copies nothing).
  const partWay = steps.filter((step) => step.remainingPages > 0 && step.remainingPages < step.totalPages);
  assert.ok(steps.length >= 1);
  // Large enough that a step-by-step copy (100 pages a step) is several steps.
  assert.ok(steps[0].totalPages > 100, `${steps[0].totalPages} pages`);
  assert.deepEqual(partWay, [], 'all pages in the step after the first: no step-by-step copy');
  assert.ok(conversationsIn(path.join(install.backupDir, written.file)) >= 3000);
});

// ─── Rotation ────────────────────────────────────────────────────────────────

// A manifest entry and its file, as a backup of this relay leaves them.
function ownBackup(dir, manifest, file, { seq, bytes = 10, quickCheck = 'ok', entryDir = dir } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), Buffer.alloc(bytes));
  manifest.backups.push({ file, dir: entryDir, version: '0.9.19', reason: 'pre-update', at: NOW.toISOString(), bytes, quickCheck, seq });
  manifest.seq = Math.max(manifest.seq, seq);
}

test('rotation keeps the N newest of its own, by the manifest\'s order (a clock gone back changes nothing), never this run\'s', () => {
  const dir = tempDir();
  try {
    const manifest = { seq: 0, backups: [], lastResult: null, pending: null };
    // Stamps out of order (a clock that went back): the order is the seq.
    ownBackup(dir, manifest, 'oar-0.9.17-20261105-000000-pre-update.db', { seq: 1 });
    ownBackup(dir, manifest, 'oar-0.9.18-20261101-000000-pre-update.db', { seq: 2 });
    ownBackup(dir, manifest, 'oar-0.9.19-20261020-000000-pre-update.db', { seq: 3 });
    const { rotated } = rotateBackups({ manifest, dir, keep: 2, keepFile: 'oar-0.9.19-20261020-000000-pre-update.db', logger: quiet });
    assert.deepEqual(rotated, ['oar-0.9.17-20261105-000000-pre-update.db']);
    assert.deepEqual(backupsIn(dir), ['oar-0.9.18-20261101-000000-pre-update.db', 'oar-0.9.19-20261020-000000-pre-update.db']);
    assert.deepEqual(manifest.backups.map((entry) => entry.seq), [2, 3]);
    // keep 1: only this run's stays, even with a lower seq given.
    rotateBackups({ manifest, dir, keep: 1, keepFile: 'oar-0.9.18-20261101-000000-pre-update.db', logger: quiet });
    assert.deepEqual(backupsIn(dir), ['oar-0.9.18-20261101-000000-pre-update.db']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation never deletes what it did not write: not listed, not the pattern, elsewhere, unchecked, changed in size, a link', () => {
  const dir = tempDir();
  const elsewhere = tempDir();
  try {
    const manifest = { seq: 0, backups: [], lastResult: null, pending: null };
    for (const name of ['oar-pre-x.db', 'copilot-pre-0.9.18.db', 'main-0.9.19-20261020.db', 'MIGRATION.md', 'oar-0.9.10-20260101-000000-pre-update.db']) {
      fs.writeFileSync(path.join(dir, name), 'not ours');
    }
    fs.mkdirSync(path.join(dir, '2026-10-20T12-00-00-000Z'));
    ownBackup(dir, manifest, 'oar-pre-y.db', { seq: 1 });
    manifest.backups.push({ file: '../escape.db', dir, quickCheck: 'ok', bytes: 0, seq: 2 });
    ownBackup(dir, manifest, 'oar-0.9.11-20260101-000000-pre-update.db', { seq: 3, quickCheck: 'failed' });
    ownBackup(dir, manifest, 'oar-0.9.12-20260101-000000-pre-update.db', { seq: 4 });
    fs.appendFileSync(path.join(dir, 'oar-0.9.12-20260101-000000-pre-update.db'), 'changed');
    ownBackup(elsewhere, manifest, 'oar-0.9.13-20260101-000000-pre-update.db', { seq: 5 });
    if (process.platform !== 'win32') { // host-platform: a real symlink; Windows needs a privilege for one
      fs.writeFileSync(path.join(elsewhere, 'target.db'), Buffer.alloc(10));
      fs.symlinkSync(path.join(elsewhere, 'target.db'), path.join(dir, 'oar-0.9.14-20260101-000000-pre-update.db'));
      manifest.backups.push({ file: 'oar-0.9.14-20260101-000000-pre-update.db', dir, quickCheck: 'ok', bytes: 10, seq: 6 });
    }
    ownBackup(dir, manifest, 'oar-0.9.19-20261101-000000-pre-update.db', { seq: 7 });
    const before = backupsIn(dir);
    rotateBackups({ manifest, dir, keep: 1, keepFile: 'oar-0.9.19-20261101-000000-pre-update.db', logger: quiet });
    assert.deepEqual(backupsIn(dir), before, 'every file stays');
    assert.ok(fs.existsSync(path.join(elsewhere, 'oar-0.9.13-20260101-000000-pre-update.db')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a file Windows holds (EBUSY) stays, warned about, and is tried again; gone files leave the manifest', () => {
  const dir = tempDir();
  try {
    const manifest = { seq: 0, backups: [], lastResult: null, pending: null };
    ownBackup(dir, manifest, 'oar-0.9.17-20261101-000000-pre-update.db', { seq: 1 });
    ownBackup(dir, manifest, 'oar-0.9.18-20261101-000000-pre-update.db', { seq: 2 });
    ownBackup(dir, manifest, 'oar-0.9.19-20261101-000000-pre-update.db', { seq: 3 });
    fs.rmSync(path.join(dir, 'oar-0.9.18-20261101-000000-pre-update.db'));
    const warnings = [];
    const busy = { ...fs, unlinkSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
    const result = rotateBackups({ manifest, dir, keep: 1, keepFile: 'oar-0.9.19-20261101-000000-pre-update.db', fsImpl: busy, logger: { log() {}, warn: (line) => warnings.push(line) } });
    assert.deepEqual(result.rotated, []);
    assert.match(warnings[0], /oar-0\.9\.17.* could not be deleted \(held by another program\); it is tried again at the next backup/);
    assert.deepEqual(manifest.backups.map((entry) => entry.seq), [1, 3], 'the gone one dropped, the held one kept');
    assert.deepEqual(rotateBackups({ manifest, dir, keep: 1, keepFile: 'oar-0.9.19-20261101-000000-pre-update.db', logger: quiet }).rotated, ['oar-0.9.17-20261101-000000-pre-update.db']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two relays sharing a folder each rotate only their own (one manifest per data folder)', async () => {
  const a = makeInstall();
  const b = makeInstall();
  const shared = path.join(a.root, 'shared');
  try {
    const config = { dbBackups: { dir: shared, keep: 1 } };
    const run = (install, at) => backupDatabase({
      source: install.db, Database, dbPath: install.dbPath, dataDir: install.dataDir, layout: install.layout, serverDir: install.serverDir,
      config, version: '0.9.19', reason: 'manual', now: () => at, logger: quiet, sleep: () => {}, fsImpl: roomy,
    });
    await run(a, NOW);
    await run(b, NOW);
    assert.deepEqual(backupsIn(shared), ['oar-0.9.19-20261103-091500-manual-2.db', 'oar-0.9.19-20261103-091500-manual.db'], 'the same second: -2');
    await run(a, new Date('2026-11-04T09:15:00.000Z'));
    assert.deepEqual(backupsIn(shared), ['oar-0.9.19-20261103-091500-manual-2.db', 'oar-0.9.19-20261104-091500-manual.db'], 'a rotated out only its own');
  } finally {
    a.db.close();
    b.db.close();
    a.cleanup();
    b.cleanup();
  }
});

test('a manifest that cannot be read is started again: nothing it listed is deleted', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    fs.writeFileSync(path.join(install.backupDir, 'oar-0.9.18-20261101-000000-pre-update.db'), 'listed once');
    fs.writeFileSync(path.join(install.dataDir, BACKUP_MANIFEST_FILE), '{ broken');
    const warnings = [];
    assert.deepEqual(readManifest(install.dataDir, { logger: { warn: (line) => warnings.push(line) } }).backups, []);
    assert.match(warnings[0], /could not be read; starting a new one/);
    await backupDatabase({
      source: install.db, Database, dbPath: install.dbPath, dataDir: install.dataDir, layout: install.layout, serverDir: install.serverDir,
      config: { dbBackups: { keep: 1 } }, version: '0.9.19', reason: 'manual', now: () => NOW, logger: quiet, sleep: () => {}, fsImpl: roomy,
    });
    assert.ok(fs.existsSync(path.join(install.backupDir, 'oar-0.9.18-20261101-000000-pre-update.db')));
    assert.equal(readManifest(install.dataDir).backups.length, 1, 'a readable manifest again');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a .partial a kill left is removed at the next backup, its side files too; anyone else\'s .partial stays', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    const left = 'oar-0.9.19-20261102-000000-pre-update.db.partial';
    for (const side of ['', '-wal', '-shm']) fs.writeFileSync(path.join(install.backupDir, `${left}${side}`), 'half');
    fs.writeFileSync(path.join(install.backupDir, 'oar-0.9.19-20261102-000000-manual.db.partial'), 'another relay\'s');
    writeManifest(install.dataDir, { seq: 0, backups: [], lastResult: null, pending: { file: left, dir: install.backupDir } });
    await backupDatabase({
      source: install.db, Database, dbPath: install.dbPath, dataDir: install.dataDir, layout: install.layout, serverDir: install.serverDir,
      config: {}, version: '0.9.19', reason: 'manual', now: () => NOW, logger: quiet, sleep: () => {}, fsImpl: roomy,
    });
    assert.deepEqual(backupsIn(install.backupDir), ['oar-0.9.19-20261102-000000-manual.db.partial', 'oar-0.9.19-20261103-091500-manual.db']);
    assert.deepEqual(readManifest(install.dataDir).pending, []);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

// ─── The start step ──────────────────────────────────────────────────────────

test('the same version (and commit on a checkout): nothing written, nothing changed', async () => {
  const install = makeInstall();
  try {
    setLastRun(install.db, { version: '0.9.20', commit: null, at: 'x' });
    assert.equal((await start(install)).status, 'same');
    setLastRun(install.db, { version: '0.9.20', commit: COMMIT, at: 'x' });
    assert.equal((await start(install, { layout: { checkout: true }, runningCommit: COMMIT, config: { dbBackups: { dir: install.backupDir } } })).status, 'same');
    assert.equal((await start(install, { layout: { checkout: true }, runningCommit: null, config: { dbBackups: { dir: install.backupDir } } })).status, 'same', 'no commit readable now: the version alone');
    assert.deepEqual(backupsIn(install.backupDir), []);
    assert.equal(fs.existsSync(path.join(install.dataDir, BACKUP_MANIFEST_FILE)), false);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a new version: a backup named after the version of the data, before db_last_run moves on; a downgrade too', async () => {
  const install = makeInstall();
  try {
    setLastRun(install.db, { version: '0.9.19', commit: null, at: 'x' });
    const result = await start(install);
    assert.equal(result.status, 'written');
    assert.deepEqual(backupsIn(install.backupDir), ['oar-0.9.19-20261103-091500-pre-update.db']);
    const copy = new Database(path.join(install.backupDir, result.file), { readonly: true });
    assert.equal(lastRun(copy).version, '0.9.19', 'the copy is of before');
    copy.close();
    assert.deepEqual(lastRun(install.db), { version: '0.9.20', commit: null, at: NOW.toISOString() });
    assert.equal((await start(install)).status, 'same', 'a restart writes none');

    setLastRun(install.db, { version: '0.9.21', commit: null, at: 'x' });
    assert.equal((await start(install)).file, 'oar-0.9.21-20261103-091500-pre-update.db', 'back from 0.9.21: named 0.9.21');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a checkout whose commit moved: pre-update-<commit7> of the data; a commit not known before counts as changed', async () => {
  const install = makeInstall();
  try {
    const checkout = { layout: { checkout: true }, config: { dbBackups: { dir: install.backupDir } } };
    setLastRun(install.db, { version: '0.9.20', commit: COMMIT, at: 'x' });
    assert.equal((await start(install, { ...checkout, runningCommit: OTHER_COMMIT })).file, 'oar-0.9.20-20261103-091500-pre-update-1512900.db');
    assert.equal(lastRun(install.db).commit, OTHER_COMMIT);
    setLastRun(install.db, { version: '0.9.20', commit: null, at: 'x' });
    assert.equal((await start(install, { ...checkout, runningCommit: COMMIT, now: () => new Date('2026-11-04T00:00:00.000Z') })).status, 'written');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('unknown (the first 0.9.20 start): the in-app update\'s fromVersion when it is this update\'s and fresh, else from-unknown', async () => {
  const cases = [
    { attempt: { attemptedVersion: '0.9.20', fromVersion: '0.9.19', startedAt: '2026-11-02T09:00:00.000Z' }, file: 'oar-0.9.19-20261103-091500-pre-update.db' },
    { attempt: { attemptedVersion: '0.9.21', fromVersion: '0.9.19', startedAt: '2026-11-02T09:00:00.000Z' }, file: 'oar-0.9.20-20261103-091500-pre-update-from-unknown.db' },
    { attempt: { attemptedVersion: '0.9.20', fromVersion: '0.9.19', startedAt: '2026-10-01T09:00:00.000Z' }, file: 'oar-0.9.20-20261103-091500-pre-update-from-unknown.db' },
    { attempt: { attemptedVersion: '0.9.20', fromVersion: '../x', startedAt: '2026-11-02T09:00:00.000Z' }, file: 'oar-0.9.20-20261103-091500-pre-update-from-unknown.db' },
    { attempt: null, file: 'oar-0.9.20-20261103-091500-pre-update-from-unknown.db' },
    { lastRun: '{ not json', attempt: null, file: 'oar-0.9.20-20261103-091500-pre-update-from-unknown.db' },
  ];
  for (const { attempt, file, lastRun: raw } of cases) {
    const install = makeInstall();
    try {
      if (attempt) install.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('update_attempt', ?, 'x')").run(JSON.stringify(attempt));
      if (raw) install.db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(DB_LAST_RUN_SETTING_KEY, raw, 'x');
      assert.equal((await start(install)).file, file, JSON.stringify(attempt));
      if (attempt) assert.ok(install.db.prepare("SELECT 1 FROM app_settings WHERE key = 'update_attempt'").get(), 'the record stays for reconcileUpdateAttempt');
    } finally {
      install.db.close();
      install.cleanup();
    }
  }
});

test('a database just created, or dbBackups.enabled false: no backup; db_last_run deferred or written', async () => {
  const install = makeInstall();
  try {
    const created = await start(install, { databaseCreated: true });
    assert.equal(created.status, 'new-database');
    assert.equal(lastRun(install.db).version, '0.9.20', 'app_settings is there in this fixture: written now');
    install.db.prepare('DELETE FROM app_settings').run();
    const disabled = await start(install, { config: { dbBackups: { enabled: false } } });
    assert.equal(disabled.status, 'disabled');
    assert.equal(lastRun(install.db).version, '0.9.20');
    assert.deepEqual(backupsIn(install.backupDir), []);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('no app_settings table yet (a new or very old database): the backup runs, db_last_run comes back to write after applySchema', async () => {
  const root = tempDir();
  try {
    const dataDir = path.join(root, 'state', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'copilot.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY)');
    const result = await maybeBackupBeforeStart({
      db, Database, dbPath, dataDir, layout: { checkout: false, root: path.join(root, 'state') }, serverDir: root, config: {},
      runningVersion: '0.9.20', now: () => NOW, logger: quiet, sleep: () => {}, fsImpl: roomy,
    });
    assert.equal(result.file, 'oar-0.9.20-20261103-091500-pre-update-from-unknown.db');
    assert.deepEqual(result.deferredLastRun, { version: '0.9.20', commit: null, at: NOW.toISOString() });
    const created = await maybeBackupBeforeStart({
      db, Database, dbPath, dataDir, databaseCreated: true, layout: { checkout: false, root }, serverDir: root, config: {}, runningVersion: '0.9.20', now: () => NOW, logger: quiet,
    });
    assert.ok(created.deferredLastRun);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a skip (disk) or a failure still writes db_last_run, says so, and keeps lastResult', async () => {
  const install = makeInstall();
  try {
    setLastRun(install.db, { version: '0.9.19', commit: null, at: 'x' });
    const warnings = [];
    const full = { ...fs, statfsSync: () => ({ bavail: 1, bsize: 1, blocks: 10 * 1024 ** 3 }) };
    const skipped = await start(install, { fsImpl: full, logger: { log() {}, warn: (line) => warnings.push(line) } });
    assert.equal(skipped.status, 'skipped');
    assert.match(warnings.join('\n'), /\[backup\] skipped: not enough disk space in .*backups/);
    assert.match(warnings.join('\n'), /run `oar backup` for one/);
    assert.equal(lastRun(install.db).version, '0.9.20', 'never tried again at every start');
    assert.equal(readManifest(install.dataDir).lastResult.status, 'skipped');

    setLastRun(install.db, { version: '0.9.19', commit: null, at: 'x' });
    const broken = { prepare: install.db.prepare.bind(install.db), backup: () => Promise.reject(new Error('disk I/O error')) };
    const failed = await start(install, { db: broken });
    assert.equal(failed.status, 'failed');
    assert.match(failed.reason, /disk I\/O error/);
    assert.equal(lastRun(install.db).version, '0.9.20');
    assert.deepEqual(backupsIn(install.backupDir), [], 'no .partial left');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a kill during the backup: db_last_run and update_attempt as they were; the next start backs up again and cleans up', async () => {
  const install = makeInstall();
  try {
    install.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('update_attempt', ?, 'x')")
      .run(JSON.stringify({ attemptedVersion: '0.9.20', fromVersion: '0.9.19', startedAt: '2026-11-02T09:00:00.000Z' }));
    let seen = null;
    const hanging = {
      prepare: install.db.prepare.bind(install.db),
      backup: (partial) => {
        fs.writeFileSync(partial, 'half a copy');
        seen = {
          progress: JSON.parse(fs.readFileSync(path.join(install.dataDir, BACKUP_PROGRESS_FILE), 'utf8')),
          manifest: readManifest(install.dataDir),
          lastRun: lastRun(install.db),
        };
        return new Promise(() => {});
      },
    };
    void start(install, { db: hanging, pid: 4242 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.progress.pid, 4242);
    assert.equal(seen.progress.task, 'backup');
    assert.deepEqual(seen.manifest.pending, [{ file: 'oar-0.9.19-20261103-091500-pre-update.db.partial', dir: install.backupDir, pid: 4242 }]);
    assert.equal(seen.lastRun, null, 'db_last_run not written yet');
    assert.ok(install.db.prepare("SELECT 1 FROM app_settings WHERE key = 'update_attempt'").get());

    // The next start, after the kill: the half copy goes, fromVersion again.
    const result = await start(install, { now: () => new Date('2026-11-03T09:16:00.000Z'), isProcessAlive: () => false });
    assert.equal(result.file, 'oar-0.9.19-20261103-091600-pre-update.db');
    assert.deepEqual(backupsIn(install.backupDir), ['oar-0.9.19-20261103-091600-pre-update.db']);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('three version changes with keep 2 leave 2, and a restored backup is backed up again before it migrates', async () => {
  const install = makeInstall();
  try {
    for (const [index, version] of ['0.9.17', '0.9.18', '0.9.19'].entries()) {
      setLastRun(install.db, { version, commit: null, at: 'x' });
      await start(install, { now: () => new Date(NOW.getTime() + index * 60_000) });
    }
    assert.deepEqual(backupsIn(install.backupDir), ['oar-0.9.18-20261103-091600-pre-update.db', 'oar-0.9.19-20261103-091700-pre-update.db']);

    // Restore: the copy in place under the live name, opened again.
    install.db.close();
    for (const side of ['', '-wal', '-shm']) fs.rmSync(`${install.dbPath}${side}`, { force: true });
    fs.copyFileSync(path.join(install.backupDir, 'oar-0.9.19-20261103-091700-pre-update.db'), install.dbPath);
    install.db = new Database(install.dbPath);
    const again = await start(install, { now: () => new Date('2026-11-05T00:00:00.000Z') });
    assert.equal(again.file, 'oar-0.9.19-20261105-000000-pre-update.db', 'its db_last_run names the old version');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

// ─── What doctor, About and the update log show ──────────────────────────────

test('the listing: own backups, changed ones, and everything else with sizes (folders summed), read only', async () => {
  const install = makeInstall();
  try {
    await backupDatabase({
      source: install.db, Database, dbPath: install.dbPath, dataDir: install.dataDir, layout: install.layout, serverDir: install.serverDir,
      config: {}, version: '0.9.19', reason: 'pre-update', now: () => NOW, logger: quiet, sleep: () => {}, fsImpl: roomy,
    });
    fs.writeFileSync(path.join(install.backupDir, 'main-0.9.19-20261020.db'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(install.backupDir, 'MIGRATION.md'), 'receipt');
    fs.mkdirSync(path.join(install.backupDir, '2026-10-20T12-00-00-000Z'));
    fs.writeFileSync(path.join(install.backupDir, '2026-10-20T12-00-00-000Z', 'copilot.db'), Buffer.alloc(4096));
    const before = backupsIn(install.backupDir);
    const described = describeBackups({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, config: {} });
    assert.deepEqual(backupsIn(install.backupDir), before);
    assert.equal(described.dir, install.backupDir);
    assert.deepEqual([described.enabled, described.keep], [true, 2]);
    assert.deepEqual(described.own.map((entry) => entry.file), ['oar-0.9.19-20261103-091500-pre-update.db']);
    assert.equal(described.lastResult.status, 'written');
    assert.deepEqual(described.others.map((entry) => [entry.name, entry.bytes, entry.folder]), [
      ['2026-10-20T12-00-00-000Z', 4096, true],
      ['main-0.9.19-20261020.db', 2048, false],
      ['MIGRATION.md', 7, false],
    ], 'by name, case aside');
    fs.appendFileSync(path.join(install.backupDir, 'oar-0.9.19-20261103-091500-pre-update.db'), 'x');
    const changed = listBackupDir({ dir: install.backupDir, manifest: readManifest(install.dataDir) });
    assert.deepEqual(changed.own, []);
    assert.deepEqual(changed.changed.map((entry) => entry.file), ['oar-0.9.19-20261103-091500-pre-update.db']);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('the update log\'s line: backs up to the folder, or why not (disabled, guarded folder, disk)', () => {
  const install = makeInstall();
  try {
    const line = (overrides = {}) => describeNextBackup({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, dbPath: install.dbPath, config: {}, fsImpl: roomy, ...overrides });
    assert.match(line(), new RegExp(`^\\[backup\\] The next start backs up the database \\(\\d+\\.\\d MB\\) to ${install.backupDir.replace(/[\\.]/g, '\\$&')} before the new version's migrations\\.$`));
    assert.match(line({ config: { dbBackups: { enabled: false } } }), /does not back up the database: dbBackups\.enabled is false/);
    fs.mkdirSync(install.backupDir);
    fs.writeFileSync(path.join(install.backupDir, 'DO_NOT_TOUCH'), '');
    assert.match(line(), /does not back up the database: .*DO_NOT_TOUCH guards .*: nothing is written there\. Run `oar backup` now/);
    fs.rmSync(path.join(install.backupDir, 'DO_NOT_TOUCH'));
    assert.match(line({ fsImpl: { ...fs, statfsSync: () => ({ bavail: 1, bsize: 1, blocks: 1e12 }) } }), /does not back up the database: not enough disk space/);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

// ─── One backup at a time, and what is left behind ───────────────────────────

const backupArgs = (install, overrides = {}) => ({
  source: install.db, Database, dbPath: install.dbPath, dataDir: install.dataDir, layout: install.layout, serverDir: install.serverDir,
  config: {}, version: '0.9.19', reason: 'manual', now: () => NOW, logger: quiet, sleep: () => {}, fsImpl: roomy, ...overrides,
});

test('the pending entry names the exact .partial (a taken name gets -2) with the writer\'s pid', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    fs.writeFileSync(path.join(install.backupDir, 'oar-0.9.19-20261103-091500-manual.db.partial'), 'another relay writes this one');
    let pending = null;
    const watching = { backup: (dest, options) => { pending = readManifest(install.dataDir).pending; return install.db.backup(dest, options); } };
    const result = await backupDatabase(backupArgs(install, { source: watching, pid: 777 }));
    assert.deepEqual(pending, [{ file: 'oar-0.9.19-20261103-091500-manual-2.db.partial', dir: install.backupDir, pid: 777 }]);
    assert.equal(result.file, 'oar-0.9.19-20261103-091500-manual-2.db');
    assert.equal(fs.readFileSync(path.join(install.backupDir, 'oar-0.9.19-20261103-091500-manual.db.partial'), 'utf8'), 'another relay writes this one');
    assert.deepEqual(readManifest(install.dataDir).pending, []);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a pending .partial of a process that still runs is left alone; one of a dead process goes', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    const live = 'oar-0.9.19-20261102-000000-pre-update.db.partial';
    const dead = 'oar-0.9.19-20261102-000001-manual.db.partial';
    for (const name of [live, dead]) fs.writeFileSync(path.join(install.backupDir, name), 'half');
    writeManifest(install.dataDir, { seq: 0, backups: [], lastResult: null, pending: [{ file: live, dir: install.backupDir, pid: 5001 }, { file: dead, dir: install.backupDir, pid: 5002 }] });
    await backupDatabase(backupArgs(install, { isProcessAlive: (pid) => pid === 5001 }));
    assert.ok(fs.existsSync(path.join(install.backupDir, live)), 'still being written');
    assert.equal(fs.existsSync(path.join(install.backupDir, dead)), false);
    assert.deepEqual(readManifest(install.dataDir).pending.map((entry) => entry.pid), [5001]);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('the manifest is written through a temp file of the writer\'s own pid', () => {
  const dir = tempDir();
  try {
    const written = [];
    writeManifest(dir, emptyManifestFor(), { pid: 4321, fsImpl: { ...fs, writeFileSync: (file, ...rest) => { written.push(path.basename(file)); return fs.writeFileSync(file, ...rest); } } });
    assert.deepEqual(written, [`${BACKUP_MANIFEST_FILE}.4321.tmp`]);
    assert.deepEqual(fs.readdirSync(dir), [BACKUP_MANIFEST_FILE]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function emptyManifestFor() {
  return { seq: 0, backups: [], lastResult: null, pending: [] };
}

test('another live process backing this database up (its progress file): busy, nothing written, its file left alone', async () => {
  const install = makeInstall();
  try {
    const progress = path.join(install.dataDir, BACKUP_PROGRESS_FILE);
    fs.writeFileSync(progress, JSON.stringify({ pid: 6001, task: 'backup' }));
    const busy = await backupDatabase(backupArgs(install, { pid: 7001, isProcessAlive: (pid) => pid === 6001 }));
    assert.equal(busy.status, 'busy');
    assert.equal(busy.pid, 6001);
    assert.deepEqual(JSON.parse(fs.readFileSync(progress, 'utf8')), { pid: 6001, task: 'backup' });
    assert.deepEqual(backupsIn(install.backupDir), []);
    // Its pid gone: a leftover, and this run goes ahead (and removes only its own file).
    const done = await backupDatabase(backupArgs(install, { pid: 7001, isProcessAlive: () => false }));
    assert.equal(done.status, 'written');
    assert.equal(fs.existsSync(progress), false, 'its own progress file is gone afterwards');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('the .partial is 0600 from its first byte, a new folder 0700; a chmod a filesystem refuses fails nothing', { skip: process.platform === 'win32' }, async () => {
  const install = makeInstall();
  try {
    let modeDuringCopy = null;
    const watching = { backup: (dest, options) => { modeDuringCopy = fs.statSync(dest).mode & 0o777; return install.db.backup(dest, options); } };
    const noChmod = { ...roomy, chmodSync: () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } };
    const result = await backupDatabase(backupArgs(install, { source: watching, fsImpl: noChmod }));
    assert.equal(result.status, 'written');
    assert.equal(modeDuringCopy, 0o600);
    assert.equal(fs.statSync(install.backupDir).mode & 0o777, 0o700);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a final name another relay takes at the last moment: the next number, nothing replaced; without hard links a checked rename', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(install.backupDir);
    const name = 'oar-0.9.19-20261103-091500-manual.db';
    let first = true;
    const racing = (from, to) => {
      if (first) { first = false; fs.writeFileSync(to, 'the other relay\'s'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); }
      return fs.linkSync(from, to);
    };
    const raced = await writeBackup({ source: install.db, Database, dir: install.backupDir, name, link: racing });
    assert.equal(raced.file, 'oar-0.9.19-20261103-091500-manual-2.db');
    assert.equal(fs.readFileSync(path.join(install.backupDir, name), 'utf8'), 'the other relay\'s');
    const noLinks = await writeBackup({
      source: install.db, Database, dir: install.backupDir, name: 'oar-0.9.19-20261103-091501-manual.db',
      link: () => { throw Object.assign(new Error('EPERM: links not supported'), { code: 'EPERM' }); },
    });
    assert.equal(noLinks.ok, true);
    assert.deepEqual(backupsIn(install.backupDir).filter((each) => each.endsWith('.partial')), []);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('the log says how long each phase took: copy, check, sync, rename', async () => {
  const install = makeInstall();
  try {
    const lines = [];
    await backupDatabase(backupArgs(install, { logger: { log: (line) => lines.push(line), warn() {} } }));
    assert.ok(lines.some((line) => /^\[backup\] phases: copy \d+\.\d s, check \d+\.\d s, sync \d+\.\d s, rename \d+\.\d s$/.test(line)), lines.join('\n'));
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a failed check through backupDatabase rotates nothing out; the bytes recorded are those of the single file', async () => {
  const install = makeInstall();
  try {
    const first = await backupDatabase(backupArgs(install, { config: { dbBackups: { keep: 1 } } }));
    const file = path.join(install.backupDir, first.file);
    // One file in rollback mode (header bytes 18-19 = 1), its size as recorded.
    const header = fs.readFileSync(file).subarray(18, 20);
    assert.deepEqual([...header], [1, 1]);
    assert.equal(readManifest(install.dataDir).backups[0].bytes, fs.statSync(file).size);
    const Failing = function Failing(target, options) {
      const db = new Database(target, options);
      const pragma = db.pragma.bind(db);
      db.pragma = (text, opts) => (String(text).startsWith('quick_check') ? 'broken' : pragma(text, opts));
      return db;
    };
    const failed = await backupDatabase(backupArgs(install, { Database: Failing, config: { dbBackups: { keep: 1 } }, now: () => new Date('2026-11-04T00:00:00.000Z') }));
    assert.equal(failed.status, 'failed');
    assert.deepEqual(backupsIn(install.backupDir), [first.file], 'the good one stays');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('About\'s listing (sizes: false) walks no folder in the backup folder; doctor\'s sums them', async () => {
  const install = makeInstall();
  try {
    fs.mkdirSync(path.join(install.backupDir, '2026-10-20T12-00-00-000Z'), { recursive: true });
    fs.writeFileSync(path.join(install.backupDir, '2026-10-20T12-00-00-000Z', 'copilot.db'), Buffer.alloc(4096));
    let walked = 0;
    const counting = { ...fs, readdirSync: (dir, ...rest) => { if (dir.includes('2026-10-20T12')) walked += 1; return fs.readdirSync(dir, ...rest); } };
    const about = describeBackups({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, config: {}, sizes: false, fsImpl: counting });
    assert.equal(walked, 0);
    assert.deepEqual(about.others, [{ name: '2026-10-20T12-00-00-000Z', bytes: null, folder: true }]);
    const doctor = describeBackups({ layout: install.layout, serverDir: install.serverDir, dataDir: install.dataDir, config: {} });
    assert.equal(doctor.others[0].bytes, 4096);
  } finally {
    install.db.close();
    install.cleanup();
  }
});

// ─── A progress file a writer left: pid reuse, the start's wait ──────────────

// A live process of this test's own (a child that sleeps) and its identity.
function liveChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return child;
}

test('a progress file whose pid lives but is another process (reused after a crash or reboot) is not busy; the start removes it, saying so', async () => {
  const install = makeInstall();
  const child = liveChild();
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const progress = path.join(install.dataDir, BACKUP_PROGRESS_FILE);
    // The pid is alive, but its recorded start is not the running process's.
    const stale = { pid: child.pid, format: 2, holder: { start: 'ticks:1', bootId: 'another-boot' }, task: 'backup' };
    fs.writeFileSync(progress, JSON.stringify(stale));
    assert.equal(backupHolderMayRun(stale), false);
    const lines = [];
    setLastRun(install.db, { version: '0.9.19', commit: null, at: 'x' });
    const result = await start(install, { logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) } });
    assert.equal(result.status, 'written', lines.join('\n'));
    assert.ok(lines.some((line) => line.includes(`removed ${progress}: process ${child.pid} that wrote it no longer runs`)), lines.join('\n'));
    assert.equal(fs.existsSync(progress), false);
  } finally {
    child.kill();
    install.db.close();
    install.cleanup();
  }
});

test('a writer still live after the bounded wait: the start makes its own backup beside it, db_last_run moves on, its file untouched', async () => {
  const install = makeInstall();
  const child = liveChild();
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const progress = path.join(install.dataDir, BACKUP_PROGRESS_FILE);
    const { processIdentity } = await import('./relay-singleton-guard.mjs');
    const theirs = { pid: child.pid, format: 2, holder: processIdentity(child.pid), task: 'backup' };
    fs.writeFileSync(progress, JSON.stringify(theirs));
    setLastRun(install.db, { version: '0.9.19', commit: null, at: 'x' });
    const lines = [];
    let waited = 0;
    let note = null;
    const result = await start(install, {
      holderWaitMs: 50, pollMs: 10,
      wait: (ms) => {
        waited += ms;
        note ??= JSON.parse(fs.readFileSync(path.join(install.dataDir, BACKUP_WAIT_FILE), 'utf8'));
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    assert.equal(result.status, 'written', lines.join('\n'));
    assert.equal(result.file, 'oar-0.9.19-20261103-091500-pre-update.db');
    assert.ok(waited > 0 && waited <= 100, `waited ${waited} ms`);
    assert.ok(lines.some((line) => line.includes(`process ${child.pid} is backing up this database; waiting for it`)), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes(`process ${child.pid} still holds`) && line.includes('makes its own backup beside it')), lines.join('\n'));
    assert.equal(note.task, 'wait-backup');
    assert.equal(note.waitingFor, child.pid);
    assert.equal(note.pid, process.pid);
    assert.equal(fs.existsSync(path.join(install.dataDir, BACKUP_WAIT_FILE)), false, 'the wait note is gone');
    assert.equal(lastRun(install.db).version, '0.9.20');
    assert.deepEqual(JSON.parse(fs.readFileSync(progress, 'utf8')), theirs, 'the live writer\'s file is left alone');
  } finally {
    child.kill();
    install.db.close();
    install.cleanup();
  }
});

test('busy is what `oar backup` (backupDatabase) answers while another writer runs: recorded in lastResult', async () => {
  const install = makeInstall();
  try {
    fs.writeFileSync(path.join(install.dataDir, BACKUP_PROGRESS_FILE), JSON.stringify({ pid: 6001, format: 2, holder: { start: 'ticks:9' }, task: 'backup' }));
    const busy = await backupDatabase(backupArgs(install, { pid: 7001, holderMayRun: () => true }));
    assert.equal(busy.status, 'busy');
    assert.equal(readManifest(install.dataDir).lastResult.status, 'busy');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('the start that waited makes its own backup once the other writer is done', async () => {
  const install = makeInstall();
  try {
    const progress = path.join(install.dataDir, BACKUP_PROGRESS_FILE);
    fs.writeFileSync(progress, JSON.stringify({ pid: 999999, format: 2, holder: { start: 'ticks:5' }, task: 'backup' }));
    setLastRun(install.db, { version: '0.9.19', commit: null, at: 'x' });
    let polls = 0;
    // The writer runs for two polls, then finishes and removes its file.
    const holderMayRun = () => { polls += 1; if (polls > 3) { fs.rmSync(progress, { force: true }); return false; } return true; };
    const result = await start(install, { holderMayRun, holderWaitMs: 60_000, pollMs: 1, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    assert.equal(result.status, 'written');
    assert.equal(result.file, 'oar-0.9.19-20261103-091500-pre-update.db');
    assert.equal(lastRun(install.db).version, '0.9.20');
  } finally {
    install.db.close();
    install.cleanup();
  }
});

test('a wait note a killed start left is removed at the next start', async () => {
  const install = makeInstall();
  try {
    fs.writeFileSync(path.join(install.dataDir, BACKUP_WAIT_FILE), JSON.stringify({ pid: 999999, task: 'wait-backup', waitingFor: 1 }));
    await start(install);
    assert.equal(fs.existsSync(path.join(install.dataDir, BACKUP_WAIT_FILE)), false);
  } finally {
    install.db.close();
    install.cleanup();
  }
});
