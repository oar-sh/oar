import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_SDK_LEASES_DIR,
  AGENT_SDK_MARKER,
  AGENT_SDK_STORE_FORMAT,
  agentSdkCheckedFiles,
  isValidAgentSdkInstall,
  platformPackageFor,
  readAgentSdkMarker,
  readAgentSdkPin,
  writeAgentSdkLease,
} from './agent-sdk-paths.mjs';
import {
  AGENT_SDK_STATUS_SETTING_KEY,
  agentSdkNpmArgs,
  agentSdkNpmEnv,
  classifyAgentSdkFailure,
  createAgentSdkStore,
} from './agent-sdk-store.mjs';
import { CLI_SPAWN_DISABLED_ERROR } from './cli-process-runner.mjs';

// Fictional pins, hosts and pids throughout: the pins folders, the host and
// the platform are passed in, npm is a fake that writes the files `npm ci`
// would, and every folder is a temp folder removed at the end.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sdk-store-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const LINUX_X64 = Object.freeze({ platform: 'linux', arch: 'x64', libc: 'glibc' });
const LINUX_ARM64 = Object.freeze({ platform: 'linux', arch: 'arm64', libc: 'glibc' });
const WIN32_X64 = Object.freeze({ platform: 'win32', arch: 'x64', libc: null });
const STORE_PID = 31_337;
const INSTALL_TIMEOUT_MS = 999_000;
const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 15_000]);
const NPM_ENOTFOUND = 'npm error code ENOTFOUND\nnpm error network request to https://registry.example.test/@cursor%2fsdk failed\n';

const PIN_FIXTURES = {
  claude: {
    dependencies: { '@anthropic-ai/claude-agent-sdk': '0.2.10' },
    platformPackages: {
      '@anthropic-ai/claude-agent-sdk-linux-x64': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
      '@anthropic-ai/claude-agent-sdk-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
    },
    entries: { 'entry.mjs': "export * from '@anthropic-ai/claude-agent-sdk';\n" },
  },
  cursor: {
    dependencies: { '@cursor/sdk': '1.4.2', 'tiny-schema': '3.1.0' },
    platformPackages: {
      '@cursor/sdk-linux-x64': { os: ['linux'], cpu: ['x64'] },
      '@cursor/sdk-win32-x64': { os: ['win32'], cpu: ['x64'] },
    },
    entries: {
      'entry.mjs': "export * from '@cursor/sdk';\n",
      'entry-sqlite.mjs': "export { openStore } from '@cursor/sdk/sqlite';\n",
    },
  },
  koffi: {
    dependencies: { koffi: '2.9.1' },
    platformPackages: { '@koromix/koffi-win32-x64': { os: ['win32'], cpu: ['x64'] } },
    entries: { 'entry.cjs': "module.exports = require('koffi');\n" },
  },
};

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The pins as the package ships them: pin.json and pin-lock.json.
function writePins(pinsDir) {
  for (const [id, fixture] of Object.entries(PIN_FIXTURES)) {
    const folder = path.join(pinsDir, id);
    writeJson(path.join(folder, 'pin.json'), { name: `fixture-${id}`, version: '0.0.0', private: true, dependencies: fixture.dependencies });
    const packages = { '': { name: `fixture-${id}`, version: '0.0.0', dependencies: fixture.dependencies } };
    for (const [name, version] of Object.entries(fixture.dependencies)) packages[`node_modules/${name}`] = { version };
    for (const [name, constraints] of Object.entries(fixture.platformPackages)) {
      packages[`node_modules/${name}`] = { version: '1.0.0', optional: true, ...constraints };
    }
    writeJson(path.join(folder, 'pin-lock.json'), { name: `fixture-${id}`, lockfileVersion: 3, requires: true, packages });
    for (const [name, text] of Object.entries(fixture.entries)) fs.writeFileSync(path.join(folder, name), text);
  }
}

/** A finished install as another process would leave it (marker last). */
function writeInstall(root, pin, { name = pin.dirName, installedAt = '2026-03-01T10:00:00.000Z', marker = {} } = {}) {
  const dir = path.join(root, pin.id, name);
  const files = {};
  for (const rel of agentSdkCheckedFiles(pin)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pin.files[rel] || `{"name":"${rel}"}\n`);
    files[rel] = fs.statSync(file).size;
  }
  writeJson(path.join(dir, AGENT_SDK_MARKER), {
    format: AGENT_SDK_STORE_FORMAT,
    id: pin.id,
    version: pin.version,
    hash: pin.hash,
    platform: pin.host.platform,
    arch: pin.host.arch,
    libc: pin.host.libc || null,
    platformPackage: platformPackageFor(pin),
    installedAt,
    files,
    ...marker,
  });
  return dir;
}

function matches(list, value) {
  return !Array.isArray(list) || list.includes(value);
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Real disk work happens in between (the fsync of a new folder on POSIX, the
// deletes): bounded by time, not by a number of turns of the event loop.
async function waitFor(predicate, label = 'condition', timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** Fake child process: the events the runner listens for. */
function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.killSignals = [];
  child.kill = (signal) => { child.killSignals.push(signal); return true; };
  child.exit = (code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code === null ? 143 : code;
    child.emit('close', code);
  };
  return child;
}

/**
 * Fake npm. Each spawn takes the next behaviour (default 'ok'):
 *   'ok'           writes node_modules as `npm ci` would, then exits 0
 *   'no-platform'  the same without the host's platform package
 *   'hang'         never exits by itself (exits when killed)
 *   { fail: text } prints npm's error text, exits 1
 */
function createFakeNpm(host) {
  const calls = [];
  const kills = [];
  const behaviors = [];
  function writeTree(cwd, { platformPackage }) {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      writeJson(path.join(cwd, 'node_modules', ...name.split('/'), 'package.json'), { name, version });
    }
    if (!platformPackage) return;
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!entry.os) continue;
      if (!matches(entry.os, host.platform) || !matches(entry.cpu, host.arch) || (entry.libc && !matches(entry.libc, host.libc))) continue;
      const name = key.slice('node_modules/'.length);
      const base = path.join(cwd, 'node_modules', ...name.split('/'));
      writeJson(path.join(base, 'package.json'), { name, version: entry.version });
      fs.writeFileSync(path.join(base, 'README.md'), '# vendor build\n');
      fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(base, 'bin', 'agent'), Buffer.alloc(96, 7));
    }
  }
  const taskkills = [];
  const taskkillCommands = [];
  function spawnImpl(command, args, options) {
    // The Windows tree kill, not an npm run.
    if (/(^|[\\/])taskkill(\.exe)?$/i.test(String(command))) {
      taskkills.push(args);
      taskkillCommands.push(command);
      return { on() {}, unref() {} };
    }
    const behavior = behaviors.shift() || 'ok';
    const child = createFakeChild(40_000 + calls.length);
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (behavior === 'hang') return;
      if (behavior === 'ok' || behavior === 'no-platform') {
        writeTree(options.cwd, { platformPackage: behavior === 'ok' });
        child.stdout.emit('data', Buffer.from('\nadded 4 packages in 2s\n'));
        child.exit(0);
        return;
      }
      child.stderr.emit('data', Buffer.from(behavior.fail));
      child.exit(1);
    });
    return child;
  }
  // Signals a process group: a fake child in it exits on SIGTERM.
  function kill(pid, signal) {
    kills.push([pid, signal]);
    const child = calls.map((call) => call.child).find((candidate) => candidate.pid === Math.abs(pid));
    if (child && signal === 'SIGTERM') setImmediate(() => child.exit(null));
    return true;
  }
  return { calls, kills, taskkills, taskkillCommands, behaviors, spawnImpl, kill, next: (...items) => behaviors.push(...items) };
}

