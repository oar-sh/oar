import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerReplacement, createWorkerReplacementFence, workerReleaseHold } from './worker-replacement.mjs';
import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';

function setup({ stopResult = { ok: true }, stopThrows = null, ensureResult = { ok: true }, alive = () => false, identity = async () => null } = {}) {
  const calls = [];
  const warnings = [];
  const identityReads = [];
  const worker = { sdkSessionId: 'sid-1-abcdef', pid: 4242, status: 'ready' };
  const registry = {
    getWorker: (sid) => { calls.push(['getWorker', sid]); return worker; },
    removeWorker: (sid) => { calls.push(['removeWorker', sid]); return true; },
  };
  const supervisor = {
    markKilled: (sid) => { calls.push(['markKilled', sid]); },
    cancelPendingStart: async (sid, options) => { calls.push(['cancelPendingStart', sid, options]); },
    clearRestartSchedule: (sid, options) => { calls.push(['clearRestartSchedule', sid, options]); },
    resetHealth: (sid, options) => { calls.push(['resetHealth', sid, options]); },
    ensureWorker: async (sid, options) => { calls.push(['ensureWorker', sid, options]); return ensureResult; },
  };
  const inspector = { name: 'inspector' };
  const isProcessAlive = alive;
  const killTmuxSession = () => {};
  let stopArgs = null;
  const replacement = createWorkerReplacement({
    registry,
    supervisor,
    processInspector: inspector,
    stopSessionWorkerProcesses: async (args) => {
      stopArgs = args;
      calls.push(['stopSessionWorkerProcesses', args.sdkSessionId]);
      if (stopThrows) throw stopThrows;
      return stopResult;
    },
    isProcessAlive,
    readProcessIdentity: async (pid, options) => {
      identityReads.push([pid, options]);
      return identity(pid, options);
    },
    killTmuxSession,
    logger: { log() {}, warn: (line) => warnings.push(line) },
    logPrefix: () => '[relay] TEST ',
  });
  return { replacement, calls, warnings, identityReads, worker, inspector, isProcessAlive, killTmuxSession, stopArgs: () => stopArgs };
}

const names = (calls) => calls.map(([name]) => name);

test('release holds: from the worker\'s own word, else read from an older snapshot', () => {
  assert.equal(workerReleaseHold(null), null);
  assert.equal(workerReleaseHold({ steering: { releasable: true } }), null);
  assert.equal(workerReleaseHold({ steering: { releasable: false, releaseHold: 'compaction' } }), 'compaction');
  assert.equal(workerReleaseHold({ steering: { releasable: false } }), 'turn');
  assert.equal(workerReleaseHold({ steering: { holdReason: 'question' } }), 'question');
  assert.equal(workerReleaseHold({ steering: { turnActive: false, autoCompactWindow: { backgroundWork: true } } }), 'background');
  assert.equal(workerReleaseHold({ status: 'processing' }), 'turn');
  assert.equal(workerReleaseHold({ status: 'ready' }), null);
});

test('a stop marks the session killed, waits out a pending start, stops every process, then clears the entry', async () => {
  const app = setup();
  assert.deepEqual(await app.replacement.stopWorker('sid-1-abcdef'), { ok: true });
  assert.deepEqual(names(app.calls), [
    'getWorker',
    'markKilled',
    'cancelPendingStart',
    'stopSessionWorkerProcesses',
    'removeWorker',
    'resetHealth',
  ]);
  assert.deepEqual(app.calls[2][2], { wait: true });
  assert.deepEqual(app.calls[5][2], { clearFailureCount: false });
  const args = app.stopArgs();
  assert.equal(args.worker, app.worker);
  assert.equal(args.processInspector, app.inspector);
  assert.equal(args.isPidAliveImpl, app.isProcessAlive);
  assert.equal(args.killTmuxSessionImpl, app.killTmuxSession);
  // The killed marker stays: the caller's launch clears it.
  assert.equal(app.calls.some(([name]) => name === 'clearRestartSchedule'), false);
  assert.deepEqual(app.warnings, []);
});

