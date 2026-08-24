import test from 'node:test';
import assert from 'node:assert/strict';

import { computeStablePrefixLength, planListPatch } from './streaming-dom-patch.mjs';

test('stable prefix stops at the first divergence', () => {
  assert.equal(computeStablePrefixLength(['a', 'b', 'c'], ['a', 'b', 'x']), 2);
  assert.equal(computeStablePrefixLength(['a'], ['a', 'b', 'c']), 1);
  assert.equal(computeStablePrefixLength([], ['a']), 0);
  assert.equal(computeStablePrefixLength(['a'], []), 0);
  assert.equal(computeStablePrefixLength(['a', 'b'], ['a', 'b']), 2);
});

test('a pure append only adds the missing tail', () => {
  assert.deepEqual(planListPatch(['a', 'b'], ['a', 'b', 'c', 'd']), { reset: false, appends: ['c', 'd'] });
  assert.deepEqual(planListPatch([], ['a']), { reset: false, appends: ['a'] });
  assert.deepEqual(planListPatch(['a'], ['a']), { reset: false, appends: [] });
});

test('an identical replay appends nothing (idempotent re-render)', () => {
  assert.deepEqual(planListPatch(['a', 'b', 'c'], ['a', 'b', 'c']), { reset: false, appends: [] });
});

test('divergence or truncation forces a reset with the full expected list', () => {
  assert.deepEqual(planListPatch(['a', 'x'], ['a', 'b', 'c']), { reset: true, appends: ['a', 'b', 'c'] });
  assert.deepEqual(planListPatch(['a', 'b', 'c'], ['a', 'b']), { reset: true, appends: ['a', 'b'] });
  assert.deepEqual(planListPatch(['a'], []), { reset: true, appends: [] });
});