/** Manual timers: retries, timeouts and log flushes fire on demand. */
function createManualTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    setTimeoutImpl(fn, ms) {
      const id = (nextId += 1);
      pending.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(handle) {
      if (handle) pending.delete(handle.id);
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
    fire(ms) {
      let fired = 0;
      for (const [id, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
        fired += 1;
      }
      return fired;
    },
  };
}

/** In-process stand-in for the cross-process lock; `block` = held elsewhere. */
function createFakeLocks() {
  const held = new Set();
  const state = { blocked: false, acquired: 0 };
  return {
    held,
    state,
    factory: (lockPath) => ({
      acquire() {
        if (state.blocked || held.has(lockPath)) throw Object.assign(new Error('held'), { code: 'ERELAYLOCKED' });
        held.add(lockPath);
        state.acquired += 1;
      },
      release() { held.delete(lockPath); },
    }),
  };
}

/**
 * One store folder layout (pins, root, settings) that several store
 * instances can share, as relay restarts do.
 */
function createHarness({ host = LINUX_X64, platform = 'linux' } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'h-'));
  const pinsDir = path.join(dir, 'pins');
  writePins(pinsDir);
  const root = path.join(dir, 'sdks');
  const settings = new Map();
  const clock = { now: Date.now() };
  const live = new Set([STORE_PID]);
  const npm = createFakeNpm(host);
  const timers = createManualTimers();
  const locks = createFakeLocks();
  const stores = [];
  const harness = {
    dir, pinsDir, root, host, settings, clock, live, npm, timers, locks,
    pin: (id) => readAgentSdkPin(id, { pinsDir, host }),
    sdkDir: (id) => path.join(root, id),
    row: () => JSON.parse(settings.get(AGENT_SDK_STATUS_SETTING_KEY) || '{}'),
    createStore(options = {}) {
      const store = createAgentSdkStore({
        env: { PATH: '/usr/bin', HOME: '/home/dev' },
        platform,
        host,
        root,
        pinsDir,
        ids: ['claude', 'cursor', 'koffi'],
        pid: STORE_PID,
        spawnImpl: npm.spawnImpl,
        processKillImpl: npm.kill,
        setTimeoutImpl: timers.setTimeoutImpl,
        clearTimeoutImpl: timers.clearTimeoutImpl,
        now: () => clock.now,
        sleep: () => flush(),
        logger: { log() {} },
        readSetting: (key) => settings.get(key) ?? null,
        writeSetting: (key, value) => settings.set(key, value),
        npmInvocation: () => ({ command: '/opt/node/bin/npm', env: { PATH: '/opt/node/bin:/usr/bin', npm_config_omit: 'optional', npm_config_registry: 'https://registry.example.test/' } }),
        holderMayRun: (record) => live.has(Number(record?.pid)),
        identityOf: (pid) => ({ start: `ticks:${pid}` }),
        bootIdOf: () => 'boot-test',
        lockFactory: locks.factory,
        installTimeoutMs: INSTALL_TIMEOUT_MS,
        retryDelaysMs: RETRY_DELAYS_MS,
        lockPollMs: 1,
        renameRetryMs: [1, 1],
        ...options,
      });
      stores.push(store);
      return store;
    },
    dispose() {
      for (const store of stores) store.dispose();
    },
  };
  return harness;
}

function folderNames(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

// ─── Installing ──────────────────────────────────────────────────────────────

test('install: npm ci into a partial folder, marker last, renamed into place, lease and ready', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({ lockFactory: undefined }); // the real cross-process lock
  const states = [];
  store.subscribe((value) => states.push(value.sdks.cursor.state));
  const ready = [];
  store.onReady((value) => ready.push(value));
  const pin = h.pin('cursor');

  const started = store.install('cursor');
  assert.equal(started.ok, true);
  assert.equal(started.reused, false);
  assert.equal(started.status.state, 'installing');
  assert.equal(started.status.active, true);
  // npm runs at once, in a partial folder beside the final one, with the pins
  // under the npm names (shipped as pin.json and pin-lock.json).
  assert.equal(h.npm.calls.length, 1);
  const call = h.npm.calls[0];
  assert.equal(path.dirname(call.options.cwd), h.sdkDir('cursor'));
  assert.match(path.basename(call.options.cwd), new RegExp(`^${pin.dirName.replace(/[.+]/g, '\\$&')}\\.partial-[0-9a-f]+$`));
  assert.deepEqual(fs.readFileSync(path.join(call.options.cwd, 'package.json')), fs.readFileSync(path.join(h.pinsDir, 'cursor', 'pin.json')));
  assert.deepEqual(fs.readFileSync(path.join(call.options.cwd, 'package-lock.json')), fs.readFileSync(path.join(h.pinsDir, 'cursor', 'pin-lock.json')));
  assert.ok(!fs.existsSync(path.join(call.options.cwd, 'pin.json')) && !fs.existsSync(path.join(call.options.cwd, 'pin-lock.json')));
  assert.ok(fs.existsSync(path.join(call.options.cwd, 'entry-sqlite.mjs')));
  assert.ok(fs.existsSync(path.join(h.sdkDir('cursor'), '.store.lock')), 'the lock is held while npm runs');
  assert.equal(call.command, '/opt/node/bin/npm');
  assert.deepEqual(call.args, agentSdkNpmArgs());
  assert.equal(call.options.detached, true);

  await waitFor(() => store.status('cursor').state === 'ready', 'ready');
  const status = store.status('cursor');
  const final = path.join(h.sdkDir('cursor'), pin.dirName);
  assert.equal(status.dir, final);
  assert.equal(status.installed, '1.4.2');
  assert.equal(status.folder, pin.dirName);
  assert.equal(status.error, null);
  assert.equal(status.active, false);
  assert.ok(status.log.includes('added 4 packages'));
  assert.ok(status.logSeq >= 1);
  assert.equal(store.readyDir('cursor'), final);
  assert.equal(isValidAgentSdkInstall(final, { pin }), true);

  // The marker: the pin, the host, and every checked file with its size.
  const marker = readAgentSdkMarker(final);
  assert.equal(marker.format, AGENT_SDK_STORE_FORMAT);
  assert.equal(marker.id, 'cursor');
  assert.equal(marker.version, '1.4.2');
  assert.equal(marker.hash, pin.hash);
  assert.deepEqual([marker.platform, marker.arch, marker.libc], ['linux', 'x64', 'glibc']);
  assert.equal(marker.platformPackage, '@cursor/sdk-linux-x64');
  assert.equal(marker.installedAt, new Date(h.clock.now).toISOString());
  assert.deepEqual(Object.keys(marker.files).sort(), [
    'entry-sqlite.mjs',
    'entry.mjs',
    'node_modules/@cursor/sdk-linux-x64/README.md',
    'node_modules/@cursor/sdk-linux-x64/bin/agent',
    'node_modules/@cursor/sdk-linux-x64/package.json',
    'node_modules/@cursor/sdk/package.json',
    'node_modules/tiny-schema/package.json',
  ]);
  for (const [rel, size] of Object.entries(marker.files)) {
    assert.equal(fs.statSync(path.join(final, ...rel.split('/'))).size, size, rel);
  }
  assert.equal(marker.files['node_modules/@cursor/sdk-linux-x64/bin/agent'], 96);
  assert.equal(fs.existsSync(path.join(final, '.owner.json')), false, 'the owner file goes before the marker');

  // No partial left, the lock released, a lease for this relay written.
  assert.deepEqual(folderNames(h.sdkDir('cursor')).filter((name) => name.includes('.partial-')), []);
  assert.equal(fs.existsSync(path.join(h.sdkDir('cursor'), '.store.lock')), false);
  const leases = folderNames(path.join(h.sdkDir('cursor'), AGENT_SDK_LEASES_DIR, pin.dirName));
  assert.equal(leases.length, 1);
  const lease = JSON.parse(fs.readFileSync(path.join(h.sdkDir('cursor'), AGENT_SDK_LEASES_DIR, pin.dirName, leases[0]), 'utf8'));
  assert.equal(lease.pid, STORE_PID);
  assert.deepEqual(lease.holder, { start: `ticks:${STORE_PID}` });
  assert.equal(lease.bootId, 'boot-test');

  // The row has no entry for it; the hook and the subscribers saw it.
  assert.equal(h.row().cursor, undefined);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].state, 'ready');
  assert.equal(states[0], 'installing');
  assert.equal(states.at(-1), 'ready');
  // A second request for a ready SDK spawns nothing.
  assert.deepEqual(store.install('cursor').ready, true);
  assert.equal(h.npm.calls.length, 1);
});

