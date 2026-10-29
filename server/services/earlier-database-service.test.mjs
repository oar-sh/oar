import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  CHECKED_FILE,
  RESCUE_DIR_NAME,
  SWAP_JOURNAL_FILE,
  TAKEOVER_PROGRESS_FILE,
  adoptEarlierDatabase,
  lostPackageDatabaseWarning,
  packageDatabaseEvidence,
} from './earlier-database-service.mjs';
import { useScratchProcessEnv } from './scratch-env-test-harness.mjs';
// Home and state folders of this process point into a scratch folder.
useScratchProcessEnv();

const UPLOAD = 'a'.repeat(64);
const OTHER_UPLOAD = 'b'.repeat(64);
const NOW = new Date('2026-10-20T12:00:00.000Z');
const STAMP = '2026-10-20T12-00-00-000Z';

// A global install as 0.9.13 left it: the autostart relay's database inside
// the package (server/data) and its uploads beside it (server/uploads), and
// an older database in the state root that a plain `oar start` used before
// autostart was switched on. The state root is the default one (APPDATA\oar,
// the platform injected), as on a real install.
function createInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-earlier-db-'));
  const appData = path.join(root, 'appdata');
  const stateRoot = path.join(appData, 'oar');
  const packageRoot = path.join(root, 'npm', 'node_modules', '@oar-sh', 'oar');
  const install = {
    root,
    packageRoot,
    serverDir: path.join(packageRoot, 'server'),
    stateRoot,
    dataDir: path.join(stateRoot, 'data'),
    uploadDir: path.join(stateRoot, 'data', 'uploads'),
    env: { APPDATA: appData, COPILOT_WEB_RELAY_DATA_DIR: path.join(stateRoot, 'data') },
    logs: [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  install.earlierDir = path.join(install.serverDir, 'data');
  install.earlierDb = path.join(install.earlierDir, 'copilot.db');
  install.pinnedDb = path.join(install.dataDir, 'copilot.db');
  fs.mkdirSync(install.serverDir, { recursive: true });
  return install;
}

// A database with the production schema and one conversation, message and
// setting, all changed at `at`. `filler` puts a table first whose page
// `corrupt` can break without touching the tables read for the stamps.
function writeDatabase(file, { marker, at, filler = false }) {
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
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('relay_name', ?, ?)").run(marker, at);
    db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(`c-${marker}`, marker, at, at);
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', ?, ?)").run(`m-${marker}`, `c-${marker}`, marker, at);
  } finally {
    db.close();
  }
}

// Breaks the filler table's root page: quick_check fails, the stamp queries
// still work.
function corrupt(file) {
  const db = new Database(file, { readonly: true });
  const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'filler'").get().rootpage;
  const pageSize = db.pragma('page_size', { simple: true });
  db.close();
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(64, 0xa5), 0, 64, (root - 1) * pageSize + 8);
  fs.closeSync(fd);
  const check = new Database(file, { readonly: true });
  assert.notEqual(check.pragma('quick_check', { simple: true }), 'ok', 'the fixture is broken');
  assert.ok(check.prepare('SELECT MAX(updated_at) AS v FROM app_settings').get().v, 'and its stamps are still readable');
  check.close();
}

function readMarker(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT value FROM app_settings WHERE key = 'relay_name'").get()?.value ?? null;
  } finally {
    db.close();
  }
}

function adopt(install, overrides = {}) {
  return adoptEarlierDatabase({
    dataDir: install.dataDir,
    uploadDir: install.uploadDir,
    serverDir: install.serverDir,
    configPath: path.join(install.stateRoot, 'config.json'),
    packageRoot: install.packageRoot,
    Database,
    env: install.env,
    platform: 'win32',
    isProcessAlive: () => false,
    processStartedAt: () => null,
    bootTime: 0,
    now: () => NOW,
    logger: { log: (line) => install.logs.push(line) },
    sleep: () => {},
    ...overrides,
  });
}

const bytes = (file) => fs.readFileSync(file);
// Every file under a folder with its bytes.
const snapshotDir = (dir) => fs.readdirSync(dir, { recursive: true }).filter((entry) => fs.statSync(path.join(dir, entry)).isFile())
  .sort().map((entry) => [entry, fs.readFileSync(path.join(dir, entry)).toString('base64')]);
const noStaging = (install) => !fs.readdirSync(install.dataDir).some((name) => name.startsWith('.earlier-database-'));
const checked = (install) => JSON.parse(fs.readFileSync(path.join(install.dataDir, CHECKED_FILE), 'utf8')).sources;

// ─── Taking over ─────────────────────────────────────────────────────────────

test('the 0.9.13 layout: the newer database in the package and its uploads come over, nothing is lost', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    // 0.9.13 kept uploads in server/uploads, beside server/data.
    fs.mkdirSync(path.join(install.serverDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(install.serverDir, 'uploads', UPLOAD), 'upload in the package');
    const earlierBefore = bytes(install.earlierDb);
    const filesBefore = fs.readdirSync(install.earlierDir).sort();

    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(readMarker(install.pinnedDb), 'stage-marker', 'the relay opens the marker database');
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((name) => name.startsWith('copilot.db')), ['copilot.db'], 'one file, no -wal moved with it');
    // The older one is a dated backup.
    assert.equal(result.backupDir, path.join(install.stateRoot, 'backups', STAMP));
    assert.equal(readMarker(path.join(result.backupDir, 'copilot.db')), 'older');
    // The original is set aside in place, byte for byte, and was never
    // opened (no -wal of its own appeared).
    const kept = path.join(install.earlierDir, `copilot.db.adopted-${STAMP}`);
    assert.equal(result.renamedTo, kept);
    assert.deepEqual(bytes(kept), earlierBefore);
    assert.deepEqual(fs.readdirSync(install.earlierDir).sort(), filesBefore.map((name) => name.replace('copilot.db', `copilot.db.adopted-${STAMP}`)).sort());
    assert.equal(fs.readFileSync(path.join(install.uploadDir, UPLOAD), 'utf8'), 'upload in the package');
    assert.equal(fs.existsSync(path.join(install.serverDir, 'uploads', UPLOAD)), true, 'copied, not moved');
    assert.equal(install.logs.length, 3);
    assert.match(install.logs[0], /^\[data\] Bringing over .+copilot\.db \(1 MB\) if it is newer; this can take a few minutes\.$/);
    assert.match(install.logs[1], /^\[data\] Looking at .+copilot\.db took \d+ s \(copy \d+ s, check \d+ s, pinned \d+ s, uploads \d+ s, swap \d+ s\)\.$/);
    assert.match(install.logs[2], /^\[data\] Brought over the database this relay ran on until now, .+ \(1 conversations, 1 messages\), to .+ with 1 upload\(s\); the original is kept as .+copilot\.db\.adopted-.+, the older database that was there in .+\.$/);
    assert.ok(noStaging(install));
    assert.equal(checked(install)[0].outcome, 'adopted');
  } finally {
    install.cleanup();
  }
});

