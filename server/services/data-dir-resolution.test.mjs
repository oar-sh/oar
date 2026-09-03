import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveDataDir } from './data-dir-resolution.mjs';

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
