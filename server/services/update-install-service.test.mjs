import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  UPDATE_ATTEMPT_SETTING_KEY,
  UPDATE_OUTCOME_SETTING_KEY,
  createUpdateInstallService,
  reconcileUpdateAttempt,
} from './update-install-service.mjs';

function settingsStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    readSetting: (key) => rows.get(key) || '',
    writeSetting: (key, value) => rows.set(key, String(value)),
    deleteSetting: (key) => rows.delete(key),
  };
}

/** A fake npm process the test scripts: emits output, then exits. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.exitCode = null;
  child.pid = 4242;
  child.kill = () => { child.emit('close', null); };
  return child;
}

function createService(store, { exitCode = 0, output = ['added 1 package'], ...overrides } = {}) {
  const spawned = [];
  const shutdowns = [];
  const events = [];
  const service = createUpdateInstallService({
    runningVersion: '0.9.1',
    installMethod: 'npm-global',
    env: {},
    platform: 'linux',
    readSetting: store.readSetting,
    writeSetting: (key, value) => { events.push(`write:${key}`); store.writeSetting(key, value); },
    deleteSetting: store.deleteSetting,
    requestRelayShutdown: (options) => { events.push('shutdown'); shutdowns.push(options); },
    // Short delays (the 250ms log flush) run on the microtask queue; long ones
    // (runToCompletion's 10-min timeout) never fire.
    setTimeoutImpl: (fn, delay) => { if (delay <= 1000) queueMicrotask(fn); return { unref: () => {} }; },
    clearTimeoutImpl: () => {},
    spawnImpl: (command, args) => {
      spawned.push([command, ...args]);
      const child = fakeChild();
      queueMicrotask(() => {
        for (const chunk of output) child.stdout.emit('data', Buffer.from(chunk));
        child.exitCode = exitCode;
        child.emit('close', exitCode);
      });
      return child;
    },
    logger: { warn: () => {} },
    ...overrides,
  });
  return { service, spawned, shutdowns, events };
}

test('a successful update persists the attempt before requesting the restart', async () => {
  const store = settingsStore();
  const { service, spawned, shutdowns, events } = createService(store);
  const result = await service.startUpdate({ version: '0.9.2' });
  assert.equal(result.ok, true);
  assert.deepEqual(spawned, [['npm', 'install', '-g', '@oar-sh/oar@0.9.2']]);
  assert.equal(shutdowns.length, 1);
  assert.equal(shutdowns[0].restart, true);

  const attempt = JSON.parse(store.rows.get(UPDATE_ATTEMPT_SETTING_KEY));
  assert.equal(attempt.attemptedVersion, '0.9.2');
  assert.equal(attempt.fromVersion, '0.9.1');
  assert.match(attempt.logTail, /added 1 package/);

  const attemptWriteIndex = events.indexOf(`write:${UPDATE_ATTEMPT_SETTING_KEY}`);
  const shutdownIndex = events.indexOf('shutdown');
  assert.ok(attemptWriteIndex >= 0 && attemptWriteIndex < shutdownIndex, 'attempt row lands before the restart request');

  const snapshot = service.getSnapshot();
  assert.equal(snapshot.state, 'success');
  assert.ok(snapshot.logSeq > 0);
  assert.match(snapshot.log, /added 1 package/);
});

test('an npm failure keeps the log, writes no attempt, requests no restart', async () => {
  const store = settingsStore();
  const { service, shutdowns } = createService(store, { exitCode: 1, output: ['npm ERR! EACCES'] });
  const result = await service.startUpdate({ version: '0.9.2' });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 500);
  assert.equal(shutdowns.length, 0);
  assert.equal(store.rows.has(UPDATE_ATTEMPT_SETTING_KEY), false);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.state, 'error');
  assert.match(snapshot.log, /EACCES/);
});

test('git checkouts, bad versions, and disabled spawns are refused up front', async () => {
  const store = settingsStore();
  const { service: checkoutService, spawned } = createService(store, { installMethod: 'git-checkout' });
  const checkout = await checkoutService.startUpdate({ version: '0.9.2' });
  assert.equal(checkout.statusCode, 400);
  assert.match(checkout.error, /git checkout/);
  assert.deepEqual(spawned, []);

  const { service: badVersionService } = createService(store);
  const bad = await badVersionService.startUpdate({ version: '0.9.2; rm -rf /' });
  assert.equal(bad.statusCode, 400);

  const { service: disabledService } = createService(store, { env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' } });
  const disabled = await disabledService.startUpdate({ version: '0.9.2' });
  assert.equal(disabled.statusCode, 503);
});

test('a second start while running is a 409 single-flight rejection', async () => {
  const store = settingsStore();
  let releaseChild = null;
  const { service } = createService(store, {
    spawnImpl: () => {
      const child = fakeChild();
      releaseChild = () => { child.exitCode = 0; child.emit('close', 0); };
      return child;
    },
  });
  const first = service.startUpdate({ version: '0.9.2' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await service.startUpdate({ version: '0.9.3' });
  assert.equal(second.statusCode, 409);
  releaseChild();
  await first;
});

test('win32 spawns npm.cmd through a shell', async () => {
  const store = settingsStore();
  const commands = [];
  const { service } = createService(store, {
    platform: 'win32',
    spawnImpl: (command, args, options) => {
      commands.push({ command, shell: options.shell === true });
      const child = fakeChild();
      queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    },
  });
  await service.startUpdate({ version: '0.9.2' });
  assert.deepEqual(commands, [{ command: 'npm.cmd', shell: true }]);
});

test('reconcile: matching version becomes a success outcome and clears the attempt', () => {
  const store = settingsStore({
    [UPDATE_ATTEMPT_SETTING_KEY]: JSON.stringify({
      attemptedVersion: '0.9.2', fromVersion: '0.9.1', startedAt: '2026-09-05T11:59:00Z', logTail: 'ok',
    }),
  });
  const outcome = reconcileUpdateAttempt({
    ...store, runningVersion: '0.9.2', nowMs: Date.parse('2026-09-05T12:00:00Z'),
  });
  assert.equal(outcome.status, 'success');
  assert.equal(store.rows.has(UPDATE_ATTEMPT_SETTING_KEY), false);
  assert.equal(JSON.parse(store.rows.get(UPDATE_OUTCOME_SETTING_KEY)).status, 'success');
});

test('reconcile: an unchanged version becomes a failure carrying the npm log tail', () => {
  const store = settingsStore({
    [UPDATE_ATTEMPT_SETTING_KEY]: JSON.stringify({
      attemptedVersion: '0.9.2', fromVersion: '0.9.1', startedAt: '2026-09-05T11:59:00Z', logTail: 'npm output here',
    }),
  });
  const outcome = reconcileUpdateAttempt({
    ...store, runningVersion: '0.9.1', nowMs: Date.parse('2026-09-05T12:00:00Z'),
  });
  assert.equal(outcome.status, 'failure');
  assert.equal(outcome.logTail, 'npm output here');
  assert.equal(store.rows.has(UPDATE_ATTEMPT_SETTING_KEY), false, 'the attempt settles exactly once');
});

test('reconcile: stale or absent attempts settle quietly with no outcome', () => {
  const empty = settingsStore();
  assert.equal(reconcileUpdateAttempt({ ...empty, runningVersion: '0.9.1' }), null);

  // The default window is a week: queue-idle restarts can defer for hours, so
  // only genuinely ancient leftovers drop without an outcome.
  const stale = settingsStore({
    [UPDATE_ATTEMPT_SETTING_KEY]: JSON.stringify({
      attemptedVersion: '0.9.2', fromVersion: '0.9.1', startedAt: '2026-08-01T00:00:00Z', logTail: 'old',
    }),
  });
  const outcome = reconcileUpdateAttempt({
    ...stale, runningVersion: '0.9.1', nowMs: Date.parse('2026-09-05T12:00:00Z'),
  });
  assert.equal(outcome, null);
  assert.equal(stale.rows.has(UPDATE_ATTEMPT_SETTING_KEY), false);
  assert.equal(stale.rows.has(UPDATE_OUTCOME_SETTING_KEY), false);
});

test('reconcile: a v-prefixed manifest version still matches the installed package.json', () => {
  const store = settingsStore({
    [UPDATE_ATTEMPT_SETTING_KEY]: JSON.stringify({
      attemptedVersion: 'v0.9.2', fromVersion: '0.9.1', startedAt: '2026-09-05T11:59:00Z', logTail: 'ok',
    }),
  });
  const outcome = reconcileUpdateAttempt({
    ...store, runningVersion: '0.9.2', nowMs: Date.parse('2026-09-05T12:00:00Z'),
  });
  assert.equal(outcome.status, 'success', 'triple-equality, not string-equality');
});

test('clearOutcome removes a persisted outcome', () => {
  const store = settingsStore({ [UPDATE_OUTCOME_SETTING_KEY]: JSON.stringify({ status: 'failure' }) });
  const { service } = createService(store);
  assert.equal(service.getSnapshot().lastOutcome.status, 'failure');
  service.clearOutcome();
  assert.equal(service.getSnapshot().lastOutcome, null);
});