test('a stop reads the worker\'s identity before it ends the process, and hands back its pid and start time', async () => {
  const app = setup({ identity: async (pid) => ({ pid, startTime: '987654', commandLine: 'node claude-session-worker.mjs --session-id sid-1-abcdef' }) });
  assert.deepEqual(await app.replacement.stopWorker('sid-1-abcdef'), { ok: true, identity: { pid: 4242, startTime: '987654' } });
  assert.deepEqual(app.identityReads, [[4242, {}]]);
  // The stop gets it too, to check a pid its process list did not show
  // before it kills it (Windows).
  assert.deepEqual(app.stopArgs().workerIdentity, { pid: 4242, startTime: '987654', commandLine: 'node claude-session-worker.mjs --session-id sid-1-abcdef' });
  assert.equal(typeof app.stopArgs().readProcessIdentityImpl, 'function');
  // A start time that could not be read: no identity, the caller keeps the pid.
  const unknown = setup({ identity: async (pid) => ({ pid, startTime: null, commandLine: null }) });
  assert.deepEqual(await unknown.replacement.stopWorker('sid-1-abcdef'), { ok: true });
  // A reader that throws is nothing known, not a failed stop.
  const throwing = setup({ identity: async () => { throw new Error('ps missing'); } });
  assert.deepEqual(await throwing.replacement.stopWorker('sid-1-abcdef'), { ok: true });
});

test('a stop that leaves processes behind clears the killed marker, warns, and keeps the entry', async () => {
  const app = setup({ stopResult: { ok: false, error: 'worker-survived-stop', remainingPids: [4242, 4243] } });
  assert.deepEqual(await app.replacement.stopWorker('sid-1-abcdef'), {
    ok: false,
    error: 'worker-survived-stop',
    remainingPids: [4242, 4243],
  });
  assert.deepEqual(names(app.calls), ['getWorker', 'markKilled', 'cancelPendingStart', 'stopSessionWorkerProcesses', 'clearRestartSchedule']);
  assert.deepEqual(app.calls[4][2], { resetKilledMarker: true });
  assert.equal(app.warnings.length, 1);
  assert.match(app.warnings[0], /^\[relay\] TEST STOP FAILED session=sid-1-ab worker-survived-stop remaining=4242,4243 — kill marker cleared/);
});

const OURS = 'node claude-session-worker.mjs --session-id sid-1-abcdef';

test('a stop that never saw the registry\'s live worker is no stop: the entry stays, the marker goes, the caller retries', async () => {
  // The process list showed no worker of the session (a command line it does
  // not know as a worker's), and the registry's pid still runs as the
  // session's worker: its command line names the session, its start time is
  // the one read before the stop.
  const identity = async (pid) => ({ pid, startTime: '1000', commandLine: OURS });
  const app = setup({ stopResult: { ok: true, pids: [] }, alive: (pid) => pid === 4242, identity });
  assert.deepEqual(await app.replacement.stopWorker('sid-1-abcdef'), {
    ok: false,
    error: 'worker-not-in-process-list',
    remainingPids: [4242],
  });
  assert.deepEqual(names(app.calls), ['getWorker', 'markKilled', 'cancelPendingStart', 'stopSessionWorkerProcesses', 'clearRestartSchedule']);
  assert.deepEqual(app.calls[4][2], { resetKilledMarker: true });
  assert.match(app.warnings[0], /STOP FAILED session=sid-1-ab worker-not-in-process-list remaining=4242 — kill marker cleared/);
  // Read before the stop, then fresh after it.
  assert.deepEqual(app.identityReads, [[4242, {}], [4242, { fresh: true }]]);

  // keepKilled keeps the marker on this failure too.
  const archived = setup({ stopResult: { ok: true, pids: [] }, alive: () => true, identity });
  assert.equal((await archived.replacement.stopWorker('sid-1-abcdef', { keepKilled: true })).error, 'worker-not-in-process-list');
  assert.equal(archived.calls.some(([name]) => name === 'clearRestartSchedule'), false);

  // A pid the list did show and the stop waited out counts as stopped (a
  // zombie not yet reaped answers signal 0), and so does a registry pid
  // that is gone.
  const listed = setup({ stopResult: { ok: true, pids: [4242] }, alive: () => true, identity });
  assert.equal((await listed.replacement.stopWorker('sid-1-abcdef')).ok, true);
  const gone = setup({ stopResult: { ok: true, pids: [] }, alive: () => false, identity });
  assert.equal((await gone.replacement.stopWorker('sid-1-abcdef')).ok, true);
  assert.equal(gone.calls.some(([name]) => name === 'removeWorker'), true);
});

