import test from 'node:test';
import assert from 'node:assert/strict';

import { createArmableInterval } from './idle-timers.mjs';

function fakeIntervals() {
  const live = new Map();
  let nextId = 1;
  return {
    setIntervalImpl: (fn, ms) => {
      const id = nextId++;
      live.set(id, { fn, ms });
      return id;
    },
    clearIntervalImpl: (id) => { live.delete(id); },
    live,
    count: () => live.size,
    async fire() {
      for (const { fn } of [...live.values()]) fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
    periods: () => [...live.values()].map((entry) => entry.ms),
  };
}

test('nothing runs until the first arm', async () => {
  const timers = fakeIntervals();
  let ticks = 0;
  const interval = createArmableInterval({ intervalMs: 5_000, tick: () => { ticks += 1; }, ...timers });
  assert.equal(interval.isArmed(), false);
  assert.equal(timers.count(), 0);
  await timers.fire();
  assert.equal(ticks, 0);
});

test('arming starts one interval of the given period; arming again adds none', () => {
  const timers = fakeIntervals();
  const interval = createArmableInterval({ intervalMs: 5_000, tick: () => true, ...timers });
  assert.equal(interval.arm(), true);
  assert.equal(interval.arm(), false);
  assert.equal(timers.count(), 1);
  assert.deepEqual(timers.periods(), [5_000]);
});

test('a tick that returns false disarms; work arriving arms it again', async () => {
  const timers = fakeIntervals();
  let work = 2;
  const interval = createArmableInterval({
    intervalMs: 5_000,
    tick: () => { work = Math.max(0, work - 1); return work > 0; },
    ...timers,
  });
  interval.arm();
  await timers.fire();
  assert.equal(interval.isArmed(), true, 'work left');
  await timers.fire();
  assert.equal(interval.isArmed(), false, 'nothing left');
  assert.equal(timers.count(), 0);
  work = 1;
  interval.arm();
  assert.equal(interval.isArmed(), true);
});

test('an async tick disarms on false too, and a throwing tick keeps the interval', async () => {
  const timers = fakeIntervals();
  const errors = [];
  let mode = 'throw';
  const interval = createArmableInterval({
    intervalMs: 5_000,
    tick: async () => {
      if (mode === 'throw') throw new Error('boom');
      return false;
    },
    onError: (error) => errors.push(error.message),
    ...timers,
  });
  interval.arm();
  await timers.fire();
  assert.deepEqual(errors, ['boom']);
  assert.equal(interval.isArmed(), true);
  mode = 'done';
  await timers.fire();
  assert.equal(interval.isArmed(), false);
});

test('stop disarms for good', () => {
  const timers = fakeIntervals();
  const interval = createArmableInterval({ intervalMs: 5_000, tick: () => true, ...timers });
  interval.arm();
  interval.stop();
  assert.equal(timers.count(), 0);
  assert.equal(interval.arm(), false);
  assert.equal(timers.count(), 0);
});

test('an arm that lands during a running tick keeps the interval armed', async () => {
  const timers = fakeIntervals();
  let release = null;
  const interval = createArmableInterval({
    intervalMs: 5_000,
    // The tick looks, finds nothing, but is still awaiting when work arrives.
    tick: () => new Promise((resolve) => { release = () => resolve(false); }),
    ...timers,
  });
  interval.arm();
  for (const { fn } of [...timers.live.values()]) fn();
  interval.arm();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interval.isArmed(), true, 'the arm during the tick wins');
  for (const { fn } of [...timers.live.values()]) fn();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interval.isArmed(), false, 'the next empty tick with no arm in between disarms');
});

test('work that stays (a launch held in restart delay or exhausted) keeps the interval running', async () => {
  const timers = fakeIntervals();
  const primed = [];
  const rows = ['sdk-delayed', 'sdk-exhausted'];
  const interval = createArmableInterval({
    intervalMs: 5_000,
    tick: async () => {
      // The launch is refused, the rows stay pending: the fresh listing after
      // the awaits decides, not the launch result.
      for (const sid of rows) primed.push(sid);
      await Promise.resolve({ ok: false, error: 'restart-delayed' });
      return rows.length > 0;
    },
    ...timers,
  });
  interval.arm();
  for (let i = 0; i < 3; i += 1) await timers.fire();
  assert.equal(interval.isArmed(), true);
  assert.equal(primed.length, 6, 'both sessions primed on every tick');
});
