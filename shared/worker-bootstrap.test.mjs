import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerDebug, parseSessionIdArg, readOptionalMs } from './worker-bootstrap.mjs';

test('the session id is read from the flag, the inline form, then the environment', () => {
  assert.equal(parseSessionIdArg(['node', 'worker.mjs', '--session-id', ' abc '], {}), 'abc');
  assert.equal(parseSessionIdArg(['node', 'worker.mjs', '--session-id=abc'], {}), 'abc');
  assert.equal(parseSessionIdArg(['node', 'worker.mjs'], { SESSION_ID: 'from-env' }), 'from-env');
  // The flag wins over the environment when both are present.
  assert.equal(parseSessionIdArg(['--session-id', 'flag'], { SESSION_ID: 'env' }), 'flag');
});

test('a missing session id is empty rather than thrown, so the caller can explain', () => {
  assert.equal(parseSessionIdArg([], {}), '');
  // A trailing `--session-id` with no value must not consume the flag itself.
  assert.equal(parseSessionIdArg(['node', 'worker.mjs', '--session-id'], {}), '');
});

test('the debug channel tags the worker name and an ISO timestamp', () => {
  const lines = [];
  const dbg = createWorkerDebug('copilot-sdk-worker', { log: (...parts) => lines.push(parts) });
  dbg('turn started', 'q-1');
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], /^\[copilot-sdk-worker \d{4}-\d{2}-\d{2}T[\d:.]+Z\]$/);
  assert.deepEqual(lines[0].slice(1), ['turn started', 'q-1']);
});

test('readOptionalMs keeps 0 as a real value and rejects junk', () => {
  assert.equal(readOptionalMs('X', { X: '0' }), 0);
  assert.equal(readOptionalMs('X', { X: '2500' }), 2500);
  assert.equal(readOptionalMs('X', {}), undefined);
  assert.equal(readOptionalMs('X', { X: 'soon' }), undefined);
  assert.equal(readOptionalMs('X', { X: '-1' }), undefined);
});
