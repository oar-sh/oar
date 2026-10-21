import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { RESCUE_DIR_NAME, adoptEarlierDatabase, lostPackageDatabaseWarning } from './earlier-database-service.mjs';
import { npmRetiredPath, rescuePackageData } from './package-data-rescue.mjs';
import { scratchEnv, useScratchProcessEnv } from './scratch-env-test-harness.mjs';

// Home and state folders of this process point into a scratch folder.
useScratchProcessEnv();

const UPLOAD = 'a'.repeat(64);
const DATA_UPLOAD = 'c'.repeat(64);
const NOW = new Date('2026-10-20T12:00:00.000Z');
const STAMP = '2026-10-20T12-00-00-000Z';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A global prefix in the middle of `npm i -g`: the new package in place, the
// one it replaces moved aside by npm under its retire name, as 0.9.13 left
// it (database, -wal and Cursor stores in server/data, uploads in
// server/uploads), and a default state root (APPDATA\oar).
function createUpdate({ oldDatabase = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-rescue-'));
  const packageRoot = path.join(root, 'prefix', 'node_modules', '@oar-sh', 'oar');
  const retired = npmRetiredPath(packageRoot);
  const appData = path.join(root, 'appdata');
  const setup = {
    root,
    packageRoot,
    retired,
    oldServer: path.join(retired, 'server'),
    env: { APPDATA: appData },
    dataDir: path.join(appData, 'oar', 'data'),
    logs: [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(setup.oldServer, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(setup.oldServer, 'uploads', UPLOAD), 'upload in server/uploads');
  if (oldDatabase) {
    writeDatabase(path.join(setup.oldServer, 'data', 'copilot.db'), 'stage-marker');
    fs.mkdirSync(path.join(setup.oldServer, 'data', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(setup.oldServer, 'data', 'uploads', DATA_UPLOAD), 'upload in server/data/uploads');
    fs.mkdirSync(path.join(setup.oldServer, 'data', 'cursor-agents', 'agent-1'), { recursive: true });
    fs.writeFileSync(path.join(setup.oldServer, 'data', 'cursor-agents', 'agent-1', 'store.db'), 'store');
    fs.writeFileSync(path.join(setup.oldServer, 'config.json'), '{"port":3333}');
  }
  return setup;
}

function writeDatabase(file, marker) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  applySchema(db);
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('relay_name', ?, '2026-10-20T09:00:00.000Z')").run(marker);
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', ?, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z')").run(marker);
  db.close();
}

function readMarker(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT value FROM app_settings WHERE key = 'relay_name'").get()?.value ?? null;
  } finally {
    db.close();
  }
}

// Every file under a folder, with its bytes.
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .filter((entry) => fs.statSync(path.join(dir, entry)).isFile())
    .sort()
    .map((entry) => [entry, fs.readFileSync(path.join(dir, entry)).toString('base64')]);
}

