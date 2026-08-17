import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  createSshTunnelManager,
  normalizeSshTunnelConfig,
} from './ssh-tunnel-manager-service.mjs';

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
      const timer = {
        fn,
        ms,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (!timer) return;
      timer.cleared = true;
    },
  };
}

// Drives a bind failure and returns the unwrapped remote cleanup script.
function buildCleanupCommandForTest(tunnelConfig) {
  const spawnArgs = [];
  const children = [];
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      autoReclaimPort: true,
      ...tunnelConfig,
    },
    spawnImpl(command, args) {
      spawnArgs.push(args);
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
    logger: { log() {}, warn() {} },
  });

  manager.start();
  children[0].stderr.emit('data', Buffer.from('Error: remote port forwarding failed for listen port 4444'));
  children[0].exitCode = 255;
  children[0].emit('close', 255);

  const args = spawnArgs[1];
  return args[args.length - 1].replace(/^sh -lc '/, '').replace(/'$/, '');
}

test('normalizeSshTunnelConfig defaults to disabled mode', () => {
  const normalized = normalizeSshTunnelConfig({});
  assert.equal(normalized.mode, 'disabled');
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.errors, []);
});

test('normalizeSshTunnelConfig leaves a bare command unresolved', () => {
  const normalized = normalizeSshTunnelConfig({ command: 'ssh' }, { configBaseDir: '/srv/relay' });
  assert.equal(normalized.command, 'ssh');
});

test('normalizeSshTunnelConfig resolves a relative command against the posix base dir', () => {
  const normalized = normalizeSshTunnelConfig({ command: './bin/ssh' }, {
    configBaseDir: '/srv/relay',
    pathImpl: path.posix,
  });
  assert.equal(normalized.command, '/srv/relay/bin/ssh');
});

test('normalizeSshTunnelConfig resolves a relative command against the win32 base dir', () => {
  const normalized = normalizeSshTunnelConfig({ command: '.\\bin\\ssh.exe' }, {
    configBaseDir: 'C:\\srv\\relay',
    pathImpl: path.win32,
  });
  assert.equal(normalized.command, 'C:\\srv\\relay\\bin\\ssh.exe');
});

test('normalizeSshTunnelConfig validates managed mode requirements', () => {
  const normalized = normalizeSshTunnelConfig({
    mode: 'managed',
  });
  assert.equal(normalized.valid, false);
  assert.deepEqual(normalized.errors, [
    'sshTunnel.user is required when sshTunnel.mode is "managed"',
    'sshTunnel.host is required when sshTunnel.mode is "managed"',
    'sshTunnel.remotePort must be a positive integer when sshTunnel.mode is "managed"',
  ]);
});

test('tunnel manager stays direct when mode is disabled', () => {
  const spawnCalls = [];
  const manager = createSshTunnelManager({
    tunnelConfig: { mode: 'disabled' },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return createFakeChild();
    },
    logger: { log() {}, warn() {} },
  });
  manager.start();
  assert.equal(spawnCalls.length, 0);
  assert.equal(manager.state.mode, 'disabled');
  assert.equal(manager.state.blocking, false);
  assert.equal(manager.state.connected, false);
});

test('managed tunnel spawns and non-required mode remains unblocked on disconnect', () => {
  const spawnCalls = [];
  const children = [];
  const fakeTimers = createFakeTimers();
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      required: false,
    },
    localPort: 3333,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: fakeTimers.setTimeoutImpl,
    clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ssh');
  assert.deepEqual(spawnCalls[0].args.slice(0, 6), ['-N', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o']);
  assert.ok(spawnCalls[0].args.includes('-R'));
  assert.ok(spawnCalls[0].args.includes('4444:127.0.0.1:3333'));
  assert.ok(spawnCalls[0].args.includes('ubuntu@relay.example.com'));
  assert.equal(manager.state.blocking, false);

  children[0].emit('spawn');
  const readinessTimer = fakeTimers.timers.find((timer) => timer.ms === 1200);
  assert.ok(readinessTimer);
  readinessTimer.fn();
  assert.equal(manager.state.connected, true);
  assert.equal(manager.state.blocking, false);

  children[0].exitCode = 1;
  children[0].emit('close', 1);
  assert.equal(manager.state.connected, false);
  assert.equal(manager.state.blocking, false);
});

test('required managed tunnel blocks when disconnected and unblocks after connect', () => {
  const children = [];
  const fakeTimers = createFakeTimers();
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      required: true,
    },
    spawnImpl() {
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: fakeTimers.setTimeoutImpl,
    clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(manager.state.blocking, true);

  children[0].emit('spawn');
  const readinessTimer = fakeTimers.timers.find((timer) => timer.ms === 1200);
  readinessTimer.fn();
  assert.equal(manager.state.connected, true);
  assert.equal(manager.state.blocking, false);

  children[0].exitCode = 255;
  children[0].emit('close', 255);
  assert.equal(manager.state.connected, false);
  assert.equal(manager.state.blocking, true);
});

test('managed tunnel keeps Windows spawn behavior stable', () => {
  const spawnCalls = [];
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
    },
    platform: 'win32',
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return createFakeChild();
    },
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'ssh');
  assert.deepEqual(spawnCalls[0].options, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
});