test('install: a second request joins the running install', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  const first = store.install('claude');
  const second = store.install('claude');
  assert.equal(first.reused, false);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(second.status.state, 'installing');
  await waitFor(() => store.status('claude').state === 'ready');
  assert.equal(h.npm.calls.length, 1);
  assert.equal(h.locks.held.size, 0, 'the lock is released');
});

test('ensure: resolves once the install is ready, and at once when it already is', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  const status = await store.ensure('claude');
  assert.equal(status.state, 'ready');
  assert.equal(status.dir, path.join(h.sdkDir('claude'), h.pin('claude').dirName));
  assert.equal((await store.ensure('claude')).state, 'ready');
  assert.equal(h.npm.calls.length, 1);
  assert.equal(await store.ensure('nope'), null);
});

test('ensure: a failed SDK stays failed for a launch unless retryFailed', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next({ fail: 'npm error code E407\nnpm error 407 Proxy Authentication Required\n' });
  const failed = await store.ensure('claude');
  assert.equal(failed.state, 'error');
  assert.equal(h.npm.calls.length, 1);

  const again = await store.ensure('claude');
  assert.equal(again.state, 'error');
  assert.equal(again.error, failed.error);
  assert.equal(h.npm.calls.length, 1, 'no spawn without retryFailed');

  const retried = await store.ensure('claude', { retryFailed: true });
  assert.equal(retried.state, 'ready');
  assert.equal(h.npm.calls.length, 2);
});

test('ensure: an SDK this host cannot run resolves unsupported without a spawn', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  const status = await store.ensure('koffi');
  assert.equal(status.state, 'unsupported');
  assert.equal(h.npm.calls.length, 0);
});

test('cancel: kills npm, removes the partial folder, resolves waiters, no retry', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next('hang');
  const waiting = store.ensure('cursor');
  assert.equal(h.npm.calls.length, 1);
  const child = h.npm.calls[0].child;
  const partial = h.npm.calls[0].options.cwd;
  assert.ok(fs.existsSync(partial));
  // The child's pid is in the partial folder for a later clean-up.
  await flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(partial, '.owner.json'), 'utf8')).pid, child.pid);

  const result = store.cancel('cursor');
  assert.equal(result.ok, true);
  assert.equal(result.status.state, 'error');
  assert.equal(result.status.kind, 'cancelled');
  assert.equal(result.status.error, 'Cursor SDK install cancelled');
  // POSIX: the whole group gets SIGTERM.
  assert.deepEqual(h.npm.kills[0], [-child.pid, 'SIGTERM']);
  const resolved = await waiting;
  assert.equal(resolved.kind, 'cancelled');

  await waitFor(() => !fs.existsSync(partial), 'partial removed');
  await waitFor(() => h.locks.held.size === 0, 'lock released');
  assert.equal(store.status('cursor').state, 'error');
  assert.equal(store.status('cursor').retryAt, null);
  assert.ok(!h.timers.delays().some((ms) => RETRY_DELAYS_MS.includes(ms)), 'no retry timer');
  assert.equal(h.row().cursor, undefined, 'a cancel is not saved as a failure');

  // Cancelling again dismisses the failure.
  const dismissed = store.cancel('cursor');
  assert.equal(dismissed.status.state, 'missing');
  assert.equal(dismissed.status.error, null);
});

test('network failure: error/network, retried at each delay, then no more timers', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next({ fail: NPM_ENOTFOUND }, { fail: NPM_ENOTFOUND }, { fail: NPM_ENOTFOUND }, { fail: NPM_ENOTFOUND });
  store.install('cursor');
  await waitFor(() => store.status('cursor').state === 'error');
  let status = store.status('cursor');
  assert.equal(status.kind, 'network');
  assert.match(status.error, /^No connection to the npm registry\. .*\(.*ENOTFOUND/s);
  assert.equal(status.attempts, 1);
  assert.equal(status.retryAt, new Date(h.clock.now + RETRY_DELAYS_MS[0]).toISOString());
  assert.equal(status.canInstall, true);
  assert.deepEqual(h.timers.delays().filter((ms) => RETRY_DELAYS_MS.includes(ms)), [RETRY_DELAYS_MS[0]]);
  // Saved with the pin's hash, for a restarted relay.
  assert.equal(h.row().cursor.hash, h.pin('cursor').hash);
  assert.equal(h.row().cursor.kind, 'network');

  for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
    assert.equal(h.timers.fire(delay), 1, `retry after ${delay} ms`);
    assert.equal(h.npm.calls.length, index + 2);
    assert.equal(store.status('cursor').state, 'installing');
    await waitFor(() => store.status('cursor').state === 'error');
    status = store.status('cursor');
    assert.equal(status.attempts, index + 2);
  }
  // Three retries, then it waits for a person.
  assert.equal(status.retryAt, null);
  assert.ok(!h.timers.delays().some((ms) => RETRY_DELAYS_MS.includes(ms)));
  assert.equal(h.npm.calls.length, 4);
  assert.equal(h.locks.held.size, 0);
});

test('network failure: a manual install starts the retries over', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next({ fail: NPM_ENOTFOUND }, { fail: NPM_ENOTFOUND }, { fail: NPM_ENOTFOUND });
  store.install('cursor');
  await waitFor(() => store.status('cursor').state === 'error');
  h.timers.fire(RETRY_DELAYS_MS[0]);
  await waitFor(() => store.status('cursor').state === 'error');
  assert.equal(store.status('cursor').attempts, 2);
  assert.deepEqual(h.timers.delays().filter((ms) => RETRY_DELAYS_MS.includes(ms)), [RETRY_DELAYS_MS[1]]);

  store.install('cursor');
  await waitFor(() => store.status('cursor').state === 'error');
  assert.equal(store.status('cursor').attempts, 1);
  assert.deepEqual(h.timers.delays().filter((ms) => RETRY_DELAYS_MS.includes(ms)), [RETRY_DELAYS_MS[0]], 'the pending later retry is gone');
});

