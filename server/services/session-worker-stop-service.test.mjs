import assert from 'node:assert/strict';
import test from 'node:test';

import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { isProcessAlive, stopSessionWorkerProcesses } from './session-worker-stop-service.mjs';

const SID = 'sess-1';

// Deterministic fake clock: sleepImpl advances it, so timeouts are instant.
function fakeClock() {
  let now = 0;
  return {
    nowMs: () => now,
    sleepImpl: async (ms) => { now += Math.max(1, Number(ms) || 1); },
  };
}

/** aliveFor: pid -> number of isPidAlive probes it survives before "dying". */
function fakeProcesses(pids, aliveFor = {}) {
  const probes = new Map();
  return {
    inspector: {
      findProcessesForSessionAsync: () => pids.map((processId) => ({ processId })),
      findWindowsProcessTreeForSessionAsync: () => pids.map((processId) => ({ processId })),
      stopWindowsPidsAsync: () => {},
    },
    isPidAliveImpl: (pid) => {
      const budget = Number(aliveFor[pid] ?? 0);
      const seen = (probes.get(pid) || 0) + 1;
      probes.set(pid, seen);
      return seen <= budget;
    },
  };
}

test('returns immediately when there are no processes to stop', async () => {
  const calls = [];
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: { findProcessesForSessionAsync: () => [] },
    killImpl: (pid, signal) => calls.push([pid, signal]),
    ...fakeClock(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pids, []);
  assert.equal(calls.length, 0);
});

test('posix: SIGTERM to every pid, success once they exit', async () => {
  const calls = [];
  const { inspector, isPidAliveImpl } = fakeProcesses([11, 12], { 11: 1, 12: 1 });
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: inspector,
    isPidAliveImpl,
    killImpl: (pid, signal) => calls.push([pid, signal]),
    killTmuxSessionImpl: () => calls.push(['tmux', SID]),
    ...fakeClock(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, false);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.pids, [11, 12]);
  assert.deepEqual(calls.filter(([, s]) => s === 'SIGTERM').map(([p]) => p), [11, 12]);
  assert.equal(calls.filter(([p]) => p === 'tmux').length, 1);
});

test('posix: escalates to SIGKILL when the graceful window expires', async () => {
  const calls = [];
  const { inspector, isPidAliveImpl } = fakeProcesses([21], { 21: 200 });
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: inspector,
    isPidAliveImpl,
    killImpl: (pid, signal) => calls.push([pid, signal]),
    gracefulTimeoutMs: 300,
    escalationTimeoutMs: 300,
    pollIntervalMs: 50,
    ...fakeClock(),
  });
  assert.deepEqual(calls, [[21, 'SIGTERM'], [21, 'SIGKILL']]);
  assert.equal(result.escalated, true);
  // 200 probes outlive both windows at 50ms/probe, so this run times out.
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.remainingPids, [21]);
});

test('posix: a pid that dies during escalation reports ok', async () => {
  const { inspector, isPidAliveImpl } = fakeProcesses([31], { 31: 8 });
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: inspector,
    isPidAliveImpl,
    killImpl: () => {},
    gracefulTimeoutMs: 150,
    escalationTimeoutMs: 900,
    pollIntervalMs: 50,
    ...fakeClock(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.deepEqual(result.remainingPids, []);
});

test('never throws on timeout; reports timedOut instead', async () => {
  const { inspector, isPidAliveImpl } = fakeProcesses([41], { 41: Number.MAX_SAFE_INTEGER });
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: inspector,
    isPidAliveImpl,
    killImpl: () => {},
    gracefulTimeoutMs: 100,
    escalationTimeoutMs: 100,
    ...fakeClock(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /^worker-stop-timeout:41$/);
});

test('ESRCH is swallowed but other kill errors surface', async () => {
  const { inspector, isPidAliveImpl } = fakeProcesses([51], {});
  const gone = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: inspector,
    isPidAliveImpl,
    killImpl: () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); },
    ...fakeClock(),
  });
  assert.equal(gone.ok, true);

  const denied = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: fakeProcesses([52], { 52: 5 }).inspector,
    isPidAliveImpl: () => true,
    killImpl: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    ...fakeClock(),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not permitted/);
});