test('remote reclaim uses single quoted sh -lc command', async () => {
  const spawnCalls = [];
  const children = [];
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      autoReclaimPort: true,
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    logger: { log() {}, warn() {} },
  });

  manager.start();
  assert.equal(spawnCalls.length, 1);
  children[0].stderr.emit('data', Buffer.from('Error: remote port forwarding failed for listen port 4444'));
  children[0].exitCode = 255;
  children[0].emit('close', 255);
  assert.equal(spawnCalls.length, 2);

  const reclaimArgs = spawnCalls[1].args;
  const remoteCommand = reclaimArgs[reclaimArgs.length - 1];
  assert.equal(reclaimArgs[reclaimArgs.length - 2], 'ubuntu@relay.example.com');
  assert.match(remoteCommand, /^sh -lc '/);
  assert.match(remoteCommand, /PORT=4444;/);
  assert.match(remoteCommand, /lsof -tiTCP:\$PORT/);
  assert.ok(!reclaimArgs.includes('-lc'));

  children[1].exitCode = 0;
  children[1].emit('close', 0);
  await Promise.resolve();
});

test('remote reclaim reads /proc/net/tcp and reports a still-held port as non-zero', () => {
  const command = buildCleanupCommandForTest({ remotePort: 4444 });
  // lsof/fuser cannot see an sshd remote-forward listener, so the port state
  // must come from ss or /proc/net/tcp, and a still-bound port must fail.
  assert.match(command, /ss -ltn/);
  assert.match(command, /\/proc\/net\/tcp6?/);
  assert.match(command, /exit 3$/);
  assert.match(command, /port_bound \|\| exit 0;/);
});

test('stale sshd session sweep is opt-in and skips sessions with children', () => {
  const off = buildCleanupCommandForTest({ remotePort: 4444 });
  assert.ok(!off.includes('sshd(-session)?'), 'sweep must not run by default');

  const on = buildCleanupCommandForTest({ remotePort: 4444, reclaimStaleSshSessions: true });
  assert.match(on, /pgrep -u "\$\(id -u\)" -f "\^sshd\(-session\)\?: "/);
  assert.match(on, /\[ "\$p" = "\$self" \] && continue;/);
  assert.match(on, /\[ -n "\$\(pgrep -P "\$p" 2>\/dev\/null\)" \] && continue;/);
});

test('a port that cannot be reclaimed backs off instead of retrying every second', async () => {
  const children = [];
  const fakeTimers = createFakeTimers();
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      autoReclaimPort: true,
    },
    spawnImpl() {
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: fakeTimers.setTimeoutImpl,
    clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });

  manager.start();
  children[0].stderr.emit('data', Buffer.from('Error: remote port forwarding failed for listen port 4444'));
  children[0].exitCode = 255;
  children[0].emit('close', 255);

  // Reclaim reports the port is still held.
  children[1].exitCode = 3;
  children[1].emit('close', 3);
  await Promise.resolve();
  await Promise.resolve();

  const reconnectTimer = fakeTimers.timers.filter((timer) => timer.ms !== 1200).pop();
  assert.ok(reconnectTimer, 'a reconnect must still be scheduled');
  assert.notEqual(reconnectTimer.ms, 1_000);
  assert.ok(reconnectTimer.ms >= 5_000, `expected backoff, got ${reconnectTimer.ms}ms`);
});

test('successful reclaims stop fast-retrying after the cap', async () => {
  const children = [];
  const fakeTimers = createFakeTimers();
  const manager = createSshTunnelManager({
    tunnelConfig: {
      mode: 'managed',
      user: 'ubuntu',
      host: 'relay.example.com',
      remotePort: 4444,
      autoReclaimPort: true,
    },
    spawnImpl() {
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    setTimeoutImpl: fakeTimers.setTimeoutImpl,
    clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    logger: { log() {}, warn() {} },
  });

  manager.start();
  const delays = [];
  for (let round = 0; round < 5; round += 1) {
    const tunnelChild = children[children.length - 1];
    tunnelChild.stderr.emit('data', Buffer.from('Error: remote port forwarding failed for listen port 4444'));
    tunnelChild.exitCode = 255;
    tunnelChild.emit('close', 255);

    const reclaimChild = children[children.length - 1];
    reclaimChild.exitCode = 0;
    reclaimChild.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    const timer = fakeTimers.timers.filter((entry) => entry.ms !== 1200).pop();
    delays.push(timer.ms);
    timer.fn();
  }

  assert.deepEqual(delays.slice(0, 3), [1_000, 1_000, 1_000]);
  assert.ok(delays[3] >= 5_000, `expected backoff after the cap, got ${delays[3]}ms`);
});