test('timeout: npm is killed and the failure counts as a network one', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next('hang');
  store.install('claude');
  const child = h.npm.calls[0].child;
  const partial = h.npm.calls[0].options.cwd;
  assert.equal(h.timers.fire(INSTALL_TIMEOUT_MS), 1);
  await waitFor(() => store.status('claude').state === 'error');
  const status = store.status('claude');
  assert.equal(status.kind, 'network');
  assert.ok(status.retryAt);
  assert.match(status.error, new RegExp(`timed out after ${INSTALL_TIMEOUT_MS}ms`));
  assert.deepEqual(h.npm.kills[0], [-child.pid, 'SIGTERM']);
  assert.equal(fs.existsSync(partial), false);
});

test('a stall: npm stopped once nothing moves for the stall time, counted as a network failure', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({ installStallMs: 300_000, stallCheckMs: 15_000, npmCacheDir: () => path.join(h.dir, 'npm-cache') });
  h.npm.next('hang');
  store.install('claude');
  const child = h.npm.calls[0].child;
  await flush();
  // Output counts as progress: a check right after a line does not stop it.
  h.clock.now += 200_000;
  child.stdout.emit('data', Buffer.from('npm http fetch GET 200 https://registry.example.test/a 812ms\n'));
  assert.equal(h.timers.fire(15_000), 1);
  assert.equal(store.status('claude').state, 'installing');
  // Bytes growing in npm's download cache count too.
  fs.mkdirSync(path.join(h.dir, 'npm-cache', '_cacache', 'tmp'), { recursive: true });
  h.clock.now += 290_000;
  fs.writeFileSync(path.join(h.dir, 'npm-cache', '_cacache', 'tmp', 'part'), 'x'.repeat(4096));
  assert.equal(h.timers.fire(15_000), 1);
  assert.equal(store.status('claude').state, 'installing');
  // Then nothing for the stall time: stopped.
  h.clock.now += 300_000;
  assert.equal(h.timers.fire(15_000), 1);
  await waitFor(() => store.status('claude').state === 'error');
  const status = store.status('claude');
  assert.equal(status.kind, 'network');
  assert.match(status.error, /npm made no progress for 5 minutes/);
  assert.ok(status.retryAt);
  assert.deepEqual(h.npm.kills[0], [-child.pid, 'SIGTERM']);
});

test('platform failure from npm: unsupported, never retried', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next({ fail: 'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform for @cursor/sdk-linux-x64\n' });
  store.install('cursor');
  await waitFor(() => store.status('cursor').state !== 'installing');
  const status = store.status('cursor');
  assert.equal(status.state, 'unsupported');
  assert.equal(status.kind, 'platform');
  assert.equal(status.retryAt, null);
  assert.equal(status.canInstall, false);
  assert.ok(!h.timers.delays().some((ms) => RETRY_DELAYS_MS.includes(ms)));
  const again = store.install('cursor');
  assert.equal(again.ok, false);
  assert.equal(again.statusCode, 409);
  assert.equal(h.npm.calls.length, 1);
});

test('a persisted platform failure comes back unsupported after a restart', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const first = h.createStore();
  h.npm.next({ fail: 'npm error code EBADPLATFORM\n' });
  first.install('cursor');
  await waitFor(() => first.status('cursor').state === 'unsupported');
  first.dispose();
  const restarted = h.createStore();
  assert.equal(restarted.status('cursor').state, 'unsupported');
});

test('no platform package for the host in the lockfile: unsupported at once; claude installs where the host CLI may stand in', async (t) => {
  const plain = createHarness({ host: LINUX_ARM64 });
  t.after(() => plain.dispose());
  assert.equal(plain.createStore().status('claude').state, 'unsupported');
  const h = createHarness({ host: LINUX_ARM64 });
  t.after(() => h.dispose());
  const store = h.createStore({ hostCliPlatforms: { claude: ['linux'] } });
  const cursor = store.status('cursor');
  assert.equal(cursor.state, 'unsupported');
  assert.equal(cursor.support, 'no');
  assert.equal(cursor.kind, 'platform');
  assert.match(cursor.error, /not available on this platform \(linux-arm64\)/);
  const refused = store.install('cursor');
  assert.equal(refused.ok, false);
  assert.equal(refused.statusCode, 409);
  assert.equal(h.npm.calls.length, 0);

  assert.equal(store.status('claude').support, 'cli');
  const status = await store.ensure('claude');
  assert.equal(status.state, 'ready');
  assert.equal(readAgentSdkMarker(status.dir).platformPackage, null);
  assert.equal(h.npm.calls.length, 1);
  assert.equal(store.status('koffi').state, 'unsupported', 'koffi is for Windows only');
});

test('npm succeeds without the platform package: error/other with the npm config hint', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next('no-platform');
  store.install('cursor');
  await waitFor(() => store.status('cursor').state === 'error');
  const status = store.status('cursor');
  assert.equal(status.kind, 'other');
  assert.equal(status.error, 'npm installed @cursor/sdk without @cursor/sdk-linux-x64; check the npm config for omit, os or cpu settings.');
  assert.equal(status.retryAt, null);
  assert.equal(store.readyDir('cursor'), null);
  assert.deepEqual(folderNames(h.sdkDir('cursor')).filter((name) => !name.startsWith('.')), [], 'no partial, no final folder');
});

test('npm failures with a fix of the user\'s carry a hint and are not retried', async (t) => {
  const cases = [
    ['npm error code E407\nnpm error 407 Proxy Authentication Required\n', /^The proxy asks for a login/],
    ['npm error code EINTEGRITY\nnpm error sha512-… integrity checksum failed\n', /^npm's cache holds a damaged copy/],
    ['npm error code ENOSPC\nnpm error nospc no space left on device\n', /^The disk is full\./],
  ];
  for (const [text, hint] of cases) {
    const h = createHarness();
    t.after(() => h.dispose());
    const store = h.createStore();
    h.npm.next({ fail: text });
    store.install('claude');
    await waitFor(() => store.status('claude').state === 'error');
    const status = store.status('claude');
    assert.equal(status.kind, 'other', text);
    assert.match(status.error, hint);
    // The hint, then npm's last lines.
    assert.match(status.error, /\(npm error code E/);
    assert.equal(status.retryAt, null);
    assert.equal(h.row().claude.kind, 'other');
  }
});

test('npm missing next to Node: a plain message, no retry', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({
    spawnImpl: () => { throw Object.assign(new Error('spawn /opt/node/bin/npm ENOENT'), { code: 'ENOENT' }); },
  });
  store.install('claude');
  await waitFor(() => store.status('claude').state === 'error');
  assert.equal(store.status('claude').error, 'npm was not found next to this Node; install npm, then try again.');
  assert.equal(store.status('claude').retryAt, null);
  assert.equal(h.locks.held.size, 0);
});

test('classifyAgentSdkFailure sorts npm output into network, platform and other', () => {
  assert.equal(classifyAgentSdkFailure('npm error code ECONNRESET').kind, 'network');
  assert.equal(classifyAgentSdkFailure('npm ERR! code EAI_AGAIN').kind, 'network');
  assert.equal(classifyAgentSdkFailure('npm error code E503').kind, 'network');
  assert.equal(classifyAgentSdkFailure('502 Bad Gateway - GET https://registry.example.test/zod').kind, 'network');
  assert.equal(classifyAgentSdkFailure('timed out after 600000ms').kind, 'network');
  assert.match(classifyAgentSdkFailure('npm error code ETIMEDOUT').hint, /npm registry/);
  // A platform error wins over anything else in the same output.
  assert.deepEqual(classifyAgentSdkFailure('npm error code EBADPLATFORM\nnpm error code ENOTFOUND'), { kind: 'platform', hint: null });
  assert.equal(classifyAgentSdkFailure('npm error code E407').kind, 'other');
  assert.equal(classifyAgentSdkFailure('npm error code E404 Not Found').kind, 'other');
  assert.deepEqual(classifyAgentSdkFailure(''), { kind: 'other', hint: null });
  assert.deepEqual(classifyAgentSdkFailure(null), { kind: 'other', hint: null });
});

// ─── The persisted row ───────────────────────────────────────────────────────

test('persisted row: shown by a restarted store while the hash matches, ignored otherwise', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const first = h.createStore();
  h.npm.next({ fail: 'npm error code E407\n' });
  first.install('claude');
  await waitFor(() => first.status('claude').state === 'error');
  const failed = first.status('claude');
  first.dispose();

  const restarted = h.createStore();
  const shown = restarted.status('claude');
  assert.equal(shown.state, 'error');
  assert.equal(shown.error, failed.error);
  assert.equal(shown.kind, 'other');
  assert.equal(shown.attempts, 1);
  restarted.dispose();

  // Saved for other pins (another hash): not this install's failure.
  const row = h.row();
  row.claude.hash = '0'.repeat(64);
  h.settings.set(AGENT_SDK_STATUS_SETTING_KEY, JSON.stringify(row));
  const otherPins = h.createStore();
  assert.equal(otherPins.status('claude').state, 'missing');
  assert.equal(otherPins.status('claude').error, null);
});

