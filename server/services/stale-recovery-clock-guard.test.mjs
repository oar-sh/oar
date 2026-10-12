import test from 'node:test';
import assert from 'node:assert/strict';

import { CLOCK_JUMP_FACTOR, createStaleRecoveryClockGuard } from './stale-recovery-clock-guard.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const INTERVAL_MS = 15_000;
const GRACE_MS = 10 * 60_000;

function setup() {
  let clock = T0;
  const lines = [];
  const guard = createStaleRecoveryClockGuard({
    now: () => clock,
    intervalMs: INTERVAL_MS,
    graceMs: GRACE_MS,
    log: (line) => lines.push(line),
  });
  return { guard, lines, advance: (ms) => { clock += ms; } };
}

test('regular ticks never skip, even the first one and a slightly late one', () => {
  const { guard, lines, advance } = setup();
  assert.equal(guard.thresholdMs, INTERVAL_MS * CLOCK_JUMP_FACTOR);
  assert.deepEqual(guard.tick(), { skip: false, jumped: false, gapMs: 0, graceRemainingMs: 0 });
  advance(INTERVAL_MS);
  assert.equal(guard.tick().skip, false);
  advance(INTERVAL_MS * CLOCK_JUMP_FACTOR);
  assert.equal(guard.tick().jumped, false, 'a gap of exactly the threshold is not a jump');
  assert.deepEqual(lines, []);
});

test('a six hour sleep is a jump: recovery skips for the grace, then resumes', () => {
  const { guard, lines, advance } = setup();
  guard.tick();
  advance(6 * 60 * 60_000);
  const woke = guard.tick();
  assert.equal(woke.jumped, true);
  assert.equal(woke.skip, true, 'no recovery on the tick that notices the jump');
  assert.equal(woke.gapMs, 6 * 60 * 60_000);
  assert.equal(woke.graceRemainingMs, GRACE_MS);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Clock jump: 21600s passed between stale-recovery ticks \(interval 15s\); stale recovery paused for 600s/);

  // The timer keeps ticking every 15 s: every tick inside the grace skips.
  let skipped = 0;
  for (let elapsed = INTERVAL_MS; elapsed < GRACE_MS; elapsed += INTERVAL_MS) {
    advance(INTERVAL_MS);
    const inside = guard.tick();
    assert.equal(inside.skip, true, `still within the grace at ${elapsed} ms`);
    assert.equal(inside.jumped, false);
    skipped += 1;
  }
  assert.equal(skipped, GRACE_MS / INTERVAL_MS - 1);
  assert.equal(lines.length, 1);
  advance(INTERVAL_MS);
  const resumed = guard.tick();
  assert.equal(resumed.skip, false);
  assert.equal(resumed.jumped, false);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /Stale recovery resumed/);
});

test('a second jump inside the grace extends it', () => {
  const { guard, advance } = setup();
  guard.tick();
  advance(2 * 60 * 60_000);
  guard.tick();
  advance(GRACE_MS / 2);
  advance(2 * 60 * 60_000);
  const again = guard.tick();
  assert.equal(again.jumped, true);
  assert.equal(again.graceRemainingMs, GRACE_MS, 'the grace restarts from the later jump');
});

test('a blocked event loop counts as a jump too, and the default threshold follows the interval', () => {
  const lines = [];
  let clock = T0;
  const guard = createStaleRecoveryClockGuard({ now: () => clock, intervalMs: 1_000, graceMs: 5_000, log: (line) => lines.push(line) });
  guard.tick();
  clock += 4_001;
  assert.equal(guard.tick().jumped, true);
  assert.equal(guard.graceMs, 5_000);
});