test('a live pid that is not the session\'s worker any more is not blamed: the worker is gone', async () => {
  const cases = {
    // The pid handed out again: another start time than before the stop.
    'another start time': (() => {
      let reads = 0;
      return async (pid) => ({ pid, startTime: (reads += 1) === 1 ? '1000' : '2000', commandLine: OURS });
    })(),
    // Another process: its command line names no session, or another one.
    'another command line': async (pid) => ({ pid, startTime: '1000', commandLine: '/usr/bin/python3 -m http.server' }),
    'another session': async (pid) => ({ pid, startTime: '1000', commandLine: 'node claude-session-worker.mjs --session-id sid-2-fedcba' }),
    // A zombie: no command line left.
    'a zombie': async (pid) => ({ pid, startTime: '1000', commandLine: '' }),
    // Gone between the signal-0 check and the read.
    'gone by the read': async (pid, options) => (options?.fresh ? null : { pid, startTime: '1000', commandLine: OURS }),
  };
  for (const [name, identity] of Object.entries(cases)) {
    const app = setup({ stopResult: { ok: true, pids: [] }, alive: () => true, identity });
    const result = await app.replacement.stopWorker('sid-1-abcdef');
    assert.equal(result.ok, true, name);
    assert.equal(app.calls.some(([call]) => call === 'removeWorker'), true, name);
    assert.deepEqual(app.warnings, [], name);
  }
});

test('a live pid nothing could be read about is no stop, and is not named', async () => {
  for (const identity of [
    async (pid) => ({ pid, startTime: null, commandLine: null }),
    async () => { throw new Error('ps missing'); },
  ]) {
    const app = setup({ stopResult: { ok: true, pids: [] }, alive: () => true, identity });
    assert.deepEqual(await app.replacement.stopWorker('sid-1-abcdef'), { ok: false, error: 'worker-not-in-process-list', remainingPids: [] });
    assert.match(app.warnings[0], /STOP FAILED session=sid-1-ab worker-not-in-process-list — kill marker cleared/);
    assert.equal(app.calls.some(([call]) => call === 'removeWorker'), false);
  }
});

test('a stop that throws is a failure with the error text and no remaining pids', async () => {
  const app = setup({ stopThrows: new Error('inspector down') });
  assert.deepEqual(await app.replacement.stopWorker('sid-1-abcdef'), { ok: false, error: 'inspector down', remainingPids: [] });
  assert.equal(app.calls.at(-1)[0], 'clearRestartSchedule');
  assert.match(app.warnings[0], /STOP FAILED session=sid-1-ab inspector down — kill marker cleared/);
});

test('keepKilled: the session stays kill-blocked on success and on failure; the entry still goes on success', async () => {
  const ok = setup();
  assert.deepEqual(await ok.replacement.stopWorker('sid-1-abcdef', { keepKilled: true }), { ok: true });
  assert.deepEqual(names(ok.calls), ['getWorker', 'markKilled', 'cancelPendingStart', 'stopSessionWorkerProcesses', 'removeWorker', 'resetHealth']);

  const failed = setup({ stopResult: { ok: false, error: 'timeout', remainingPids: [7] } });
  assert.equal((await failed.replacement.stopWorker('sid-1-abcdef', { keepKilled: true })).ok, false);
  assert.equal(failed.calls.some(([name]) => name === 'clearRestartSchedule'), false);
  assert.equal(failed.calls.some(([name]) => name === 'removeWorker'), false);
  assert.match(failed.warnings[0], /kill marker kept/);
});

test('a launch clears the killed marker and starts a fresh worker, never reusing a live process', async () => {
  const app = setup();
  assert.deepEqual(await app.replacement.launchWorker('sid-1-abcdef'), { ok: true, error: null });
  assert.deepEqual(app.calls, [
    ['clearRestartSchedule', 'sid-1-abcdef', { resetKilledMarker: true }],
    ['ensureWorker', 'sid-1-abcdef', { allowProcessReuse: false }],
  ]);
  const failed = setup({ ensureResult: { ok: false, error: 'kill-blocked' } });
  assert.deepEqual(await failed.replacement.launchWorker('sid-1-abcdef'), { ok: false, error: 'kill-blocked' });
});

