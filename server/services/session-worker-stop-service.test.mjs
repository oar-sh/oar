import assert from 'node:assert/strict';
import test from 'node:test';

import { stopSessionWorkerProcesses } from './session-worker-stop-service.mjs';

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
      findProcessesForSession: () => pids.map((processId) => ({ processId })),
      findWindowsProcessTreeForSession: () => pids.map((processId) => ({ processId })),
      stopWindowsPids: () => {},
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
    processInspector: { findProcessesForSession: () => [] },
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

test('win32: survivors trigger re-enumeration and a second stopWindowsPids pass', async () => {
  const stopCalls = [];
  let enumerations = 0;
  // The first snapshot sees pid 71; a child (72) appears only on re-enumeration.
  const inspector = {
    findWindowsProcessTreeForSession: () => {
      enumerations += 1;
      return enumerations === 1 ? [{ processId: 71 }] : [{ processId: 71 }, { processId: 72 }];
    },
    stopWindowsPids: (pids) => stopCalls.push([...pids]),
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
