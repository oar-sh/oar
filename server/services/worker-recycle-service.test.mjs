import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkerRecycleService, isWorkerOnOtherBuild, RECYCLE_HOLDS, workerRecycleStuckNoteText } from './worker-recycle-service.mjs';
import { sweepArchivedWorkers } from './worker-recycle-service.mjs';
import { createWorkerReplacementFence } from './worker-replacement.mjs';
import { createKeyedMutex } from './keyed-mutex-service.mjs';

const RELAY = '0.9.21+0123456789ab';
const OLD = '0.9.20+fedcba987654';

// A controllable clock: timers fire only when the test advances it.
function createClock(start = CLOCK_START) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      const timer = { id, at: current + Math.max(0, Number(ms) || 0), fn, unrefed: false, unref() { this.unrefed = true; return this; } };
      timers.set(id, timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timers.delete(timer.id); },
    pending: () => Array.from(timers.values()),
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = Array.from(timers.values()).filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        current = Math.max(current, due.at);
        due.fn();
        await flush();
      }
      current = target;
      await flush();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const CLOCK_START = Date.parse('2026-10-30T12:00:00.000Z');
// Started well before the clock: past the absent-build-id grace.
const LONG_AGO = new Date(CLOCK_START - 3_600_000).toISOString();

function worker(sid, extra = {}) {
  return { sdkSessionId: sid, pid: 100, status: 'ready', kind: 'claude', buildId: OLD, startedAt: LONG_AGO, steering: { releasable: true }, ...extra };
}

function setup({
  workers = [],
  relayBuildId = RELAY,
  heartbeated = () => true,
  running = () => false,
  archived = () => false,
  stop = null,
  launch = null,
  options = {},
} = {}) {
  const clock = createClock();
  const registry = new Map(workers.map((entry) => [entry.sdkSessionId, entry]));
  const calls = [];
  const logs = [];
  const warns = [];
  let nextPid = 500;
  const defaultStop = async (sid) => { registry.delete(sid); return { ok: true }; };
  const defaultLaunch = async (sid) => {
    nextPid += 1;
    registry.set(sid, worker(sid, { pid: nextPid, buildId: RELAY }));
    return { ok: true };
  };
  const service = createWorkerRecycleService({
    relayBuildId,
    listWorkers: () => Array.from(registry.values()),
    getWorker: (sid) => registry.get(sid) || null,
    hasRunningTurn: (sid) => running(sid),
    hasHeartbeated: (sid) => heartbeated(sid),
    isArchived: (sid) => archived(sid),
    stopWorker: async (sid, opts) => {
      calls.push(opts ? ['stop', sid, opts] : ['stop', sid]);
      return (stop || defaultStop)(sid, opts, { registry });
    },
    launchWorker: async (sid) => {
      calls.push(['launch', sid]);
      return (launch || defaultLaunch)(sid, { registry, defaultLaunch });
    },
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    minStartGapMs: 0,
    logger: { log: (line) => logs.push(line), warn: (line) => warns.push(line) },
    ...options,
  });
  return { service, clock, registry, calls, logs, warns };
}

test('stale: an absent build id only once the worker heartbeated; a different id; never an equal id', () => {
  let beat = false;
  const app = setup({ heartbeated: () => beat });
  const { isStale } = app.service;
  assert.equal(isStale(worker('a', { buildId: null })), false, 'a booting worker that has not spoken is left alone');
  beat = true;
  assert.equal(isStale(worker('a', { buildId: null })), true);
  assert.equal(isStale(worker('a', { buildId: OLD })), true);
  assert.equal(isStale(worker('a', { buildId: RELAY })), false);
  assert.equal(isStale(worker('a', { status: 'processing' })), true);
  assert.equal(isStale(worker('a', { status: 'starting' })), false);
  assert.equal(isStale(worker('a', { pid: null })), false);
  assert.equal(isStale(null), false);
});

test('an absent build id counts only once the entry is nullBuildIdGraceMs old; a different id needs no grace', () => {
  const app = setup({ heartbeated: () => true });
  const { isStale } = app.service;
  const ago = (ms) => new Date(CLOCK_START - ms).toISOString();
  assert.equal(isStale(worker('a', { buildId: null, startedAt: ago(10_000) })), false, 'a fresh launch has not said hello yet');
  assert.equal(isStale(worker('a', { buildId: null, startedAt: ago(31_000) })), true);
  assert.equal(isStale(worker('a', { buildId: null, startedAt: CLOCK_START - 31_000 })), true, 'epoch ms read too');
  assert.equal(isStale(worker('a', { buildId: null, startedAt: null })), false, 'no start time, no age');
  assert.equal(isStale(worker('a', { buildId: OLD, startedAt: ago(1_000) })), true);
  assert.equal(isStale(worker('a', { buildId: OLD, startedAt: null })), true);
  const strict = setup({ heartbeated: () => true, options: { nullBuildIdGraceMs: 60_000 } });
  assert.equal(strict.service.isStale(worker('a', { buildId: null, startedAt: ago(31_000) })), false);
});

test('a relay with no build id recycles nothing and says so once at start', async () => {
  const app = setup({ relayBuildId: '', workers: [worker('sid-a'), worker('sid-b', { buildId: null })] });
  assert.equal(app.service.isStale(worker('sid-a')), false);
  app.service.start();
  app.service.start();
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.warns, ['[worker-recycle] relay build id unknown; workers are not recycled']);
  assert.equal(app.clock.pending().length, 0);
  assert.deepEqual(app.service.status(), { relayBuildId: null, staleCount: 0, inFlight: 0, recycled: 0, waiting: [], skipped: [] });
});

test('an idle stale worker is stopped, then relaunched, with both log lines', async () => {
  const app = setup({ workers: [worker('sid-aaaaaaaa-1', { pid: 321 }), worker('sid-bbbbbbbb-2', { buildId: RELAY })] });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-aaaaaaaa-1'], ['launch', 'sid-aaaaaaaa-1']]);
  assert.deepEqual(app.logs, [
    `[worker-recycle] recycling sid-aaaa kind=claude from=${OLD} to=${RELAY}`,
    '[worker-recycle] recycled sid-aaaa pid 321→501',
  ]);
  assert.equal(app.service.status().recycled, 1);
  assert.equal(app.service.status().staleCount, 0);
});

test('a worker that states no build id logs from=none, and a launch with no pid yet logs pending', async () => {
  const app = setup({
    workers: [worker('sid-cccccccc', { buildId: null, kind: null })],
    launch: async () => ({ ok: true }),
  });
  await app.service.sweep();
  assert.deepEqual(app.logs, [
    `[worker-recycle] recycling sid-cccc kind=unknown from=none to=${RELAY}`,
    '[worker-recycle] recycled sid-cccc pid 100→pending',
  ]);
});

