import test from 'node:test';
import assert from 'node:assert/strict';

import { createFailuresReporter } from './node-test-failures-reporter.mjs';

// Events as node:test emits them, with a clock that each event moves on.
function run(events, options) {
  let clock = 0;
  async function* source() {
    for (const [ms, type, data] of events) {
      clock += ms;
      yield { type, data };
    }
  }
  const reporter = createFailuresReporter({ ...options, now: () => clock });
  return (async () => {
    let out = '';
    for await (const chunk of reporter(source())) out += chunk;
    return out;
  })();
}

const pass = (name, ms = 0) => [ms, 'test:pass', { name, file: '/r/a.test.mjs', nesting: 0, details: { type: 'test' } }];
const summary = (passed, failed) => [0, 'test:summary', {
  success: failed === 0,
  duration_ms: 61_000,
  counts: { tests: passed + failed, passed, failed, cancelled: 0, skipped: 0, todo: 0 },
}];

test('in a log: a progress line every 30 s, then the summary', async () => {
  const out = await run([
    pass('a', 10_000), pass('b', 10_000), pass('c', 15_000), pass('d', 1_000),
    pass('e', 30_000), pass('f', 1_000), summary(6, 0),
  ], { isTTY: false, progress: true });
  assert.deepEqual(out.split('\n').filter(Boolean), [
    '… 3 tests done, 0 failed (35s)',
    '… 5 tests done, 0 failed (66s)',
    'ok: 6 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo (6 tests, 61s)',
  ]);
});

test('on a terminal: one line rewritten in place, cleared before a failure and the summary', async () => {
  const failure = [2_000, 'test:fail', {
    name: 'breaks', file: '/r/a.test.mjs', nesting: 0, line: 7,
    details: { type: 'test', error: new Error('boom') },
  }];
  const out = await run([
    [0, 'test:start', { name: 'breaks', file: '/r/a.test.mjs', nesting: 0 }],
    pass('a', 1_500), failure, pass('b', 2_000), summary(2, 1),
  ], { isTTY: true, progress: true });
  // The failure prints first (the line taken away), the line comes back under it.
  assert.ok(out.startsWith('\r\x1b[K… 1 tests done, 0 failed (2s)\r\x1b[K\n✖ '), JSON.stringify(out.slice(0, 80)));
  assert.match(out, /✖ .*a\.test\.mjs:7\n {2}breaks\n {4}Error: boom/);
  assert.match(out, /\n\r\x1b\[K… 2 tests done, 1 failed \(4s\)\r\x1b\[K… 3 tests done, 1 failed \(6s\)\r\x1b\[K\nFAILED: 2 passed, 1 failed/);
});

test('suites are not counted, and OAR_TEST_PROGRESS=0 (progress false) prints only failures and the summary', async () => {
  const suite = [40_000, 'test:pass', { name: 's', file: '/r/a.test.mjs', nesting: 0, details: { type: 'suite' } }];
  const counted = await run([pass('a', 1_000), suite, pass('b', 0), summary(2, 0)], { isTTY: false, progress: true });
  assert.match(counted, /^… 2 tests done, 0 failed \(41s\)\n/, 'the suite moved the clock but is not a test');
  const quiet = await run([pass('a', 40_000), pass('b', 40_000), summary(2, 0)], { isTTY: false, progress: false });
  assert.equal(quiet, '\nok: 2 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo (2 tests, 61s)\n');
});
