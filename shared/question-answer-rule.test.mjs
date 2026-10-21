import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  closedQuestionAnswer,
  matchQuestionChoice,
  questionAcceptsFreeText,
  readApprovalAnswer,
} from './question-answer-rule.mjs';

test('a choice matches trimmed and in any case, and comes back as the card\'s own label', () => {
  assert.equal(matchQuestionChoice('  allow ', ['Allow', 'Deny']), 'Allow');
  assert.equal(matchQuestionChoice('DENY', ['Allow', 'Deny']), 'Deny');
  assert.equal(matchQuestionChoice('allow it', ['Allow', 'Deny']), null);
  assert.equal(matchQuestionChoice('', ['Allow', 'Deny']), null);
  assert.equal(matchQuestionChoice('Allow', null), null);
});

test('every Allow / Deny card reads its answer by the same rule', () => {
  const card = { approve: 'Allow', deny: 'Deny' };
  assert.equal(readApprovalAnswer('Allow', card), 'approve');
  assert.equal(readApprovalAnswer(' allow ', card), 'approve');
  assert.equal(readApprovalAnswer('ALLOW', card), 'approve');
  assert.equal(readApprovalAnswer('deny', card), 'deny');
  // Not a choice: neither an approval nor, silently, a denial.
  for (const other of ['yes', 'ok', 'allow it', '', null, undefined]) {
    assert.equal(readApprovalAnswer(other, card), null, String(other));
  }
  assert.equal(readApprovalAnswer('approve', { approve: 'Approve', deny: 'Deny' }), 'approve');
});

test('a card with choices takes typed text only when it says so', () => {
  assert.equal(questionAcceptsFreeText({ allowFreeform: false, choices: ['Allow', 'Deny'] }), false);
  assert.equal(questionAcceptsFreeText({ allowFreeform: true, choices: ['Allow', 'Deny'] }), true);
  // No flag stored: closed, as the relay's question rows read it.
  assert.equal(questionAcceptsFreeText({ choices: ['Allow', 'Deny'] }), false);
  assert.equal(questionAcceptsFreeText({ allowFreeform: null, choices: ['Allow', 'Deny'] }), false);
  // Without choices the card could not be answered at all.
  assert.equal(questionAcceptsFreeText({ allowFreeform: false, choices: [] }), true);
  assert.equal(questionAcceptsFreeText(null), true);
});

test('a closed card accepts one of its choices, or several on a multi-select card', () => {
  const card = { choices: ['Alpha', 'Beta', 'Gamma'] };
  assert.equal(closedQuestionAnswer(card, ' beta'), 'Beta');
  assert.equal(closedQuestionAnswer(card, 'something else'), null);
  assert.equal(closedQuestionAnswer(card, 'Alpha, Gamma'), null, 'a single-choice card takes one');
  const multi = { ...card, multiSelect: true };
  assert.equal(closedQuestionAnswer(multi, 'alpha, GAMMA'), 'Alpha, Gamma');
  assert.equal(closedQuestionAnswer(multi, 'Alpha, and a note'), null);
});
