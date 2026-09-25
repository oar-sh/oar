import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeMultiSelectAnswer, isMultiSelectQuestion, offersMultiSelectToggle } from './question-multi-select.mjs';

const card = (context, choices = ['a', 'b', 'c']) => ({ choices, context });

test('without the switch, a card is multi-select exactly when its provider flagged it', () => {
  assert.equal(isMultiSelectQuestion(card({ multiSelect: true })), true);
  assert.equal(isMultiSelectQuestion(card({ multiSelect: false })), false);
  assert.equal(isMultiSelectQuestion(card({})), false);
  assert.equal(isMultiSelectQuestion(card({ multiSelect: true }, ['only'])), false, 'one choice is never multi');
  assert.equal(isMultiSelectQuestion(card({ multiSelect: true }, [])), false);
  assert.equal(isMultiSelectQuestion(null), false);
});

test('a Copilot card offers the switch; its position overrides the flag either way', () => {
  const copilotSingle = card({ allowMultiSelect: true });
  const copilotMulti = card({ allowMultiSelect: true, multiSelect: true });
  assert.equal(offersMultiSelectToggle(copilotSingle), true);
  assert.equal(isMultiSelectQuestion(copilotSingle), false, 'untouched: follows the flag');
  assert.equal(isMultiSelectQuestion(copilotSingle, true), true, 'switched on');
  assert.equal(isMultiSelectQuestion(copilotMulti), true, 'pre-selected by the flag or wording');
  assert.equal(isMultiSelectQuestion(copilotMulti, false), false, 'switched back off');
});

test('a Claude card has no switch and follows its flag strictly, whatever the override says', () => {
  const claudeSingle = card({ source: 'AskUserQuestion' });
  const claudeMulti = card({ source: 'AskUserQuestion', multiSelect: true });
  assert.equal(offersMultiSelectToggle(claudeSingle), false);
  assert.equal(isMultiSelectQuestion(claudeSingle, true), false);
  assert.equal(isMultiSelectQuestion(claudeMulti, false), true);
  assert.equal(offersMultiSelectToggle(card({ allowMultiSelect: true }, ['only'])), false, 'no switch on a one-choice card');
});

test('the answer is the selected labels in order, plus the typed extra as one more item', () => {
  assert.equal(composeMultiSelectAnswer(['Unlisted visibility', 'noindex by default']), 'Unlisted visibility, noindex by default');
  assert.equal(composeMultiSelectAnswer(['A'], 'and a watermark option'), 'A, and a watermark option');
  assert.equal(composeMultiSelectAnswer([], 'just this'), 'just this');
  assert.equal(composeMultiSelectAnswer([' A ', 'A', ''], ' A '), 'A', 'duplicates and blanks collapse');
  assert.equal(composeMultiSelectAnswer([], ''), '');
  assert.equal(composeMultiSelectAnswer(null, undefined), '');
});