test('persisted row: a garbled row is ignored', (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  h.settings.set(AGENT_SDK_STATUS_SETTING_KEY, '{not json');
  assert.equal(h.createStore().status('claude').state, 'missing');
  h.settings.set(AGENT_SDK_STATUS_SETTING_KEY, '[1,2]');
  assert.equal(h.createStore().status('claude').state, 'missing');
});

test('persisted row: cleared once the folder turns valid', (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const pin = h.pin('claude');
  h.settings.set(AGENT_SDK_STATUS_SETTING_KEY, JSON.stringify({
    claude: { hash: pin.hash, error: 'The disk is full. (npm error code ENOSPC)', kind: 'other', attempts: 1, lastAttemptAt: new Date(h.clock.now).toISOString() },
    cursor: { hash: h.pin('cursor').hash, error: 'kept', kind: 'other', attempts: 1 },
  }));
  const store = h.createStore();
  assert.equal(store.status('claude').state, 'error');
  // Another process installs it meanwhile.
  writeInstall(h.root, pin);
  const status = store.status('claude');
  assert.equal(status.state, 'ready');
  assert.equal(status.error, null);
  assert.equal(h.row().claude, undefined);
  assert.equal(h.row().cursor.error, 'kept', 'other SDKs keep their row');
});

// ─── Reconcile ───────────────────────────────────────────────────────────────

test('reconcile: removes partial and trash folders and a final-named folder without a marker', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const pin = h.pin('claude');
  const sdk = h.sdkDir('claude');
  // A dead install's partial folder whose npm (pid 7777) still runs.
  const partial = path.join(sdk, `${pin.dirName}.partial-abc123`);
  writeJson(path.join(partial, '.owner.json'), { format: 2, pid: 7777, holder: { start: 'ticks:7777' } });
  fs.writeFileSync(path.join(partial, 'package.json'), '{}');
  h.live.add(7777);
  // One whose npm is gone.
  writeJson(path.join(sdk, `${pin.dirName}.partial-def456`, '.owner.json'), { format: 2, pid: 7778 });
  fs.mkdirSync(path.join(sdk, '.trash-0a1b2c', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(sdk, pin.dirName, 'node_modules'), { recursive: true });
  const store = h.createStore();

  await store.reconcile({ inUse: [] });
  const names = folderNames(sdk);
  assert.ok(!names.some((name) => name.includes('.partial-')), names.join());
  assert.ok(!names.includes('.trash-0a1b2c'));
  assert.ok(!names.includes(pin.dirName), 'the unmarked final folder is moved aside');
  assert.deepEqual(h.npm.kills, [[-7777, 'SIGKILL']], 'only the live orphan is killed');
  assert.equal(h.npm.calls.length, 0, 'nothing in use, nothing installed');
  assert.equal(h.locks.held.size, 0);
});

test('reconcile: installs only the SDKs in use that are missing', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  writeInstall(h.root, h.pin('claude'));
  const store = h.createStore();
  await store.reconcile({ inUse: ['claude', 'cursor', 'koffi'] });
  // claude is ready, koffi unsupported here: cursor alone.
  assert.equal(h.npm.calls.length, 1);
  assert.equal(path.dirname(h.npm.calls[0].options.cwd), h.sdkDir('cursor'));
  await waitFor(() => store.status('cursor').state === 'ready');
  await store.reconcile({ inUse: ['claude', 'cursor'] });
  assert.equal(h.npm.calls.length, 1);
});

test('reconcile: a failure newer than 60 s is left alone, an older one is tried again', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  h.settings.set(AGENT_SDK_STATUS_SETTING_KEY, JSON.stringify({
    claude: {
      hash: h.pin('claude').hash,
      error: 'No connection to the npm registry. (npm error code ENOTFOUND)',
      kind: 'network',
      attempts: 1,
      lastAttemptAt: new Date(h.clock.now - 10_000).toISOString(),
    },
  }));
  const store = h.createStore();
  await store.reconcile({ inUse: ['claude'] });
  assert.equal(h.npm.calls.length, 0);
  assert.equal(store.status('claude').state, 'error');

  h.clock.now += 60_000;
  await store.reconcile({ inUse: ['claude'] });
  assert.equal(h.npm.calls.length, 1);
  await waitFor(() => store.status('claude').state === 'ready');
  assert.equal(h.row().claude, undefined);
});

test('reconcile: GC keeps the pinned folder, the newest other and leased ones, deletes the rest', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const pin = h.pin('cursor');
  const sdk = h.sdkDir('cursor');
  writeInstall(h.root, pin, { installedAt: '2025-06-01T00:00:00.000Z' });
  const other = (name, installedAt) => writeInstall(h.root, pin, { name, installedAt, marker: { version: name.split('-')[0], hash: name.slice(-8).repeat(8) } });
  other('1.1.0-aaaaaaaa', '2026-01-01T00:00:00.000Z');
  other('1.2.0-bbbbbbbb', '2026-02-01T00:00:00.000Z');
  other('1.3.0-cccccccc', '2026-03-01T00:00:00.000Z');
  const leased = other('1.0.0-dddddddd', '2025-12-01T00:00:00.000Z');
  // A worker (pid 5150) still uses 1.0.0; a dead one (6000) used 1.1.0.
  writeAgentSdkLease(leased, { pid: 5150 });
  writeAgentSdkLease(path.join(sdk, '1.1.0-aaaaaaaa'), { pid: 6000 });
  h.live.add(5150);
  // Past the grace period of the leases just written.
  h.clock.now += 60 * 60_000;
  const store = h.createStore();

  await store.reconcile({ inUse: ['cursor'] });
  const names = folderNames(sdk).filter((name) => !name.startsWith('.'));
  assert.deepEqual(names, ['1.0.0-dddddddd', '1.3.0-cccccccc', pin.dirName].sort());
  assert.ok(!folderNames(sdk).some((name) => name.startsWith('.trash-')), 'deleted, not only moved aside');
  // The dead lease and its folder entry are gone; the live one stays.
  const leaseFolders = folderNames(path.join(sdk, AGENT_SDK_LEASES_DIR));
  assert.ok(!leaseFolders.includes('1.1.0-aaaaaaaa'));
  assert.ok(leaseFolders.includes('1.0.0-dddddddd'));
  assert.ok(leaseFolders.includes(pin.dirName), 'the relay leases its own folder');
  assert.equal(h.npm.calls.length, 0, 'the pinned folder is ready');
});

