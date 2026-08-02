import test from 'node:test';
import assert from 'node:assert/strict';

import { countPlanLikeLines } from './plan-lines.mjs';

test('counts bullet and numbered lines, ignoring prose', () => {
  const text = [
    'Here is the plan:',
    '- first step',
    '* second step',
    '1. third step',
    '12. later step',
    'closing prose',
  ].join('\n');
  assert.equal(countPlanLikeLines(text), 4);
});

test('trims indentation and handles CRLF', () => {
  assert.equal(countPlanLikeLines('  - indented\r\n\t* tabbed\r\n'), 2);
});

test('returns zero for empty or non-plan text', () => {
  assert.equal(countPlanLikeLines(''), 0);
  assert.equal(countPlanLikeLines(null), 0);
  assert.equal(countPlanLikeLines('just a sentence - with a dash'), 0);
  assert.equal(countPlanLikeLines('-missing space bullet'), 0);
});
