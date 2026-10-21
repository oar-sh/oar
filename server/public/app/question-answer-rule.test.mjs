import test from 'node:test';
import assert from 'node:assert/strict';

import * as mirror from './question-answer-rule.mjs';
import { questionAcceptsFreeText } from '../../../shared/question-answer-rule.mjs';

// The browser cannot import shared/, so question-answer-rule.mjs is a hand-kept
// copy: the card hides its reply box exactly when the relay refuses typed text.

test('the card view and the answer route agree on which cards take typed text', () => {
  for (const question of [
    { allowFreeform: false, choices: ['Allow', 'Deny'] },
    { allowFreeform: true, choices: ['Allow', 'Deny'] },
    { choices: ['Allow', 'Deny'] },
    { allowFreeform: null, choices: ['Allow', 'Deny'] },
    { allowFreeform: false, choices: [] },
    { allowFreeform: false },
    null,
    undefined,
  ]) {
    assert.equal(mirror.questionAcceptsFreeText(question), questionAcceptsFreeText(question), JSON.stringify(question));
  }
});