test('cancel: a failure saved before is dismissed with the install', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const first = h.createStore();
  h.npm.next({ fail: NPM_ENOTFOUND });
  await first.ensure('cursor');
  assert.equal(h.row().cursor.kind, 'network');
  first.dispose();
  const store = h.createStore();
  h.npm.next('hang');
  store.install('cursor');
  store.cancel('cursor');
  assert.equal(h.row().cursor, undefined);
});

test('reconcile: GC leaves folders made for another platform alone', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const pin = h.pin('cursor');
  const sdk = h.sdkDir('cursor');
  writeInstall(h.root, pin, { installedAt: '2025-06-01T00:00:00.000Z' });
  const other = (name, installedAt, marker = {}) => writeInstall(h.root, pin, { name, installedAt, marker: { version: name.split('-')[0], hash: name.slice(-8).repeat(8), ...marker } });
  other('1.1.0-aaaaaaaa', '2026-01-01T00:00:00.000Z', { platform: 'win32', libc: null });
  other('1.2.0-bbbbbbbb', '2026-02-01T00:00:00.000Z');
  other('1.3.0-cccccccc', '2026-03-01T00:00:00.000Z');
  const store = h.createStore();
  await store.reconcile({ inUse: [] });
  const names = folderNames(sdk).filter((name) => !name.startsWith('.'));
  assert.deepEqual(names, ['1.1.0-aaaaaaaa', '1.3.0-cccccccc', pin.dirName].sort(), 'the Windows folder stays, the older Linux one goes');
});

test('reconcile: does nothing while another process holds the lock', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const pin = h.pin('claude');
  fs.mkdirSync(path.join(h.sdkDir('claude'), `${pin.dirName}.partial-abcdef`), { recursive: true });
  h.locks.state.blocked = true;
  const store = h.createStore();
  await store.reconcile({ inUse: [] });
  assert.ok(fs.existsSync(path.join(h.sdkDir('claude'), `${pin.dirName}.partial-abcdef`)));
});

// ─── The lock ────────────────────────────────────────────────────────────────

test('lock held elsewhere: installing with heldBy, ready once the other process puts the folder in place', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const pin = h.pin('claude');
  writeJson(path.join(h.sdkDir('claude'), '.store.lock'), { pid: 4242, format: 2 });
  // An old folder the other process may still be judging: GC is its job.
  writeInstall(h.root, pin, { name: '0.1.0-aaaaaaaa', installedAt: '2026-01-01T00:00:00.000Z', marker: { version: '0.1.0', hash: 'a'.repeat(64) } });
  writeInstall(h.root, pin, { name: '0.2.0-bbbbbbbb', installedAt: '2026-02-01T00:00:00.000Z', marker: { version: '0.2.0', hash: 'b'.repeat(64) } });
  h.locks.state.blocked = true;
  const store = h.createStore();
  const waiting = store.ensure('claude');
  await waitFor(() => store.status('claude').heldBy === 4242, 'heldBy');
  assert.equal(store.status('claude').state, 'installing');
  assert.equal(store.status('claude').canInstall, false);
  assert.equal(h.npm.calls.length, 0);

  writeInstall(h.root, pin);
  const status = await waiting;
  assert.equal(status.state, 'ready');
  assert.equal(status.heldBy, null);
  assert.equal(h.npm.calls.length, 0);
  assert.ok(fs.existsSync(path.join(h.sdkDir('claude'), '0.1.0-aaaaaaaa')), 'no clean-up without the lock');
});

test('lock: an unexpected lock error fails the install', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({ lockFactory: () => ({ acquire() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, release() {} }) });
  store.install('claude');
  await waitFor(() => store.status('claude').state === 'error');
  assert.equal(store.status('claude').error, 'The SDK folder could not be locked (EACCES).');
  assert.equal(h.npm.calls.length, 0);
});

// ─── Reinstall, leases, guards ───────────────────────────────────────────────

test('force reinstall replaces a ready folder', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  await store.ensure('claude');
  const dir = store.readyDir('claude');
  const firstAt = readAgentSdkMarker(dir).installedAt;
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'from the old copy');

  assert.equal(store.install('claude').ready, true, 'no reinstall without force');
  h.clock.now += 5_000;
  const started = store.install('claude', { force: true });
  assert.equal(started.reused, false);
  assert.equal(store.status('claude').state, 'installing');
  await waitFor(() => store.status('claude').state === 'ready');
  assert.equal(h.npm.calls.length, 2);
  assert.equal(store.readyDir('claude'), dir, 'same path');
  assert.notEqual(readAgentSdkMarker(dir).installedAt, firstAt);
  assert.equal(fs.existsSync(path.join(dir, 'stray.txt')), false, 'a fresh copy');
});

test('a failed force reinstall: its waiters learn the failure, the old folder stays ready', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  // A listener asks for the status on every change, as the relay's does.
  const seen = [];
  const broadcasts = [];
  store.subscribe((snapshot) => {
    seen.push(snapshot.sdks.claude.state);
    broadcasts.push(snapshot.sdks.claude);
  });
  await store.ensure('claude');
  const dir = store.readyDir('claude');
  const firstAt = readAgentSdkMarker(dir).installedAt;
  assert.equal(store.status('claude').reinstallFailure, null);

  h.npm.next({ fail: 'npm error code E407\nnpm error 407 Proxy Authentication Required\n' });
  assert.equal(store.install('claude', { force: true }).reused, false);
  const outcome = await store.ensure('claude', { retryFailed: true });
  assert.equal(outcome.state, 'error');
  assert.match(outcome.error, /407/);
  assert.equal(outcome.dir, dir, 'the folder it was to replace');
  assert.equal(outcome.active, false);
  // The old folder checks out still: it is what the relay keeps using.
  assert.equal(store.status('claude').state, 'ready');
  assert.equal(store.readyDir('claude'), dir);
  assert.equal(readAgentSdkMarker(dir).installedAt, firstAt);
  assert.ok(seen.includes('installing'));
  // What Settings gets (the broadcast and GET /api/agent-sdks/status): a
  // ready row that still says the reinstall failed, and why.
  const last = broadcasts.at(-1);
  assert.equal(last.state, 'ready');
  assert.equal(last.dir, dir);
  assert.match(last.reinstallFailure?.error || '', /407/);
  assert.equal(store.snapshot().sdks.claude.reinstallFailure.error, last.reinstallFailure.error);
  // The next install, and its success, clear it.
  assert.equal(store.install('claude', { force: true }).reused, false);
  assert.equal(store.status('claude').reinstallFailure, null);
  assert.equal((await store.ensure('claude')).state, 'ready');
  assert.equal(store.status('claude').reinstallFailure, null);
});

test('a failed force reinstall is told until the relay restarts: the next store shows the row ready, with no failure', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  await store.ensure('claude');
  const dir = store.readyDir('claude');
  h.npm.next({ fail: 'npm error code E407\nnpm error 407 Proxy Authentication Required\n' });
  store.install('claude', { force: true });
  await store.ensure('claude', { retryFailed: true });
  assert.match(store.status('claude').reinstallFailure?.error || '', /407/);
  // The failure lives in memory only (CHANGELOG): a restarted relay's store
  // finds the folder that still checks out, and nothing of the failure.
  const restarted = h.createStore();
  assert.equal(restarted.status('claude').state, 'ready');
  assert.equal(restarted.readyDir('claude'), dir);
  assert.equal(restarted.status('claude').reinstallFailure, null);
});

