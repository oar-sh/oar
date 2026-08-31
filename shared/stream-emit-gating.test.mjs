import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldEmitStreamUpdate } from './stream-emit-gating.mjs';

test('shouldEmitStreamUpdate matches the extension stream publisher gating', () => {
  assert.equal(shouldEmitStreamUpdate('', 'abc'), false);
  assert.equal(shouldEmitStreamUpdate('abc', ''), true);
  assert.equal(shouldEmitStreamUpdate('abc', 'abc'), false);
  assert.equal(shouldEmitStreamUpdate('abcd', 'abc'), false);
  assert.equal(shouldEmitStreamUpdate('abc.', 'abc'), true);
  assert.equal(shouldEmitStreamUpdate(`abc${'x'.repeat(24)}`, 'abc'), true);
});

test('a rewritten or shortened text always publishes', () => {
  // The authoritative message replacing accumulated deltas is the case that
  // matters: the published text must never be left stale.
  assert.equal(shouldEmitStreamUpdate('ab', 'abcdef'), true);
  assert.equal(shouldEmitStreamUpdate('xyz', 'abc'), true);
});

test('null and undefined are treated as empty text', () => {
  assert.equal(shouldEmitStreamUpdate(null, null), false);
  assert.equal(shouldEmitStreamUpdate(undefined, undefined), false);
  assert.equal(shouldEmitStreamUpdate('abc', null), true);
});
