import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeMultiSelectAnswer, isMultiSelectQuestion } from './question-multi-select.mjs';

test('a card is multi-select only when its provider said so and it offers several choices', () => {
  assert.equal(isMultiSelectQuestion({ choices: ['a', 'b'], context: { multiSelect: true } }), true);
  assert.equal(isMultiSelectQuestion({ choices: ['a', 'b'], context: { multiSelect: false } }), false);
  assert.equal(isMultiSelectQuestion({ choices: ['a', 'b'], context: {} }), false);
  assert.equal(isMultiSelectQuestion({ choices: ['only'], context: { multiSelect: true } }), false);
  assert.equal(isMultiSelectQuestion({ choices: [], context: { multiSelect: true } }), false);
  assert.equal(isMultiSelectQuestion(null), false);
});

test('the answer is the selected labels in order, plus the typed extra as one more item', () => {
  assert.equal(composeMultiSelectAnswer(['Unlisted visibility', 'noindex by default']), 'Unlisted visibility, noindex by default');
  assert.equal(composeMultiSelectAnswer(['A'], 'and a watermark option'), 'A, and a watermark option');
  assert.equal(composeMultiSelectAnswer([], 'just this'), 'just this');
  assert.equal(composeMultiSelectAnswer([' A ', 'A', ''], ' A '), 'A', 'duplicates and blanks collapse');
  assert.equal(composeMultiSelectAnswer([], ''), '');
  assert.equal(composeMultiSelectAnswer(null, undefined), '');
});