test('killTmuxSession runs on posix only', async () => {
  let tmuxCalls = 0;
  const { inspector, isPidAliveImpl } = fakeProcesses([61], {});
  await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'win32',
    processInspector: inspector,
    isPidAliveImpl,
    killTmuxSessionImpl: () => { tmuxCalls += 1; },
    ...fakeClock(),
  });
  assert.equal(tmuxCalls, 0);
});

test('win32: survivors trigger re-enumeration and a second stopWindowsPidsAsync pass', async () => {
  const stopCalls = [];
  let enumerations = 0;
  // The first snapshot sees pid 71; a child (72) appears only on re-enumeration.
  const inspector = {
    findWindowsProcessTreeForSessionAsync: () => {
      enumerations += 1;
      return enumerations === 1 ? [{ processId: 71 }] : [{ processId: 71 }, { processId: 72 }];
    },
    stopWindowsPidsAsync: (pids) => stopCalls.push([...pids]),
  };
  const probes = new Map();
  const isPidAliveImpl = (pid) => {
    const seen = (probes.get(pid) || 0) + 1;
    probes.set(pid, seen);
    // 71 survives the graceful window, then both die during escalation.
    return pid === 71 ? seen <= 4 : seen <= 1;
  };
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'win32',
    processInspector: inspector,
    isPidAliveImpl,
    gracefulTimeoutMs: 150,
    escalationTimeoutMs: 900,
    pollIntervalMs: 50,
    ...fakeClock(),
  });
  assert.equal(stopCalls.length, 2);
  assert.deepEqual(stopCalls[0], [71]);
  assert.ok(stopCalls[1].includes(72), 'the rediscovered child must be killed too');
  assert.equal(result.escalated, true);
  assert.equal(result.ok, true);
});

test('an unreadable process list stops nothing blind and says so', async () => {
  const stopCalls = [];
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    worker: { pid: 4242 },
    platform: 'win32',
    processInspector: {
      findWindowsProcessTreeForSessionAsync: async () => { throw new Error('windows-process-snapshot-unreadable: Bad control character in string literal'); },
      stopWindowsPidsAsync: async (pids) => stopCalls.push([...pids]),
    },
    isPidAliveImpl: () => true,
    ...fakeClock(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /^process-list-unreadable: windows-process-snapshot-unreadable/);
  assert.deepEqual(stopCalls, [], 'the known pid alone is not stopped: its tree would run on');
  assert.deepEqual(result.pids, []);
});

test('a registry pid whose process is gone counts as stopped: nothing to stop, no stop call', async () => {
  for (const platform of ['win32', 'linux']) {
    const calls = [];
    const result = await stopSessionWorkerProcesses({
      sdkSessionId: SID,
      worker: { pid: 4242 },
      platform,
      processInspector: {
        findWindowsProcessTreeForSessionAsync: async () => [],
        findProcessesForSessionAsync: async () => [],
        // Windows: the stop's own process read could fail; it is never asked.
        stopWindowsPidsAsync: async () => { calls.push('stop'); throw new Error('Get-CimInstance timed out'); },
      },
      killImpl: (pid, signal) => calls.push([pid, signal]),
      isPidAliveImpl: () => false,
      ...fakeClock(),
    });
    assert.equal(result.ok, true, platform);
    assert.deepEqual(result.pids, [], platform);
    assert.deepEqual(calls, [], platform);
  }
});