// The replacement fence: while a worker process is replaced, no work is
// handed to it.
test('the fence refuses the pid being replaced only, and lifts on release', () => {
  const fence = createWorkerReplacementFence();
  assert.equal(fence.isHeld('sid-1', 100), false);
  fence.hold('sid-1', 100);
  assert.equal(fence.isHeld('sid-1', 100), true);
  assert.equal(fence.isHeld('sid-1', '100'), true, 'a pid from a header reads the same');
  assert.equal(fence.isHeld('sid-1', 101), false, 'the new worker is never fenced');
  assert.equal(fence.isHeld('sid-2', 100), false);
  // A request that names no pid cannot be told from the old process.
  assert.equal(fence.isHeld('sid-1', null), true);
  assert.equal(fence.isHeld('sid-1'), true);
  // A release for another pid (an older replacement's, late) lifts nothing.
  assert.equal(fence.release('sid-1', 99), false);
  assert.equal(fence.isHeld('sid-1', 100), true);
  assert.deepEqual(fence.list(), [{ sdkSessionId: 'sid-1', pid: 100 }]);
  assert.equal(fence.release('sid-1', 100), true);
  assert.equal(fence.isHeld('sid-1', 100), false);
  fence.hold('sid-1', 100);
  assert.equal(fence.release('sid-1'), true, 'a release without a pid lifts the session\'s fence');
  assert.equal(fence.isHeld('sid-1', 100), false);
  assert.equal(fence.hold('', 100), false);
});

test('createWorkerReplacement hands back the fence it was given (or its own)', () => {
  const fence = createWorkerReplacementFence();
  const shared = createWorkerReplacement({ registry: {}, supervisor: {}, stopSessionWorkerProcesses: async () => ({ ok: true }), fence });
  assert.equal(shared.fence, fence);
  const own = createWorkerReplacement({ registry: {}, supervisor: {}, stopSessionWorkerProcesses: async () => ({ ok: true }) });
  assert.equal(typeof own.fence.isHeld, 'function');
  assert.notEqual(own.fence, fence);
});

test('lifting the killed marker does not lift the fence: clearRestartSchedule({ resetKilledMarker }) and the kill grace leave it up', async () => {
  let nowMs = 1_000;
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    spawnWorker: async () => ({ workerId: 'worker-x', pid: null }),
    isPidAlive: () => false,
  });
  const fence = createWorkerReplacementFence();
  const replacement = createWorkerReplacement({
    registry,
    supervisor,
    stopSessionWorkerProcesses: async () => ({ ok: true }),
    isProcessAlive: () => false,
    fence,
    logger: { log() {}, warn() {} },
  });
  registry.upsertWorker({ sdkSessionId: 'sid-fenced', pid: 4242, status: 'ready' });
  fence.hold('sid-fenced', 4242);
  supervisor.markKilled('sid-fenced');
  assert.equal(supervisor.isKillBlocked('sid-fenced'), true);
  // Any relaunch path (the delivery's fallback restart among them) lifts the
  // killed marker at once ...
  supervisor.clearRestartSchedule('sid-fenced', { resetKilledMarker: true });
  assert.equal(supervisor.isKillBlocked('sid-fenced'), false);
  assert.equal(replacement.fence.isHeld('sid-fenced', 4242), true, 'the fence is its own structure');
  // ... and the kill grace lapses by itself, long before a verified stop is done.
  supervisor.markKilled('sid-fenced');
  nowMs += 60_000;
  assert.equal(supervisor.isKillBlocked('sid-fenced'), false);
  assert.equal(fence.isHeld('sid-fenced', 4242), true);
  // Nor does the replacement's own stop or launch touch it: the caller lowers it.
  await replacement.stopWorker('sid-fenced');
  await replacement.launchWorker('sid-fenced');
  assert.equal(fence.isHeld('sid-fenced', 4242), true);
});