test('a slow take-over says so with its size, at least once a minute and with each step\'s time, and keeps a progress file with its pid', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'slow', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    const progressFile = path.join(install.dataDir, TAKEOVER_PROGRESS_FILE);
    const seen = [];
    const fsImpl = {
      ...fs,
      copyFileSync(from, to, mode) {
        if (path.basename(from) === 'copilot.db') seen.push(JSON.parse(fs.readFileSync(progressFile, 'utf8')));
        return fs.copyFileSync(from, to, mode);
      },
    };
    // Every look at the clock is 25 s later: a take-over of minutes.
    let at = 0;
    const result = adopt(install, { fsImpl, pid: 4321, clock: () => (at += 25_000) });
    assert.equal(result.status, 'adopted');
    assert.equal(seen[0].pid, 4321);
    assert.equal(seen[0].step, 'copy');
    assert.equal(seen[0].from, install.earlierDb);
    assert.ok(seen[0].bytes > 0);
    assert.equal(fs.existsSync(progressFile), false, 'gone once it is done');
    assert.match(install.logs[0], /^\[data\] Bringing over .+copilot\.db \(1 MB\) if it is newer; this can take a few minutes\.$/);
    const still = install.logs.filter((line) => /^\[data\] Still bringing over .+copilot\.db: (copy|check|pinned|uploads|swap), \d+ s so far\.$/.test(line));
    assert.ok(still.length >= 2, install.logs.join('\n'));
    assert.ok(install.logs.some((line) => /took \d+ s \(copy \d+ s, check \d+ s, pinned \d+ s, uploads \d+ s, swap \d+ s\)/.test(line)));
  } finally {
    install.cleanup();
  }
});

test('an adopted database is never offered again, even after the pinned one lost a conversation', () => {
  for (const renamable of [true, false]) {
    const install = createInstall();
    try {
      writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-10T09:00:00.000Z' });
      // Where the source may not be renamed, only the record says it was seen.
      const fsImpl = renamable ? fs : {
        ...fs,
        renameSync: (from, to) => {
          if (String(from).startsWith(install.earlierDir)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          return fs.renameSync(from, to);
        },
      };
      assert.equal(adopt(install, { fsImpl }).status, 'adopted');
      // The user deletes the conversation; the shutdown writes a setting.
      const db = new Database(install.pinnedDb);
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM conversations').run();
      db.prepare("UPDATE app_settings SET updated_at = '2026-10-21T09:00:00.000Z'").run();
      db.close();
      const before = bytes(install.pinnedDb);
      const again = adopt(install, { fsImpl });
      assert.notEqual(again.status, 'refused', renamable ? 'renamed' : 'recorded');
      assert.deepEqual(bytes(install.pinnedDb), before);
      assert.equal(fs.existsSync(install.earlierDb), !renamable);
    } finally {
      install.cleanup();
    }
  }
});

test('no database in the state root yet: the earlier one is brought over, no backup', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(result.backupDir, null);
    assert.equal(readMarker(install.pinnedDb), 'stage-marker');
    assert.ok(!fs.existsSync(path.join(install.stateRoot, 'backups')));
  } finally {
    install.cleanup();
  }
});

test('the state root\'s database is the newest: nothing changes there, the older one is set aside', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'old-package', at: '2026-10-01T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'current', at: '2026-10-20T09:00:00.000Z' });
    const before = bytes(install.pinnedDb);
    const result = adopt(install);
    assert.equal(result.status, 'kept');
    assert.deepEqual(bytes(install.pinnedDb), before);
    assert.ok(fs.existsSync(path.join(install.earlierDir, `copilot.db.older-${STAMP}`)));
    assert.ok(!fs.existsSync(path.join(install.stateRoot, 'backups')));
    assert.ok(noStaging(install));
    // And not looked at again.
    assert.equal(adopt(install).status, 'no-earlier-database');
  } finally {
    install.cleanup();
  }
});

test('no earlier database: nothing changes', () => {
  const install = createInstall();
  try {
    writeDatabase(install.pinnedDb, { marker: 'current', at: '2026-10-20T09:00:00.000Z' });
    const before = bytes(install.pinnedDb);
    assert.equal(adopt(install).status, 'no-earlier-database');
    assert.deepEqual(bytes(install.pinnedDb), before);
    assert.deepEqual(install.logs, []);
  } finally {
    install.cleanup();
  }
});

test('uploads already in the state root are never overwritten', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    fs.mkdirSync(path.join(install.serverDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(install.serverDir, 'uploads', UPLOAD), 'from the package');
    fs.mkdirSync(install.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(install.uploadDir, UPLOAD), 'already here');
    assert.equal(adopt(install).status, 'adopted');
    assert.equal(fs.readFileSync(path.join(install.uploadDir, UPLOAD), 'utf8'), 'already here');
  } finally {
    install.cleanup();
  }
});

test('a data folder config.json named is taken over by copying, and left exactly as it is', () => {
  const install = createInstall();
  try {
    const configured = path.join(install.root, 'own-data');
    fs.mkdirSync(install.stateRoot, { recursive: true });
    fs.writeFileSync(path.join(install.stateRoot, 'config.json'), JSON.stringify({ dataDir: configured }));
    writeDatabase(path.join(configured, 'copilot.db'), { marker: 'configured', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'pinned', at: '2026-10-01T09:00:00.000Z' });
    const before = snapshotDir(configured);
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(result.from, configured);
    assert.equal(result.renamedTo, null, 'a user\'s folder is never renamed');
    assert.equal(readMarker(install.pinnedDb), 'configured');
    assert.deepEqual(snapshotDir(configured), before, 'byte for byte, no file added or renamed');
    // Recorded, so it is not offered again while it stays as it is.
    assert.equal(checked(install)[0].outcome, 'adopted');
    assert.equal(adopt(install, { now: () => new Date('2026-10-20T13:00:00.000Z') }).status, 'no-earlier-database');
  } finally {
    install.cleanup();
  }
});

