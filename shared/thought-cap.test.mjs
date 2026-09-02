import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_THOUGHT_CHARS, capThought } from './thought-cap.mjs';

test('the cap is the extension bridge\'s 16 KiB', () => {
  assert.equal(MAX_THOUGHT_CHARS, 16 * 1024);
});

test('text under the cap is returned unchanged', () => {
  assert.equal(capThought('thinking'), 'thinking');
  assert.equal(capThought('x'.repeat(MAX_THOUGHT_CHARS)).length, MAX_THOUGHT_CHARS);
});

test('text over the cap is truncated to exactly the cap', () => {
  assert.equal(capThought('x'.repeat(MAX_THOUGHT_CHARS + 5_000)).length, MAX_THOUGHT_CHARS);
});

test('non-string input degrades to a string', () => {
  assert.equal(capThought(null), '');
  assert.equal(capThought(undefined), '');
  assert.equal(capThought(42), '42');
});
