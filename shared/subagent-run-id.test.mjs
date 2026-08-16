import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSubagentRunId } from './subagent-run-id.mjs';

test('well-formed ids pass through untouched', () => {
  assert.equal(sanitizeSubagentRunId('toolu_01AbCdEf'), 'toolu_01AbCdEf');
});

test('embedded newlines and concatenated ids collapse to one printable id', () => {
  // The live ef37beba shape: two ids glued with a newline.
  assert.equal(sanitizeSubagentRunId('call_abc\ncall_def'), 'call_abc-call_def');
  assert.equal(sanitizeSubagentRunId('  call_1 \t call_2  '), 'call_1-call_2');
});

test('empty and unprintable-only input is rejected', () => {
  assert.equal(sanitizeSubagentRunId(''), null);
  assert.equal(sanitizeSubagentRunId('\n\t '), null);
  assert.equal(sanitizeSubagentRunId(null), null);
});

test('overlong ids are capped', () => {
  assert.equal(sanitizeSubagentRunId('x'.repeat(300)).length, 128);
});