// ─── Refusing ────────────────────────────────────────────────────────────────

test('a copy that fails stops the start with one line, nothing is lost, and it is offered again', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    const pinnedBefore = bytes(install.pinnedDb);
    const earlierBefore = bytes(install.earlierDb);
    const busy = {
      ...fs,
      copyFileSync: (from, to, mode) => {
        if (String(from).startsWith(install.earlierDir)) throw Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${from}'`), { code: 'EBUSY' });
        return fs.copyFileSync(from, to, mode);
      },
    };
    const result = adopt(install, { fsImpl: busy });
    assert.equal(result.status, 'refused');
    assert.match(result.error, /^\[data\] Not starting: its database could not be copied and read \(EBUSY: .*\)\. The relay ran on .+ until now and is pinned to .+; nothing was changed in either\.$/);
    assert.deepEqual(bytes(install.pinnedDb), pinnedBefore);
    assert.deepEqual(bytes(install.earlierDb), earlierBefore);
    assert.ok(noStaging(install));
    assert.ok(!fs.existsSync(path.join(install.dataDir, CHECKED_FILE)), 'not recorded: it was not looked at');
    assert.equal(adopt(install).status, 'adopted', 'offered again once it can be copied');
  } finally {
    install.cleanup();
  }
});

test('a failure while swapping puts the state root\'s database back and takes the uploads it added', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    fs.mkdirSync(path.join(install.serverDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(install.serverDir, 'uploads', UPLOAD), 'new');
    fs.mkdirSync(install.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(install.uploadDir, OTHER_UPLOAD), 'there before');
    const failingPlace = {
      ...fs,
      renameSync: (from, to) => {
        if (String(from).includes('.earlier-database-') && String(from).endsWith('copilot.db')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
        return fs.renameSync(from, to);
      },
    };
    const result = adopt(install, { fsImpl: failingPlace });
    assert.equal(result.status, 'refused');
    assert.match(result.error, /it could not be brought over \(EPERM/);
    assert.equal(readMarker(install.pinnedDb), 'older', 'back in place');
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((name) => name.startsWith('copilot.db')).sort(), ['copilot.db', 'copilot.db-shm', 'copilot.db-wal'].filter((name) => fs.existsSync(path.join(install.dataDir, name))));
    assert.equal(fs.existsSync(path.join(install.uploadDir, UPLOAD)), false, 'the upload it copied is gone again');
    assert.equal(fs.readFileSync(path.join(install.uploadDir, OTHER_UPLOAD), 'utf8'), 'there before');
    assert.equal(fs.existsSync(path.join(install.dataDir, SWAP_JOURNAL_FILE)), false);
    assert.equal(readMarker(install.earlierDb), 'stage-marker', 'the source untouched, not set aside');
  } finally {
    install.cleanup();
  }
});

test('the backup of the pinned database holds every row in its main file, a -wal-only one too', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    // A pinned database whose last row is only in its -wal: copied while the
    // connection that wrote it was still open.
    const hot = path.join(install.root, 'hot', 'copilot.db');
    writeDatabase(hot, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    const writer = new Database(hot);
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare("UPDATE app_settings SET value = 'older-wal-only'").run();
    fs.mkdirSync(install.dataDir, { recursive: true });
    for (const name of ['copilot.db', 'copilot.db-wal', 'copilot.db-shm']) {
      fs.copyFileSync(path.join(path.dirname(hot), name), path.join(install.dataDir, name));
    }
    writer.close();
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    const alone = path.join(install.root, 'alone', 'copilot.db');
    fs.mkdirSync(path.dirname(alone), { recursive: true });
    fs.copyFileSync(path.join(result.backupDir, 'copilot.db'), alone);
    assert.equal(readMarker(alone), 'older-wal-only', 'the main file alone is the whole database');
  } finally {
    install.cleanup();
  }
});

test('a file the indexer holds for a moment is retried', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    let busy = 2;
    const sleeps = [];
    const flaky = {
      ...fs,
      renameSync: (from, to) => {
        if (String(from).includes('.earlier-database-') && String(from).endsWith('copilot.db') && busy > 0) {
          busy -= 1;
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        return fs.renameSync(from, to);
      },
    };
    assert.equal(adopt(install, { fsImpl: flaky, sleep: (ms) => sleeps.push(ms) }).status, 'adopted');
    assert.deepEqual(sleeps, [50, 100]);
    assert.equal(readMarker(install.pinnedDb), 'stage-marker');
  } finally {
    install.cleanup();
  }
});

test('each database newer than the other somewhere: no start, nothing changed or set aside', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'package', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'state', at: '2026-10-01T09:00:00.000Z' });
    const db = new Database(install.pinnedDb);
    db.prepare("UPDATE app_settings SET updated_at = '2026-10-21T09:00:00.000Z'").run();
    db.close();
    const before = bytes(install.pinnedDb);
    const result = adopt(install);
    assert.equal(result.status, 'refused');
    assert.match(result.error, /each database has changes newer than the other's\. Move the files of the one not to go on with \(copilot\.db, copilot\.db-wal, copilot\.db-shm in .+, or copilot\.db, copilot\.db-wal, copilot\.db-shm in .+\) into a folder of your own/);
    assert.deepEqual(bytes(install.pinnedDb), before);
    assert.ok(fs.existsSync(install.earlierDb));
  } finally {
    install.cleanup();
  }
});

test('a refused start leaves every file of the pinned database as it was, its -shm too', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'package', at: '2026-10-20T09:00:00.000Z' });
    // A pinned database with its -wal and -shm on disk, as a relay leaves it
    // when it is stopped hard; newer than the earlier one in one table.
    const hot = path.join(install.root, 'hot', 'copilot.db');
    writeDatabase(hot, { marker: 'state', at: '2026-10-01T09:00:00.000Z' });
    const writer = new Database(hot);
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare("UPDATE app_settings SET updated_at = '2026-10-21T09:00:00.000Z'").run();
    fs.mkdirSync(install.dataDir, { recursive: true });
    for (const name of ['copilot.db', 'copilot.db-wal', 'copilot.db-shm']) {
      fs.copyFileSync(path.join(path.dirname(hot), name), path.join(install.dataDir, name));
    }
    writer.close();
    const before = Object.fromEntries(['copilot.db', 'copilot.db-wal', 'copilot.db-shm'].map((name) => [name, bytes(path.join(install.dataDir, name))]));
    const result = adopt(install);
    assert.equal(result.status, 'refused');
    for (const [name, content] of Object.entries(before)) {
      assert.deepEqual(bytes(path.join(install.dataDir, name)), content, `${name} unchanged`);
    }
    assert.ok(noStaging(install));
  } finally {
    install.cleanup();
  }
});

