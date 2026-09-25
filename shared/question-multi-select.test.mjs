import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeMultiSelectQuestion } from './question-multi-select.mjs';

test('a question reads as multi-select from its wording, conservatively', () => {
  const choices = ['a', 'b', 'c'];
  for (const text of [
    'Which public-exposure controls do you want? Select all that apply.',
    'Pick any number of the following features.',
    'Choose one or more regions to deploy to.',
    'Which linters should I enable? You can select multiple.',
    'Tick all the checks you want in CI.',
    'This is a multi-select question: which files?',
  ]) {
    assert.equal(looksLikeMultiSelectQuestion(text, choices), true, text);
  }
  for (const text of [
    'Which environment should I deploy to?',
    'Pick the one you prefer.',
    'Select a model.',
    'Should I continue?',
    'Which is the best single option?',
  ]) {
    assert.equal(looksLikeMultiSelectQuestion(text, choices), false, text);
  }
  assert.equal(looksLikeMultiSelectQuestion('Select all that apply.', ['only one']), false, 'one choice is never multi');
  assert.equal(looksLikeMultiSelectQuestion('Select all that apply.', []), false);
  assert.equal(looksLikeMultiSelectQuestion('', choices), false);
});
