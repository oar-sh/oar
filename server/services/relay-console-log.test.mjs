import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  RELAY_CONSOLE_LOG_FILE,
  installRelayConsoleLog,
  resolveRelayConsoleLogPath,
} from './relay-console-log.mjs';

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-console-log-'));
  const logPath = path.join(dir, 'logs', RELAY_CONSOLE_LOG_FILE);
  const shown = [];
  const consoleImpl = {
    log: (...args) => shown.push(['log', ...args]),
    warn: (...args) => shown.push(['warn', ...args]),
    error: (...args) => shown.push(['error', ...args]),
  };
  const processImpl = new EventEmitter();
  let tick = Date.parse('2026-09-20T10:00:00.000Z');
  const installed = installRelayConsoleLog({
    logPath,
    env: {},
    consoleImpl,
    processImpl,
    now: () => new Date(tick++),
    ...options,
  });
  const read = (file = logPath) => fs.readFileSync(file, 'utf8');
  const cleanup = () => {
    installed?.uninstall();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, logPath, shown, consoleImpl, processImpl, installed, read, cleanup };
}

test('what the relay writes to its console is kept in the file, and still shown', () => {
  const { consoleImpl, shown, read, cleanup } = setup();
  try {
    consoleImpl.log('[server] listening on %d', 3333);
    consoleImpl.warn('\u001b[33mslow request\u001b[0m');
    consoleImpl.error('first line\nsecond line');
    assert.deepEqual(shown, [
      ['log', '[server] listening on %d', 3333],
      ['warn', '\u001b[33mslow request\u001b[0m'],
      ['error', 'first line\nsecond line'],
    ], 'the console gets exactly what it was given');
    assert.deepEqual(read().split('\n'), [
      '2026-09-20T10:00:00.000Z [server] listening on 3333',
      '2026-09-20T10:00:00.001Z WARN slow request',
      '2026-09-20T10:00:00.002Z ERROR first line',
      '2026-09-20T10:00:00.002Z ERROR second line',
      '',
    ]);
  } finally {
    cleanup();
  }
});

test('a token is never written: not the relay\'s own and not one in a link', () => {
  const { consoleImpl, installed, read, cleanup } = setup();
  try {
    installed.setSecrets(['s3cret-relay-token', '', 'ab']);
    consoleImpl.log('open https://relay-a.example.test/?token=s3cret-relay-token&conv=c-1');
    consoleImpl.log('pairing offered other-relay-token-value via ?token=other-relay-token-value');
    consoleImpl.error(new Error('request failed: Bearer s3cret-relay-token'));
    const text = read();
    assert.equal(text.includes('s3cret-relay-token'), false);
    assert.match(text, /\?token=\[token\]&conv=c-1/);
    assert.match(text, /via \?token=\[token\]/);
    assert.match(text, /Bearer \[token\]/);

    // A token that changes while the relay runs is covered from then on.
    let current = 'first-relay-token';
    installed.setSecrets(() => [current]);
    current = 'rotated-relay-token';
    consoleImpl.log('now using rotated-relay-token');
    assert.equal(read().includes('rotated-relay-token'), false);
  } finally {
    cleanup();
  }
});

test('the file is rotated at its size limit and the oldest copy is dropped', () => {
  const { consoleImpl, logPath, read, cleanup } = setup({ maxBytes: 200, keep: 2 });
  try {
    for (let index = 0; index < 12; index += 1) consoleImpl.log(`line ${index} ${'x'.repeat(40)}`);
    assert.ok(fs.statSync(logPath).size <= 200);
    assert.ok(fs.existsSync(`${logPath}.1`));
    assert.ok(fs.existsSync(`${logPath}.2`));
    assert.equal(fs.existsSync(`${logPath}.3`), false);
    assert.match(read(), /line 11 /, 'the newest line is in the current file');
    assert.doesNotMatch(read() + read(`${logPath}.1`) + read(`${logPath}.2`), /line 0 /, 'the oldest lines went with the oldest copy');
  } finally {
    cleanup();
  }
});

test('a console that was replaced is wrapped again, once', () => {
  const { consoleImpl, shown, installed, read, cleanup } = setup();
  try {
    // A terminal console takes the methods over.
    const taken = (...args) => shown.push(['terminal', ...args]);
    consoleImpl.log = taken;
    consoleImpl.log('lost to the file');
    installed.rewrap();
    installed.rewrap();
    consoleImpl.log('kept again');
    assert.deepEqual(shown.map((entry) => entry[0]), ['terminal', 'terminal']);
    assert.deepEqual(read().trim().split('\n').map((line) => line.replace(/^\S+ /, '')), ['kept again']);
  } finally {
    cleanup();
  }
});

test('an uncaught error reaches the file, and uninstall gives the console back', () => {
  const { consoleImpl, processImpl, installed, read, cleanup } = setup();
  try {
    const wrapped = consoleImpl.log;
    processImpl.emit('uncaughtExceptionMonitor', new Error('the lantern went out'), 'uncaughtException');
    assert.match(read(), /ERROR uncaughtException: Error: the lantern went out/);
    installed.uninstall();
    assert.notEqual(consoleImpl.log, wrapped);
    consoleImpl.log('after uninstall');
    assert.doesNotMatch(read(), /after uninstall/);
  } finally {
    cleanup();
  }
});

test('it can be switched off, and a file that cannot be opened stops nothing', () => {
  const off = setup({ env: { OAR_NO_CONSOLE_LOG: '1' } });
  try {
    assert.equal(off.installed, null);
    assert.equal(fs.existsSync(off.logPath), false);
  } finally {
    off.cleanup();
  }
  const broken = installRelayConsoleLog({
    logPath: '/home/dev/logs/relay-console.log',
    env: {},
    consoleImpl: { log() {} },
    processImpl: new EventEmitter(),
    fsImpl: { mkdirSync() { throw new Error('read-only'); } },
  });
  assert.equal(broken, null);
});

test('the log goes where the relay keeps its logs', () => {
  const pathImpl = path.posix;
  assert.equal(
    resolveRelayConsoleLogPath({ env: {}, serverDir: '/home/dev/relay/server', pathImpl }),
    '/home/dev/relay/server/logs/relay-console.log',
  );
  assert.equal(
    resolveRelayConsoleLogPath({ env: { COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/relay-data' }, serverDir: '/home/dev/relay/server', pathImpl }),
    '/home/dev/relay-data/logs/relay-console.log',
  );
  assert.equal(
    resolveRelayConsoleLogPath({
      env: { COPILOT_WEB_RELAY_LOG_DIR: '/home/dev/relay-logs', COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/relay-data' },
      serverDir: '/home/dev/relay/server',
      pathImpl,
    }),
    '/home/dev/relay-logs/relay-console.log',
  );
});