test('a broken earlier or pinned database is never taken over or replaced', () => {
  for (const broken of ['earlier', 'pinned']) {
    const install = createInstall();
    try {
      writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z', filler: broken === 'earlier' });
      writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z', filler: broken === 'pinned' });
      corrupt(broken === 'earlier' ? install.earlierDb : install.pinnedDb);
      const pinnedBefore = bytes(install.pinnedDb);
      const result = adopt(install);
      assert.equal(result.status, 'refused', broken);
      assert.match(result.error, broken === 'earlier' ? /its database failed its check/ : /the pinned database failed its check/);
      assert.ok(!result.error.includes('\n'), 'one line');
      assert.deepEqual(bytes(install.pinnedDb), pinnedBefore);
    } finally {
      install.cleanup();
    }
  }
});

test('a time that is not a time tells nothing: never newer because it sorts later as text', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'package', at: 'zzz not a time' });
    writeDatabase(install.pinnedDb, { marker: 'state', at: '2026-10-01T09:00:00.000Z' });
    const before = bytes(install.pinnedDb);
    assert.equal(adopt(install).status, 'kept');
    assert.deepEqual(bytes(install.pinnedDb), before);
  } finally {
    install.cleanup();
  }
});

// ─── Whose relay holds the lock ──────────────────────────────────────────────

test('a relay that may still run on the earlier folder stops the start; a stale lock does not', () => {
  const lockedAt = '2026-10-20T08:00:00.000Z';
  const cases = [
    { label: 'alive since the lock', alive: true, startedAt: Date.parse(lockedAt) - 1000, bootTime: 0, refused: true },
    { label: 'alive, start time unknown', alive: true, startedAt: null, bootTime: 0, refused: true },
    { label: 'dead', alive: false, startedAt: null, bootTime: 0, refused: false },
    { label: 'pid reused after the lock', alive: true, startedAt: Date.parse(lockedAt) + 60_000, bootTime: 0, refused: false },
    { label: 'lock from before the last boot', alive: true, startedAt: null, bootTime: Date.parse(lockedAt) + 1000, refused: false },
  ];
  for (const scenario of cases) {
    const install = createInstall();
    try {
      writeDatabase(install.earlierDb, { marker: 'stage-marker', at: '2026-10-20T09:00:00.000Z' });
      fs.writeFileSync(path.join(install.earlierDir, 'relay-server.lock'), JSON.stringify({ pid: 4242, startedAt: lockedAt }));
      const result = adopt(install, {
        isProcessAlive: () => scenario.alive,
        processStartedAt: () => scenario.startedAt,
        bootTime: scenario.bootTime,
      });
      assert.equal(result.status, scenario.refused ? 'refused' : 'adopted', scenario.label);
      if (scenario.refused) assert.match(result.error, /a relay \(pid 4242\) may still run on /);
    } finally {
      install.cleanup();
    }
  }
});

// ─── Left alone ──────────────────────────────────────────────────────────────

test('a checkout, or a relay on folders of its own, is left alone', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'checkout-dev', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'release', at: '2026-10-01T09:00:00.000Z' });
    const before = bytes(install.pinnedDb);
    fs.mkdirSync(path.join(install.packageRoot, '.git'));
    assert.deepEqual(adopt(install), { status: 'not-applicable', reason: 'checkout' });
    fs.rmSync(path.join(install.packageRoot, '.git'), { recursive: true });
    const scratch = path.join(install.root, 'scratch-data');
    assert.deepEqual(adopt(install, {
      dataDir: scratch,
      env: { ...install.env, COPILOT_WEB_RELAY_DATA_DIR: scratch },
    }), { status: 'not-applicable', reason: 'own-folders' });
    assert.deepEqual(bytes(install.pinnedDb), before);
    assert.ok(fs.existsSync(install.earlierDb));
  } finally {
    install.cleanup();
  }
});

test('an earlier folder that is the pinned folder itself is not looked at', () => {
  const install = createInstall();
  try {
    writeDatabase(install.pinnedDb, { marker: 'current', at: '2026-10-20T09:00:00.000Z' });
    fs.mkdirSync(install.stateRoot, { recursive: true });
    fs.writeFileSync(path.join(install.stateRoot, 'config.json'), JSON.stringify({ dataDir: install.dataDir }));
    const before = bytes(install.pinnedDb);
    assert.equal(adopt(install).status, 'no-earlier-database');
    assert.deepEqual(bytes(install.pinnedDb), before);
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((name) => name.startsWith('copilot.db')), ['copilot.db'], 'not set aside');
  } finally {
    install.cleanup();
  }
});

test('a relay on another state root leaves the package\'s database alone, unless the lock is its own', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'real-user-data', at: '2026-10-20T09:00:00.000Z' });
    const isolatedRoot = path.join(install.root, 'isolated');
    const isolated = {
      dataDir: path.join(isolatedRoot, 'data'),
      uploadDir: path.join(isolatedRoot, 'data', 'uploads'),
      env: { ...install.env, OAR_STATE_ROOT: isolatedRoot, COPILOT_WEB_RELAY_DATA_DIR: path.join(isolatedRoot, 'data') },
    };
    assert.equal(adopt(install, isolated).status, 'no-earlier-database');
    assert.ok(!fs.existsSync(path.join(isolatedRoot, 'data', 'copilot.db')));
    const tokenHash = crypto.createHash('sha256').update('own-token').digest('hex');
    fs.writeFileSync(path.join(install.earlierDir, 'relay-server.lock'), JSON.stringify({ pid: 1, tokenHash }));
    assert.equal(adopt(install, { ...isolated, authToken: 'own-token' }).status, 'adopted');
  } finally {
    install.cleanup();
  }
});