// Windows hands a pid out again within seconds: the registry's pid that is
// not in the session's tree is stopped only while it is still the worker.
function windowsUnlistedWorker({ snapshot, workerIdentity = null, readProcessIdentityImpl = undefined }) {
  const stopCalls = [];
  const snapshotReads = [];
  const alive = new Set([4242]);
  return {
    stopCalls,
    snapshotReads,
    run: () => stopSessionWorkerProcesses({
      sdkSessionId: SID,
      worker: { pid: 4242 },
      workerIdentity,
      platform: 'win32',
      processInspector: {
        findWindowsProcessTreeForSessionAsync: async () => [{ processId: 81 }],
        ...(snapshot ? { readProcessSnapshot: async (options) => { snapshotReads.push(options); return snapshot; } } : {}),
        stopWindowsPidsAsync: async (pids) => { stopCalls.push([...pids]); for (const pid of pids) alive.delete(pid); },
      },
      ...(readProcessIdentityImpl ? { readProcessIdentityImpl } : {}),
      isPidAliveImpl: (pid) => alive.has(pid),
      ...fakeClock(),
    }),
  };
}

const WORKER_ROW = { processId: 4242, parentProcessId: 1, name: 'node.exe', commandLine: `node claude-session-worker.mjs --session-id ${SID}`, createdAt: 1762941600000 };

test('win32: a registry pid the tree does not show is stopped when it is still the session\'s worker', async () => {
  const app = windowsUnlistedWorker({ snapshot: [WORKER_ROW], workerIdentity: { pid: 4242, startTime: '1762941600000' } });
  const result = await app.run();
  assert.equal(result.ok, true);
  assert.deepEqual(app.stopCalls, [[81, 4242]]);
  // The list the tree came from, not a read of its own.
  assert.deepEqual(app.snapshotReads, [{ fresh: false }]);
});

test('win32: a registry pid that is not verified as the worker is never killed', async () => {
  const cases = {
    'another process got the pid': { snapshot: [{ ...WORKER_ROW, name: 'svchost.exe', commandLine: 'C:\\Windows\\system32\\svchost.exe -k netsvcs' }] },
    'another session\'s worker': { snapshot: [{ ...WORKER_ROW, commandLine: 'node claude-session-worker.mjs --session-id sess-2' }] },
    'another start time than before the stop': { snapshot: [WORKER_ROW], workerIdentity: { pid: 4242, startTime: '1762941500000' } },
    'not on the list at all': { snapshot: [] },
    'no list to read': { snapshot: null },
    'a reader that throws': { snapshot: [WORKER_ROW], readProcessIdentityImpl: async () => { throw new Error('unreadable'); } },
  };
  for (const [name, options] of Object.entries(cases)) {
    const app = windowsUnlistedWorker(options);
    const result = await app.run();
    assert.equal(result.ok, true, name);
    assert.deepEqual(app.stopCalls, [[81]], name);
    assert.deepEqual(result.pids, [81], name);
  }
});

// The process list holds every process with its command line, so a live
// worker is always on it; the registry's pid that is not is someone else's
// process now (or an unreaped zombie), and no signal goes to it.
test('posix: a registry pid that is alive but not listed is not the worker: nothing to stop', async () => {
  for (const code of [null, 'EPERM']) {
    const calls = [];
    const result = await stopSessionWorkerProcesses({
      sdkSessionId: SID,
      worker: { pid: 4242 },
      platform: 'linux',
      processInspector: { findProcessesForSessionAsync: async () => [] },
      isPidAliveImpl: () => true,
      killImpl: (pid, signal) => {
        calls.push([pid, signal]);
        if (code) throw Object.assign(new Error('operation not permitted'), { code });
      },
      ...fakeClock(),
    });
    assert.equal(result.ok, true, String(code));
    assert.deepEqual(result.pids, [], String(code));
    assert.deepEqual(calls, [], String(code));
  }
});

