import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSY_HOLD_MS,
  BUSY_KEEPALIVE_MS,
  IDLE_KEEPALIVE_CAPABILITY,
  IDLE_KEEPALIVE_MS,
  createWorkerKeepalive,
} from "./worker-keepalive.mjs";

function setup({ capabilities = [IDLE_KEEPALIVE_CAPABILITY], work = false, linkBusy = false } = {}) {
  let clock = 0;
  const timers = new Map();
  let nextId = 1;
  const state = { work, linkBusy, capabilities: new Set(capabilities), pulses: 0, refreshes: [] };
  const heartbeat = {
    hasWork: () => state.work,
    pulseHeartbeat: async () => { state.pulses += 1; return true; },
  };
  const link = {
    isBusy: () => state.linkBusy,
    serverSupports: (name) => state.capabilities.has(name),
    refreshReadiness: (reason) => { state.refreshes.push({ at: clock, reason }); return true; },
  };
  const keepalive = createWorkerKeepalive({
    heartbeat,
    link,
    now: () => clock,
    setTimeoutImpl: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeoutImpl: (id) => { timers.delete(id); },
  });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = until;
  }
  return { keepalive, state, advance, timerCount: () => timers.size, beats: () => state.refreshes.map((r) => r.at) };
}

test("the cadences are 30 s idle and 10 s busy, gated on idle-keepalive", () => {
  assert.equal(IDLE_KEEPALIVE_MS, 30_000);
  assert.equal(BUSY_KEEPALIVE_MS, 10_000);
  assert.equal(IDLE_KEEPALIVE_CAPABILITY, "idle-keepalive");
  assert.equal(BUSY_HOLD_MS, 30_000);
});

test("one timer drives both the heartbeat and the readiness refresh", () => {
  const { keepalive, state, advance, timerCount } = setup({ capabilities: [] });
  keepalive.start();
  assert.equal(state.pulses, 1, "the first heartbeat goes out at once");
  assert.equal(timerCount(), 1);
  advance(10_000);
  assert.equal(state.pulses, 2);
  assert.equal(state.refreshes.length, 1);
  assert.equal(state.refreshes[0].reason, "readiness-refresh");
  assert.equal(timerCount(), 1);
  keepalive.stop();
});

test("an idle worker on a relay with idle-keepalive beats every 30 s", () => {
  const { keepalive, advance, beats } = setup();
  keepalive.start();
  // The first wait is decided before the relay is known to the beat: the
  // fake relay is known from the start, so it is 30 s at once.
  advance(120_000);
  assert.deepEqual(beats(), [30_000, 60_000, 90_000, 120_000]);
  keepalive.stop();
});

test("an idle worker on a relay without idle-keepalive keeps 10 s", () => {
  const { keepalive, advance, beats } = setup({ capabilities: [] });
  keepalive.start();
  advance(40_000);
  assert.deepEqual(beats(), [10_000, 20_000, 30_000, 40_000]);
  keepalive.stop();
});

test("the cadence follows the relay: 10 s until its hello names the capability", () => {
  const { keepalive, state, advance, beats } = setup({ capabilities: [] });
  keepalive.start();
  advance(10_000);
  state.capabilities.add(IDLE_KEEPALIVE_CAPABILITY);
  advance(50_000);
  assert.deepEqual(beats(), [10_000, 20_000, 50_000]);
  // The relay restarts as an older one: the beat already due at 80 s comes
  // as planned, the next one 10 s after it.
  state.capabilities.clear();
  advance(40_000);
  assert.deepEqual(beats(), [10_000, 20_000, 50_000, 80_000, 90_000, 100_000]);
  keepalive.stop();
});

test("work on the heartbeat side or a busy link keeps the busy cadence", () => {
  for (const options of [{ work: true }, { linkBusy: true }]) {
    const { keepalive, advance, beats } = setup(options);
    keepalive.start();
    advance(30_000);
    assert.deepEqual(beats(), [10_000, 20_000, 30_000], JSON.stringify(options));
    keepalive.stop();
  }
});

test("a nudge cuts an idle wait to the busy cadence, and only shortens", () => {
  const { keepalive, advance, beats } = setup();
  keepalive.start();
  advance(5_000);
  keepalive.nudge();
  assert.equal(keepalive.status().dueAtMs, 15_000);
  keepalive.nudge();
  assert.equal(keepalive.status().dueAtMs, 15_000, "a second nudge does not push the beat out");
  advance(10_000);
  assert.deepEqual(beats(), [15_000]);
  advance(9_000);
  keepalive.nudge();
  assert.equal(keepalive.status().dueAtMs, 25_000, "already within the busy cadence");
  keepalive.stop();
});

test("after a hello or a delivery the busy cadence holds for 30 s, then idle again", () => {
  const { keepalive, advance, beats } = setup();
  keepalive.start();
  advance(1_000);
  // The relay's server.hello (or a queue.deliver) arrives.
  keepalive.nudge();
  advance(60_000);
  // Beats at 11, 21, 31 s inside the hold (until 31 s); the one at 31 s is
  // no longer inside it, so the next wait is 30 s.
  assert.deepEqual(beats(), [11_000, 21_000, 31_000, 61_000]);
  keepalive.stop();
});

test("stop clears the timer, and a stopped keepalive ignores nudges", () => {
  const { keepalive, advance, timerCount, state } = setup();
  keepalive.start();
  keepalive.stop();
  assert.equal(timerCount(), 0);
  keepalive.nudge();
  assert.equal(timerCount(), 0);
  advance(60_000);
  assert.equal(state.pulses, 1);
});

test("a getter that throws counts as busy", () => {
  const timers = [];
  const keepalive = createWorkerKeepalive({
    heartbeat: { hasWork: () => { throw new Error("boom"); }, pulseHeartbeat: async () => true },
    link: { serverSupports: () => true },
    setTimeoutImpl: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  keepalive.start();
  assert.deepEqual(timers, [10_000]);
  keepalive.stop();
});
