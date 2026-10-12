import test from 'node:test';
import assert from 'node:assert/strict';

import { STALE_ATTEMPT_SUMMARY_QUIET_MS, createStaleAttemptLogLimiter } from './stale-attempt-log-limiter.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const MESSAGE = 'msg-fixture-0001-aaaa';
const OLD_ATTEMPT = 'att-fixture-old-aaaa';
const NEW_ATTEMPT = 'att-fixture-new-bbbb';

function setup() {
  let clock = T0;
  const timers = [];
  const lines = [];
  const limiter = createStaleAttemptLogLimiter({
    warn: (line) => lines.push(line),
    now: () => clock,
    setTimer(fn, ms) {
      const timer = { fn, at: clock + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.done = true; },
  });
  return {
    limiter,
    lines,
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = timers.filter((timer) => !timer.done && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = Math.max(clock, next.at);
        next.done = true;
        next.fn();
      }
      clock = until;
    },
  };
}

test('the first refusal of an attempt is logged in full; a burst becomes one summary line', () => {
  const { limiter, lines, advance } = setup();
  const first = limiter.note({ messageId: MESSAGE, attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route: 'stream', status: 'processing' });
  assert.deepEqual(first, { logged: true, count: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^STALE ATTEMPT msg-fixt route=stream claimed=att-fixt current=att-fixt status=processing \(further writes/);

  // 695 more writes over four minutes, like the live burst.
  for (let i = 0; i < 695; i += 1) {
    advance(Math.round(4 * 60_000 / 695));
    const route = i % 3 === 0 ? 'activity' : 'stream';
    const result = limiter.note({ messageId: MESSAGE, attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route, status: 'processing' });
    assert.equal(result.logged, false);
  }
  assert.equal(lines.length, 1, 'nothing more while the burst goes on');

  advance(STALE_ATTEMPT_SUMMARY_QUIET_MS);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^STALE ATTEMPT msg-fixt attempt=att-fixt: 695 more writes refused over 24\ds \(routes stream,activity; current=att-fixt status=processing\)$/);
  assert.equal(limiter.size(), 0);

  // The attempt is forgotten: a late write is a new first line.
  limiter.note({ messageId: MESSAGE, attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route: 'response', status: 'done' });
  assert.equal(lines.length, 3);
  assert.match(lines[2], /route=response/);
});

test('a single refusal gets no summary, and different attempts are counted apart', () => {
  const { limiter, lines, advance } = setup();
  limiter.note({ messageId: MESSAGE, attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route: 'response' });
  limiter.note({ messageId: 'msg-fixture-0002-bbbb', attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route: 'response' });
  limiter.note({ messageId: 'msg-fixture-0002-bbbb', attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route: 'thought' });
  assert.equal(lines.length, 2);
  advance(STALE_ATTEMPT_SUMMARY_QUIET_MS);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^STALE ATTEMPT msg-fixt attempt=att-fixt: 1 more write refused over 1s \(routes response,thought/);
});

test('flush writes the pending summaries at once', () => {
  const { limiter, lines } = setup();
  for (let i = 0; i < 3; i += 1) limiter.note({ messageId: MESSAGE, attemptId: OLD_ATTEMPT, currentAttemptId: NEW_ATTEMPT, route: 'stream' });
  assert.equal(lines.length, 1);
  limiter.flush();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /2 more writes refused/);
  assert.equal(limiter.size(), 0);
});