// The list matches command lines: a shell that carried the session's
// arguments can be on it while it ends by itself, another user's included
// (no signal reaches it), and a process killed but not reaped yet answers
// signal 0 though it is gone from the list.
test('posix: a match that is gone from a fresh list by the re-check counts as stopped; the others get their signals', async () => {
  const cases = {
    'another user\'s ending shell': (pid) => { if (pid === 5150) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    'an unreaped zombie': () => {},
  };
  for (const [name, refuse] of Object.entries(cases)) {
    const calls = [];
    let reads = 0;
    const result = await stopSessionWorkerProcesses({
      sdkSessionId: SID,
      platform: 'linux',
      processInspector: {
        findProcessesForSessionAsync: async () => (reads++ === 0 ? [{ processId: 5150 }, { processId: 61 }] : []),
      },
      // 61 dies on SIGTERM; 5150 answers signal 0 throughout.
      isPidAliveImpl: (pid) => pid === 5150 || !calls.some(([p]) => p === pid),
      killImpl: (pid, signal) => {
        refuse(pid);
        calls.push([pid, signal]);
      },
      gracefulTimeoutMs: 100,
      escalationTimeoutMs: 100,
      ...fakeClock(),
    });
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.remainingPids, [], name);
    assert.ok(calls.some(([pid, signal]) => pid === 61 && signal === 'SIGTERM'), `${name}: the other pid was signalled`);
    assert.equal(reads, 2, `${name}: the list was read again before giving up`);
  }
});

test('posix: a match a fresh list still shows after the stop is not stopped, and the reason says why', async () => {
  const denied = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: { findProcessesForSessionAsync: async () => [{ processId: 71 }] },
    isPidAliveImpl: () => true,
    killImpl: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    gracefulTimeoutMs: 100,
    escalationTimeoutMs: 100,
    ...fakeClock(),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.timedOut, false);
  assert.deepEqual(denied.remainingPids, [71]);
  assert.match(denied.error, /not permitted/);
  // One refused and one that took its signals and lives on: a timeout.
  const mixed = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: { findProcessesForSessionAsync: async () => [{ processId: 71 }, { processId: 73 }] },
    isPidAliveImpl: () => true,
    killImpl: (pid) => { if (pid === 71) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    gracefulTimeoutMs: 100,
    escalationTimeoutMs: 100,
    ...fakeClock(),
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.timedOut, true);
  assert.deepEqual(mixed.remainingPids, [71, 73]);
  assert.match(mixed.error, /^worker-stop-timeout:71,73$/);
  // An unreadable second list changes nothing: the survivor stays one.
  let reads = 0;
  const unreadable = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'linux',
    processInspector: { findProcessesForSessionAsync: async () => { if (reads++) throw new Error('ps failed'); return [{ processId: 72 }]; } },
    isPidAliveImpl: () => true,
    killImpl: () => {},
    gracefulTimeoutMs: 100,
    escalationTimeoutMs: 100,
    ...fakeClock(),
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.error, /^worker-stop-timeout:72$/);
});

test('isProcessAlive: signal 0 reaches it; EPERM is alive, anything else is not', async () => {
  assert.equal(isProcessAlive(process.pid), true, 'this process');
  const child = spawn(process.execPath, ['-e', '']);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(isProcessAlive(child.pid), false, 'a child that has ended');
  const throwing = (code) => ({ killImpl: () => { throw Object.assign(new Error(code), { code }); } });
  assert.equal(isProcessAlive(4242, throwing('EPERM')), true, 'someone else\'s process');
  assert.equal(isProcessAlive(4242, throwing('ESRCH')), false);
  for (const pid of [0, -1, 1.5, 'x', null]) assert.equal(isProcessAlive(pid), false, String(pid));
});

test('without a check of its own, a stop asks the process itself: an ended worker is not signalled', async () => {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const calls = [];
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    worker: { pid: child.pid },
    platform: 'linux',
    processInspector: { findProcessesForSessionAsync: async () => [] },
    killImpl: (pid, signal) => calls.push([pid, signal]),
    ...fakeClock(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pids, []);
  assert.deepEqual(calls, []);
});

test('the stop reads the list fresh, off the thread', async () => {
  const options = [];
  const result = await stopSessionWorkerProcesses({
    sdkSessionId: SID,
    platform: 'win32',
    processInspector: {
      findWindowsProcessTreeForSessionAsync: async (_sid, opts) => { options.push(opts); return [{ processId: 91 }]; },
      stopWindowsPidsAsync: async () => {},
    },
    isPidAliveImpl: () => false,
    ...fakeClock(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(options, [{ fresh: true }]);
});
