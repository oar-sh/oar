import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adviseWatchdogTick,
  RELAY_WATCHDOG_HARD_RESET_TICKS,
} from './relay-watchdog-policy.mjs';

test('connected and disabled states reset the disconnected counter', () => {
  for (const state of ['connected', 'disabled']) {
    assert.deepEqual(
      adviseWatchdogTick({ state, disconnectedTicks: 3 }),
      { disconnectedTicks: 0, hardReset: false },
    );
  }
});

test('disconnected states accumulate ticks without an early hard reset', () => {
  let ticks = 0;
  for (let i = 1; i < RELAY_WATCHDOG_HARD_RESET_TICKS; i++) {
    const advice = adviseWatchdogTick({ state: i % 2 ? 'retrying' : 'forced', disconnectedTicks: ticks });
    assert.equal(advice.hardReset, false);
    assert.equal(advice.disconnectedTicks, i);
    ticks = advice.disconnectedTicks;
  }
});

test('reaching the threshold requests a hard reset and restarts the count', () => {
  const advice = adviseWatchdogTick({
    state: 'retrying',
    disconnectedTicks: RELAY_WATCHDOG_HARD_RESET_TICKS - 1,
  });
  assert.deepEqual(advice, { disconnectedTicks: 0, hardReset: true });
});

test('a reconnect between outages restarts the escalation from zero', () => {
  let advice = adviseWatchdogTick({ state: 'retrying', disconnectedTicks: 2 });
  advice = adviseWatchdogTick({ state: 'connected', disconnectedTicks: advice.disconnectedTicks });
  advice = adviseWatchdogTick({ state: 'retrying', disconnectedTicks: advice.disconnectedTicks });
  assert.deepEqual(advice, { disconnectedTicks: 1, hardReset: false });
});

test('a missing counter is treated as zero', () => {
  assert.deepEqual(
    adviseWatchdogTick({ state: 'retrying', disconnectedTicks: undefined }),
    { disconnectedTicks: 1, hardReset: false },
  );
});