test('waits while the session owns a running turn or the worker holds, logging once per interval', async () => {
  const holds = [
    ['sid-turn', { steering: { releasable: true } }, 'turn'],
    ['sid-question', { steering: { releasable: false, releaseHold: 'question' } }, 'question'],
    ['sid-compaction', { steering: { releasable: false, releaseHold: 'compaction' } }, 'compaction'],
    ['sid-background', { steering: { releasable: false, releaseHold: 'background', backgroundTaskCount: 2 } }, 'background'],
    ['sid-busy-old', { steering: { turnActive: true } }, 'turn'],
    ['sid-old-question', { steering: { turnActive: true, holdReason: 'question' } }, 'question'],
    ['sid-no-snapshot', { steering: null, status: 'processing' }, 'turn'],
  ];
  const app = setup({
    workers: holds.map(([sid, extra]) => worker(sid, extra)),
    running: (sid) => sid === 'sid-turn',
    options: { waitLogEveryMs: 60_000 },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.service.status().waiting, holds.map(([sdkSessionId, , hold]) => ({ sdkSessionId, hold })));
  assert.deepEqual(app.logs, holds.map(([sid, , hold]) => `[worker-recycle] waiting ${sid.slice(0, 8)}: ${hold}`));

  await app.clock.advance(30_000);
  await app.service.sweep();
  assert.equal(app.logs.length, holds.length, 'no repeat within the interval');
  await app.clock.advance(30_000);
  await app.service.sweep();
  assert.equal(app.logs.length, holds.length * 2);

  // The hold ends: the next sweep recycles, and the session no longer waits.
  app.registry.set('sid-question', worker('sid-question'));
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-question'], ['launch', 'sid-question']]);
  assert.equal(app.service.status().waiting.some((entry) => entry.sdkSessionId === 'sid-question'), false);
});

test('an archived session\'s stale worker is stopped kill-blocked and never relaunched', async () => {
  const app = setup({ workers: [worker('sid-archived-1', { pid: 77 })], archived: (sid) => sid === 'sid-archived-1' });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-archived-1', { keepKilled: true }]]);
  assert.deepEqual(app.logs, ['[worker-recycle] stopped sid-arch (archived)']);
  await app.clock.advance(120_000);
  await app.service.sweep();
  assert.equal(app.calls.length, 1);
  assert.equal(app.service.status().recycled, 0);
});

test('an archived session waits for its hold like any other', async () => {
  const app = setup({
    workers: [worker('sid-archived-2', { steering: { releasable: false, releaseHold: 'background' } })],
    archived: () => true,
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-archived-2', hold: 'background' }]);
});

test('at most maxInFlight recycles at once; the rest wait for a free slot', async () => {
  const releases = [];
  const app = setup({
    workers: [worker('sid-1'), worker('sid-2'), worker('sid-3')],
    stop: (sid, opts, { registry }) => new Promise((resolve) => {
      releases.push(() => { registry.delete(sid); resolve({ ok: true }); });
    }),
    options: { maxInFlight: 2 },
  });
  const first = app.service.sweep();
  await flush();
  assert.deepEqual(app.calls, [['stop', 'sid-1'], ['stop', 'sid-2']]);
  assert.equal(app.service.status().inFlight, 2);
  void app.service.sweep();
  await flush();
  assert.equal(app.calls.length, 2, 'a sweep with both slots taken starts nothing');
  releases.shift()();
  await flush();
  assert.equal(app.service.status().inFlight, 1);
  const second = app.service.sweep();
  await flush();
  assert.deepEqual(app.calls.map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-1', 'stop:sid-2', 'launch:sid-1', 'stop:sid-3']);
  releases.shift()();
  releases.shift()();
  await Promise.all([first, second]);
  assert.equal(app.service.status().recycled, 3);
  assert.equal(app.service.status().inFlight, 0);
});

test('one start per minStartGapMs on the relay: the next stale worker goes to a later sweep', async () => {
  const app = setup({ workers: [worker('sid-1'), worker('sid-2'), worker('sid-3')], options: { minStartGapMs: 3_000 } });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-1'], ['launch', 'sid-1']]);
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.equal(app.calls.length, 2);
  await app.clock.advance(2_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(2), [['stop', 'sid-2'], ['launch', 'sid-2']]);
});

test('a launch waits for the gap after another launch even when its stop was slow', async () => {
  let releaseSlowStop = null;
  const app = setup({
    workers: [worker('sid-slow'), worker('sid-fast')],
    stop: (sid, opts, { registry }) => {
      if (sid !== 'sid-slow') { registry.delete(sid); return { ok: true }; }
      return new Promise((resolve) => { releaseSlowStop = () => { registry.delete(sid); resolve({ ok: true }); }; });
    },
    options: { minStartGapMs: 3_000 },
  });
  void app.service.sweep();
  await flush();
  await app.clock.advance(3_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-slow', 'stop:sid-fast', 'launch:sid-fast']);
  await app.clock.advance(500);
  releaseSlowStop();
  await flush();
  assert.equal(app.calls.length, 3, 'the slow one waits out the gap after the fast launch');
  await app.clock.advance(2_499);
  assert.equal(app.calls.length, 3);
  await app.clock.advance(1);
  assert.deepEqual(app.calls.at(-1), ['launch', 'sid-slow']);
});

test('a failing stop backs off, doubling to the cap, and warns once naming the session after stuckAfter failures', async () => {
  const app = setup({
    workers: [worker('sid-stuck-session')],
    stop: async () => ({ ok: false, error: 'worker-survived-stop' }),
    options: { retryBaseMs: 1_000, retryMaxMs: 4_000, stuckAfter: 3 },
  });
  const stops = () => app.calls.filter(([kind]) => kind === 'stop').length;
  await app.service.sweep();
  assert.equal(stops(), 1);
  await app.clock.advance(999);
  await app.service.sweep();
  assert.equal(stops(), 1, 'in backoff');
  await app.clock.advance(1);
  await app.service.sweep();
  assert.equal(stops(), 2);
  await app.clock.advance(1_999);
  await app.service.sweep();
  assert.equal(stops(), 2);
  await app.clock.advance(1);
  await app.service.sweep();
  assert.equal(stops(), 3);
  assert.equal(app.warns.length, 1);
  assert.match(app.warns[0], /^\[worker-recycle\] session sid-stuck-session is stuck: 3 recycle attempts failed \(last: stop: worker-survived-stop\)/);
  // Capped at retryMaxMs from here on, and no further warning.
  for (let i = 0; i < 3; i += 1) {
    await app.clock.advance(3_999);
    await app.service.sweep();
    const before = stops();
    await app.clock.advance(1);
    await app.service.sweep();
    assert.equal(stops(), before + 1);
  }
  assert.equal(app.warns.length, 1);
  assert.equal(app.calls.some(([kind]) => kind === 'launch'), false);
  assert.match(app.logs.find((line) => line.includes('failed')), /^\[worker-recycle\] stop failed sid-stuc \(1\): worker-survived-stop; retrying in 1s$/);
});

test('a stop that stays stuck tells the person once per streak, with the old worker\'s pids', async () => {
  const stuck = [];
  let stopOk = false;
  const app = setup({
    workers: [worker('sid-stuck-note', { pid: 4321 })],
    stop: async (sid, opts, { registry }) => {
      if (!stopOk) return { ok: false, error: 'worker-not-in-process-list', remainingPids: [4321] };
      registry.delete(sid);
      return { ok: true };
    },
    options: { retryBaseMs: 1_000, retryMaxMs: 4_000, stuckAfter: 3, onStuck: (note) => stuck.push(note) },
  });
  await app.service.sweep();
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(stuck, [], 'two tries: no note yet');
  await app.clock.advance(2_000);
  await app.service.sweep();
  assert.deepEqual(stuck, [{ sdkSessionId: 'sid-stuck-note', step: 'stop', error: 'worker-not-in-process-list', attempts: 3, pids: [4321], archived: false }]);
  await app.clock.advance(4_000);
  await app.service.sweep();
  assert.equal(stuck.length, 1, 'one note per streak');
  // The stop goes through at last: the streak ends with the recycle.
  stopOk = true;
  await app.clock.advance(4_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.at(-1), ['launch', 'sid-stuck-note']);
  assert.equal(stuck.length, 1);
});

test('the stuck note names only the pids the stop verified, never the registry\'s pid on its own', async () => {
  const stuck = [];
  const app = setup({
    workers: [worker('sid-unverified', { pid: 4321 }), worker('sid-archived-stuck', { pid: 4322 })],
    archived: (sid) => sid === 'sid-archived-stuck',
    // The stop could not tell what the process at 4321 is: it names none.
    stop: async () => ({ ok: false, error: 'worker-not-in-process-list', remainingPids: [] }),
    options: { stuckAfter: 1, onStuck: (note) => stuck.push(note) },
  });
  await app.service.sweep();
  assert.deepEqual(stuck.map(({ sdkSessionId, pids }) => [sdkSessionId, pids]).sort(), [
    ['sid-archived-stuck', []],
    ['sid-unverified', []],
  ]);
});

test('the troubleshooting guide\'s wait matches the default backoff, and sends nobody to another user\'s process', async () => {
  // Defaults: the three tries before the fence drops are two backoffs apart.
  const app = setup({
    workers: [worker('sid-guide')],
    stop: async () => ({ ok: false, error: 'worker-survived-stop' }),
  });
  await app.service.sweep();
  await app.clock.advance(5_000);
  await app.service.sweep();
  const waits = app.logs
    .map((line) => line.match(/^\[worker-recycle\] stop failed sid-guid \(\d\): worker-survived-stop; retrying in (\d+)s$/)?.[1])
    .filter(Boolean)
    .map(Number);
  assert.deepEqual(waits, [5, 10]);
  const guide = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'troubleshooting.md'), 'utf8');
  const from = guide.indexOf("## A chat's old worker does not stop");
  assert.notEqual(from, -1, 'the section the stuck note names');
  const section = guide.slice(from, guide.indexOf('\n## ', from + 1));
  assert.match(section, new RegExp(`about ${waits[0] + waits[1]} seconds of backoff between them plus the time the three stops take`));
  assert.doesNotMatch(section, /sudo/);
});

test('a throwing stuck note is only a warning', async () => {
  const app = setup({
    workers: [worker('sid-stuck-throw')],
    stop: async () => ({ ok: false, error: 'worker-survived-stop' }),
    options: { stuckAfter: 1, onStuck: () => { throw new Error('no database'); } },
  });
  await app.service.sweep();
  assert.match(app.warns.at(-1), /^\[worker-recycle\] stuck note for sid-stuc failed: no database$/);
});

test('the stuck note names the old worker and how to stop it by hand, per platform', () => {
  const stuck = { sdkSessionId: 'sid-note-fixture', step: 'stop', error: 'worker-not-in-process-list', attempts: 3, pids: [4321] };
  const posix = workerRecycleStuckNoteText(stuck, { platform: 'linux' });
  assert.match(posix, /^⚠️ The relay could not stop this chat's old worker \(pid 4321\) to restart it on the updated code: 3 tries failed \(worker-not-in-process-list\)\./);
  assert.match(posix, /stop it by hand \(`kill 4321`\); a relay restart does not end it/);
  assert.match(posix, /"A chat's old worker does not stop" in the troubleshooting guide\.$/);
  const windows = workerRecycleStuckNoteText({ ...stuck, pids: [4321, 4322] }, { platform: 'win32' });
  assert.match(windows, /old worker \(pids 4321, 4322\)/);
  assert.match(windows, /\(`taskkill \/PID 4321 \/T \/F`, `taskkill \/PID 4322 \/T \/F`\)/);
  // No pid known: how to find it.
  assert.match(workerRecycleStuckNoteText({ ...stuck, pids: [] }, { platform: 'linux' }), /the node process with `--session-id sid-note-fixture` in its command line/);
  // A launch or a probe that stays stuck: no process to stop.
  const launch = workerRecycleStuckNoteText({ ...stuck, step: 'launch', error: 'spawn-failed', pids: [] });
  assert.match(launch, /could not restart this chat's worker on the updated code: 3 tries failed \(last: launch: spawn-failed\)\. .*restart the relay\.$/);
});

test('a failed launch is retried after the backoff without a second stop; success resets the failures', async () => {
  let launchOk = false;
  const app = setup({
    workers: [worker('sid-launch', { pid: 42 })],
    launch: async (sid, { defaultLaunch }) => (launchOk ? defaultLaunch(sid) : { ok: false, error: 'spawn-failed' }),
    options: { retryBaseMs: 1_000 },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-launch'], ['launch', 'sid-launch']]);
  await app.service.sweep();
  assert.equal(app.calls.length, 2, 'in backoff');
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.at(-1), ['launch', 'sid-launch']);
  launchOk = true;
  await app.clock.advance(2_000);
  await app.service.sweep();
  assert.equal(app.calls.filter(([kind]) => kind === 'stop').length, 1);
  assert.equal(app.logs.at(-1), '[worker-recycle] recycled sid-laun pid 42→501');
  assert.equal(app.service.status().recycled, 1);
});

test('a launch that names the stopped pid is no recycle: the fence stays, and the retry stops the session again before it launches', async () => {
  const fence = createWorkerReplacementFence();
  let adopt = true;
  const app = setup({
    workers: [worker('sid-adopt', { pid: 42, buildId: OLD })],
    // The launch joined a start that reused the stopped process from a
    // process list read before the stop: the registry names pid 42 again.
    launch: async (sid, { registry, defaultLaunch }) => {
      if (!adopt) return defaultLaunch(sid);
      registry.set(sid, worker(sid, { pid: 42, buildId: OLD }));
      return { ok: true };
    },
    options: { retryBaseMs: 1_000, fence },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-adopt'], ['launch', 'sid-adopt']]);
  assert.equal(app.logs.some((line) => line.includes('recycled sid-adop')), false, 'nothing claimed');
  assert.equal(app.logs.at(-1), '[worker-recycle] launch failed sid-adop (1): the launch named the stopped pid 42; retrying in 1s');
  assert.equal(fence.isHeld('sid-adopt', 42), true, 'the stopped pid gets no work');
  assert.equal(app.service.status().recycled, 0);

  // Nothing tells what runs at pid 42 (no reader): the retry stops the
  // session again, then launches, so it never has two processes.
  adopt = false;
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(2), [['stop', 'sid-adopt'], ['launch', 'sid-adopt']]);
  assert.ok(app.logs.includes('[worker-recycle] stopped sid-adop pid 42 again before the launch: the process there could not be told from the stopped one'));
  assert.equal(app.logs.at(-1), '[worker-recycle] recycled sid-adop pid 42→501');
  assert.equal(fence.isHeld('sid-adopt', 42), false);
  assert.equal(app.service.status().recycled, 1);
});

// One recycle of a worker at pid 42 whose launch names pid 42 again, as a
// worker that has not said hello yet (no build id); `current` is what the
// identity reader finds there after the launch.
async function launchOnStoppedPid({ sid, stoppedStartTime = '1000', current, buildId = null }) {
  const reads = [];
  const app = setup({
    workers: [worker(sid, { pid: 42, buildId: OLD })],
    stop: async (id, opts, { registry }) => {
      registry.delete(id);
      return stoppedStartTime ? { ok: true, identity: { pid: 42, startTime: stoppedStartTime } } : { ok: true };
    },
    launch: async (id, { registry }) => { registry.set(id, worker(id, { pid: 42, buildId })); return { ok: true }; },
    options: { retryBaseMs: 1_000, readProcessIdentity: async (pid) => { reads.push(pid); return current; } },
  });
  await app.service.sweep();
  return { app, reads };
}

test('a launch that names the stopped pid is a new worker only by another start time and the session\'s command line, or by this relay\'s build id', async () => {
  const commandLine = (sid) => `node /home/dev/oar/server/claude-worker/claude-session-worker.mjs --session-id ${sid}`;
  // The same start time: the stopped process.
  let run = await launchOnStoppedPid({ sid: 'sid-same', current: { pid: 42, startTime: '1000', commandLine: commandLine('sid-same') } });
  assert.deepEqual(run.reads, [42]);
  assert.equal(run.app.logs.at(-1), '[worker-recycle] launch failed sid-same (1): the launch named the stopped pid 42; retrying in 1s');
  // A start time that cannot be read now proves nothing.
  run = await launchOnStoppedPid({ sid: 'sid-unread', current: { pid: 42, startTime: null, commandLine: null } });
  assert.match(run.app.logs.at(-1), /launch failed sid-unre \(1\): the launch named the stopped pid 42;/);
  // Nor one the stop could not read.
  run = await launchOnStoppedPid({ sid: 'sid-nostart', stoppedStartTime: null, current: { pid: 42, startTime: '2000', commandLine: commandLine('sid-nostart') } });
  assert.match(run.app.logs.at(-1), /launch failed sid-nost \(1\): the launch named the stopped pid 42;/);
  // A pid no process has is no worker either.
  run = await launchOnStoppedPid({ sid: 'sid-gone', current: null });
  assert.match(run.app.logs.at(-1), /launch failed sid-gone \(1\): the launch named the stopped pid 42, which no process has;/);
  // Another start time, but not a process of the session (its command line
  // names none, or cannot be read): the pid went elsewhere, no new worker.
  run = await launchOnStoppedPid({ sid: 'sid-foreign', current: { pid: 42, startTime: '2000', commandLine: '/usr/sbin/cron -f' } });
  assert.match(run.app.logs.at(-1), /launch failed sid-fore \(1\): the launch named the stopped pid 42;/);
  run = await launchOnStoppedPid({ sid: 'sid-blind', current: { pid: 42, startTime: '2000', commandLine: null } });
  assert.match(run.app.logs.at(-1), /launch failed sid-blin \(1\): the launch named the stopped pid 42;/);
  // Another start time and the session's: a new process that got the pid.
  run = await launchOnStoppedPid({ sid: 'sid-new', current: { pid: 42, startTime: '2000', commandLine: commandLine('sid-new') } });
  assert.equal(run.app.logs.at(-1), '[worker-recycle] recycled sid-new pid 42→42');
  assert.equal(run.app.service.status().recycled, 1);
  // The registry entry states this relay's build: the new worker (the
  // stopped one was stale), whatever the start times say.
  run = await launchOnStoppedPid({ sid: 'sid-build', buildId: RELAY, current: { pid: 42, startTime: '1000', commandLine: commandLine('sid-build') } });
  assert.deepEqual(run.reads, [], 'the build id decides');
  assert.equal(run.app.logs.at(-1), '[worker-recycle] recycled sid-buil pid 42→42');
});

test('the start time of the old pid unreadable: one worker results, never a second spawn while the first lives', async () => {
  const sid = 'sid-one-worker';
  // The session's processes, as the host runs them.
  const alive = new Set([42]);
  let most = alive.size;
  let nextPid = 42;
  const spawned = [];
  const app = setup({
    workers: [worker(sid, { pid: 42, buildId: OLD })],
    // The stop ends every process of the session; it could not read the old
    // worker's start time.
    stop: async (id, opts, { registry }) => { alive.clear(); registry.delete(id); return { ok: true }; },
    // A detached spawn: a process of its own, whatever else runs. The first
    // one gets the stopped worker's pid, handed out again.
    launch: async (id, { registry }) => {
      const pid = nextPid;
      nextPid += 1;
      alive.add(pid);
      most = Math.max(most, alive.size);
      spawned.push(pid);
      registry.set(id, worker(id, { pid, buildId: null }));
      return { ok: true };
    },
    options: {
      retryBaseMs: 1_000,
      readProcessIdentity: async (pid) => (alive.has(pid)
        ? { pid, startTime: `start-${pid}`, commandLine: `node /home/dev/oar/server/claude-worker/claude-session-worker.mjs --session-id ${sid}` }
        : null),
    },
  });
  await app.service.sweep();
  assert.deepEqual(spawned, [42]);
  assert.match(app.logs.at(-1), /launch failed sid-one- \(1\): the launch named the stopped pid 42;/, 'not told apart from the stopped one');

  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', sid], ['launch', sid], ['stop', sid], ['launch', sid]]);
  assert.deepEqual(spawned, [42, 43]);
  assert.equal(most, 1, 'never two processes for the session');
  assert.deepEqual([...alive], [43]);
  assert.equal(app.logs.at(-1), '[worker-recycle] recycled sid-one- pid 42→43');

  await app.clock.advance(60_000);
  await app.service.sweep();
  assert.equal(app.calls.length, 4, 'done: nothing more');
});

test('the retry of a launch that named the stopped pid: this relay\'s build id ends it, a gone process needs no second stop', async () => {
  // The worker at pid 42 says hello before the retry: it is the new one.
  let run = await launchOnStoppedPid({ sid: 'sid-hello', stoppedStartTime: null, current: { pid: 42, startTime: '2000', commandLine: null } });
  assert.match(run.app.logs.at(-1), /launch failed sid-hell \(1\)/);
  run.app.registry.set('sid-hello', worker('sid-hello', { pid: 42, buildId: RELAY }));
  await run.app.clock.advance(1_000);
  await run.app.service.sweep();
  assert.deepEqual(run.app.calls, [['stop', 'sid-hello'], ['launch', 'sid-hello']], 'neither stopped nor launched again');
  assert.equal(run.app.logs.at(-1), '[worker-recycle] recycled sid-hell pid 42→42 (on this build)');
  assert.equal(run.app.service.status().recycled, 1);

  // No process has pid 42 any more: the retry launches without a stop.
  run = await launchOnStoppedPid({ sid: 'sid-ended', current: null });
  await run.app.clock.advance(1_000);
  await run.app.service.sweep();
  assert.deepEqual(run.app.calls.map(([kind]) => kind), ['stop', 'launch', 'launch']);
});

test('another start lands on the stopped pid while a failed launch backs off: the retry leaves the session one worker', async () => {
  const sid = 'sid-backoff-start';
  const commandLine = `node /home/dev/oar/server/claude-worker/claude-session-worker.mjs --session-id ${sid}`;
  for (const { stoppedStartTime, expect } of [
    // The stop could not read the old start time: the process there cannot
    // be told from the stopped one, so it is stopped before the launch.
    { stoppedStartTime: null, expect: { calls: ['stop', 'launch', 'stop', 'launch'], alive: [43] } },
    // Another start time and the session's: that start's worker is the new
    // one, and no launch follows.
    { stoppedStartTime: 'start-old', expect: { calls: ['stop', 'launch'], alive: [42] } },
  ]) {
    const alive = new Set([42]);
    let most = alive.size;
    let launchOk = false;
    let nextPid = 43;
    const spawn = (registry, pid) => {
      alive.add(pid);
      most = Math.max(most, alive.size);
      // Before its first heartbeat: no build id yet.
      registry.set(sid, worker(sid, { pid, buildId: null }));
    };
    const app = setup({
      workers: [worker(sid, { pid: 42, buildId: OLD })],
      stop: async (id, opts, { registry }) => {
        alive.clear();
        registry.delete(id);
        return stoppedStartTime ? { ok: true, identity: { pid: 42, startTime: stoppedStartTime } } : { ok: true };
      },
      // The recycle's own launch fails first; its retry is a detached spawn.
      launch: async (id, { registry }) => {
        if (!launchOk) return { ok: false, error: 'spawn-failed' };
        spawn(registry, nextPid);
        nextPid += 1;
        return { ok: true };
      },
      options: {
        retryBaseMs: 1_000,
        readProcessIdentity: async (pid) => (alive.has(pid) ? { pid, startTime: `start-${pid}`, commandLine } : null),
      },
    });
    await app.service.sweep();
    assert.match(app.logs.at(-1), /launch failed sid-back \(1\): spawn-failed;/);
    assert.deepEqual([...alive], []);
    // During the backoff another start (the queue's) brings a worker up, and
    // the stopped worker's pid is handed out to it.
    spawn(app.registry, 42);
    launchOk = true;
    await app.clock.advance(1_000);
    await app.service.sweep();
    assert.deepEqual(app.calls.map(([kind]) => kind), expect.calls, `stopped start time ${stoppedStartTime}`);
    assert.equal(most, 1, 'never two processes for the session');
    assert.deepEqual([...alive], expect.alive);
    assert.equal(app.service.status().recycled, 1);
  }
});

test('a launch owed is dropped when another path brought a new worker up meanwhile', async () => {
  const app = setup({
    workers: [worker('sid-primed', { pid: 42 })],
    launch: async () => ({ ok: false, error: 'spawn-failed' }),
    options: { retryBaseMs: 1_000 },
  });
  await app.service.sweep();
  app.registry.set('sid-primed', worker('sid-primed', { pid: 900, buildId: RELAY }));
  await app.clock.advance(5_000);
  await app.service.sweep();
  assert.equal(app.calls.length, 2);
});

test('one recycle per pid: an entry the stop left behind is never stopped again; a new pid is judged by its own id', async () => {
  const reads = [];
  const app = setup({
    workers: [worker('sid-pid', { pid: 42 })],
    // The stop went through but a late heartbeat re-listed the old pid, and
    // the launch keeps failing.
    // The stopped process is gone: no process has pid 42.
    stop: async () => ({ ok: true }),
    launch: async () => ({ ok: false, error: 'spawn-failed' }),
    options: { retryBaseMs: 1_000, readProcessIdentity: async (pid) => { reads.push(pid); return null; } },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-pid'], ['launch', 'sid-pid']]);
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(2), [['launch', 'sid-pid']], 'pid 42 is not stopped twice; only the launch is retried');
  assert.deepEqual(reads, [42, 42], 'each launch reads the pid the entry names');

  app.registry.set('sid-pid', worker('sid-pid', { pid: 43, buildId: RELAY }));
  await app.clock.advance(2_000);
  await app.service.sweep();
  assert.equal(app.calls.length, 3, 'a new pid on the relay\'s build is left alone, and the launch owed is over');

  app.registry.set('sid-pid', worker('sid-pid', { pid: 44, buildId: OLD }));
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(3), [['stop', 'sid-pid'], ['launch', 'sid-pid']]);
});

test('one recycle per session per relay build: a new process still on another build is named once and left alone', async () => {
  const app = setup({
    workers: [worker('sid-tree-1', { pid: 42 })],
    // The relaunched worker runs from another tree: it states the old id.
    launch: async (sid, { registry }) => {
      registry.set(sid, worker(sid, { pid: 43, buildId: OLD }));
      return { ok: true };
    },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-tree-1'], ['launch', 'sid-tree-1']]);
  assert.equal(app.service.isStale(app.registry.get('sid-tree-1')), false);
  assert.equal(app.service.status().staleCount, 0);
  for (let i = 0; i < 3; i += 1) {
    await app.clock.advance(60_000);
    await app.service.sweep();
  }
  assert.equal(app.calls.length, 2, 'not recycled again under this build');
  assert.deepEqual(app.warns, [
    `[worker-recycle] sid-tree still on ${OLD} after a recycle under ${RELAY}: the worker tree differs from the relay's; not recycled again under this build`,
  ]);
  assert.deepEqual(app.service.status().skipped, [{ sdkSessionId: 'sid-tree-1', buildId: OLD }]);
  assert.equal(app.service.status().recycled, 1);
});

test('a new process that states no build id after a recycle gets the same skip and its own warning', async () => {
  const app = setup({
    workers: [worker('sid-tree-2', { pid: 42 })],
    launch: async (sid, { registry }) => {
      registry.set(sid, worker(sid, { pid: 43, buildId: null }));
      return { ok: true };
    },
  });
  await app.service.sweep();
  await app.service.sweep();
  await app.service.sweep();
  assert.equal(app.calls.length, 2);
  assert.equal(app.warns.length, 1);
  assert.match(app.warns[0], /^\[worker-recycle\] sid-tree still states no build id after a recycle under /);
  assert.deepEqual(app.service.status().skipped, [{ sdkSessionId: 'sid-tree-2', buildId: null }]);
});

test('a session recycled under one relay build is eligible again under the next', async () => {
  const registry = new Map([['sid-next', worker('sid-next', { pid: 42 })]]);
  const calls = [];
  const build = (relayBuildId) => createWorkerRecycleService({
    relayBuildId,
    listWorkers: () => Array.from(registry.values()),
    getWorker: (sid) => registry.get(sid) || null,
    hasHeartbeated: () => true,
    stopWorker: async (sid) => { calls.push(['stop', sid, relayBuildId]); registry.delete(sid); return { ok: true }; },
    launchWorker: async (sid) => {
      calls.push(['launch', sid, relayBuildId]);
      registry.set(sid, worker(sid, { pid: 100 + calls.length, buildId: OLD }));
      return { ok: true };
    },
    minStartGapMs: 0,
    logger: { log() {}, warn() {} },
  });
  const underA = build(RELAY);
  await underA.sweep();
  await underA.sweep();
  assert.equal(calls.length, 2);
  // The next deploy: a new relay process, a new build id.
  const underB = build('0.9.22+aaaaaaaaaaaa');
  assert.equal(underB.isStale(registry.get('sid-next')), true);
  await underB.sweep();
  assert.deepEqual(calls.slice(2).map(([kind, , id]) => `${kind}:${id}`), ['stop:0.9.22+aaaaaaaaaaaa', 'launch:0.9.22+aaaaaaaaaaaa']);
});

test('a callback that throws counts as that step\'s failure; sweep never rejects', async () => {
  const probe = setup({
    workers: [worker('sid-probe')],
    running: () => { throw new Error('db locked'); },
    options: { retryBaseMs: 1_000 },
  });
  await probe.service.sweep();
  assert.deepEqual(probe.calls, [], 'never stopped on a guess');
  assert.match(probe.logs[0], /probe failed sid-prob \(1\): db locked/);

  const archivedProbe = setup({ workers: [worker('sid-arch')], archived: () => { throw new Error('db locked'); } });
  await archivedProbe.service.sweep();
  assert.deepEqual(archivedProbe.calls, []);

  const stopThrows = setup({
    workers: [worker('sid-throw')],
    stop: async () => { throw new Error('boom'); },
    options: { retryBaseMs: 1_000 },
  });
  await stopThrows.service.sweep();
  assert.match(stopThrows.logs.at(-1), /stop failed sid-thro \(1\): boom/);
  await stopThrows.clock.advance(1_000);
  await stopThrows.service.sweep();
  assert.equal(stopThrows.calls.length, 2);

  const launchThrows = setup({ workers: [worker('sid-lthrow')], launch: async () => { throw new Error('no tmux'); } });
  await launchThrows.service.sweep();
  assert.match(launchThrows.logs.at(-1), /launch failed sid-lthr \(1\): no tmux/);

  const heartbeatThrows = setup({ heartbeated: () => { throw new Error('x'); } });
  assert.equal(heartbeatThrows.service.isStale(worker('sid-hb', { buildId: null })), false);

  const listThrows = setup();
  const service = createWorkerRecycleService({
    relayBuildId: RELAY,
    listWorkers: () => { throw new Error('registry gone'); },
    stopWorker: async () => ({ ok: true }),
    launchWorker: async () => ({ ok: true }),
    logger: { log() {}, warn: (line) => listThrows.warns.push(line) },
  });
  await service.sweep();
  assert.equal(service.status().staleCount, 0);
  assert.match(listThrows.warns[0], /cannot list workers: registry gone/);
});

test('status() reports the relay id, the stale count, the recycles in flight and done, and who waits on what', async () => {
  let releaseStop = null;
  const app = setup({
    workers: [
      worker('sid-wait', { steering: { releasable: false, releaseHold: 'question' } }),
      worker('sid-go'),
      worker('sid-fresh', { buildId: RELAY }),
    ],
    stop: (sid, opts, { registry }) => new Promise((resolve) => { releaseStop = () => { registry.delete(sid); resolve({ ok: true }); }; }),
  });
  assert.deepEqual(app.service.status(), { relayBuildId: RELAY, staleCount: 2, inFlight: 0, recycled: 0, waiting: [], skipped: [] });
  const swept = app.service.sweep();
  await flush();
  assert.deepEqual(app.service.status(), {
    relayBuildId: RELAY,
    staleCount: 2,
    inFlight: 1,
    recycled: 0,
    waiting: [{ sdkSessionId: 'sid-wait', hold: 'question' }],
    skipped: [],
  });
  releaseStop();
  await swept;
  assert.deepEqual(app.service.status(), {
    relayBuildId: RELAY,
    staleCount: 1,
    inFlight: 0,
    recycled: 1,
    waiting: [{ sdkSessionId: 'sid-wait', hold: 'question' }],
    skipped: [],
  });
});

test('start() sweeps at once, then every interval on an unref\'d timer, and stop() ends it', async () => {
  const app = setup({ workers: [worker('sid-timer')], options: { sweepIntervalMs: 15_000 } });
  app.service.start();
  const [timer] = app.clock.pending();
  assert.equal(timer.unrefed, true);
  await flush();
  assert.deepEqual(app.calls, [['stop', 'sid-timer'], ['launch', 'sid-timer']], 'the start\'s own sweep');
  // A stale worker that turns up later waits for the interval.
  app.registry.set('sid-later', worker('sid-later', { pid: 8 }));
  await app.clock.advance(14_999);
  assert.equal(app.calls.length, 2);
  await app.clock.advance(1);
  assert.deepEqual(app.calls.slice(2), [['stop', 'sid-later'], ['launch', 'sid-later']]);
  app.registry.set('sid-later', worker('sid-later', { pid: 9 }));
  app.service.stop();
  assert.equal(app.clock.pending().length, 0);
  await app.clock.advance(60_000);
  assert.equal(app.calls.length, 4);
});

test('while started, a recycle put off for the gap comes as soon as the gap ends, not a whole interval later', async () => {
  const app = setup({
    workers: [worker('sid-1'), worker('sid-2'), worker('sid-3')],
    options: { sweepIntervalMs: 15_000, minStartGapMs: 3_000 },
  });
  app.service.start();
  await flush();
  assert.deepEqual(app.calls.map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-1', 'launch:sid-1']);
  await app.clock.advance(3_000);
  assert.deepEqual(app.calls.slice(2).map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-2', 'launch:sid-2']);
  await app.clock.advance(3_000);
  assert.deepEqual(app.calls.slice(4).map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-3', 'launch:sid-3']);
  app.service.stop();
  assert.equal(app.clock.pending().length, 0);
});

// The replacement fence: from the moment a recycle passes its holds until
// its launch is done, no delivery reaches the old process.
test('the fence is up for the old pid from the hold check through the launch, and only for that pid', async () => {
  const fence = createWorkerReplacementFence();
  let releaseStop = null;
  const app = setup({
    workers: [worker('sid-fence', { pid: 321 })],
    stop: (sid, opts, { registry }) => new Promise((resolve) => { releaseStop = () => { registry.delete(sid); resolve({ ok: true }); }; }),
    options: { fence },
  });
  const swept = app.service.sweep();
  // Raised synchronously by the sweep, before any await: nothing can slip in
  // between the hold check and the stop.
  assert.equal(fence.isHeld('sid-fence', 321), true);
  await flush();
  assert.deepEqual(app.calls, [['stop', 'sid-fence']]);
  assert.equal(fence.isHeld('sid-fence', 321), true, 'held while the stop runs');
  assert.equal(fence.isHeld('sid-fence', 999), false, 'another pid of the session is never fenced');
  assert.equal(fence.isHeld('sid-other', 321), false);
  releaseStop();
  await swept;
  assert.deepEqual(app.calls, [['stop', 'sid-fence'], ['launch', 'sid-fence']]);
  assert.equal(fence.isHeld('sid-fence', 321), false, 'released once the launch is done');
  assert.deepEqual(fence.list(), []);
});

test('a stop that fails lowers the fence: the old worker keeps serving its session', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [worker('sid-fence-stop', { pid: 322 })],
    stop: async () => ({ ok: false, error: 'worker-survived-stop' }),
    options: { fence },
  });
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-fence-stop', 322), false);
});

test('a failed launch keeps the fence up through the backoff; the retry\'s launch lowers it', async () => {
  const fence = createWorkerReplacementFence();
  let launchOk = false;
  const app = setup({
    workers: [worker('sid-fence-launch', { pid: 323 })],
    launch: async (sid, { defaultLaunch }) => (launchOk ? defaultLaunch(sid) : { ok: false, error: 'spawn-failed' }),
    options: { fence, retryBaseMs: 1_000 },
  });
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-fence-launch', 323), true, 'the old pid is gone; the fence waits for the retry');
  launchOk = true;
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.map(([kind]) => kind), ['stop', 'launch', 'launch']);
  assert.equal(fence.isHeld('sid-fence-launch', 323), false);
});

test('a launch owed that another path ended lowers the fence too', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [worker('sid-fence-primed', { pid: 324 })],
    launch: async () => ({ ok: false, error: 'spawn-failed' }),
    options: { fence, retryBaseMs: 1_000 },
  });
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-fence-primed', 324), true);
  app.registry.set('sid-fence-primed', worker('sid-fence-primed', { pid: 901, buildId: RELAY }));
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-fence-primed', 324), false);
});

// The launch must not kill a worker another path brought up meanwhile.
test('a new pid in the registry between the stop and the launch ends the job: no launch, counted as recycled', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [worker('sid-raced-1', { pid: 42 })],
    // The stop goes through; the primer (a delivery) starts a worker before
    // the recycle's launch slot comes.
    stop: async (sid, opts, { registry }) => {
      registry.delete(sid);
      registry.set(sid, worker(sid, { pid: 900, buildId: RELAY }));
      return { ok: true };
    },
    options: { fence },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-raced-1']], 'launchWorker is not called');
  assert.equal(app.service.status().recycled, 1);
  assert.equal(fence.isHeld('sid-raced-1', 42), false);
  assert.equal(app.logs.at(-1), '[worker-recycle] recycled sid-race pid 42→900 (started elsewhere)');
  // Recycled under this build: the session is not touched again.
  app.registry.set('sid-raced-1', worker('sid-raced-1', { pid: 901, buildId: OLD }));
  await app.service.sweep();
  assert.equal(app.calls.length, 1);
});

test('a new pid that comes up while the launch waits for its slot is kept, not killed', async () => {
  let releaseSlowStop = null;
  const app = setup({
    workers: [worker('sid-slow', { pid: 43 }), worker('sid-fast')],
    stop: (sid, opts, { registry }) => {
      if (sid !== 'sid-slow') { registry.delete(sid); return { ok: true }; }
      return new Promise((resolve) => { releaseSlowStop = () => { registry.delete(sid); resolve({ ok: true }); }; });
    },
    options: { minStartGapMs: 3_000 },
  });
  void app.service.sweep();
  await flush();
  await app.clock.advance(3_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-slow', 'stop:sid-fast', 'launch:sid-fast']);
  // The slow stop ends; its launch waits out the gap after the fast launch.
  await app.clock.advance(500);
  releaseSlowStop();
  await flush();
  // Meanwhile the primer brings sid-slow's new worker up.
  await app.clock.advance(1_000);
  app.registry.set('sid-slow', worker('sid-slow', { pid: 902, buildId: RELAY }));
  await app.clock.advance(1_500);
  assert.deepEqual(app.calls.map(([kind, sid]) => `${kind}:${sid}`), ['stop:sid-slow', 'stop:sid-fast', 'launch:sid-fast'], 'pid 902 is not killed by a second launch');
  assert.equal(app.service.status().recycled, 2);
  assert.equal(app.service.status().inFlight, 0);
});

// The launch re-checks the archive, and the stop and the launch run under the
// relay's launch mutex.
test('a session archived between the stop and the launch is not relaunched and stays killed', async () => {
  let archivedNow = false;
  const app = setup({
    workers: [worker('sid-late-archive', { pid: 55 })],
    archived: () => archivedNow,
    stop: async (sid, opts, { registry }) => { registry.delete(sid); archivedNow = true; return { ok: true }; },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-late-archive']], 'no launch: the stop\'s killed marker is left in place');
  assert.equal(app.logs.at(-1), '[worker-recycle] stopped sid-late (archived)');
  assert.equal(app.service.status().recycled, 0);
  await app.clock.advance(120_000);
  await app.service.sweep();
  assert.equal(app.calls.length, 1, 'and no launch owed is retried');
});

test('the stop and the launch run under the launch mutex, one exclusive section per recycle', async () => {
  const order = [];
  const app = setup({
    workers: [worker('sid-mutex')],
    stop: async (sid, opts, { registry }) => { order.push('stop'); registry.delete(sid); return { ok: true }; },
    launch: async (sid, { defaultLaunch }) => { order.push('launch'); return defaultLaunch(sid); },
    options: {
      runExclusive: async (sid, fn) => {
        order.push(`lock:${sid}`);
        try { return await fn(); } finally { order.push(`unlock:${sid}`); }
      },
    },
  });
  await app.service.sweep();
  assert.deepEqual(order, ['lock:sid-mutex', 'stop', 'launch', 'unlock:sid-mutex']);
});

test('a recycle waits for a Change CWD relaunch holding the mutex, and leaves the worker that relaunch started alone', async () => {
  const mutex = createKeyedMutex({ warn() {} });
  const fence = createWorkerReplacementFence();
  const order = [];
  const app = setup({
    workers: [worker('sid-cwd', { pid: 60 })],
    options: { fence, runExclusive: (sid, fn) => mutex.runExclusive(sid, fn) },
  });
  let finishRelaunch = null;
  const relaunch = mutex.runExclusive('sid-cwd', () => new Promise((resolve) => {
    finishRelaunch = () => {
      // The relaunch replaced the worker under the mutex.
      app.registry.set('sid-cwd', worker('sid-cwd', { pid: 61, buildId: RELAY }));
      order.push('relaunched');
      resolve();
    };
  }));
  const swept = app.service.sweep();
  await flush();
  assert.deepEqual(app.calls, [], 'nothing stopped while the relaunch holds the mutex');
  assert.equal(fence.isHeld('sid-cwd', 60), true);
  finishRelaunch();
  await relaunch;
  await swept;
  assert.deepEqual(order, ['relaunched']);
  assert.deepEqual(app.calls, [], 'the fresh worker is not the one judged stale: not stopped');
  assert.equal(fence.isHeld('sid-cwd', 60), false);
});

test('the launch retry after a failed launch runs under the mutex too', async () => {
  const locks = [];
  let launchOk = false;
  const app = setup({
    workers: [worker('sid-retry-lock', { pid: 70 })],
    launch: async (sid, { defaultLaunch }) => (launchOk ? defaultLaunch(sid) : { ok: false, error: 'spawn-failed' }),
    options: {
      retryBaseMs: 1_000,
      runExclusive: async (sid, fn) => { locks.push(sid); return fn(); },
    },
  });
  await app.service.sweep();
  launchOk = true;
  await app.clock.advance(1_000);
  await app.service.sweep();
  assert.deepEqual(locks, ['sid-retry-lock', 'sid-retry-lock']);
  assert.equal(app.service.status().recycled, 1);
});

// A stale worker is recycled only once its CLI child is gone; a worker that
// does not say waits out quietMs since the session's last delivery.
test('cliAlive true holds the worker (cli); cliAlive false lets it go', async () => {
  const app = setup({
    workers: [
      worker('sid-cli-alive', { steering: { releasable: true, cliAlive: true } }),
      worker('sid-cli-gone', { steering: { releasable: true, cliAlive: false } }),
    ],
    // Recent activity counts for nothing once the worker reports its child.
    options: { quietSince: () => CLOCK_START - 1_000 },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-cli-gone'], ['launch', 'sid-cli-gone']]);
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-cli-alive', hold: 'cli' }]);
  assert.ok(app.logs.includes('[worker-recycle] waiting sid-cli-: cli'));
});

test('a worker that does not report cliAlive waits for quietMs since the last delivery (quiet)', async () => {
  const lastDelivery = new Map([
    ['sid-quiet-5', CLOCK_START - 5 * 60_000],
    ['sid-quiet-11', CLOCK_START - 11 * 60_000],
  ]);
  const app = setup({
    workers: [worker('sid-quiet-5'), worker('sid-quiet-11')],
    options: { quietSince: (sid) => lastDelivery.get(sid) ?? null },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-quiet-11'], ['launch', 'sid-quiet-11']]);
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-quiet-5', hold: 'quiet' }]);
  assert.ok(app.logs.includes('[worker-recycle] waiting sid-quie: quiet'));
  // Ten minutes after the delivery, the quiet one goes too.
  await app.clock.advance(5 * 60_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(2), [['stop', 'sid-quiet-5'], ['launch', 'sid-quiet-5']]);
});

test('no queue rows: the quiet window starts at the worker\'s start, else when the service first saw it', async () => {
  const ago = (ms) => new Date(CLOCK_START - ms).toISOString();
  const app = setup({
    workers: [
      worker('sid-new-start', { startedAt: ago(5 * 60_000) }),
      worker('sid-old-start', { startedAt: ago(11 * 60_000) }),
      worker('sid-no-start', { startedAt: null }),
    ],
    options: { quietSince: () => null },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-old-start'], ['launch', 'sid-old-start']]);
  assert.deepEqual(app.service.status().waiting.map(({ hold }) => hold), ['quiet', 'quiet']);
  await app.clock.advance(10 * 60_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(2).map(([kind, sid]) => `${kind}:${sid}`).sort(), [
    'launch:sid-new-start', 'launch:sid-no-start', 'stop:sid-new-start', 'stop:sid-no-start',
  ]);
});

test('a quietSince that throws is a probe failure: nothing is stopped on a guess', async () => {
  const app = setup({
    workers: [worker('sid-quiet-throws')],
    options: { quietSince: () => { throw new Error('db locked'); } },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.match(app.logs[0], /probe failed sid-quie \(1\): db locked/);
});

test('the hold names include cli, quiet and steering', () => {
  assert.deepEqual(RECYCLE_HOLDS, ['turn', 'question', 'compaction', 'background', 'cli', 'quiet', 'steering']);
});

// ─── Stale workers on an agent SDK ──────────────────────────────────────────
// An update can take the files their next CLI child starts from: they skip
// the cli and quiet holds and are fenced from the first sweep that sees them
// stale until their recycle.

const SDK_KINDS = new Set(['claude', 'claude-api', 'deepseek', 'cursor']);
const onAgentSdk = (entry) => SDK_KINDS.has(String(entry?.kind || ''));

test('a stale claude or cursor worker whose CLI child runs is recycled without waiting for the child or the quiet time', async () => {
  const kinds = ['claude', 'claude-api', 'deepseek', 'cursor'];
  const app = setup({
    workers: kinds.map((kind, index) => worker(`sid-sdk-${kind}`, { kind, pid: 200 + index, steering: { releasable: true, cliAlive: true } })),
    options: { isAgentSdkWorker: onAgentSdk, quietSince: () => CLOCK_START - 1_000, maxInFlight: 10 },
  });
  await app.service.sweep();
  assert.deepEqual(
    app.calls.filter(([step]) => step === 'stop').map(([, sid]) => sid),
    kinds.map((kind) => `sid-sdk-${kind}`),
  );
  assert.equal(app.calls.filter(([step]) => step === 'launch').length, kinds.length);
  assert.deepEqual(app.service.status().waiting, []);
});

test('a stale worker without an agent SDK still waits for its CLI child and the quiet time', async () => {
  const app = setup({
    workers: [
      worker('sid-copilot-cli', { kind: 'copilot-sdk', steering: { releasable: true, cliAlive: true } }),
      worker('sid-grok-quiet', { kind: 'grok', steering: { releasable: true } }),
      worker('sid-nokind-cli', { kind: null, steering: { releasable: true, cliAlive: true } }),
    ],
    options: { isAgentSdkWorker: onAgentSdk, quietSince: () => CLOCK_START - 1_000, fence: createWorkerReplacementFence() },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.service.status().waiting, [
    { sdkSessionId: 'sid-copilot-cli', hold: 'cli' },
    { sdkSessionId: 'sid-grok-quiet', hold: 'quiet' },
    { sdkSessionId: 'sid-nokind-cli', hold: 'cli' },
  ]);
});

test('a stale worker on an agent SDK still waits out a turn, a question, a compaction and background tasks', async () => {
  const fence = createWorkerReplacementFence();
  const holds = [
    ['sid-sdk-row', { steering: { releasable: true, cliAlive: true } }, 'turn', 301],
    ['sid-sdk-turn', { steering: { releasable: false, releaseHold: 'turn', cliAlive: true } }, 'turn', 302],
    ['sid-sdk-question', { kind: 'cursor', steering: { releasable: false, releaseHold: 'question' } }, 'question', 303],
    ['sid-sdk-compaction', { kind: 'deepseek', steering: { releasable: false, releaseHold: 'compaction', cliAlive: true } }, 'compaction', 304],
    ['sid-sdk-background', { steering: { releasable: false, releaseHold: 'background', backgroundTaskCount: 1, cliAlive: true } }, 'background', 305],
  ];
  const app = setup({
    workers: holds.map(([sid, extra, , pid]) => worker(sid, { ...extra, pid })),
    running: (sid) => sid === 'sid-sdk-row',
    options: { isAgentSdkWorker: onAgentSdk, fence },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.service.status().waiting, holds.map(([sdkSessionId, , hold]) => ({ sdkSessionId, hold })));
  // Fenced while it waits, except for background tasks: those keep its CLI
  // child up, and a delivery goes to that child.
  for (const [sid, , hold, pid] of holds) {
    assert.equal(fence.isHeld(sid, pid), hold !== 'background', `${sid} fenced`);
  }
  // Background tasks start in a fenced session (its turn ended with some
  // left running): the fence comes down; they end: it is recycled.
  app.registry.set('sid-sdk-turn', worker('sid-sdk-turn', { pid: 302, steering: { releasable: false, releaseHold: 'background', cliAlive: true } }));
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-turn', 302), false);
  assert.deepEqual(app.calls, []);
  app.registry.set('sid-sdk-turn', worker('sid-sdk-turn', { pid: 302, steering: { releasable: true, cliAlive: true } }));
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-sdk-turn'], ['launch', 'sid-sdk-turn']]);
});

test('deliveries to a stale worker on an agent SDK are fenced until its recycle, then go to the new worker', async () => {
  const fence = createWorkerReplacementFence();
  let turn = true;
  const app = setup({
    workers: [worker('sid-sdk-fence', { pid: 410, steering: { releasable: true, cliAlive: false } })],
    running: () => turn,
    stop: async (sid, opts, { registry }) => {
      assert.equal(claim(410), null, 'nothing reaches the old process while it is stopped');
      registry.delete(sid);
      return { ok: true };
    },
    options: { isAgentSdkWorker: onAgentSdk, fence },
  });
  // A delivery path as the runtime's: refused while the fence is up for the
  // asking process, else handed the queued row.
  const queued = ['row-1'];
  const claim = (pid) => (fence.isHeld('sid-sdk-fence', pid) ? null : queued.shift() || null);

  await app.service.sweep();
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-sdk-fence', hold: 'turn' }]);
  assert.equal(claim(410), null, 'the old process gets nothing while its turn runs');
  assert.ok(app.logs.includes('[worker-recycle] fenced sid-sdk- pid 410: stale on an agent SDK, deliveries wait for the recycle'));
  await app.service.sweep();
  assert.equal(claim(410), null, 'still fenced on the next sweep');

  turn = false;
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-sdk-fence'], ['launch', 'sid-sdk-fence']]);
  const fresh = app.registry.get('sid-sdk-fence');
  // The fence came down only after the old process was stopped (the stop
  // ran first): the row is the new worker's.
  assert.notEqual(fresh.pid, 410);
  assert.equal(claim(fresh.pid), 'row-1', 'the new worker gets the row');
  assert.deepEqual(fence.list(), []);
});

test('the agent-SDK fence waits for the recycle\'s pacing and stays up through a failed stop\'s backoff', async () => {
  const fence = createWorkerReplacementFence();
  let stopOk = false;
  const app = setup({
    workers: [
      worker('sid-sdk-first', { pid: 420 }),
      worker('sid-sdk-second', { pid: 421 }),
    ],
    stop: async (sid, opts, { registry }) => {
      if (!stopOk) return { ok: false, error: 'worker-survived-stop' };
      registry.delete(sid);
      return { ok: true };
    },
    options: { isAgentSdkWorker: onAgentSdk, fence, minStartGapMs: 3_000, retryBaseMs: 1_000 },
  });
  await app.service.sweep();
  // The first one's stop failed: its SDK's files may be gone, so it stays
  // fenced through the backoff. The second one waits for the gap, fenced.
  assert.deepEqual(app.calls, [['stop', 'sid-sdk-first']]);
  assert.equal(fence.isHeld('sid-sdk-first', 420), true);
  assert.equal(fence.isHeld('sid-sdk-second', 421), true);
  assert.ok(app.logs.some((line) => /fence kept sid-sdk-.* pid 420: its stop failed/.test(line)));
  // A sweep inside the backoff keeps it.
  await app.clock.advance(500);
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-first', 420), true);
  // The next slot: the first one again (its backoff is over); the second
  // still waits, fenced.
  stopOk = true;
  await app.clock.advance(3_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(1), [['stop', 'sid-sdk-first'], ['launch', 'sid-sdk-first']]);
  assert.equal(fence.isHeld('sid-sdk-second', 421), true);
  await app.clock.advance(3_000);
  await app.service.sweep();
  assert.deepEqual(app.calls.slice(3), [['stop', 'sid-sdk-second'], ['launch', 'sid-sdk-second']]);
  assert.deepEqual(fence.list(), []);
});

test('a failed stop\'s agent-SDK fence: no queued row reaches the old pid; down when the worker goes or after stuckAfter tries', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [worker('sid-sdk-stuck', { pid: 430 }), worker('sid-sdk-gone', { pid: 431 })],
    stop: async () => ({ ok: false, error: 'worker-survived-stop' }),
    options: { isAgentSdkWorker: onAgentSdk, fence, retryBaseMs: 1_000, stuckAfter: 3 },
  });
  // The delivery path asks the fence before it hands a queued row out.
  const deliverable = (sid, pid) => !fence.isHeld(sid, pid);
  await app.service.sweep();
  assert.equal(deliverable('sid-sdk-stuck', 430), false, 'the queued row waits');
  assert.equal(deliverable('sid-sdk-gone', 431), false);
  // The worker exits: the next sweep lowers its fence.
  app.registry.delete('sid-sdk-gone');
  await app.clock.advance(100);
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-gone', 431), false);
  assert.equal(deliverable('sid-sdk-stuck', 430), false);
  // Tries two and three fail: at stuckAfter the old worker serves again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.clock.advance(60_000);
    await app.service.sweep();
  }
  assert.equal(app.calls.filter(([step, sid]) => step === 'stop' && sid === 'sid-sdk-stuck').length, 3);
  assert.equal(fence.isHeld('sid-sdk-stuck', 430), false);
  assert.equal(deliverable('sid-sdk-stuck', 430), true);
});

test('a stale worker on an agent SDK with no steering snapshot yet waits for one, fenced, then goes at once', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [worker('sid-sdk-hello', { pid: 430, steering: null })],
    options: { isAgentSdkWorker: onAgentSdk, fence },
  });
  await app.service.sweep();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-sdk-hello', hold: 'steering' }]);
  assert.equal(fence.isHeld('sid-sdk-hello', 430), true);
  // Its first heartbeat names no hold.
  app.registry.set('sid-sdk-hello', worker('sid-sdk-hello', { pid: 430, steering: { releasable: true, cliAlive: true } }));
  await app.service.sweep();
  assert.deepEqual(app.calls, [['stop', 'sid-sdk-hello'], ['launch', 'sid-sdk-hello']]);
  assert.deepEqual(fence.list(), []);
});

test('a stale worker on an agent SDK that never sends a snapshot is judged as any other after steeringWaitMs, unfenced', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [worker('sid-sdk-mute', { pid: 440, steering: null })],
    options: { isAgentSdkWorker: onAgentSdk, fence, steeringWaitMs: 30_000, quietSince: () => CLOCK_START },
  });
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-mute', 440), true);
  await app.clock.advance(30_000);
  await app.service.sweep();
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-sdk-mute', hold: 'quiet' }]);
  assert.equal(fence.isHeld('sid-sdk-mute', 440), false);
  assert.ok(app.logs.includes('[worker-recycle] unfenced sid-sdk- pid 440'));
  assert.deepEqual(app.calls, []);
});

test('the agent-SDK fence comes down when the worker goes, when a probe fails, and is never raised for a session recycled under this build', async () => {
  const fence = createWorkerReplacementFence();
  let probeFails = false;
  const app = setup({
    workers: [
      worker('sid-sdk-gone', { pid: 450 }),
      worker('sid-sdk-probe', { pid: 451 }),
    ],
    running: (sid) => {
      if (sid === 'sid-sdk-probe' && probeFails) throw new Error('db locked');
      return true;
    },
    options: { isAgentSdkWorker: onAgentSdk, fence },
  });
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-gone', 450), true);
  assert.equal(fence.isHeld('sid-sdk-probe', 451), true);
  app.registry.delete('sid-sdk-gone');
  probeFails = true;
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-gone', 450), false, 'a worker that left the registry is not fenced on');
  assert.equal(fence.isHeld('sid-sdk-probe', 451), false, 'nothing is fenced on a guess');
  assert.deepEqual(fence.list(), []);
});

test('the agent-SDK fence keeps a delivery from the session\'s worker pid only, and a recycle takes it over without a gap', async () => {
  const fence = createWorkerReplacementFence();
  let releaseStop = null;
  let turn = true;
  const app = setup({
    workers: [worker('sid-sdk-handover', { pid: 460 })],
    running: () => turn,
    stop: (sid, opts, { registry }) => new Promise((resolve) => { releaseStop = () => { registry.delete(sid); resolve({ ok: true }); }; }),
    options: { isAgentSdkWorker: onAgentSdk, fence },
  });
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-handover', 460), true);
  assert.equal(fence.isHeld('sid-sdk-handover', 461), false, 'another pid of the session is not fenced');
  turn = false;
  const swept = app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-handover', 460), true, 'still up as the recycle starts');
  await flush();
  // A sweep while the stop runs leaves the recycle's fence alone.
  await app.service.sweep();
  assert.equal(fence.isHeld('sid-sdk-handover', 460), true, 'up through the stop');
  releaseStop();
  await swept;
  assert.deepEqual(app.calls, [['stop', 'sid-sdk-handover'], ['launch', 'sid-sdk-handover']]);
  assert.deepEqual(fence.list(), []);
});

test('sweepNow (a worker hello) judges and fences synchronously while started, and does nothing before start', async () => {
  const fence = createWorkerReplacementFence();
  const app = setup({
    workers: [],
    running: () => true,
    options: { isAgentSdkWorker: onAgentSdk, fence, sweepIntervalMs: 15_000 },
  });
  app.registry.set('sid-sdk-early', worker('sid-sdk-early', { pid: 470 }));
  await app.service.sweepNow();
  assert.deepEqual(fence.list(), [], 'not started: no sweep');

  app.registry.delete('sid-sdk-early');
  app.service.start();
  await flush();
  // A stale worker reconnects and says hello: fenced before the hello's own
  // request for work is answered, with no await in between.
  app.registry.set('sid-sdk-hello', worker('sid-sdk-hello', { pid: 471 }));
  const swept = app.service.sweepNow();
  assert.equal(fence.isHeld('sid-sdk-hello', 471), true);
  await swept;
  assert.deepEqual(app.service.status().waiting, [{ sdkSessionId: 'sid-sdk-hello', hold: 'turn' }]);
  app.service.stop();
});

test('isWorkerOnOtherBuild: a different or absent build id is another build; an equal one is not; an unknown relay id compares nothing', () => {
  assert.equal(isWorkerOnOtherBuild({ buildId: OLD }, RELAY), true);
  assert.equal(isWorkerOnOtherBuild({ buildId: null }, RELAY), true);
  assert.equal(isWorkerOnOtherBuild({}, RELAY), true);
  assert.equal(isWorkerOnOtherBuild({ buildId: ` ${RELAY} ` }, RELAY), false);
  assert.equal(isWorkerOnOtherBuild({ buildId: OLD }, null), false);
  assert.equal(isWorkerOnOtherBuild({ buildId: null }, ''), false);
  assert.equal(isWorkerOnOtherBuild(null, RELAY), false);
});

// The archived sweep at relay start, over fakes: which sessions are archived,
// which have a live process, and the stop.
function archivedSweepSetup({ archivedIds = [], live = [], stillArchived = () => true, stop = null, options = {} } = {}) {
  const calls = [];
  const logs = [];
  const warns = [];
  const liveSet = new Set(live);
  return {
    calls,
    logs,
    warns,
    run: () => sweepArchivedWorkers({
      listArchivedSessionIds: () => archivedIds,
      hasLiveProcess: async (sid) => { calls.push(['probe', sid]); return liveSet.has(sid); },
      isArchived: stillArchived,
      stopWorker: async (sid, opts) => {
        calls.push(['stop', sid, opts]);
        return stop ? stop(sid, opts) : { ok: true };
      },
      logger: { log: (line) => logs.push(line), warn: (line) => warns.push(line) },
      ...options,
    }),
  };
}

test('archived sweep: an archived session\'s live worker is stopped for good; one with no process is left alone', async () => {
  const app = archivedSweepSetup({ archivedIds: ['sid-archived-live', 'sid-archived-gone'], live: ['sid-archived-live', 'sid-in-use'] });
  const result = await app.run();
  assert.deepEqual(result, { stopped: ['sid-archived-live'], failed: [] });
  assert.deepEqual(app.calls, [
    ['probe', 'sid-archived-live'],
    ['stop', 'sid-archived-live', { keepKilled: true }],
    ['probe', 'sid-archived-gone'],
  ]);
  // The live worker of a session not on the list is never looked at.
  assert.equal(app.calls.some(([, sid]) => sid === 'sid-in-use'), false);
  assert.deepEqual(app.logs, ['[worker-recycle] stopped sid-arch (archived at start)']);
  assert.deepEqual(app.warns, []);
});

test('archived sweep: one session at a time, each id once, blanks dropped', async () => {
  let active = 0;
  let maxActive = 0;
  const app = archivedSweepSetup({
    archivedIds: ['sid-1', ' sid-2 ', 'sid-1', '', null],
    live: ['sid-1', 'sid-2'],
    stop: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { ok: true };
    },
  });
  const result = await app.run();
  assert.deepEqual(result.stopped, ['sid-1', 'sid-2']);
  assert.equal(maxActive, 1);
});

test('archived sweep: a session unarchived since the list was read keeps its worker', async () => {
  const app = archivedSweepSetup({ archivedIds: ['sid-back'], live: ['sid-back'], stillArchived: () => false });
  assert.deepEqual(await app.run(), { stopped: [], failed: [] });
  assert.deepEqual(app.calls, [['probe', 'sid-back']]);
});

test('archived sweep: a failed or throwing stop is warned and the sweep goes on; it never rejects', async () => {
  const app = archivedSweepSetup({
    archivedIds: ['sid-fail', 'sid-throw', 'sid-ok'],
    live: ['sid-fail', 'sid-throw', 'sid-ok'],
    stop: (sid) => {
      if (sid === 'sid-fail') return { ok: false, error: 'worker-survived-stop' };
      if (sid === 'sid-throw') throw new Error('boom');
      return { ok: true };
    },
  });
  const result = await app.run();
  assert.deepEqual(result, { stopped: ['sid-ok'], failed: ['sid-fail', 'sid-throw'] });
  assert.deepEqual(app.warns, [
    '[worker-recycle] could not stop sid-fail (archived at start): worker-survived-stop',
    '[worker-recycle] could not stop sid-thro (archived at start): boom',
  ]);
  assert.deepEqual(app.logs, ['[worker-recycle] stopped sid-ok (archived at start)']);
});

test('archived sweep: a list or a probe that throws is warned, and nothing is stopped on a guess', async () => {
  const warns = [];
  const logger = { log() {}, warn: (line) => warns.push(line) };
  const stops = [];
  const stopWorker = async (sid) => { stops.push(sid); return { ok: true }; };
  const listFails = await sweepArchivedWorkers({
    listArchivedSessionIds: () => { throw new Error('db closed'); },
    stopWorker,
    logger,
  });
  assert.deepEqual(listFails, { stopped: [], failed: [] });
  assert.match(warns[0], /cannot list archived sessions: db closed/);

  const probeFails = await sweepArchivedWorkers({
    listArchivedSessionIds: async () => ['sid-unknown', 'sid-live'],
    hasLiveProcess: async (sid) => {
      if (sid === 'sid-unknown') throw new Error('process list unreadable');
      return true;
    },
    stopWorker,
    logger,
  });
  assert.deepEqual(probeFails, { stopped: ['sid-live'], failed: ['sid-unknown'] });
  assert.deepEqual(stops, ['sid-live']);
  assert.match(warns[1], /archived sweep skipped sid-unkn: process list unreadable/);

  assert.deepEqual(await sweepArchivedWorkers({ listArchivedSessionIds: () => ['sid-x'], logger }), { stopped: [], failed: [] });
  assert.match(warns[2], /archived sweep skipped: no stopWorker/);
});

test('archived sweep: each stop runs under the launch mutex', async () => {
  const order = [];
  const app = archivedSweepSetup({
    archivedIds: ['sid-lock-1', 'sid-lock-2'],
    live: ['sid-lock-1', 'sid-lock-2'],
    stillArchived: (sid) => { order.push(`archived?:${sid}`); return true; },
    stop: (sid) => { order.push(`stop:${sid}`); return { ok: true }; },
    options: {
      runExclusive: async (sid, fn) => {
        order.push(`lock:${sid}`);
        try { return await fn(); } finally { order.push(`unlock:${sid}`); }
      },
    },
  });
  assert.deepEqual((await app.run()).stopped, ['sid-lock-1', 'sid-lock-2']);
  assert.deepEqual(order, [
    'lock:sid-lock-1', 'archived?:sid-lock-1', 'stop:sid-lock-1', 'unlock:sid-lock-1',
    'lock:sid-lock-2', 'archived?:sid-lock-2', 'stop:sid-lock-2', 'unlock:sid-lock-2',
  ]);
});

test('archived sweep: the fence is up for the stopped pid during the stop and down after it, whether the stop went through or not', async () => {
  const fence = createWorkerReplacementFence();
  const seen = [];
  const app = archivedSweepSetup({
    archivedIds: ['sid-fence-ok', 'sid-fence-fail', 'sid-fence-throw'],
    live: ['sid-fence-ok', 'sid-fence-fail', 'sid-fence-throw'],
    stop: (sid) => {
      seen.push([sid, fence.isHeld(sid, 4100), fence.isHeld(sid, 4200)]);
      if (sid === 'sid-fence-fail') return { ok: false, error: 'worker-survived-stop' };
      if (sid === 'sid-fence-throw') throw new Error('boom');
      return { ok: true };
    },
    options: { fence, workerPid: async () => 4100 },
  });
  const result = await app.run();
  assert.deepEqual(result, { stopped: ['sid-fence-ok'], failed: ['sid-fence-fail', 'sid-fence-throw'] });
  // Up for the pid being stopped only; another pid of the session is not fenced.
  assert.deepEqual(seen, [
    ['sid-fence-ok', true, false],
    ['sid-fence-fail', true, false],
    ['sid-fence-throw', true, false],
  ]);
  assert.deepEqual(fence.list(), [], 'lowered after every stop: a failed stop leaves the old worker serving');
});

test('archived sweep: with no known pid the fence refuses every process of the session during the stop', async () => {
  const fence = createWorkerReplacementFence();
  let heldDuringStop = null;
  const app = archivedSweepSetup({
    archivedIds: ['sid-fence-nopid'],
    live: ['sid-fence-nopid'],
    stop: (sid) => { heldDuringStop = [fence.isHeld(sid, 4100), fence.isHeld(sid, null)]; return { ok: true }; },
    options: { fence, workerPid: () => null },
  });
  await app.run();
  assert.deepEqual(heldDuringStop, [true, true]);
  assert.deepEqual(fence.list(), []);
});

test('archived sweep: a fence another replacement holds for the process is left up after the stop', async () => {
  const fence = createWorkerReplacementFence();
  fence.hold('sid-fence-owned', 4100);
  const app = archivedSweepSetup({
    archivedIds: ['sid-fence-owned'],
    live: ['sid-fence-owned'],
    options: { fence, workerPid: () => 4100 },
  });
  await app.run();
  assert.equal(fence.isHeld('sid-fence-owned', 4100), true, 'its owner lowers it');
});

test('archived sweep: a session unarchived while the sweep waits for the launch mutex is not stopped', async () => {
  const mutex = createKeyedMutex({ warn() {} });
  const fence = createWorkerReplacementFence();
  let archived = true;
  const app = archivedSweepSetup({
    archivedIds: ['sid-unarchived-1'],
    live: ['sid-unarchived-1'],
    stillArchived: () => archived,
    options: { fence, workerPid: () => 4100, runExclusive: (sid, fn) => mutex.runExclusive(sid, fn) },
  });
  let release = null;
  const holder = mutex.runExclusive('sid-unarchived-1', () => new Promise((resolve) => { release = resolve; }));
  const swept = app.run();
  await flush();
  assert.deepEqual(app.calls, [['probe', 'sid-unarchived-1']], 'nothing stopped while another holds the mutex');
  // A message arrives meanwhile: the conversation route unarchives the session.
  archived = false;
  release();
  await holder;
  assert.deepEqual(await swept, { stopped: [], failed: [] });
  assert.deepEqual(app.calls, [['probe', 'sid-unarchived-1']], 'the worker that serves the message is kept');
  assert.deepEqual(app.logs, ['[worker-recycle] kept sid-unar: no longer archived']);
  assert.deepEqual(fence.list(), [], 'never fenced');
});