test('a relay already running on server/data itself is left alone', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'package', at: '2026-10-20T09:00:00.000Z' });
    assert.deepEqual(adopt(install, {
      dataDir: install.earlierDir,
      env: { APPDATA: install.env.APPDATA },
    }), { status: 'not-applicable', reason: 'own-folders' });
  } finally {
    install.cleanup();
  }
});

// ─── A start after a kill ────────────────────────────────────────────────────

test('a kill after the pinned database moved aside: the next start puts the checked copy in place', () => {
  // R3 as well: the -wal was moved, the main file not yet.
  for (const moved of [['copilot.db', 'copilot.db-wal'], ['copilot.db-wal']]) {
    const install = createInstall();
    try {
      writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
      const staging = path.join(install.dataDir, '.earlier-database-T0-0');
      writeDatabase(path.join(staging, 'copilot.db'), { marker: 'checked-copy', at: '2026-10-20T09:00:00.000Z' });
      const backupDir = path.join(install.stateRoot, 'backups', 'T0');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(install.dataDir, 'copilot.db-wal'), '');
      for (const name of moved) fs.renameSync(path.join(install.dataDir, name), path.join(backupDir, name));
      fs.writeFileSync(path.join(install.dataDir, SWAP_JOURNAL_FILE), JSON.stringify({ stagingDir: staging, backupDir }));

      const result = adopt(install);
      assert.notEqual(result.status, 'refused');
      assert.equal(readMarker(install.pinnedDb), 'checked-copy');
      assert.equal(readMarker(path.join(backupDir, 'copilot.db')), 'older', 'the whole pinned database in one backup');
      assert.ok(fs.existsSync(path.join(backupDir, 'copilot.db-wal')));
      assert.equal(fs.existsSync(path.join(install.dataDir, SWAP_JOURNAL_FILE)), false);
      assert.match(install.logs[0], /^\[data\] Finished bringing over a database an interrupted start left half done/);
    } finally {
      install.cleanup();
    }
  }
});

test('a copy an interrupted run left before its check finished is never taken over', () => {
  const install = createInstall();
  try {
    const leftover = path.join(install.dataDir, '.earlier-database-T0-0');
    writeDatabase(path.join(leftover, 'copilot.db'), { marker: 'unchecked', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'pinned', at: '2026-10-01T09:00:00.000Z' });
    assert.equal(adopt(install).status, 'no-earlier-database');
    assert.equal(readMarker(install.pinnedDb), 'pinned');
    assert.ok(fs.existsSync(path.join(leftover, 'copilot.db')), 'left as it is');
  } finally {
    install.cleanup();
  }
});

test('a copy an interrupted run left, with its source gone, is taken over rather than starting empty', () => {
  const install = createInstall();
  try {
    const leftover = path.join(install.dataDir, '.earlier-database-T0-0');
    writeDatabase(path.join(leftover, 'copilot.db'), { marker: 'only-copy', at: '2026-10-20T09:00:00.000Z' });
    fs.writeFileSync(path.join(leftover, '.checked'), '');
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(readMarker(install.pinnedDb), 'only-copy');
    assert.ok(fs.existsSync(path.join(leftover, `copilot.db.adopted-${STAMP}`)), 'kept, not deleted');
  } finally {
    install.cleanup();
  }
});

// ─── Copies the install-time rescue made ─────────────────────────────────────

