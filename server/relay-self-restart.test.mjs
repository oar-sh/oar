import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { RELAY_STOP_EXIT_CODE } from './relay-exit-codes.mjs';
import { relayRuntimeNodeFlags } from './relay-heap-guard.mjs';
import { RELAY_RUNTIME_FLAG, runDirectRelaySupervisor, spawnRelayRuntime } from './relay-self-restart.mjs';

const MINUTE = 60 * 1000;

// Never a real systemctl: a test that reaches one fails. The full suite may
// run inside a worker of a relay's own systemd service.
const NO_SYSTEMCTL = (command, args) => { throw new Error(`unexpected ${command} ${args.join(' ')}`); };

// Runs the supervisor over runtimes that each exit with the next code, or
// the next [code, signal]. `runMs` is how long each runtime runs (a fake
// clock); `onDelay` runs during each wait before a relaunch. Not under
// systemd unless `hosting` says so; `systemctl` answers the handover's calls.
async function supervise(exits, {
  runMs = 1000, onDelay = () => {}, hosting = { systemd: false }, systemctl = NO_SYSTEMCTL, delay = null, pid = 4321,
  // How a runtime's exit is delivered: on the next turn by default; the
  // handover tests deliver it from an I/O callback, as a real child's is.
  deliverExit = setImmediate,
} = {}) {
  const spawned = [];
  const logs = [];
  const calls = [];
  const signals = new EventEmitter();
  let clock = 0;
  let exitCode = null;
  await runDirectRelaySupervisor({
    hosting,
    pid,
    handoverWaitMs: 30_000,
    spawnSyncImpl: (command, args, options) => {
      calls.push([command, ...args].join(' '));
      return systemctl(command, args, { signals, options });
    },
    scriptPath: 'server.js',
    spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), { pid: spawned.length + 1, exitCode: null, stdout: null, stderr: null });
      spawned.push(child);
      const next = exits[spawned.length - 1];
      const [code, signal] = Array.isArray(next) ? next : [next, null];
      deliverExit(() => { clock += runMs; child.emit('exit', code, signal); });
      return child;
    },
    nodeFlags: () => ({ flags: [] }),
    delay: delay ? (ms) => delay(ms, signals) : async () => { onDelay(signals); },
    exitImpl: (code) => { exitCode = code; },
    logger: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    signals,
    now: () => clock,
  });
  assert.equal(signals.listenerCount('SIGINT'), 0, 'its handlers are taken off');
  return { spawned: spawned.length, exitCode, logs, calls };
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

// ─── exit 75 under a systemd user service ────────────────────────────────────

const USER_UNIT = { systemd: true, userManager: true, unit: 'oar.service' };

// systemctl of the user manager: this supervisor (pid 4321) is the unit's
// main process; `restart` answers `restartStatus`, and its stop (SIGTERM)
// comes `sigterm` ('now': during the call, 'never', or after the call).
function userManager({ mainPid = 4321, restartStatus = 0, sigterm = 'now', showStatus = 0 } = {}) {
  return (command, args, { signals }) => {
    assert.equal(command, 'systemctl');
    if (args.includes('show')) return { status: showStatus, stdout: showStatus === 0 ? `${mainPid}\n` : '', stderr: showStatus ? 'Failed to connect to bus' : '' };
    if (args.includes('reset-failed')) return { status: 0 };
    if (args.includes('restart')) {
      if (restartStatus === 0 && sigterm === 'now') signals.emit('SIGTERM');
      if (restartStatus === 0 && sigterm === 'later') setTimeout(() => signals.emit('SIGTERM'), 5);
      return { status: restartStatus, stderr: restartStatus ? 'Access denied' : '' };
    }
    throw new Error(`unexpected systemctl ${args.join(' ')}`);
  };
}

const HANDOVER = [
  'systemctl --user show -p MainPID --value oar.service',
  'systemctl --user reset-failed oar.service',
  'systemctl --user restart --no-block oar.service',
];

test('under a user service, exit 75 hands the restart to systemd and ends on its SIGTERM', async () => {
  const { spawned, exitCode, logs, calls } = await supervise([75], { hosting: USER_UNIT, systemctl: userManager() });
  assert.equal(spawned, 1, 'no relaunch here');
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, HANDOVER);
  assert.ok(logs.some((line) => /restart handed to systemd: oar\.service/.test(line)), logs.join('\n'));
  assert.ok(!logs.some((line) => /relaunching/.test(line)));
});

test('the SIGTERM may come a while after the restart call', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms === 30_000 ? 200 : 0));
  const { spawned, exitCode, calls } = await supervise([75], { hosting: USER_UNIT, systemctl: userManager({ sigterm: 'later' }), delay: wait });
  assert.equal(spawned, 1);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, HANDOVER);
});

test('a stop that comes in during the handover wins: no restart is sent', async () => {
  const manager = userManager();
  const stopDuringShow = (command, args, context) => {
    const answer = manager(command, args, context);
    if (args.includes('show')) context.signals.emit('SIGTERM');
    return answer;
  };
  const { spawned, exitCode, logs, calls } = await supervise([75, 0], { hosting: USER_UNIT, systemctl: stopDuringShow });
  assert.equal(spawned, 1, 'no relaunch');
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, HANDOVER.slice(0, 2), 'no restart --no-block');
  assert.ok(logs.some((line) => /a stop came in; not restarting oar\.service/.test(line)), logs.join('\n'));
});

