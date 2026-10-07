import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  createCloudflaredTunnelManager,
  describeConfiguredTunnel,
  describeMissingCloudflaredBinary,
  describeTunnelState,
  locateCloudflaredBinary,
  normalizeCloudflaredTunnelConfig,
  redactCloudflaredArgs,
} from './cloudflared-tunnel-service.mjs';

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    child.exitCode = 0;
    child.emit('close', 0);
  };
  return child;
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (!timer) return;
      timer.cleared = true;
    },
  };
}

function createManager(overrides = {}) {
  const spawns = [];
  const children = [];
  const emitted = [];
  const timers = overrides.timers || createFakeTimers();
  let now = overrides.startTime ?? 0;
  const manager = createCloudflaredTunnelManager({
    tunnelConfig: { mode: 'managed', token: 'tok-abc', binary: '/opt/cloudflared', ...overrides.tunnelConfig },
    env: overrides.env || {},
    // The binary is "installed" unless a test says otherwise; the host's PATH is never read.
    locateBinary: overrides.locateBinary || ((binary) => binary),
    pathImpl: path.posix,
    platform: overrides.platform || 'linux',
    runtimeShutdownRef: overrides.runtimeShutdownRef || (() => false),
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });
  return { manager, spawns, children, emitted, timers, setNow: (v) => { now = v; }, get now() { return now; } };
}

test('normalizeCloudflaredTunnelConfig defaults to disabled', () => {
  const normalized = normalizeCloudflaredTunnelConfig({}, { env: {} });
  assert.equal(normalized.mode, 'disabled');
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.errors, []);
});

test('normalizeCloudflaredTunnelConfig accepts a valid managed config', () => {
  const normalized = normalizeCloudflaredTunnelConfig({
    mode: 'managed',
    required: true,
    token: 'tok-abc',
    extraArgs: ['--loglevel', 'debug', ''],
  }, { env: {} });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.required, true);
  assert.equal(normalized.binary, 'cloudflared');
  assert.equal(normalized.binarySource, 'path');
  assert.deepEqual(normalized.extraArgs, ['--loglevel', 'debug']);
});

test('normalizeCloudflaredTunnelConfig reports a missing token in managed mode', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'managed' }, { env: {} });
  assert.equal(normalized.valid, false);
  assert.equal(normalized.errors.length, 1);
  assert.match(normalized.errors[0], /token is required/);
});

test('normalizeCloudflaredTunnelConfig ignores a missing token when disabled', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'disabled' }, { env: {} });
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.errors, []);
});

test('normalizeCloudflaredTunnelConfig lets env overrides beat file values', () => {
  const normalized = normalizeCloudflaredTunnelConfig({
    mode: 'disabled',
    token: 'file-token',
    binary: 'file-binary',
  }, {
    env: {
      COPILOT_CLOUDFLARED_MODE: 'managed',
      COPILOT_CLOUDFLARED_TOKEN: 'env-token',
      COPILOT_CLOUDFLARED_BINARY: 'env-binary',
    },
  });
  assert.equal(normalized.mode, 'managed');
  assert.equal(normalized.token, 'env-token');
  assert.equal(normalized.binary, 'env-binary');
  assert.equal(normalized.binarySource, 'config');
});

test('normalizeCloudflaredTunnelConfig resolves the binary config path first', () => {
  const normalized = normalizeCloudflaredTunnelConfig({
    mode: 'managed',
    token: 'tok',
    binary: './bin/cloudflared',
  }, {
    env: {},
    configBaseDir: '/srv/relay',
    pathImpl: path.posix,
  });
  assert.equal(normalized.binary, '/srv/relay/bin/cloudflared');
  assert.equal(normalized.binarySource, 'config');
});

