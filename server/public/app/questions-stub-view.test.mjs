import test from 'node:test';
import assert from 'node:assert/strict';

import { askStubAnswerText, askStubHostKey, askStubKey, askStubText } from './questions-stub-view.mjs';

const ask = (extra = {}) => ({ id: 'ask_1', status: 'pending', urgency: 'normal', ...extra });

test('the stub says what the ask is now, per status and urgency', () => {
  assert.equal(askStubText(ask()), '📓 Question for you');
  assert.equal(askStubText(ask({ urgency: 'now' })), '📓 Question for you · urgent');
  assert.equal(askStubText(ask({ status: 'answered', choice: 'Option B', answer: 'Option B' })), '📓 Answered: Option B');
  assert.equal(askStubText(ask({ status: 'answered', answer: 'Calibrate\n  the north   pier first' })), '📓 Answered: Calibrate the north pier first');
  assert.equal(askStubText(ask({ status: 'dismissed', urgency: 'now' })), '📓 Dismissed');
  assert.equal(askStubText(ask({ status: 'withdrawn' })), '📓 Withdrawn');
  // A cancelled ask (its session ended) leaves no stub; nor does nothing.
  assert.equal(askStubText(ask({ status: 'cancelled' })), '');
  assert.equal(askStubText(null), '');
});

test('a long answer is cut to 80 characters', () => {
  const long = 'x'.repeat(200);
  const text = askStubAnswerText(ask({ status: 'answered', answer: long }));
  assert.equal(text.length, 80);
  assert.ok(text.endsWith('…'));
  assert.equal(askStubAnswerText(ask({ status: 'answered', choice: 'Yes', answer: long })), 'Yes');
});

test('the host is the asking turn\'s queue row, or none', () => {
  assert.equal(askStubHostKey(ask({ queueId: 'q-heron-3' })), 'q-heron-3');
  assert.equal(askStubHostKey(ask({ queueId: null })), null);
  assert.equal(askStubHostKey(ask()), null);
  assert.equal(askStubHostKey(ask({ queueId: '  ' })), null);
});

test('the key changes with what the stub shows, not with anything else', () => {
  const base = askStubKey(ask());
  assert.equal(askStubKey(ask({ updatedAt: '2026-05-14T09:00:00.000Z', question: 'Other?' })), base);
  assert.notEqual(askStubKey(ask({ urgency: 'now' })), base);
  assert.notEqual(askStubKey(ask({ status: 'answered', choice: 'A' })), askStubKey(ask({ status: 'answered', choice: 'B' })));
});