test('every rescue copy is looked at in the first start: the newest is in place, with its uploads and Cursor stores', () => {
  const install = createInstall();
  try {
    const rescue = path.join(install.dataDir, RESCUE_DIR_NAME, '2026-10-20T10-00-00-000Z');
    writeDatabase(path.join(rescue, 'data', 'copilot.db'), { marker: 'rescued', at: '2026-10-20T09:00:00.000Z' });
    fs.mkdirSync(path.join(rescue, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(rescue, 'uploads', UPLOAD), 'rescued upload');
    fs.mkdirSync(path.join(rescue, 'data', 'cursor-agents', 'agent-1'), { recursive: true });
    fs.writeFileSync(path.join(rescue, 'data', 'cursor-agents', 'agent-1', 'store.db'), 'store');
    const older = path.join(install.dataDir, RESCUE_DIR_NAME, '2026-10-19T10-00-00-000Z');
    writeDatabase(path.join(older, 'data', 'copilot.db'), { marker: 'older-rescue', at: '2026-10-18T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });

    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(readMarker(install.pinnedDb), 'rescued');
    assert.equal(fs.readFileSync(path.join(install.uploadDir, UPLOAD), 'utf8'), 'rescued upload');
    assert.equal(fs.readFileSync(path.join(install.dataDir, 'cursor-agents', 'agent-1', 'store.db'), 'utf8'), 'store');
    assert.ok(fs.existsSync(path.join(rescue, 'data', `copilot.db.adopted-${STAMP}`)), 'kept in its folder');
    assert.ok(!fs.existsSync(path.join(older, 'data', 'copilot.db')), 'the older rescue was looked at too');
    assert.equal(adopt(install, { now: () => new Date('2026-10-20T14:00:00.000Z') }).status, 'no-earlier-database');
  } finally {
    install.cleanup();
  }
});

test('a stale rescue copy beside the real one never puts the relay on the wrong database (repros B and C)', () => {
  const install = createInstall();
  try {
    // One rescue run, two sources: the real retired package (-0) and a stale
    // folder (-1), older than the state root's database.
    const real = path.join(install.dataDir, RESCUE_DIR_NAME, `${STAMP}-0`);
    const stale = path.join(install.dataDir, RESCUE_DIR_NAME, `${STAMP}-1`);
    writeDatabase(path.join(real, 'data', 'copilot.db'), { marker: 'real', at: '2026-10-15T09:00:00.000Z' });
    writeDatabase(path.join(stale, 'data', 'copilot.db'), { marker: 'stale', at: '2026-06-01T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'pinned', at: '2026-09-01T09:00:00.000Z' });
    // B: the first start runs on the real one.
    assert.equal(adopt(install).status, 'adopted');
    assert.equal(readMarker(install.pinnedDb), 'real');
    // C: that session writes a setting at its exit; the next start goes on.
    const db = new Database(install.pinnedDb);
    db.prepare("UPDATE app_settings SET updated_at = '2026-10-20T13:00:00.000Z'").run();
    db.close();
    const next = adopt(install, { now: () => new Date('2026-10-20T14:00:00.000Z') });
    assert.notEqual(next.status, 'refused');
    assert.equal(readMarker(install.pinnedDb), 'real');
  } finally {
    install.cleanup();
  }
});

test('a rescue copy the rescue did not finish (.partial) is never taken over', () => {
  const install = createInstall();
  try {
    const partial = path.join(install.dataDir, RESCUE_DIR_NAME, `${STAMP}.partial`);
    writeDatabase(path.join(partial, 'data', 'copilot.db'), { marker: 'half', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.pinnedDb, { marker: 'pinned', at: '2026-10-01T09:00:00.000Z' });
    assert.equal(adopt(install).status, 'no-earlier-database');
    assert.equal(readMarker(install.pinnedDb), 'pinned');
    assert.ok(fs.existsSync(path.join(partial, 'data', 'copilot.db')), 'left as it is');
  } finally {
    install.cleanup();
  }
});

// ─── A database the update already removed ───────────────────────────────────

test('a launcher that ran the relay on the package database, with nothing of it found, is said loudly', () => {
  const base = { unpinnedLaunchers: ['launcher.cmd'], serverDir: path.join('pkg', 'server'), dbPath: path.join('state', 'data', 'copilot.db') };
  // With a trace of such a relay it is said as a fact, without one as a may.
  const line = lostPackageDatabaseWarning({ ...base, earlierDatabase: { status: 'no-earlier-database' }, evidence: true });
  assert.match(line, /^\[data\] WARNING: an autostart launcher of an earlier version ran this relay on the database inside the installed package \(.+\), and no copy of it was found: the update removed it with the old version\. This relay runs on .+\. If you saved that folder, see "save your data before this update" in the upgrade notes \(CHANGELOG\.md\)\.$/);
  assert.ok(!line.includes('\n'));
  const maybe = lostPackageDatabaseWarning({ ...base, earlierDatabase: { status: 'no-earlier-database' } });
  assert.match(maybe, /^\[data\] WARNING: an autostart launcher of an earlier version may have run this relay on the database inside the installed package \(.+\), and no copy of it was found: if it did, the update removed it with the old version\./);
  // Started by the old launcher itself, on a database it just made.
  assert.ok(lostPackageDatabaseWarning({ ...base, earlierDatabase: { status: 'not-applicable' }, databaseCreated: true }));
  // Nothing to say: it came over, was older, the relay's database was there
  // already, or no such launcher was found.
  for (const status of ['adopted', 'kept', 'recovered']) {
    assert.equal(lostPackageDatabaseWarning({ ...base, earlierDatabase: { status }, databaseCreated: true }), null, status);
  }
  assert.equal(lostPackageDatabaseWarning({ ...base, earlierDatabase: { status: 'not-applicable' }, databaseCreated: false }), null);
  assert.equal(lostPackageDatabaseWarning({ ...base, unpinnedLaunchers: [], earlierDatabase: { status: 'no-earlier-database' } }), null);
});

test('a trace of a relay inside the package is server/data or server/logs not its own, or a retired folder with data', () => {
  const install = createInstall();
  try {
    const evidence = (ownDirs = []) => packageDatabaseEvidence({ serverDir: install.serverDir, ownDirs, platform: 'win32' });
    assert.equal(evidence(), false, 'a fresh package: no trace');
    fs.mkdirSync(path.join(install.serverDir, 'logs'));
    assert.equal(evidence([path.join(install.serverDir, 'logs')]), false, 'this relay\'s own log folder is no trace');
    assert.equal(evidence(), true);
    fs.rmSync(path.join(install.serverDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(path.dirname(install.packageRoot), '.oar-cli-abcdefgh', 'server', 'data'), { recursive: true });
    assert.equal(evidence(), false, 'another package\'s retired folder');
    fs.mkdirSync(path.join(path.dirname(install.packageRoot), '.oar-AbCd1234', 'server', 'data'), { recursive: true });
    assert.equal(evidence(), true, 'npm\'s retired folder of the old package');
  } finally {
    install.cleanup();
  }
});

// ─── Kills at every write ────────────────────────────────────────────────────

// An fs that dies at its Nth write: that call and every later one throw, as
// nothing more is written after a kill. (SQLite's own writes to the copy
// and the checkpoint of the pinned database are not counted.)
function dyingFs(killAt) {
  let writes = 0;
  const write = (call) => (...args) => {
    writes += 1;
    if (writes >= killAt) throw Object.assign(new Error('killed'), { code: 'EKILLED' });
    return call(...args);
  };
  return {
    fsImpl: {
      ...fs,
      copyFileSync: write(fs.copyFileSync),
      renameSync: write(fs.renameSync),
      writeFileSync: write(fs.writeFileSync),
      mkdirSync: write(fs.mkdirSync),
      rmSync: write(fs.rmSync),
    },
    writes: () => writes,
  };
}

function seedPackageLayout(install) {
  writeDatabase(install.earlierDb, { marker: 'package-newer', at: '2026-10-20T09:00:00.000Z' });
  writeDatabase(install.pinnedDb, { marker: 'pinned-older', at: '2026-10-01T09:00:00.000Z' });
  fs.mkdirSync(path.join(install.serverDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(install.serverDir, 'uploads', UPLOAD), 'upload');
  fs.mkdirSync(path.join(install.earlierDir, 'cursor-agents', 'agent-1'), { recursive: true });
  fs.writeFileSync(path.join(install.earlierDir, 'cursor-agents', 'agent-1', 'store.db'), 'store');
}

test('a kill at any write of the first adopting start: the next starts end with the newer database, its uploads and Cursor stores', () => {
  const counting = createInstall();
  let total;
  try {
    seedPackageLayout(counting);
    const { fsImpl, writes } = dyingFs(Infinity);
    assert.equal(adopt(counting, { fsImpl }).status, 'adopted');
    total = writes();
  } finally {
    counting.cleanup();
  }
  assert.ok(total >= 12, `a full run writes ${total} times`);
  for (let killAt = 1; killAt <= total; killAt += 1) {
    const install = createInstall();
    try {
      seedPackageLayout(install);
      try { adopt(install, { fsImpl: dyingFs(killAt).fsImpl }); } catch {}
      let last;
      for (const hour of [13, 14]) last = adopt(install, { now: () => new Date(`2026-10-20T${hour}:00:00.000Z`) });
      assert.notEqual(last.status, 'refused', `kill at write ${killAt}: ${last.error || ''}`);
      assert.equal(readMarker(install.pinnedDb), 'package-newer', `kill at write ${killAt}`);
      assert.equal(fs.readFileSync(path.join(install.uploadDir, UPLOAD), 'utf8'), 'upload', `kill at write ${killAt}: upload`);
      assert.equal(fs.readFileSync(path.join(install.dataDir, 'cursor-agents', 'agent-1', 'store.db'), 'utf8'), 'store', `kill at write ${killAt}: Cursor store`);
    } finally {
      install.cleanup();
    }
  }
});

test('the journal is on disk before the pinned database moves aside', () => {
  const install = createInstall();
  try {
    seedPackageLayout(install);
    const seenAtMove = [];
    const watching = {
      ...fs,
      renameSync: (from, to) => {
        if (String(from) === install.pinnedDb) seenAtMove.push(fs.existsSync(path.join(install.dataDir, SWAP_JOURNAL_FILE)));
        return fs.renameSync(from, to);
      },
    };
    assert.equal(adopt(install, { fsImpl: watching }).status, 'adopted');
    assert.deepEqual(seenAtMove, [true]);
    assert.equal(fs.existsSync(path.join(install.dataDir, SWAP_JOURNAL_FILE)), false, 'and gone once the copy is in place');
  } finally {
    install.cleanup();
  }
});

test('a journal with neither the copy nor a database in place puts the pinned database back', () => {
  const install = createInstall();
  try {
    const backupDir = path.join(install.stateRoot, 'backups', 'T0');
    writeDatabase(path.join(backupDir, 'copilot.db'), { marker: 'moved-aside', at: '2026-10-01T09:00:00.000Z' });
    fs.mkdirSync(install.dataDir, { recursive: true });
    fs.writeFileSync(path.join(install.dataDir, SWAP_JOURNAL_FILE), JSON.stringify({
      stagingDir: path.join(install.dataDir, '.earlier-database-T0-0'), backupDir,
    }));
    assert.notEqual(adopt(install).status, 'refused');
    assert.equal(readMarker(install.pinnedDb), 'moved-aside', 'back in place, not an empty database');
    assert.equal(fs.existsSync(path.join(install.dataDir, SWAP_JOURNAL_FILE)), false);
  } finally {
    install.cleanup();
  }
});

// ─── The two names (0.9.20: oar.db, copilot.db before) ───────────────────────

// A copy of `writeDatabase`'s database whose last change is only in its
// -wal, under `file` (any name): the -wal pairs by name, so it is copied as
// `<file>-wal`.
function writeHotWal(install, file, { marker, at, walValue }) {
  const hot = path.join(install.root, `hot-${crypto.randomUUID()}`, 'source.db');
  writeDatabase(hot, { marker, at });
  const writer = new Database(hot);
  try {
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare("UPDATE app_settings SET value = ? WHERE key = 'relay_name'").run(walValue);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(hot, file);
    fs.copyFileSync(`${hot}-wal`, `${file}-wal`);
  } finally {
    writer.close();
  }
}

test('a rescue copy holding oar.db is a candidate too; with no database pinned it keeps its name', () => {
  const install = createInstall();
  try {
    const rescue = path.join(install.dataDir, RESCUE_DIR_NAME, '2026-10-20T10-00-00-000Z');
    writeDatabase(path.join(rescue, 'data', 'oar.db'), { marker: 'rescued-oar', at: '2026-10-20T09:00:00.000Z' });
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(result.dbPath, path.join(install.dataDir, 'oar.db'));
    assert.equal(readMarker(path.join(install.dataDir, 'oar.db')), 'rescued-oar');
    assert.equal(fs.existsSync(install.pinnedDb), false, 'no copilot.db made');
    assert.ok(fs.existsSync(path.join(rescue, 'data', `oar.db.adopted-${STAMP}`)), 'set aside under its own name');
  } finally {
    install.cleanup();
  }
});

test('no database pinned: a copilot.db brought over stays copilot.db, so an earlier version still runs on it', () => {
  const install = createInstall();
  try {
    writeDatabase(install.earlierDb, { marker: 'package', at: '2026-10-20T09:00:00.000Z' });
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(result.dbPath, install.pinnedDb);
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((name) => name.startsWith('oar.db')), []);
  } finally {
    install.cleanup();
  }
});

test('a pinned oar.db and a newer copilot.db: it comes in as oar.db with its -wal rows, the old oar.db to backups/<time>/', () => {
  const install = createInstall();
  try {
    const pinnedOar = path.join(install.dataDir, 'oar.db');
    writeDatabase(pinnedOar, { marker: 'pinned-oar', at: '2026-10-01T09:00:00.000Z' });
    writeHotWal(install, install.earlierDb, { marker: 'package', at: '2026-10-20T09:00:00.000Z', walValue: 'package-wal-only' });
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(result.dbPath, pinnedOar);
    assert.equal(readMarker(pinnedOar), 'package-wal-only', 'the copy took its -wal along under the new name');
    assert.deepEqual(fs.readdirSync(install.dataDir).filter((name) => name.startsWith('copilot.db')), []);
    assert.equal(readMarker(path.join(result.backupDir, 'oar.db')), 'pinned-oar', 'the old one under its own name');
    // Set aside checkpointed: no -wal left, its rows in its main file (read
    // after the look at the folder: opening it makes a -wal again).
    assert.deepEqual(fs.readdirSync(install.earlierDir).filter((name) => name.endsWith('-wal')), []);
    assert.equal(readMarker(path.join(install.earlierDir, `copilot.db.adopted-${STAMP}`)), 'package-wal-only');
    assert.match(install.logs.join('\n'), /to .*oar\.db/);
  } finally {
    install.cleanup();
  }
});

test('a pinned copilot.db and a newer oar.db in the package: it comes in as copilot.db', () => {
  const install = createInstall();
  try {
    writeDatabase(install.pinnedDb, { marker: 'pinned', at: '2026-10-01T09:00:00.000Z' });
    writeDatabase(path.join(install.earlierDir, 'oar.db'), { marker: 'package-oar', at: '2026-10-20T09:00:00.000Z' });
    const result = adopt(install);
    assert.equal(result.status, 'adopted');
    assert.equal(readMarker(install.pinnedDb), 'package-oar');
    assert.equal(fs.existsSync(path.join(install.dataDir, 'oar.db')), false);
    assert.ok(fs.existsSync(path.join(install.earlierDir, `oar.db.adopted-${STAMP}`)));
  } finally {
    install.cleanup();
  }
});

test('the refusal for two databases each newer somewhere names the files by their names', () => {
  const install = createInstall();
  try {
    writeDatabase(path.join(install.dataDir, 'oar.db'), { marker: 'pinned', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.earlierDb, { marker: 'package', at: '2026-10-01T09:00:00.000Z' });
    const db = new Database(install.earlierDb);
    db.prepare("UPDATE app_settings SET updated_at = '2026-10-25T09:00:00.000Z'").run();
    db.close();
    const result = adopt(install);
    assert.equal(result.status, 'refused');
    assert.match(result.error, /\(copilot\.db, copilot\.db-wal, copilot\.db-shm in .*, or oar\.db, oar\.db-wal, oar\.db-shm in .*\)/);
  } finally {
    install.cleanup();
  }
});

test('the journal names the database; a kill after the pinned oar.db moved aside ends with the copy as oar.db', () => {
  const install = createInstall();
  try {
    const pinnedOar = path.join(install.dataDir, 'oar.db');
    writeDatabase(pinnedOar, { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    const staging = path.join(install.dataDir, '.earlier-database-T0-0');
    writeDatabase(path.join(staging, 'oar.db'), { marker: 'checked-copy', at: '2026-10-20T09:00:00.000Z' });
    const backupDir = path.join(install.stateRoot, 'backups', 'T0');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.renameSync(pinnedOar, path.join(backupDir, 'oar.db'));
    fs.writeFileSync(path.join(install.dataDir, SWAP_JOURNAL_FILE), JSON.stringify({ stagingDir: staging, backupDir, dbName: 'oar.db' }));
    assert.notEqual(adopt(install).status, 'refused');
    assert.equal(readMarker(pinnedOar), 'checked-copy');
    assert.equal(fs.existsSync(install.pinnedDb), false, 'no copilot.db');
  } finally {
    install.cleanup();
  }
});

test('a journal naming oar.db with neither the copy nor a database in place puts the pinned oar.db back', () => {
  const install = createInstall();
  try {
    const backupDir = path.join(install.stateRoot, 'backups', 'T0');
    writeDatabase(path.join(backupDir, 'oar.db'), { marker: 'moved-aside', at: '2026-10-01T09:00:00.000Z' });
    fs.mkdirSync(install.dataDir, { recursive: true });
    fs.writeFileSync(path.join(install.dataDir, SWAP_JOURNAL_FILE), JSON.stringify({
      stagingDir: path.join(install.dataDir, '.earlier-database-T0-0'), backupDir, dbName: 'oar.db',
    }));
    assert.notEqual(adopt(install).status, 'refused');
    assert.equal(readMarker(path.join(install.dataDir, 'oar.db')), 'moved-aside');
  } finally {
    install.cleanup();
  }
});

test('the journal written during a swap carries the name the database goes in as', () => {
  const install = createInstall();
  try {
    writeDatabase(path.join(install.dataDir, 'oar.db'), { marker: 'older', at: '2026-10-01T09:00:00.000Z' });
    writeDatabase(install.earlierDb, { marker: 'package', at: '2026-10-20T09:00:00.000Z' });
    let journal = null;
    const fsImpl = {
      ...fs,
      renameSync: (from, to) => {
        const file = path.join(install.dataDir, SWAP_JOURNAL_FILE);
        if (!journal && fs.existsSync(file)) journal = JSON.parse(fs.readFileSync(file, 'utf8'));
        return fs.renameSync(from, to);
      },
    };
    assert.equal(adopt(install, { fsImpl }).status, 'adopted');
    assert.equal(journal?.dbName, 'oar.db');
  } finally {
    install.cleanup();
  }
});

test('a candidate set aside moves its main file last; a reader that blocks the checkpoint leaves it in place', () => {
  const install = createInstall();
  try {
    writeDatabase(install.pinnedDb, { marker: 'current', at: '2026-10-20T09:00:00.000Z' });
    writeDatabase(install.earlierDb, { marker: 'old-package', at: '2026-10-01T09:00:00.000Z' });
    fs.writeFileSync(`${install.earlierDb}-shm`, Buffer.alloc(32768));
    const order = [];
    const fsImpl = { ...fs, renameSync: (from, to) => { if (path.dirname(from) === install.earlierDir) order.push(path.basename(from)); return fs.renameSync(from, to); } };
    assert.equal(adopt(install, { fsImpl }).status, 'kept');
    assert.equal(order.at(-1), 'copilot.db', 'the main file last');

    const second = createInstall();
    try {
      writeDatabase(second.pinnedDb, { marker: 'current', at: '2026-10-20T09:00:00.000Z' });
      writeDatabase(second.earlierDb, { marker: 'old-package', at: '2026-10-01T09:00:00.000Z' });
      const writer = new Database(second.earlierDb);
      writer.pragma('wal_autocheckpoint = 0');
      writer.prepare("UPDATE app_settings SET value = 'x'").run();
      const reader = new Database(second.earlierDb, { readonly: true });
      reader.prepare('BEGIN').run();
      reader.prepare('SELECT 1 FROM app_settings').get();
      try {
        const result = adopt(second);
        assert.equal(result.renamedTo, null, 'not renamed while a reader holds its -wal');
        assert.ok(fs.existsSync(second.earlierDb));
      } finally {
        reader.prepare('COMMIT').run();
        reader.close();
        writer.close();
      }
    } finally {
      second.cleanup();
    }
  } finally {
    install.cleanup();
  }
});

test('a candidate folder whose database name is a link to nothing is skipped, as before 0.9.20', { skip: process.platform === 'win32' }, () => {
  const install = createInstall();
  try {
    writeDatabase(install.pinnedDb, { marker: 'current', at: '2026-10-20T09:00:00.000Z' });
    fs.mkdirSync(install.earlierDir, { recursive: true });
    fs.symlinkSync(path.join(install.root, 'gone.db'), install.earlierDb);
    assert.equal(adopt(install).status, 'no-earlier-database');
  } finally {
    install.cleanup();
  }
});