test('normalizeCloudflaredTunnelConfig resolves a relative binary against the win32 base dir', () => {
  const normalized = normalizeCloudflaredTunnelConfig({
    mode: 'managed',
    token: 'tok',
    binary: '.\\bin\\cloudflared.exe',
  }, {
    env: {},
    configBaseDir: 'C:\\srv\\relay',
    pathImpl: path.win32,
  });
  assert.equal(normalized.binary, 'C:\\srv\\relay\\bin\\cloudflared.exe');
  assert.equal(normalized.binarySource, 'config');
});

test('normalizeCloudflaredTunnelConfig takes cloudflared from PATH when no binary is configured', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'managed', token: 'tok' }, { env: {} });
  assert.equal(normalized.binary, 'cloudflared');
  assert.equal(normalized.binarySource, 'path');
  assert.equal(normalized.valid, true);
});

// A fake disk: `files` are executable files, `plain` exist without the execute bit.
function fakeFs({ files = [], plain = [] } = {}) {
  return {
    statSync(candidate) {
      if (files.includes(candidate) || plain.includes(candidate)) return { isFile: () => true };
      throw new Error('ENOENT');
    },
    accessSync(candidate) {
      if (!files.includes(candidate)) throw new Error('EACCES');
    },
  };
}

test('locateCloudflaredBinary finds the name on PATH, first directory first', () => {
  const located = locateCloudflaredBinary('cloudflared', {
    platform: 'linux',
    env: { PATH: '/home/dev/bin:/usr/local/bin:/usr/bin' },
    fsImpl: fakeFs({ files: ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared'] }),
  });
  assert.equal(located, '/usr/local/bin/cloudflared');
});

test('locateCloudflaredBinary returns null when PATH has no cloudflared', () => {
  const options = { platform: 'linux', fsImpl: fakeFs() };
  assert.equal(locateCloudflaredBinary('cloudflared', { ...options, env: { PATH: '/usr/bin' } }), null);
  assert.equal(locateCloudflaredBinary('cloudflared', { ...options, env: {} }), null);
  assert.equal(locateCloudflaredBinary('', { ...options, env: { PATH: '/usr/bin' } }), null);
});

test('locateCloudflaredBinary skips a file that is not executable', () => {
  const located = locateCloudflaredBinary('cloudflared', {
    platform: 'linux',
    env: { PATH: '/home/dev/bin:/usr/bin' },
    fsImpl: fakeFs({ plain: ['/home/dev/bin/cloudflared'], files: ['/usr/bin/cloudflared'] }),
  });
  assert.equal(located, '/usr/bin/cloudflared');
});

test('locateCloudflaredBinary checks a configured path as it is, without PATH', () => {
  const options = { platform: 'linux', env: { PATH: '/usr/bin' } };
  assert.equal(
    locateCloudflaredBinary('/opt/cloudflared', { ...options, fsImpl: fakeFs({ files: ['/opt/cloudflared'] }) }),
    '/opt/cloudflared',
  );
  assert.equal(
    locateCloudflaredBinary('/opt/cloudflared', { ...options, fsImpl: fakeFs({ plain: ['/opt/cloudflared'] }) }),
    null,
  );
  assert.equal(
    locateCloudflaredBinary('/opt/cloudflared', { ...options, fsImpl: fakeFs({ files: ['/usr/bin/cloudflared'] }) }),
    null,
  );
});

test('locateCloudflaredBinary adds the PATHEXT suffix on win32', () => {
  const located = locateCloudflaredBinary('cloudflared', {
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32;C:\\Users\\dev\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    fsImpl: fakeFs({ plain: ['C:\\Users\\dev\\bin\\cloudflared.exe'] }), // win32: no execute bit to check
  });
  assert.equal(located, 'C:\\Users\\dev\\bin\\cloudflared.exe');
});

test('locateCloudflaredBinary ignores a batch launcher on win32', () => {
  // A .cmd needs a shell to start; the tunnel is started without one.
  const located = locateCloudflaredBinary('cloudflared', {
    platform: 'win32',
    env: { PATH: 'C:\\Users\\dev\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    fsImpl: fakeFs({ plain: ['C:\\Users\\dev\\bin\\cloudflared.cmd', 'C:\\Users\\dev\\bin\\cloudflared'] }), // win32
  });
  assert.equal(located, null);
});

test('locateCloudflaredBinary takes a configured win32 path with or without the suffix', () => {
  const fsImpl = fakeFs({ plain: ['C:\\tools\\cloudflared.exe'] }); // win32
  assert.equal(
    locateCloudflaredBinary('C:\\tools\\cloudflared.exe', { platform: 'win32', env: {}, fsImpl }),
    'C:\\tools\\cloudflared.exe', // win32
  );
  assert.equal(
    locateCloudflaredBinary('C:\\tools\\cloudflared', { platform: 'win32', env: {}, fsImpl }),
    'C:\\tools\\cloudflared.exe', // win32
  );
});

test('describeMissingCloudflaredBinary names the install command of the platform', () => {
  assert.equal(
    describeMissingCloudflaredBinary({ binary: 'cloudflared', binarySource: 'path', platform: 'win32' }),
    'cloudflared is not installed — install it with: winget install --id Cloudflare.cloudflared',
  );
  assert.equal(
    describeMissingCloudflaredBinary({ binary: 'cloudflared', binarySource: 'path', platform: 'darwin' }),
    'cloudflared is not installed — install it with: brew install cloudflared',
  );
  assert.equal(
    describeMissingCloudflaredBinary({ binary: 'cloudflared', binarySource: 'path', platform: 'linux' }),
    "cloudflared is not installed — install it from Cloudflare's package repository: https://pkg.cloudflare.com/",
  );
});

test('describeMissingCloudflaredBinary names a configured binary that is not there', () => {
  assert.equal(
    describeMissingCloudflaredBinary({ binary: '/opt/cloudflared', binarySource: 'config', platform: 'darwin' }),
    'cloudflared was not found as configured (/opt/cloudflared) — correct cloudflaredTunnel.binary, or install it with: brew install cloudflared',
  );
});

test('describeTunnelState says off for no tunnel, a disabled one and a malformed state', () => {
  for (const state of [null, undefined, 'managed', {}, { mode: 'disabled', connected: true }]) {
    assert.equal(describeTunnelState(state), 'off');
  }
});

test('describeTunnelState says running, with the address when the caller knows it', () => {
  assert.equal(describeTunnelState({ mode: 'managed', connected: true }), 'running');
  assert.equal(
    describeTunnelState({ mode: 'managed', connected: true }, { url: 'https://relay.example.com/' }),
    'running (https://relay.example.com/)',
  );
  assert.equal(describeTunnelState({ enabled: true, connected: true }), 'running');
});

test('describeTunnelState says why a tunnel that cannot start is off', () => {
  const missing = describeMissingCloudflaredBinary({ binarySource: 'path', platform: 'darwin' });
  assert.equal(
    describeTunnelState({ mode: 'managed', connected: false, binaryMissing: true, lastError: missing }),
    'off: cloudflared is not installed — install it with: brew install cloudflared',
  );
  assert.equal(
    describeTunnelState({ mode: 'managed', enabled: false, valid: false, lastError: 'cloudflaredTunnel.token is required' }),
    'off: cloudflaredTunnel.token is required',
  );
});

test('describeTunnelState says not connected for a tunnel that is down or still starting', () => {
  assert.equal(describeTunnelState({ mode: 'managed', connected: false }), 'not connected');
  assert.equal(
    describeTunnelState({ mode: 'managed', connected: false, lastError: 'auth-or-config' }),
    'not connected (auth-or-config)',
  );
});

test('describeConfiguredTunnel reports the tunnel from the config alone', () => {
  const options = { env: {}, platform: 'linux', configBaseDir: '/srv/relay', pathImpl: path.posix };
  const found = { ...options, locateBinary: () => '/usr/bin/cloudflared' };
  const absent = { ...options, locateBinary: () => null };
  assert.equal(describeConfiguredTunnel({}, absent), 'disabled');
  assert.equal(describeConfiguredTunnel(undefined, absent), 'disabled');
  assert.equal(
    describeConfiguredTunnel({ mode: 'managed', token: 'tok' }, found),
    'managed (cloudflared: /usr/bin/cloudflared)',
  );
  assert.equal(
    describeConfiguredTunnel({ enabled: true, token: 'tok' }, absent),
    "managed, cannot start: cloudflared is not installed — install it from Cloudflare's package repository: https://pkg.cloudflare.com/",
  );
  assert.match(describeConfiguredTunnel({ enabled: true }, found), /^managed, cannot start: cloudflaredTunnel\.token is required/);
});

test('redactCloudflaredArgs hides the tunnel token', () => {
  assert.deepEqual(
    redactCloudflaredArgs(['tunnel', 'run', '--token', 'secret', '--loglevel', 'debug']),
    ['tunnel', 'run', '--token', '<redacted>', '--loglevel', 'debug'],
  );
});

test('manager spawns cloudflared with the tunnel token and extra args', () => {
  const ctx = createManager({ tunnelConfig: { extraArgs: ['--loglevel', 'debug'] } });
  ctx.manager.start();
  assert.equal(ctx.spawns.length, 1);
  assert.equal(ctx.spawns[0].command, '/opt/cloudflared');
  assert.deepEqual(ctx.spawns[0].args, ['tunnel', 'run', '--token', 'tok-abc', '--loglevel', 'debug']);
  assert.equal(ctx.spawns[0].options.windowsHide, undefined);
});

test('manager never logs the raw tunnel token', () => {
  const logs = [];
  const manager = createCloudflaredTunnelManager({
    tunnelConfig: { mode: 'managed', token: 'super-secret-token' },
    env: {},
    locateBinary: () => '/opt/cloudflared',
    spawnImpl: () => createFakeChild(),
    setTimeoutImpl: (fn, ms) => ({ fn, ms, unref() {} }),
    clearTimeoutImpl: () => {},
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  manager.start();
  assert.equal(logs.some((line) => line.includes('super-secret-token')), false);
  assert.equal(logs.some((line) => line.includes('<redacted>')), true);
});

test('manager hides the window on win32', () => {
  const ctx = createManager({ platform: 'win32' });
  ctx.manager.start();
  assert.equal(ctx.spawns[0].options.windowsHide, true);
});

test('manager marks connected on a registration line', () => {
  const ctx = createManager();
  ctx.manager.start();
  ctx.children[0].emit('spawn');
  ctx.children[0].stderr.emit('data', Buffer.from('INF Registered tunnel connection connIndex=0'));
  assert.equal(ctx.manager.state.connected, true);
  assert.ok(ctx.manager.state.connectedSince);
  const statuses = ctx.emitted.filter((e) => e.event === 'cloudflared_tunnel_status');
  assert.equal(statuses.at(-1).payload.connected, true);
});

test('manager marks connected via the readiness-window fallback', () => {
  const ctx = createManager();
  ctx.manager.start();
  ctx.children[0].emit('spawn');
  assert.equal(ctx.manager.state.connected, false);
  const readiness = ctx.timers.timers.find((t) => t.ms === 5000);
  assert.ok(readiness);
  readiness.fn();
  assert.equal(ctx.manager.state.connected, true);
});

test('manager does not use the readiness fallback after the process exited', () => {
  const ctx = createManager();
  ctx.manager.start();
  ctx.children[0].emit('spawn');
  const readiness = ctx.timers.timers.find((t) => t.ms === 5000);
  ctx.children[0].exitCode = 1;
  readiness.fn();
  assert.equal(ctx.manager.state.connected, false);
});

test('manager disconnects and schedules backoff reconnects on exit', () => {
  const ctx = createManager();
  ctx.manager.start();
  ctx.children[0].emit('spawn');
  ctx.children[0].stderr.emit('data', Buffer.from('Registered tunnel connection'));
  assert.equal(ctx.manager.state.connected, true);

  ctx.children[0].emit('close', 1);
  assert.equal(ctx.manager.state.connected, false);
  assert.equal(ctx.manager.state.reconnectAttempts, 1);
  const first = ctx.timers.timers.filter((t) => t.ms >= 5000 && t.ms <= 6000).at(-1);
  assert.ok(first, 'first backoff should be in the 5s tier');
});

test('manager backoff grows across consecutive slow failures', () => {
  const ctx = createManager();
  const observed = [];
  ctx.manager.start();
  for (let i = 0; i < 3; i += 1) {
    const child = ctx.children.at(-1);
    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('Registered tunnel connection'));
    // Emulate a long-lived connection so the fast-exit path is not taken.
    ctx.manager.state.fastExits = 0;
    child.emit('close', 1);
    const timer = ctx.timers.timers.at(-1);
    observed.push(timer.ms);
    ctx.manager.state.fastExits = 0;
    timer.fn();
  }
  assert.ok(observed[1] > observed[0], `expected growth, got ${observed.join(',')}`);
  assert.ok(observed[2] > observed[1], `expected growth, got ${observed.join(',')}`);
});

test('manager reports auth-or-config after repeated fast exits and backs off slowest', () => {
  const ctx = createManager();
  ctx.manager.start();
  for (let i = 0; i < 3; i += 1) {
    const child = ctx.children.at(-1);
    child.emit('spawn');
    child.emit('close', 1);
    const timer = ctx.timers.timers.at(-1);
    if (i < 2) timer.fn();
  }
  assert.equal(ctx.manager.state.lastError, 'auth-or-config');
  const timer = ctx.timers.timers.at(-1);
  assert.ok(timer.ms >= 60000, `expected slowest tier, got ${timer.ms}`);
});

test('manager blocking follows required and connection state', () => {
  const ctx = createManager({ tunnelConfig: { required: true } });
  assert.equal(ctx.manager.state.blocking, true);
  ctx.manager.start();
  ctx.children[0].emit('spawn');
  ctx.children[0].stderr.emit('data', Buffer.from('Registered tunnel connection'));
  assert.equal(ctx.manager.state.blocking, false);
  ctx.children[0].emit('close', 1);
  assert.equal(ctx.manager.state.blocking, true);
});

test('manager never blocks when required is false', () => {
  const ctx = createManager({ tunnelConfig: { required: false } });
  ctx.manager.start();
  assert.equal(ctx.manager.state.blocking, false);
  ctx.children[0].emit('close', 1);
  assert.equal(ctx.manager.state.blocking, false);
});

test('manager does not respawn during shutdown', () => {
  let shuttingDown = false;
  const ctx = createManager({ runtimeShutdownRef: () => shuttingDown });
  ctx.manager.start();
  shuttingDown = true;
  ctx.children[0].emit('close', 0);
  assert.equal(ctx.manager.state.reconnectAttempts, 0);
  assert.equal(ctx.timers.timers.filter((t) => t.ms >= 5000).length, 0);
});

test('manager does not start in disabled mode', () => {
  const ctx = createManager({ tunnelConfig: { mode: 'disabled' } });
  ctx.manager.start();
  assert.equal(ctx.spawns.length, 0);
  assert.equal(ctx.manager.state.blocking, false);
  assert.equal(ctx.emitted.at(-1).event, 'cloudflared_tunnel_status');
});

test('manager does not start with an invalid managed config', () => {
  const ctx = createManager({ tunnelConfig: { token: '' } });
  ctx.manager.start();
  assert.equal(ctx.spawns.length, 0);
  assert.equal(ctx.manager.state.valid, false);
  assert.match(String(ctx.manager.state.lastError), /token is required/);
});

test('manager stop kills the process and clears the backoff timer', () => {
  const ctx = createManager();
  ctx.manager.start();
  const child = ctx.children[0];
  child.emit('close', 1);
  const timer = ctx.timers.timers.at(-1);
  ctx.manager.stop();
  assert.equal(timer.cleared, true);
  assert.equal(ctx.manager.state.proc, null);
});

test('manager emits status on process error', () => {
  const ctx = createManager();
  ctx.manager.start();
  ctx.children[0].emit('error', new Error('ENOENT'));
  assert.equal(ctx.manager.state.lastError, 'ENOENT');
  assert.equal(ctx.emitted.at(-1).payload.lastError, 'ENOENT');
});

test('manager does not start the tunnel when cloudflared is missing, and says how to install it', () => {
  const ctx = createManager({ platform: 'darwin', tunnelConfig: { binary: '' }, locateBinary: () => null });
  ctx.manager.start();
  assert.equal(ctx.spawns.length, 0);
  assert.equal(ctx.manager.state.binaryMissing, true);
  assert.equal(ctx.manager.state.connected, false);
  assert.equal(ctx.manager.state.blocking, false);
  assert.equal(
    ctx.manager.state.lastError,
    'cloudflared is not installed — install it with: brew install cloudflared',
  );
  const status = ctx.emitted.at(-1);
  assert.equal(status.event, 'cloudflared_tunnel_status');
  assert.equal(status.payload.binaryMissing, true);
  assert.equal(status.payload.lastError, ctx.manager.state.lastError);
});

test('manager names a configured binary that is not there', () => {
  const ctx = createManager({ locateBinary: () => null });
  ctx.manager.start();
  assert.equal(ctx.spawns.length, 0);
  assert.match(ctx.manager.state.lastError, /^cloudflared was not found as configured \(\/opt\/cloudflared\)/);
});

test('manager starts the tunnel once cloudflared is installed, without a restart', () => {
  let installed = null;
  const ctx = createManager({ tunnelConfig: { binary: '' }, locateBinary: () => installed });
  ctx.manager.start();
  const recheck = ctx.timers.timers.at(-1);
  assert.equal(recheck.ms, 60000);

  // Still missing: one more look later, no second status event, no spawn.
  const eventsBefore = ctx.emitted.length;
  recheck.fn();
  assert.equal(ctx.spawns.length, 0);
  assert.equal(ctx.emitted.length, eventsBefore);
  assert.equal(recheck.cleared, true);

  installed = '/usr/local/bin/cloudflared';
  ctx.timers.timers.at(-1).fn();
  assert.equal(ctx.spawns.length, 1);
  assert.equal(ctx.spawns[0].command, '/usr/local/bin/cloudflared');
  assert.equal(ctx.manager.state.binaryMissing, false);
  assert.equal(ctx.manager.state.lastError, null);
  assert.equal(ctx.emitted.at(-1).payload.binaryMissing, false);
});

test('manager keeps a required tunnel blocking while cloudflared is missing', () => {
  const ctx = createManager({ tunnelConfig: { required: true }, locateBinary: () => null });
  ctx.manager.start();
  assert.equal(ctx.manager.state.blocking, true);
  assert.equal(ctx.emitted.at(-1).payload.blocking, true);
});

test('manager stop ends the wait for a missing cloudflared', () => {
  const ctx = createManager({ locateBinary: () => null });
  ctx.manager.start();
  const recheck = ctx.timers.timers.at(-1);
  ctx.manager.stop();
  assert.equal(recheck.cleared, true);
});

test('manager survives a locator that throws', () => {
  const ctx = createManager({ locateBinary: () => { throw new Error('EPERM'); } });
  ctx.manager.start();
  assert.equal(ctx.spawns.length, 0);
  assert.equal(ctx.manager.state.binaryMissing, true);
});