test('a cancelled force reinstall is no reinstall failure', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  await store.ensure('claude');
  h.npm.next('hang');
  assert.equal(store.install('claude', { force: true }).reused, false);
  const reinstalling = store.ensure('claude', { retryFailed: true });
  await flush();
  store.cancel('claude');
  assert.equal((await reinstalling).kind, 'cancelled');
  assert.equal(store.status('claude').state, 'ready');
  assert.equal(store.status('claude').reinstallFailure, null);
});

test('a ready folder that stops checking out turns missing', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  const status = await store.ensure('claude');
  fs.appendFileSync(path.join(status.dir, 'entry.mjs'), '// changed\n');
  const after = store.status('claude');
  assert.equal(after.state, 'missing');
  assert.equal(after.dir, null);
  assert.equal(store.readyDir('claude'), null);
});

test('lease: writes a lease for a worker pid beside the folder', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  const { dir } = await store.ensure('claude');
  const file = store.lease(dir, 9001);
  assert.equal(path.dirname(file), path.join(h.sdkDir('claude'), AGENT_SDK_LEASES_DIR, path.basename(dir)));
  const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(lease.pid, 9001);
  assert.deepEqual(lease.holder, { start: 'ticks:9001' });
});

test('spawns disabled: a 503-shaped refusal, nothing spawned', (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({ env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' } });
  assert.equal(store.status('claude').canInstall, false);
  const result = store.install('claude');
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, CLI_SPAWN_DISABLED_ERROR);
  assert.equal(result.status.state, 'error');
  assert.equal(h.npm.calls.length, 0);
});

test('spawns disabled with the stub opt-in: the stub installer runs with the id', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN: '1',
      COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND: '/opt/stub/install-sdk',
    },
  });
  store.install('claude');
  assert.equal(h.npm.calls[0].command, '/opt/stub/install-sdk');
  assert.deepEqual(h.npm.calls[0].args, ['claude']);
  await waitFor(() => store.status('claude').state === 'ready');
});

test('unknown ids: 400 for install and cancel, null for status and readyDir', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore({ ids: ['claude'] });
  for (const id of ['nope', 'cursor']) {
    assert.deepEqual(store.install(id), { ok: false, statusCode: 400, error: 'Unknown agent SDK' });
    assert.deepEqual(store.cancel(id), { ok: false, statusCode: 400, error: 'Unknown agent SDK' });
    assert.equal(store.status(id), null);
    assert.equal(store.readyDir(id), null);
    assert.equal(await store.ensure(id), null);
  }
  assert.deepEqual(Object.keys(store.snapshot().sdks), ['claude']);
  assert.deepEqual(store.ids(), ['claude']);
  assert.equal(h.npm.calls.length, 0);
});

test('root problems: on Windows a root over 120 characters refuses installs; elsewhere it is fine', async (t) => {
  const h = createHarness({ host: WIN32_X64, platform: 'win32' });
  t.after(() => h.dispose());
  const root = path.join(h.dir, 'x'.repeat(130));
  const store = h.createStore({ root });
  assert.equal(store.status('cursor').canInstall, false);
  const result = store.install('cursor');
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.match(result.error, /longer than 120 characters; set OAR_SDK_DIR/);
  assert.equal((await store.ensure('cursor')).state, 'error');
  await store.reconcile({ inUse: ['cursor'] });
  assert.equal(h.npm.calls.length, 0);
  assert.equal(fs.existsSync(root), false);

  const posix = createHarness();
  t.after(() => posix.dispose());
  assert.equal(posix.createStore({ root: path.join(posix.dir, 'x'.repeat(130)) }).status('claude').canInstall, true);
});

test('root problems: a network path on Windows refuses installs', (t) => {
  const h = createHarness({ host: WIN32_X64, platform: 'win32' });
  t.after(() => h.dispose());
  // No file call may reach the (invented) network path.
  const isUnc = (target) => /^[\\/]{2}/.test(String(target));
  const guarded = (fn) => (target, ...rest) => {
    if (isUnc(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return fn(target, ...rest);
  };
  const fsImpl = {
    ...fs,
    readFileSync: guarded(fs.readFileSync),
    statSync: guarded(fs.statSync),
    existsSync: (target) => !isUnc(target) && fs.existsSync(target),
    readdirSync: guarded(fs.readdirSync),
    mkdirSync: guarded(fs.mkdirSync),
  };
  const store = h.createStore({ root: '\\\\fileserver.invalid\\share\\sdks', fsImpl });
  const result = store.install('cursor');
  assert.equal(result.statusCode, 409);
  assert.match(result.error, /is a network path; set OAR_SDK_DIR to a local folder/);
  assert.equal(h.npm.calls.length, 0);
});

test('win32: npm.cmd runs through a shell as one quoted line; koffi installs with scripts off', async (t) => {
  const h = createHarness({ host: WIN32_X64, platform: 'win32' });
  t.after(() => h.dispose());
  const store = h.createStore({ npmInvocation: () => ({ command: 'npm.cmd', env: { Path: 'C:\\Tools\\node', npm_config_global: 'true' } }) });
  assert.equal(store.status('koffi').support, 'yes');
  assert.equal(store.status('claude').support, 'no', 'the fixture lists no Windows build of claude');
  store.install('koffi');
  const call = h.npm.calls[0];
  assert.deepEqual(call.args, []);
  assert.equal(call.options.shell, true);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, undefined);
  assert.ok(call.command.startsWith('"npm.cmd" "ci" '));
  assert.ok(call.command.includes('"--ignore-scripts"'));
  assert.ok(!call.command.includes('allow-scripts'));
  assert.deepEqual(call.options.env, { Path: 'C:\\Tools\\node' });
  await waitFor(() => store.status('koffi').state === 'ready');
  assert.equal(readAgentSdkMarker(store.readyDir('koffi')).platformPackage, '@koromix/koffi-win32-x64');
});

test('win32: a cancel, and the npm of a dead install, end with their whole process tree', async (t) => {
  const h = createHarness({ host: WIN32_X64, platform: 'win32' });
  t.after(() => h.dispose());
  const store = h.createStore({ npmInvocation: () => ({ command: 'npm.cmd', env: {} }) });
  h.npm.next('hang');
  store.install('cursor');
  const child = h.npm.calls[0].child;
  store.cancel('cursor');
  assert.deepEqual(h.npm.taskkills, [['/PID', String(child.pid), '/T', '/F']], 'npm.cmd runs under cmd.exe: the tree, not the shell');
  // System32's taskkill where the environment names the system root, else the bare name.
  assert.match(h.npm.taskkillCommands[0], /(^|[\\/])taskkill(\.exe)?$/i);
  assert.deepEqual(child.killSignals, []);
  // What taskkill does to it.
  child.exitCode = 1;
  child.emit('close', 1);
  // An owner file a dead relay left, whose npm still runs.
  const pin = h.pin('cursor');
  const partial = path.join(h.sdkDir('cursor'), `${pin.dirName}.partial-abcdef`);
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, '.owner.json'), JSON.stringify({ format: 2, pid: 7777, holder: null }));
  h.live.add(7777);
  await waitFor(() => h.locks.held.size === 0, 'cancelled install let go of the lock');
  await store.reconcile({ inUse: [] });
  assert.deepEqual(h.npm.taskkills.at(-1), ['/PID', '7777', '/T', '/F']);
  assert.equal(fs.existsSync(partial), false);
});

