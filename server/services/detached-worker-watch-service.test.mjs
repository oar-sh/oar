import test from 'node:test';
import assert from 'node:assert/strict';

import { createDetachedWorkerWatch } from './detached-worker-watch-service.mjs';

const SID = 'sess-detached-0001';

function createHarness(overrides = {}) {
  const state = {
    nowMs: 1_000_000,
    waiting: [SID],
    sockets: new Set(),
    turns: new Set(),
    background: new Set(),
    blocked: new Set(),
    alive: new Set([SID]),
    launch: new Map(),
    enabled: true,
    replaced: [],
    logs: [],
    replaceResult: { ok: true },
  };
  const watch = createDetachedWorkerWatch({
    graceMs: 60_000,
    replaceCooldownMs: 300_000,
    now: () => state.nowMs,
    isEnabled: () => state.enabled,
    listWaitingSessionIds: () => state.waiting,
    hasWorkerSocket: (sid) => state.sockets.has(sid),
    hasRunningTurn: (sid) => state.turns.has(sid),
    hasBackgroundWork: (sid) => state.background.has(sid),
    isLaunchBlocked: (sid) => state.blocked.has(sid),
    getLaunchState: (sid) => state.launch.get(sid) || null,
    isWorkerProcessAlive: async (sid) => state.alive.has(sid),
    replaceWorker: async (sid, info) => {
      state.replaced.push({ sid, ...info });
      return state.replaceResult;
    },
    log: (line) => state.logs.push(line),
    ...overrides,
  });
  return { watch, state };
}

test('a worker alive without a socket is replaced once the grace time from relay start is up', async () => {
  const { watch, state } = createHarness();
  state.nowMs += 59_000;
  assert.equal(await watch.sweep(), 0, 'not before the grace time');
  state.nowMs += 1_000;
  assert.equal(await watch.sweep(), 1);
  assert.deepEqual(state.replaced, [{ sid: SID, detachedMs: 60_000 }]);
  assert.match(state.logs.join('\n'), /WORKER DETACHED session=sess-det detachedMs=60000/);
  assert.match(state.logs.join('\n'), /replaced/);
});

test('the grace time counts from the session\'s last socket end', async () => {
  const { watch, state } = createHarness();
  state.nowMs += 600_000;
  watch.noteSocketEnded(SID);
  state.nowMs += 30_000;
  assert.equal(await watch.sweep(), 0);
  state.nowMs += 30_000;
  assert.equal(await watch.sweep(), 1);
});

test('the grace time counts from a spawn, and a booting worker gets twice as long', async () => {
  const { watch, state } = createHarness();
  state.nowMs += 600_000;
  state.launch.set(SID, { launchMode: 'spawned', launchAtMs: state.nowMs, awaitingHeartbeat: true });
  state.nowMs += 60_000;
  assert.equal(await watch.sweep(), 0, 'still booting');
  state.nowMs += 60_000;
  assert.equal(await watch.sweep(), 1);

  // A reused worker's launch note does not restart the clock.
  const second = createHarness();
  second.state.nowMs += 600_000;
  second.state.launch.set(SID, { launchMode: 'reused', launchAtMs: second.state.nowMs, awaitingHeartbeat: true });
  assert.equal(await second.watch.sweep(), 1);
});

test('nothing happens while the worker has a socket, a turn, background work or a kill block', async () => {
  for (const blocker of ['sockets', 'turns', 'background', 'blocked']) {
    const { watch, state } = createHarness();
    state[blocker].add(SID);
    state.nowMs += 600_000;
    assert.equal(await watch.sweep(), 0, blocker);
    assert.equal(state.replaced.length, 0, blocker);
  }
});

test('a session with no message waiting, or a dead worker process, is left alone', async () => {
  const idle = createHarness();
  idle.state.waiting = [];
  idle.state.nowMs += 600_000;
  assert.equal(await idle.watch.sweep(), 0);

  // A dead process is the spawn path's business, not the watch's.
  const dead = createHarness();
  dead.state.alive.clear();
  dead.state.nowMs += 600_000;
  assert.equal(await dead.watch.sweep(), 0);
  assert.equal(dead.state.replaced.length, 0);
});

test('a worker that reconnects while its process is being probed is not replaced', async () => {
  let harness = null;
  harness = createHarness({
    isWorkerProcessAlive: async (sid) => {
      harness.state.sockets.add(sid);
      return true;
    },
  });
  harness.state.nowMs += 600_000;
  assert.equal(await harness.watch.sweep(), 0);
  assert.equal(harness.state.replaced.length, 0);
});

test('nothing happens while the watch is disabled (a relay shutting down)', async () => {
  const { watch, state } = createHarness();
  state.enabled = false;
  state.nowMs += 600_000;
  assert.equal(await watch.sweep(), 0);
});

test('a replacement is not repeated within the cooldown, failed or not', async () => {
  const { watch, state } = createHarness();
  state.replaceResult = { ok: false, error: 'worker-survived-stop' };
  state.nowMs += 600_000;
  assert.equal(await watch.sweep(), 0);
  assert.equal(state.replaced.length, 1);
  assert.match(state.logs.at(-1), /replace failed: worker-survived-stop/);
  state.nowMs += 60_000;
  await watch.sweep();
  assert.equal(state.replaced.length, 1, 'within the cooldown');
  state.nowMs += 300_000;
  await watch.sweep();
  assert.equal(state.replaced.length, 2, 'after the cooldown');
});

test('overlapping sweeps replace a worker once', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const { watch, state } = createHarness({
    replaceWorker: async (sid) => {
      state.replaced.push({ sid });
      await gate;
      return { ok: true };
    },
  });
  state.nowMs += 600_000;
  const first = watch.sweep();
  const second = await watch.sweep();
  release();
  assert.equal(await first, 1);
  assert.equal(second, 0);
  assert.equal(state.replaced.length, 1);
});

test('a throwing replace is logged and the sweep goes on to the next session', async () => {
  const other = 'sess-detached-0002';
  const { watch, state } = createHarness({
    replaceWorker: async (sid) => {
      state.replaced.push({ sid });
      if (sid === SID) throw new Error('boom');
      return { ok: true };
    },
  });
  state.waiting = [SID, other];
  state.alive.add(other);
  state.nowMs += 600_000;
  assert.equal(await watch.sweep(), 1);
  assert.deepEqual(state.replaced.map((entry) => entry.sid), [SID, other]);
  assert.match(state.logs.join('\n'), /replace failed: boom/);
});

test('an unwired watch never replaces anything', async () => {
  let nowMs = 0;
  const watch = createDetachedWorkerWatch({
    now: () => nowMs,
    listWaitingSessionIds: () => [SID],
    isWorkerProcessAlive: async () => true,
  });
  nowMs = 10 * 60_000;
  assert.equal(await watch.sweep(), 0);
});