test('a stop that arrives during reset-failed is seen once the loop has polled: no restart is sent', async (t) => {
  // As on a real host: the runtime's exit comes from an I/O callback (here an
  // fs.stat's), and the SIGTERM that arrives during the blocking reset-failed
  // waits as I/O too (here a byte on a loopback socket, written during the
  // call, which then blocks a while like spawnSync does). The stop is seen
  // only after the loop's next poll: one setImmediate is too early for it.
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = net.connect(server.address().port, '127.0.0.1');
  const [[peer]] = await Promise.all([once(server, 'connection'), once(client, 'connect')]);
  t.after(() => { client.destroy(); peer.destroy(); server.close(); });
  let raise = null;
  peer.on('data', () => raise?.());
  const manager = userManager();
  const stopDuringResetFailed = (command, args, context) => {
    const answer = manager(command, args, context);
    if (args.includes('reset-failed')) {
      raise = () => context.signals.emit('SIGTERM');
      client.write('x');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return answer;
  };
  const { spawned, exitCode, logs, calls } = await supervise([75, 0], {
    hosting: USER_UNIT,
    systemctl: stopDuringResetFailed,
    deliverExit: (fn) => fs.stat(fileURLToPath(import.meta.url), () => fn()),
  });
  assert.deepEqual(calls, HANDOVER.slice(0, 2), 'no restart --no-block');
  assert.equal(spawned, 1, 'no relaunch');
  assert.equal(exitCode, 0);
  assert.ok(logs.some((line) => /a stop came in; not restarting oar\.service/.test(line)), logs.join('\n'));
});

test('no SIGTERM within the wait: the runtime is relaunched here, with a log line', async () => {
  const { spawned, exitCode, logs, calls } = await supervise([75, 0], { hosting: USER_UNIT, systemctl: userManager({ sigterm: 'never' }) });
  assert.equal(spawned, 2);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, HANDOVER);
  assert.ok(logs.some((line) => /systemd did not stop oar\.service within 30 s/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /runtime requested restart; relaunching/.test(line)));
});

test('a failing systemctl restart relaunches at once', async () => {
  const { spawned, exitCode, logs, calls } = await supervise([75, 0], { hosting: USER_UNIT, systemctl: userManager({ restartStatus: 1 }) });
  assert.equal(spawned, 2);
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, HANDOVER);
  assert.ok(logs.some((line) => /restart --no-block oar\.service failed \(status 1: Access denied\)/.test(line)), logs.join('\n'));
});

test('a supervisor that is not the unit\'s main process never restarts the unit', async () => {
  // A relay started inside a worker that still sits in the service's cgroup:
  // it looks like the service, but the service's main process is another one.
  for (const manager of [userManager({ mainPid: 999 }), userManager({ showStatus: 1 }), userManager({ mainPid: 0 })]) {
    const { spawned, exitCode, logs, calls } = await supervise([75, 0], { hosting: USER_UNIT, systemctl: manager });
    assert.equal(spawned, 2, 'relaunched as today');
    assert.equal(exitCode, 0);
    assert.deepEqual(calls, ['systemctl --user show -p MainPID --value oar.service'], 'no reset-failed, no restart');
    assert.ok(logs.some((line) => /not handed to systemd, oar\.service is not this supervisor's \(pid 4321/.test(line)), logs.join('\n'));
  }
});

test('not under a user service, exit 75 relaunches the runtime and calls no systemctl', async () => {
  for (const hosting of [
    { systemd: false },
    { systemd: true, userManager: false, unit: 'oar.service' },
    { systemd: true, userManager: true, unit: '' },
  ]) {
    const { spawned, exitCode, calls, logs } = await supervise([75, 75, 0], { hosting });
    assert.equal(spawned, 3);
    assert.equal(exitCode, 0);
    assert.deepEqual(calls, []);
    assert.ok(logs.some((line) => /runtime requested restart; relaunching/.test(line)));
  }
});

test('under a user service, crashes and exit 78 are still the supervisor\'s', async () => {
  const crashes = await supervise([1, 1, 1], { hosting: USER_UNIT });
  assert.equal(crashes.spawned, 3);
  assert.equal(crashes.exitCode, 1);
  assert.deepEqual(crashes.calls, []);
  const stopped = await supervise([RELAY_STOP_EXIT_CODE], { hosting: USER_UNIT });
  assert.equal(stopped.exitCode, RELAY_STOP_EXIT_CODE);
  assert.deepEqual(stopped.calls, []);
  // A handover that falls back resets the crash count, as a relaunch does.
  const mixed = await supervise([1, 75, 1, 1, 0], { hosting: USER_UNIT, systemctl: userManager({ restartStatus: 1 }) });
  assert.equal(mixed.spawned, 5);
  assert.equal(mixed.exitCode, 0);
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