// A module and the modules its static relative imports reach, repo-relative.
function importClosure(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const match of text.matchAll(/(?:^import\s[^'"]*|\bimport\()['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  return [...seen];
}

function rescue(setup, overrides = {}) {
  return rescuePackageData({
    packageRoot: setup.packageRoot,
    env: setup.env,
    platform: 'win32',
    now: () => NOW,
    logger: { log: (line) => setup.logs.push(line) },
    ...overrides,
  });
}

test('the retired name is the one npm gives a package it replaces', () => {
  // @npmcli/arborist lib/retire-path.js: sha1 of the path, base64, letters
  // and digits only, 8 of them.
  const dir = path.join(path.sep, 'prefix', 'node_modules', '@oar-sh', 'oar');
  const retired = npmRetiredPath(dir);
  assert.equal(path.dirname(retired), path.dirname(path.resolve(dir)));
  assert.match(path.basename(retired), /^\.oar-[a-zA-Z0-9]{8}$/);
});

test('the update from 0.9.13: database, uploads of both places, Cursor stores and config are copied, nothing else changes', () => {
  const setup = createUpdate();
  try {
    const before = snapshot(setup.retired);
    const result = rescue(setup);
    assert.equal(result.status, 'rescued');
    const target = path.join(setup.dataDir, RESCUE_DIR_NAME, STAMP);
    assert.deepEqual(result.rescued, [{ from: setup.oldServer, to: target }]);
    assert.equal(readMarker(path.join(target, 'data', 'copilot.db')), 'stage-marker');
    assert.equal(fs.readFileSync(path.join(target, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
    assert.equal(fs.readFileSync(path.join(target, 'uploads', DATA_UPLOAD), 'utf8'), 'upload in server/data/uploads');
    assert.equal(fs.readFileSync(path.join(target, 'data', 'cursor-agents', 'agent-1', 'store.db'), 'utf8'), 'store');
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"port":3333}');
    assert.match(fs.readFileSync(path.join(target, 'README.txt'), 'utf8'), /Nothing here is deleted by OAR/);
    assert.deepEqual(snapshot(setup.retired), before, 'the old package byte for byte');
    assert.equal(setup.logs.length, 1);
    assert.match(setup.logs[0], /^\[oar\] Copied the data of the version being replaced from .+ to .+; the relay takes it over at its next start\.$/);
  } finally {
    setup.cleanup();
  }
});

test('the first pinned start after the update takes the rescued marker database over', () => {
  const setup = createUpdate();
  try {
    rescue(setup);
    // The new package has no server/data of its own; the state root has an
    // older database from a plain `oar start` before autostart.
    writeDatabase(path.join(setup.dataDir, 'copilot.db'), 'older');
    const db = new Database(path.join(setup.dataDir, 'copilot.db'));
    db.prepare("UPDATE app_settings SET updated_at = '2026-10-01T09:00:00.000Z'").run();
    db.prepare("UPDATE conversations SET updated_at = '2026-10-01T09:00:00.000Z'").run();
    db.close();
    const logs = [];
    const result = adoptEarlierDatabase({
      dataDir: setup.dataDir,
      uploadDir: path.join(setup.dataDir, 'uploads'),
      serverDir: path.join(setup.packageRoot, 'server'),
      configPath: path.join(setup.dataDir, '..', 'config.json'),
      packageRoot: setup.packageRoot,
      Database,
      env: { ...setup.env, COPILOT_WEB_RELAY_DATA_DIR: setup.dataDir },
      platform: 'win32',
      isProcessAlive: () => false,
      processStartedAt: () => null,
      bootTime: 0,
      now: () => new Date('2026-10-20T12:30:00.000Z'),
      logger: { log: (line) => logs.push(line) },
      sleep: () => {},
    });
    assert.equal(result.status, 'adopted');
    assert.equal(readMarker(path.join(setup.dataDir, 'copilot.db')), 'stage-marker');
    assert.equal(fs.readFileSync(path.join(setup.dataDir, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
    assert.equal(fs.readFileSync(path.join(setup.dataDir, 'uploads', DATA_UPLOAD), 'utf8'), 'upload in server/data/uploads');
    assert.equal(fs.readFileSync(path.join(setup.dataDir, 'cursor-agents', 'agent-1', 'store.db'), 'utf8'), 'store');
    assert.ok(fs.existsSync(path.join(setup.dataDir, RESCUE_DIR_NAME, STAMP, 'README.txt')), 'the rescue folder stays');
  } finally {
    setup.cleanup();
  }
});

test('without anything of a relay (only the files the package ships) nothing is copied or printed', () => {
  const setup = createUpdate({ oldDatabase: false });
  try {
    fs.rmSync(path.join(setup.oldServer, 'uploads', UPLOAD));
    for (const name of ['README.md', 'image_input.md']) fs.writeFileSync(path.join(setup.oldServer, 'uploads', name), 'shipped');
    assert.equal(rescue(setup).status, 'nothing');
    assert.equal(fs.existsSync(setup.dataDir), false);
    assert.deepEqual(setup.logs, []);
  } finally {
    setup.cleanup();
  }
});

// The first pinned start of the new version, on the state root's data folder.
function firstStart(setup, overrides = {}) {
  return adoptEarlierDatabase({
    dataDir: setup.dataDir,
    uploadDir: path.join(setup.dataDir, 'uploads'),
    serverDir: path.join(setup.packageRoot, 'server'),
    configPath: path.join(setup.dataDir, '..', 'config.json'),
    packageRoot: setup.packageRoot,
    Database,
    env: { ...setup.env, COPILOT_WEB_RELAY_DATA_DIR: setup.dataDir },
    platform: 'win32',
    isProcessAlive: () => false,
    processStartedAt: () => null,
    bootTime: 0,
    now: () => new Date('2026-10-20T12:30:00.000Z'),
    logger: { log: (line) => setup.logs.push(line) },
    sleep: () => {},
    ...overrides,
  });
}

test('a package with uploads and no database anywhere: its uploads are copied, and the first start serves them', () => {
  const setup = createUpdate({ oldDatabase: false });
  try {
    const result = rescue(setup);
    assert.equal(result.status, 'rescued');
    const target = path.join(setup.dataDir, RESCUE_DIR_NAME, STAMP);
    assert.equal(fs.readFileSync(path.join(target, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
    assert.equal(fs.existsSync(path.join(target, 'data', 'copilot.db')), false);
    assert.equal(firstStart(setup).status, 'files');
    // Where the relay serves uploads from (resolveUploadDir: <data>/uploads).
    assert.equal(fs.readFileSync(path.join(setup.dataDir, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
    assert.match(setup.logs.at(-1), /^\[data\] Copied 1 upload\(s\) and 0 Cursor file\(s\) of .+ where missing\.$/);
    // Looked at: not copied again.
    setup.logs.length = 0;
    firstStart(setup, { now: () => new Date('2026-10-20T13:00:00.000Z') });
    assert.deepEqual(setup.logs, []);
  } finally {
    setup.cleanup();
  }
});

test('uploads of a rescue copy that could not be copied at the first start are tried again at the next', () => {
  const setup = createUpdate({ oldDatabase: false });
  try {
    rescue(setup);
    const failing = { ...fs, copyFileSync: () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); } };
    firstStart(setup, { fsImpl: failing });
    assert.equal(fs.existsSync(path.join(setup.dataDir, 'uploads', UPLOAD)), false);
    firstStart(setup, { now: () => new Date('2026-10-20T13:00:00.000Z') });
    assert.equal(fs.readFileSync(path.join(setup.dataDir, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
  } finally {
    setup.cleanup();
  }
});

test('the database in a configured dataDir, the uploads in the package (0.9.13): both come over, the user folder stays byte for byte', () => {
  const setup = createUpdate({ oldDatabase: false });
  try {
    const ownData = path.join(setup.root, 'oar-own-data');
    writeDatabase(path.join(ownData, 'copilot.db'), 'own-data');
    fs.mkdirSync(path.dirname(setup.dataDir), { recursive: true });
    fs.writeFileSync(path.join(setup.dataDir, '..', 'config.json'), JSON.stringify({ dataDir: ownData }));
    const ownBefore = snapshot(ownData);
    rescue(setup);
    const result = firstStart(setup);
    assert.equal(result.status, 'adopted');
    assert.equal(readMarker(path.join(setup.dataDir, 'copilot.db')), 'own-data');
    assert.equal(fs.readFileSync(path.join(setup.dataDir, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads', 'served');
    assert.deepEqual(snapshot(ownData), ownBefore, 'the user folder byte for byte');
  } finally {
    setup.cleanup();
  }
});

test('a package with uploads only whose copy fails stops the install: exit 1', () => {
  const setup = createUpdate({ oldDatabase: false });
  try {
    const run = installEntry(setup);
    fs.writeFileSync(path.join(setup.root, 'blocked'), '');
    const failed = run({ OAR_STATE_ROOT: path.join(setup.root, 'blocked', 'oar') });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^\[oar\] Could not copy the data of the version being replaced .+\r?\n$/);
    const failing = { ...fs, copyFileSync: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } };
    assert.throws(() => rescue(setup, { fsImpl: failing }), (error) => error.rescueCopyFailed === true);
  } finally {
    setup.cleanup();
  }
});

// An old package with nothing of a relay but `what`.
function onlyThis(what) {
  const setup = createUpdate({ oldDatabase: false });
  fs.rmSync(path.join(setup.oldServer, 'uploads', UPLOAD));
  what(setup.oldServer);
  return setup;
}

test('a file in server/uploads whose name is not a sha256 is no upload: nothing is copied', () => {
  for (const name of ['a'.repeat(63), 'a'.repeat(65), 'abc123']) {
    const setup = onlyThis((server) => fs.writeFileSync(path.join(server, 'uploads', name), 'not an upload'));
    try {
      assert.equal(rescue(setup).status, 'nothing', name);
    } finally {
      setup.cleanup();
    }
  }
});

test('a package with only uploads in server/data/uploads, only config.json or only Cursor stores is rescued', () => {
  const cases = [
    ['server/data/uploads', (server) => {
      fs.mkdirSync(path.join(server, 'data', 'uploads'), { recursive: true });
      fs.writeFileSync(path.join(server, 'data', 'uploads', DATA_UPLOAD), 'data upload');
    }, (target) => fs.readFileSync(path.join(target, 'uploads', DATA_UPLOAD), 'utf8') === 'data upload'],
    ['server/config.json', (server) => fs.writeFileSync(path.join(server, 'config.json'), '{"port":3333}'),
      (target) => fs.readFileSync(path.join(target, 'config.json'), 'utf8') === '{"port":3333}'],
    ['server/data/cursor-agents', (server) => {
      fs.mkdirSync(path.join(server, 'data', 'cursor-agents', 'agent-1'), { recursive: true });
      fs.writeFileSync(path.join(server, 'data', 'cursor-agents', 'agent-1', 'store.db'), 'store');
    }, (target) => fs.readFileSync(path.join(target, 'data', 'cursor-agents', 'agent-1', 'store.db'), 'utf8') === 'store'],
  ];
  for (const [label, what, copied] of cases) {
    const setup = onlyThis(what);
    try {
      assert.equal(rescue(setup).status, 'rescued', label);
      assert.ok(copied(path.join(setup.dataDir, RESCUE_DIR_NAME, STAMP)), label);
    } finally {
      setup.cleanup();
    }
  }
});

test('Cursor stores of a rescue copy that could not be copied at the first start are tried again at the next', () => {
  const setup = onlyThis((server) => {
    fs.mkdirSync(path.join(server, 'data', 'cursor-agents', 'agent-1'), { recursive: true });
    fs.writeFileSync(path.join(server, 'data', 'cursor-agents', 'agent-1', 'store.db'), 'store');
  });
  try {
    rescue(setup);
    const failing = { ...fs, copyFileSync: () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); } };
    firstStart(setup, { fsImpl: failing });
    const store = path.join(setup.dataDir, 'cursor-agents', 'agent-1', 'store.db');
    assert.equal(fs.existsSync(store), false);
    firstStart(setup, { now: () => new Date('2026-10-20T13:00:00.000Z') });
    assert.equal(fs.readFileSync(store, 'utf8'), 'store');
  } finally {
    setup.cleanup();
  }
});

test('a start that took only uploads over, on a database it created, does not say a database was lost', () => {
  const setup = createUpdate({ oldDatabase: false });
  try {
    rescue(setup);
    const earlierDatabase = firstStart(setup);
    assert.equal(earlierDatabase.status, 'files');
    assert.equal(lostPackageDatabaseWarning({
      unpinnedLaunchers: ['an earlier launcher'], earlierDatabase, databaseCreated: true, evidence: true,
      serverDir: path.join(setup.packageRoot, 'server'), dbPath: path.join(setup.dataDir, 'copilot.db'),
    }), null);
  } finally {
    setup.cleanup();
  }
});

test('in a checkout it does nothing', () => {
  const setup = createUpdate();
  try {
    assert.equal(rescue(setup, { packageRoot: repoRoot }).status, 'not-installed');
    assert.equal(fs.existsSync(setup.dataDir), false);
    assert.deepEqual(setup.logs, []);
  } finally {
    setup.cleanup();
  }
});

test('on Linux (and macOS, the same code path): the gh copilot relay\'s database and upload are copied and taken over', () => {
  const setup = createUpdate();
  try {
    // A plain `gh copilot` relay before 0.9.14: database and upload in
    // <prefix>/lib/node_modules/@oar-sh/oar/server, state root ~/.oar.
    const stateRoot = path.join(setup.root, 'home', '.oar');
    const env = { OAR_STATE_ROOT: stateRoot };
    const before = snapshot(setup.retired);
    const result = rescue(setup, { platform: 'linux', env });
    assert.equal(result.status, 'rescued');
    const target = path.join(stateRoot, 'data', RESCUE_DIR_NAME, STAMP);
    assert.equal(result.rescued[0].to, target);
    assert.equal(readMarker(path.join(target, 'data', 'copilot.db')), 'stage-marker');
    assert.equal(fs.readFileSync(path.join(target, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
    assert.deepEqual(snapshot(setup.retired), before, 'the source untouched');
    const dataDir = path.join(stateRoot, 'data');
    const taken = adoptEarlierDatabase({
      dataDir,
      uploadDir: path.join(dataDir, 'uploads'),
      serverDir: path.join(setup.packageRoot, 'server'),
      configPath: path.join(stateRoot, 'config.json'),
      packageRoot: setup.packageRoot,
      Database,
      env: { ...env, COPILOT_WEB_RELAY_DATA_DIR: dataDir },
      platform: 'linux',
      isProcessAlive: () => false,
      processStartedAt: () => null,
      bootTime: 0,
      now: () => new Date('2026-10-20T12:30:00.000Z'),
      logger: {},
      sleep: () => {},
    });
    assert.equal(taken.status, 'adopted');
    assert.equal(readMarker(path.join(dataDir, 'copilot.db')), 'stage-marker');
    assert.equal(fs.readFileSync(path.join(dataDir, 'uploads', UPLOAD), 'utf8'), 'upload in server/uploads');
  } finally {
    setup.cleanup();
  }
});

test('only npm\'s retired folder for this package is rescued: not another package\'s, not a stray one (repro D)', () => {
  const setup = createUpdate();
  try {
    const scope = path.dirname(setup.packageRoot);
    const plant = (name, marker) => writeDatabase(path.join(scope, name, 'server', 'data', 'copilot.db'), marker);
    plant('.oar-cli-abcdefgh', 'other-package');
    plant('.oar-zzzzzzzz', 'stray');
    // The exact retired path is there: it alone is copied.
    const result = rescue(setup);
    assert.deepEqual(result.rescued.map(({ from }) => from), [setup.oldServer]);
    // Without it, only names npm gives are looked at: the stray one is
    // npm-shaped, the other package's is not.
    fs.rmSync(setup.retired, { recursive: true });
    const scan = rescue(setup, { now: () => new Date('2026-10-20T13:00:00.000Z') });
    assert.deepEqual(scan.rescued.map(({ from }) => path.basename(path.dirname(from))), ['.oar-zzzzzzzz']);
  } finally {
    setup.cleanup();
  }
});

test('a copy that fails throws, naming what to save, and leaves no rescue to take over', () => {
  const setup = createUpdate();
  try {
    const before = snapshot(setup.retired);
    const failing = {
      ...fs,
      copyFileSync: (from, to, mode) => {
        if (String(from).endsWith('copilot.db')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return fs.copyFileSync(from, to, mode);
      },
    };
    assert.throws(() => rescue(setup, { fsImpl: failing }), (error) => {
      assert.equal(error.rescueCopyFailed, true, 'the marked failure the entry exits 1 for');
      assert.match(error.message, /^Could not copy the data of the version being replaced \(.+\) to .+: ENOSPC: no space left on device\. The update stops and the version installed stays as it is; copy .+data and .+uploads somewhere safe by hand, then update again\.$/);
      return true;
    });
    assert.deepEqual(snapshot(setup.retired), before, 'nothing deleted or moved');
    const rescues = fs.readdirSync(path.join(setup.dataDir, RESCUE_DIR_NAME));
    assert.ok(rescues.every((name) => name.endsWith('.partial')), 'only a .partial folder, never offered');
  } finally {
    setup.cleanup();
  }
});

// The installed package as npm runs its preinstall: the entry and every
// module it reaches, found by following its imports (static and dynamic).
const PREINSTALL = 'server/services/package-data-rescue-preinstall.mjs';
function installEntry(setup) {
  for (const file of [...importClosure(PREINSTALL), 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(setup.packageRoot, file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), path.join(setup.packageRoot, file));
  }
  return (env) => spawnSync(process.execPath, [path.join(setup.packageRoot, PREINSTALL)], {
    cwd: setup.packageRoot,
    env: scratchEnv(setup.root, env),
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('as npm runs it: exit 0 and quiet without an old database, exit 1 and one line when the copy fails', () => {
  const setup = createUpdate();
  try {
    const run = installEntry(setup);
    // The state root cannot be made: a file where its folder belongs.
    fs.writeFileSync(path.join(setup.root, 'blocked'), '');
    const failed = run({ OAR_STATE_ROOT: path.join(setup.root, 'blocked', 'oar') });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /^\[oar\] Could not copy the data of the version being replaced .+\r?\n$/);
    assert.equal(failed.stderr.trim().split(/\r?\n/).length, 1);
    const ok = run({ OAR_STATE_ROOT: path.join(setup.root, 'state') });
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /^\[oar\] Copied the data of the version being replaced/);
    fs.rmSync(setup.retired, { recursive: true });
    const nothing = run({ OAR_STATE_ROOT: path.join(setup.root, 'state') });
    assert.equal(nothing.status, 0);
    assert.equal(`${nothing.stdout}${nothing.stderr}`, '');
  } finally {
    setup.cleanup();
  }
});

test('a module that cannot load never fails the install: one line, exit 0', () => {
  const broken = [
    ['a module it imports is missing', (setup) => fs.rmSync(path.join(setup.packageRoot, 'server', 'services', 'earlier-database-service.mjs'))],
    ['a module throws as it loads', (setup) => fs.appendFileSync(path.join(setup.packageRoot, 'server', 'services', 'oar-state-layout.mjs'), '\nthrow new Error("broken at load");\n')],
    ['a TypeError in a dependency at load', (setup) => fs.appendFileSync(path.join(setup.packageRoot, 'server', 'services', 'relay-singleton-guard.mjs'), '\nnull.boom;\n')],
  ];
  for (const [label, breakIt] of broken) {
    const setup = createUpdate();
    try {
      const run = installEntry(setup);
      breakIt(setup);
      const result = run({ OAR_STATE_ROOT: path.join(setup.root, 'state') });
      assert.equal(result.status, 0, label);
      assert.match(result.stderr, /^\[oar\] Did not copy the data of the version being replaced: .+\r?\n$/, label);
    } finally {
      setup.cleanup();
    }
  }
});

test('once an old database is found, failing to tell where to copy it stops the install too', () => {
  const setup = createUpdate();
  try {
    const before = snapshot(setup.retired);
    // The environment cannot be read: the data folder cannot be resolved.
    const env = new Proxy({}, { get() { throw new Error('environment unreadable'); }, has() { throw new Error('environment unreadable'); } });
    assert.throws(() => rescue(setup, { env }), (error) => {
      assert.equal(error.rescueCopyFailed, true, 'exit 1: npm puts the old package back');
      assert.match(error.message, /environment unreadable/);
      return true;
    });
    assert.deepEqual(snapshot(setup.retired), before);
  } finally {
    setup.cleanup();
  }
});

test('failing to look for an old package is no copy failure: the install goes on', () => {
  const setup = createUpdate();
  try {
    const blind = { ...fs, existsSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    assert.throws(() => rescue(setup, { fsImpl: blind }), (error) => {
      assert.notEqual(error.rescueCopyFailed, true, 'exit 0, one line');
      assert.match(error.message, /^Could not look for the data of the version being replaced: EACCES/);
      return true;
    });
  } finally {
    setup.cleanup();
  }
});
