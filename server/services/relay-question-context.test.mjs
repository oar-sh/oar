import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeRelayQuestionContext } from './relay-question-context.mjs';

test('the context keeps the fields workers send, trimmed and bounded', () => {
  const context = sanitizeRelayQuestionContext({
    source: '  onUserInputRequest ',
    rationale: 'Copilot requested clarification to continue this turn.',
    queueMessageId: ' q-1 ',
    conversationId: 'conv-1',
    relayMode: 'autopilot',
  });
  assert.deepEqual(context, {
    source: 'onUserInputRequest',
    rationale: 'Copilot requested clarification to continue this turn.',
    queueMessageId: 'q-1',
    conversationId: 'conv-1',
    relayMode: 'autopilot',
  });
});

test('the multi-select flag and the question header survive, so the card can render checkmarks', () => {
  // Live 2026-09-25: the flag was stripped here, and neither Claude's
  // multiSelect cards nor Copilot's "select all that apply" ones ever
  // rendered checkmarks.
  const context = sanitizeRelayQuestionContext({ source: 'AskUserQuestion', multiSelect: true, header: '  Visibility ' });
  assert.equal(context.multiSelect, true);
  assert.equal(context.header, 'Visibility');
  assert.equal('multiSelect' in sanitizeRelayQuestionContext({ source: 's', multiSelect: false }), false);
  assert.equal('multiSelect' in sanitizeRelayQuestionContext({ source: 's', multiSelect: 'true' }), false, 'only a real boolean true');
  assert.equal(sanitizeRelayQuestionContext({ header: 'x'.repeat(500) }).header.length, 120);
});

test('unknown keys are dropped and an empty or invalid context is null', () => {
  assert.deepEqual(sanitizeRelayQuestionContext({ source: 's', requestId: 'r1', html: '<b>' }), { source: 's' });
  assert.equal(sanitizeRelayQuestionContext({}), null);
  assert.equal(sanitizeRelayQuestionContext(null), null);
  assert.equal(sanitizeRelayQuestionContext(['a']), null);
  assert.equal(sanitizeRelayQuestionContext({ source: '   ' }), null);
});

test('an unknown relay mode falls back to the default', () => {
  const normalizeRelayMode = (mode) => (['agent', 'plan'].includes(mode) ? mode : null);
  assert.equal(sanitizeRelayQuestionContext({ relayMode: 'bogus' }, { normalizeRelayMode, defaultRelayMode: 'agent' }).relayMode, 'agent');
  assert.equal(sanitizeRelayQuestionContext({ relayMode: 'plan' }, { normalizeRelayMode }).relayMode, 'plan');
});