test('the npm environment drops what a parent npm set and keeps what reaches the registry', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  store.install('claude');
  // From npmInvocation's env: omit is dropped, the registry kept.
  assert.deepEqual(h.npm.calls[0].options.env, { PATH: '/opt/node/bin:/usr/bin', npm_config_registry: 'https://registry.example.test/' });
  await waitFor(() => store.status('claude').state === 'ready');
});

test('agentSdkNpmEnv keeps registry, proxy, cache, userconfig and auth settings only', () => {
  const env = agentSdkNpmEnv({
    PATH: '/usr/bin',
    HOME: '/home/dev',
    NODE_OPTIONS: '--max-old-space-size=4096',
    npm_config_registry: 'https://registry.example.test/',
    'npm_config_@acme:registry': 'https://npm.acme.example.test/',
    'npm_config_//npm.acme.example.test/:_authToken': 'fixture-token',
    npm_config__auth: 'Zml4dHVyZQ==',
    NPM_CONFIG_HTTPS_PROXY: 'http://proxy.example.test:3128',
    npm_config_proxy: 'http://proxy.example.test:3128',
    npm_config_noproxy: 'localhost',
    npm_config_cafile: '/etc/ssl/fixture.pem',
    npm_config_strict_ssl: 'true',
    npm_config_cache: '/home/dev/.npm',
    npm_config_userconfig: '/home/dev/.npmrc',
    npm_config_fetch_retries: '4',
    npm_config_fetch_retry_mintimeout: '20000',
    npm_config_prefer_offline: 'true',
    npm_config_omit: 'optional',
    npm_config_os: 'darwin',
    npm_config_global: 'true',
    npm_config_prefix: '/usr/local',
    npm_config_ignore_scripts: 'false',
    npm_package_name: 'some-parent',
    npm_package_version: '1.0.0',
    npm_lifecycle_event: 'start',
    npm_lifecycle_script: 'node server.mjs',
    OAR_AGENT_SDK_DIR_CLAUDE: '/somewhere',
    oar_agent_sdk_dir_cursor: '/elsewhere',
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'HOME',
    'NODE_OPTIONS',
    'NPM_CONFIG_HTTPS_PROXY',
    'PATH',
    'npm_config_//npm.acme.example.test/:_authToken',
    'npm_config_@acme:registry',
    'npm_config__auth',
    'npm_config_cache',
    'npm_config_cafile',
    'npm_config_fetch_retries',
    'npm_config_fetch_retry_mintimeout',
    'npm_config_noproxy',
    'npm_config_prefer_offline',
    'npm_config_proxy',
    'npm_config_registry',
    'npm_config_strict_ssl',
    'npm_config_userconfig',
  ].sort());
  assert.deepEqual(agentSdkNpmEnv(null), {});
});

test('agentSdkNpmArgs: npm ci from the lockfile, scripts off for every pins folder', () => {
  const args = agentSdkNpmArgs();
  assert.equal(args[0], 'ci');
  for (const flag of ['--no-workspaces', '--include=prod', '--include=optional', '--omit=dev', '--ignore-scripts', '--package-lock=true', '--install-strategy=hoisted', '--no-audit', '--no-fund']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(!args.includes('--no-ignore-scripts'));
  assert.ok(!args.some((arg) => arg.startsWith('--allow-scripts')));
});

test('the store never touches the real process environment when given its own', () => {
  const h = createHarness();
  const env = { OAR_AGENT_SDK_DIR_CLAUDE: '/kept' };
  h.createStore({ env });
  assert.equal(env.OAR_AGENT_SDK_DIR_CLAUDE, '/kept');
  h.dispose();
});

test('dispose: stops a running install and resolves its waiters', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const store = h.createStore();
  h.npm.next('hang');
  const waiting = store.ensure('claude');
  const partial = h.npm.calls[0].options.cwd;
  store.dispose();
  const status = await waiting;
  assert.equal(status.active, false);
  assert.deepEqual(h.npm.kills[0], [-h.npm.calls[0].child.pid, 'SIGTERM']);
  await waitFor(() => !fs.existsSync(partial), 'partial removed');
  // The lock goes right after the folder (the store awaits the removal, then
  // releases): the folder can be gone one tick before the release runs.
  await waitFor(() => h.locks.held.size === 0, 'lock released');
});

test('a git checkout reports its SDKs ready from the devDependencies', (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  // The checkout has cursor installed, not claude (as after --omit=dev).
  const store = h.createStore({ fromCheckout: (sdk) => sdk === 'cursor' });
  assert.equal(store.status('claude').source, 'store');
  const status = store.status('cursor');
  assert.equal(status.state, 'ready');
  assert.equal(status.source, 'checkout');
  assert.equal(status.installed, status.pinned);
  assert.equal(status.canInstall, false);
  assert.equal(store.readyDir('cursor'), null, 'no store folder: the loader takes the devDependency');
  assert.equal(store.snapshot().checkout, true);
  assert.equal(h.createStore().status('cursor').source, 'store');
});

// fs with its promise API held at a gate: the install waits inside the
// clean-up (rm) or the sync before the marker (open) until the test lets go.
function gatedFs({ rm = false, open = false } = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const promises = {
    ...fs.promises,
    rm: rm ? async (...args) => { await gate; return fs.promises.rm(...args); } : fs.promises.rm,
    open: open ? async (target, ...args) => {
      if (String(target).includes('.partial-')) await gate;
      return fs.promises.open(target, ...args);
    } : fs.promises.open,
  };
  return { fsImpl: { ...fs, promises }, release: () => release() };
}

for (const how of ['cancel', 'dispose']) {
  test(`${how} while the leftovers are deleted: no folder, no npm, the lock let go`, async (t) => {
    const h = createHarness();
    t.after(() => h.dispose());
    fs.mkdirSync(path.join(h.sdkDir('cursor'), '.trash-abcdef'), { recursive: true });
    const gated = gatedFs({ rm: true });
    const store = h.createStore({ fsImpl: gated.fsImpl });
    store.install('cursor');
    await waitFor(() => h.locks.held.size === 1, 'the install holds the lock');
    if (how === 'cancel') assert.equal(store.cancel('cursor').status.kind, 'cancelled');
    else store.dispose();
    gated.release();
    await waitFor(() => h.locks.held.size === 0, 'lock let go');
    await flush();
    assert.equal(h.npm.calls.length, 0, 'npm never started');
    assert.deepEqual(folderNames(h.sdkDir('cursor')).filter((name) => name.includes('.partial-')), [], 'no partial folder');
  });
}

test('cancel while the new folder is synced to disk: it never goes into place', async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());
  const gated = gatedFs({ open: true });
  const store = h.createStore({ fsImpl: gated.fsImpl });
  store.install('cursor');
  await waitFor(() => h.npm.calls.length === 1, 'npm ran');
  await waitFor(() => folderNames(h.sdkDir('cursor')).some((name) => name.includes('.partial-')) && h.npm.calls[0].child.exitCode !== undefined, 'npm done');
  await flush();
  assert.equal(store.cancel('cursor').status.kind, 'cancelled');
  gated.release();
  await waitFor(() => h.locks.held.size === 0, 'lock let go');
  await waitFor(() => !folderNames(h.sdkDir('cursor')).some((name) => name.includes('.partial-')), 'partial folder gone');
  assert.equal(store.readyDir('cursor'), null);
  assert.deepEqual(folderNames(h.sdkDir('cursor')).filter((name) => !name.startsWith('.')), [], 'nothing renamed into place');
  assert.equal(store.status('cursor').state, 'error');
});
