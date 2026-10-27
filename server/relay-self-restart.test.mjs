import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { RELAY_STOP_EXIT_CODE } from './relay-exit-codes.mjs';
import { relayRuntimeNodeFlags } from './relay-heap-guard.mjs';
import { RELAY_RUNTIME_FLAG, runDirectRelaySupervisor, spawnRelayRuntime } from './relay-self-restart.mjs';

const MINUTE = 60 * 1000;

// Runs the supervisor over runtimes that each exit with the next code, or
// the next [code, signal]. `runMs` is how long each runtime runs (a fake
// clock); `onDelay` runs during each wait before a relaunch.
async function supervise(exits, { runMs = 1000, onDelay = () => {} } = {}) {
  const spawned = [];
  const logs = [];
  const signals = new EventEmitter();
  let clock = 0;
  let exitCode = null;
  await runDirectRelaySupervisor({
    scriptPath: 'server.js',
    spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), { pid: spawned.length + 1, exitCode: null, stdout: null, stderr: null });
      spawned.push(child);
      const next = exits[spawned.length - 1];
      const [code, signal] = Array.isArray(next) ? next : [next, null];
      setImmediate(() => { clock += runMs; child.emit('exit', code, signal); });
      return child;
    },
    nodeFlags: () => ({ flags: [] }),
    delay: async () => { onDelay(signals); },
    exitImpl: (code) => { exitCode = code; },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    signals,
    now: () => clock,
  });
  assert.equal(signals.listenerCount('SIGINT'), 0, 'its handlers are taken off');
  return { spawned: spawned.length, exitCode, logs };
}

test('a runtime that stops on purpose is not restarted, and its code goes on', async () => {
  assert.equal(RELAY_STOP_EXIT_CODE, 78);
  const { spawned, exitCode, logs } = await supervise([RELAY_STOP_EXIT_CODE]);
  assert.equal(spawned, 1, 'started once');
  assert.equal(exitCode, RELAY_STOP_EXIT_CODE);
  assert.ok(!logs.some((line) => /crash/.test(line)), 'not a crash');
});

test('a crash is still retried up to the limit, and the limit exits 1', async () => {
  const { spawned, exitCode, logs } = await supervise([1, 1, 1]);
  assert.equal(spawned, 3);
  assert.equal(exitCode, 1, 'systemd Restart=on-failure needs a failure');
  assert.ok(logs.some((line) => /crash limit reached/.test(line)));
});

test('a runtime killed by a signal (an out-of-memory abort) is a crash and is relaunched', async () => {
  const { spawned, exitCode, logs } = await supervise([[null, 'SIGABRT'], 0]);
  assert.equal(spawned, 2, 'relaunched, not taken for a clean exit');
  assert.equal(exitCode, 0);
  assert.ok(logs.includes('[relay] runtime crashed with signal SIGABRT (crash 1/3).'), logs.join('\n'));
});

test('signal exits count toward the crash limit, which exits 1', async () => {
  const { spawned, exitCode } = await supervise([[null, 'SIGKILL'], [null, 'SIGABRT'], [null, 'SIGKILL']]);
  assert.equal(spawned, 3);
  assert.equal(exitCode, 1);
});

test('a Ctrl-C that reaches the runtime first is not relaunched', async () => {
  // The runtime dies of SIGINT; the supervisor's own SIGINT arrives during the wait.
  const { spawned, exitCode } = await supervise([[null, 'SIGINT'], 0], { onDelay: (signals) => signals.emit('SIGINT') });
  assert.equal(spawned, 1);
  assert.equal(exitCode, 0);
});

test('a runtime that ran 10 minutes before it crashed starts the crash count afresh', async () => {
  const long = await supervise([1, 1, 1, 1, 0], { runMs: 11 * MINUTE });
  assert.equal(long.spawned, 5);
  assert.equal(long.exitCode, 0);
  assert.ok(!long.logs.some((line) => /crash 2\/3/.test(line)), long.logs.join('\n'));
});

function spawnArgs({ execArgv = [], env = {} } = {}) {
  let args = null;
  const fsImpl = { readFileSync() { throw new Error('no config'); }, mkdirSync() {}, statfsSync: () => ({ bavail: 1e9, bsize: 4096 }), readdirSync: () => [] };
  spawnRelayRuntime({
    env: { COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/.oar/data', ...env },
    scriptPath: '/home/dev/oar/server/server.js',
    execArgv,
    spawnImpl: (command, spawned) => { args = spawned; return { pid: 7 }; },
    nodeFlags: (options) => relayRuntimeNodeFlags({ ...options, fsImpl, totalMem: 8 * 1024 ** 3, constrainedMem: 0, heapSizeLimit: 2240 * 1024 ** 2 }),
    logger: { log() {} },
  });
  return args;
}

test('spawnRelayRuntime starts the runtime with the heap limit and snapshot flags', () => {
  const args = spawnArgs({ execArgv: ['--enable-source-maps'] });
  assert.equal(args[0], '--max-old-space-size=4864');
  assert.equal(args[1], '--heapsnapshot-near-heap-limit=1');
  assert.match(args[2], /^--diagnostic-dir=.*diagnostics$/);
  assert.deepEqual(args.slice(3), ['--enable-source-maps', '/home/dev/oar/server/server.js', RELAY_RUNTIME_FLAG]);
});

test("spawnRelayRuntime keeps the operator's heap limit, once", () => {
  for (const [options, kept] of [
    [{ execArgv: ['--max-old-space-size=3000'] }, '--max-old-space-size=3000'],
    [{ env: { NODE_OPTIONS: '--max-old-space-size=4096' } }, null],
  ]) {
    const heapFlags = spawnArgs(options).filter((arg) => /max-old-space-size/.test(arg));
    assert.deepEqual(heapFlags, kept ? [kept] : [], JSON.stringify(options));
  }
});

test('spawnRelayRuntime still starts the runtime when the heap guard throws', () => {
  let args = null;
  const logs = [];
  spawnRelayRuntime({
    env: {},
    scriptPath: '/home/dev/oar/server/server.js',
    execArgv: ['--enable-source-maps'],
    spawnImpl: (command, spawned) => { args = spawned; return { pid: 7 }; },
    nodeFlags: () => { throw new Error('no statfs'); },
    logger: { log: (line) => logs.push(line) },
  });
  assert.deepEqual(args, ['--enable-source-maps', '/home/dev/oar/server/server.js', RELAY_RUNTIME_FLAG]);
  assert.deepEqual(logs.filter((line) => line.includes('heap')), ['[relay] starting the runtime without heap flags: no statfs']);
});
