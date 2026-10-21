import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ensureDataDirs, resolveDataDir, resolveUploadDir } from './data-dir-resolution.mjs';

// Fixed literals per the hygiene guard's placeholder-host convention; the
// platform's path semantics are injected via path.win32, never read from the
// host.
const SERVER_DIR = 'C:\\Users\\dev\\oar\\server';
const CONFIG = 'C:\\Users\\dev\\AppData\\Roaming\\oar\\config.json';

function fakeFs(files) {
  return {
    readFileSync: (p) => {
      if (Object.hasOwn(files, String(p))) return files[String(p)];
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  };
}

test('the env var wins over everything', () => {
  const dir = resolveDataDir({
    env: { COPILOT_WEB_RELAY_DATA_DIR: 'C:\\Users\\dev\\elsewhere\\data' },
    configPath: CONFIG,
    serverDir: SERVER_DIR,
    fsImpl: fakeFs({ [CONFIG]: '{"dataDir":"C:\\\\Users\\\\dev\\\\ignored"}' }),
    pathImpl: path.win32,
  });
  assert.equal(dir, 'C:\\Users\\dev\\elsewhere\\data');
});

test('an absolute dataDir in config.json is used as-is', () => {
  const dir = resolveDataDir({
    env: {},
    configPath: CONFIG,
    serverDir: SERVER_DIR,
    fsImpl: fakeFs({ [CONFIG]: '{"dataDir":"C:\\\\Users\\\\dev\\\\AppData\\\\Roaming\\\\oar\\\\data"}' }),
    pathImpl: path.win32,
  });
  assert.equal(dir, 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data');
});

test('a relative dataDir resolves against the config directory, not cwd', () => {
  const dir = resolveDataDir({
    env: {},
    configPath: CONFIG,
    serverDir: SERVER_DIR,
    fsImpl: fakeFs({ [CONFIG]: '{"dataDir":"data"}' }),
    pathImpl: path.win32,
  });
  assert.equal(dir, 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data');
});

test('no env, no config key: the server directory default', () => {
  for (const contents of ['{}', '{"dataDir":""}', '{"dataDir":"   "}', 'not json']) {
    const dir = resolveDataDir({
      env: {},
      configPath: CONFIG,
      serverDir: SERVER_DIR,
      fsImpl: fakeFs({ [CONFIG]: contents }),
      pathImpl: path.win32,
    });
    assert.equal(dir, 'C:\\Users\\dev\\oar\\server\\data', `contents: ${contents}`);
  }
});

test('a missing config file falls through to the default without throwing', () => {
  const dir = resolveDataDir({
    env: {},
    configPath: CONFIG,
    serverDir: SERVER_DIR,
    fsImpl: fakeFs({}),
    pathImpl: path.win32,
  });
  assert.equal(dir, 'C:\\Users\\dev\\oar\\server\\data');
});

test('uploads follow a data dir the env var or config.json chose', () => {
  const chosen = 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data';
  assert.equal(
    resolveUploadDir({ dataDir: chosen, env: { COPILOT_WEB_RELAY_DATA_DIR: chosen }, serverDir: SERVER_DIR, pathImpl: path.win32 }),
    'C:\\Users\\dev\\AppData\\Roaming\\oar\\data\\uploads',
  );
  assert.equal(
    resolveUploadDir({ dataDir: chosen, env: {}, serverDir: SERVER_DIR, pathImpl: path.win32 }),
    'C:\\Users\\dev\\AppData\\Roaming\\oar\\data\\uploads',
  );
  // Pinned to the server's own data dir by the env var: inside it, as before.
  assert.equal(
    resolveUploadDir({
      dataDir: 'C:\\Users\\dev\\oar\\server\\data',
      env: { COPILOT_WEB_RELAY_DATA_DIR: 'C:\\Users\\dev\\oar\\server\\data' },
      serverDir: SERVER_DIR,
      pathImpl: path.win32,
    }),
    'C:\\Users\\dev\\oar\\server\\data\\uploads',
  );
});

test('the server directory default keeps uploads beside data/, in <server>/uploads', () => {
  assert.equal(
    resolveUploadDir({ dataDir: 'C:\\Users\\dev\\oar\\server\\data', env: {}, serverDir: SERVER_DIR, pathImpl: path.win32 }),
    'C:\\Users\\dev\\oar\\server\\uploads',
  );
});

test('on win32 the server default is recognised whatever the case of the path', () => {
  assert.equal(
    resolveUploadDir({
      dataDir: 'c:\\users\\DEV\\oar\\SERVER\\data',
      env: {},
      serverDir: SERVER_DIR,
      pathImpl: path.win32,
      platform: 'win32',
    }),
    'C:\\Users\\dev\\oar\\server\\uploads',
  );
});

// ─── Creating the folders at startup ─────────────────────────────────────────

// `files`: paths that are files; `mkdirErrors`: path → the code mkdir fails with.
function startupFs({ missingDrive = null, files = [], mkdirErrors = {} } = {}) {
  const made = [];
  const fail = (code, call, dir) => Object.assign(new Error(`${code}: failed, ${call} '${dir}'`), { code });
  return {
    made,
    statSync: (dir) => {
      if (files.includes(String(dir))) return { isDirectory: () => false };
      if (made.some(([known]) => known === String(dir))) return { isDirectory: () => true };
      throw fail('ENOENT', 'stat', dir);
    },
    mkdirSync: (dir, options) => {
      if (missingDrive && String(dir).toUpperCase().startsWith(missingDrive)) throw fail('ENOENT', 'mkdir', dir);
      if (mkdirErrors[String(dir)]) throw fail(mkdirErrors[String(dir)], 'mkdir', dir);
      made.push([String(dir), options]);
    },
  };
}

function startupRun(fsImpl, { dataDir = 'R:\\oar\\data', uploadDir = 'R:\\oar\\data\\uploads' } = {}) {
  const errors = [];
  const exits = [];
  const ok = ensureDataDirs({
    dataDir,
    uploadDir,
    fsImpl,
    logger: { error: (line) => errors.push(line) },
    exit: (code) => exits.push(code),
  });
  return { ok, errors, exits };
}

// One line, exit code 1, and nothing created after the failure.
function assertStopped({ ok, errors, exits }, pattern) {
  assert.equal(ok, false);
  assert.deepEqual(exits, [78]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], pattern);
  assert.ok(!errors[0].includes('\n'), 'one line, no stack');
}

test('the data and upload folders are created, the data folder private', () => {
  const fsImpl = startupFs();
  const { ok, errors, exits } = startupRun(fsImpl);
  assert.equal(ok, true);
  assert.deepEqual(fsImpl.made, [
    ['R:\\oar\\data', { recursive: true, mode: 0o700 }],
    ['R:\\oar\\data\\uploads', { recursive: true }],
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(exits, []);
});

test('a missing data drive ends the start with one line naming the folder and a non-zero exit', () => {
  const fsImpl = startupFs({ missingDrive: 'R:\\' });
  const { ok, errors, exits } = startupRun(fsImpl);
  assert.equal(ok, false);
  assert.deepEqual(exits, [78]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /R:\\oar\\data/);
  assert.match(errors[0], /drive/);
  assert.ok(!errors[0].includes('\n'), 'one line, no stack');
  // Nothing anywhere else: the data must not go to another folder.
  assert.deepEqual(fsImpl.made, []);
});

test('folders that are there already are left as they are', () => {
  const fsImpl = startupFs();
  assert.equal(startupRun(fsImpl).ok, true);
  const before = [...fsImpl.made];
  assert.equal(startupRun(fsImpl).ok, true);
  assert.deepEqual(fsImpl.made, before, 'no second mkdir');
});

test('a file where a folder belongs is named, not passed over', () => {
  for (const file of ['R:\\oar\\data', 'R:\\oar\\data\\uploads']) {
    const fsImpl = startupFs({ files: [file] });
    const run = startupRun(fsImpl);
    assertStopped(run, new RegExp(`^\\[startup\\] ${file.replaceAll('\\', '\\\\')} is a file, not a folder\\. Exiting with code 78\\.$`));
    assert.ok(!fsImpl.made.some(([dir]) => dir === file));
  }
  // A file above the folder: mkdir fails with ENOTDIR, same reason.
  const run = startupRun(startupFs({ mkdirErrors: { 'R:\\oar\\data\\uploads': 'ENOTDIR' } }));
  assertStopped(run, /^\[startup\] Cannot create R:\\oar\\data\\uploads: it or a folder above it is a file, not a folder\. Exiting with code 78\.$/);
});

test('a folder it may not create is named with the error', () => {
  const fsImpl = startupFs({ mkdirErrors: { 'R:\\oar\\data\\uploads': 'EACCES' } });
  const run = startupRun(fsImpl);
  assertStopped(run, /^\[startup\] Cannot create R:\\oar\\data\\uploads: EACCES: .*\. Exiting with code 78\.$/);
  assert.deepEqual(fsImpl.made.map(([dir]) => dir), ['R:\\oar\\data']);
});

test('on Windows, a drive letter that does not exist reads as a missing drive', { skip: process.platform !== 'win32' }, () => {
  const letter = 'QPONMLKJ'.split('').find((candidate) => !fs.existsSync(`${candidate}:\\`));
  assert.ok(letter, 'a free drive letter');
  const dataDir = `${letter}:\\oar\\data`;
  const run = startupRun(fs, { dataDir, uploadDir: `${dataDir}\\uploads` });
  assertStopped(run, new RegExp(`^\\[startup\\] Cannot create ${letter}:\\\\oar\\\\data: its drive or a folder above it is missing\\.`));
});
