import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  createCloudflaredTunnelManager,
  normalizeCloudflaredTunnelConfig,
  redactCloudflaredArgs,
  resolveCloudflaredBinaryFromPackage,
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
    tunnelConfig: { mode: 'managed', token: 'tok-abc', ...overrides.tunnelConfig },
    env: overrides.env || {},
    resolveBinary: overrides.resolveBinary || (() => '/opt/cloudflared'),
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
  const normalized = normalizeCloudflaredTunnelConfig({}, { env: {}, resolveBinary: () => null });
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
  }, { env: {}, resolveBinary: () => '/opt/cloudflared' });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.required, true);
  assert.equal(normalized.binary, '/opt/cloudflared');
  assert.equal(normalized.binarySource, 'package');
  assert.deepEqual(normalized.extraArgs, ['--loglevel', 'debug']);
});

test('normalizeCloudflaredTunnelConfig reports a missing token in managed mode', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'managed' }, {
    env: {},
    resolveBinary: () => '/opt/cloudflared',
  });
  assert.equal(normalized.valid, false);
  assert.equal(normalized.errors.length, 1);
  assert.match(normalized.errors[0], /token is required/);
});

test('normalizeCloudflaredTunnelConfig ignores a missing token when disabled', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'disabled' }, {
    env: {},
    resolveBinary: () => null,
  });
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
    resolveBinary: () => '/opt/cloudflared',
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
    resolveBinary: () => '/opt/cloudflared',
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
    resolveBinary: () => null,
    configBaseDir: 'C:\\srv\\relay',
    pathImpl: path.win32,
  });
  assert.equal(normalized.binary, 'C:\\srv\\relay\\bin\\cloudflared.exe');
  assert.equal(normalized.binarySource, 'config');
});

test('normalizeCloudflaredTunnelConfig falls back to PATH when the package is absent', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'managed', token: 'tok' }, {
    env: {},
    resolveBinary: () => null,
  });
  assert.equal(normalized.binary, 'cloudflared');
  assert.equal(normalized.binarySource, 'path');
  assert.equal(normalized.valid, true);
});

test('normalizeCloudflaredTunnelConfig survives a throwing binary resolver', () => {
  const normalized = normalizeCloudflaredTunnelConfig({ mode: 'managed', token: 'tok' }, {
    env: {},
    resolveBinary: () => { throw new Error('module not found'); },
  });
  assert.equal(normalized.binary, 'cloudflared');
  assert.equal(normalized.valid, true);
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
    resolveBinary: () => '/opt/cloudflared',
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

// `cloudflared` is an optionalDependency whose postinstall downloads a binary over
// the network, so these must not depend on it actually being installed on the host.
const fakeCloudflaredModule = { bin: '/opt/cloudflared/cloudflared' };

test('resolveCloudflaredBinaryFromPackage ignores a not-yet-downloaded binary path', () => {
  assert.equal(resolveCloudflaredBinaryFromPackage({
    existsSync: () => false,
    requireImpl: () => fakeCloudflaredModule,
  }), null);
});

test('resolveCloudflaredBinaryFromPackage returns the downloaded binary path', () => {
  const resolved = resolveCloudflaredBinaryFromPackage({
    existsSync: () => true,
    requireImpl: () => fakeCloudflaredModule,
  });
  assert.equal(resolved, '/opt/cloudflared/cloudflared');
});

test('resolveCloudflaredBinaryFromPackage returns null when the package is not installed', () => {
  assert.equal(resolveCloudflaredBinaryFromPackage({
    existsSync: () => true,
    requireImpl: () => { throw new Error("Cannot find module 'cloudflared'"); },
  }), null);
});
