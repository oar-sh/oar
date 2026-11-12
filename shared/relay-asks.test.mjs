import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUD_PERMISSION_QUESTION_SOURCE,
  RELAY_ASK_LIMITS,
  PERSON_ONLY_QUESTION_SOURCE,
  REMOTE_RELAY_APPROVAL_SOURCE,
  isPersonOnlyCard,
  isPersonOnlyQuestion,
  isRelayAskId,
  normalizeRelayAskAnswer,
  normalizeRelayAskInput,
  relayQuestionKind,
} from './relay-asks.mjs';
import * as contract from './remote-relay-contract.mjs';

test('an ask takes a question, up to eight options, a recommendation, a detail and an urgency', () => {
  const checked = normalizeRelayAskInput({
    question: '  Which   database\nfor the cache? ',
    options: ['Postgres', 'SQLite', 'postgres', ''],
    recommendation: 'sqlite',
    detail: 'Line one\r\nLine two\u0007',
    urgency: 'NOW',
  });
  assert.deepEqual(checked, {
    ok: true,
    value: {
      question: 'Which database for the cache?',
      options: ['Postgres', 'SQLite'],
      recommendation: 'SQLite',
      detail: 'Line one\nLine two',
      urgency: 'now',
    },
  });
  assert.deepEqual(normalizeRelayAskInput({ question: 'Go on?' }).value, { question: 'Go on?', options: [], recommendation: '', detail: '', urgency: 'normal' });
  assert.equal(normalizeRelayAskInput({ question: 'Q', recommendation: 'Wait a day' }).value.recommendation, 'Wait a day', 'free text is a recommendation too');
});

test('too long is refused, never cut', () => {
  assert.match(normalizeRelayAskInput({}).error, /needs question/);
  assert.match(normalizeRelayAskInput({ question: 'x'.repeat(RELAY_ASK_LIMITS.questionMax + 1) }).error, /longer than 500/);
  assert.equal(normalizeRelayAskInput({ question: 'x'.repeat(RELAY_ASK_LIMITS.questionMax) }).ok, true);
  assert.match(normalizeRelayAskInput({ question: 'Q', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }).error, /at most 8/);
  assert.match(normalizeRelayAskInput({ question: 'Q', options: ['x'.repeat(121)] }).error, /option is longer/);
  assert.match(normalizeRelayAskInput({ question: 'Q', options: [{ label: 'A' }] }).error, /list of short labels/);
  assert.match(normalizeRelayAskInput({ question: 'Q', detail: 'x'.repeat(2001) }).error, /detail is longer/);
  assert.match(normalizeRelayAskInput({ question: 'Q', urgency: 'later' }).error, /urgency must be one of: normal, now/);
});

test('an answer is an option, typed text, or both; typed text that is an option counts as it', () => {
  const ask = { options: ['Postgres', 'SQLite'] };
  assert.deepEqual(normalizeRelayAskAnswer(ask, { choice: 'sqlite' }).value, { answer: 'SQLite', choice: 'SQLite' });
  assert.deepEqual(normalizeRelayAskAnswer(ask, { choice: 'SQLite', answer: 'for now' }).value, { answer: 'for now', choice: 'SQLite' });
  assert.deepEqual(normalizeRelayAskAnswer(ask, { answer: 'postgres' }).value, { answer: 'postgres', choice: 'Postgres' });
  assert.deepEqual(normalizeRelayAskAnswer(ask, { answer: 'neither' }).value, { answer: 'neither', choice: '' });
  assert.match(normalizeRelayAskAnswer(ask, { choice: 'MySQL' }).error, /not an option/);
  assert.match(normalizeRelayAskAnswer(ask, {}).error, /needs a choice or some text/);
});

test('ask ids and the kinds of question cards', () => {
  assert.equal(isRelayAskId('ask_0a1b2c3d4e5f'), true);
  assert.equal(isRelayAskId('9f0c-uuid'), false);
  assert.equal(isRelayAskId('ask_../x'), false);
  assert.equal(relayQuestionKind({ kind: 'ask' }), 'ask');
  assert.equal(relayQuestionKind({ context: { source: 'remote_relay' } }), 'approval');
  // One value: the contract re-exports this module's, which kept the old name.
  assert.equal(contract.REMOTE_RELAY_APPROVAL_SOURCE, REMOTE_RELAY_APPROVAL_SOURCE);
  assert.equal(relayQuestionKind({ context: { source: REMOTE_RELAY_APPROVAL_SOURCE } }), 'approval');
  assert.equal(relayQuestionKind({ context: { source: 'relay_tool' } }), 'ask_user');
  assert.equal(relayQuestionKind({ context: null }), 'ask_user');
  assert.equal(relayQuestionKind(null), 'ask_user');
});

test('isPersonOnlyQuestion knows a Safety check card by its context source alone', () => {
  assert.equal(PERSON_ONLY_QUESTION_SOURCE, 'ClaudeSafetyCheck');
  assert.equal(isPersonOnlyQuestion({ source: 'ClaudeSafetyCheck', header: 'Safety check' }), true);
  assert.equal(isPersonOnlyQuestion({ source: ' ClaudeSafetyCheck ' }), true);
  for (const context of [{ source: 'AskUserQuestion' }, { source: REMOTE_RELAY_APPROVAL_SOURCE }, { header: 'Safety check' }, {}, null, undefined, 'ClaudeSafetyCheck']) {
    assert.equal(isPersonOnlyQuestion(context), false, JSON.stringify(context));
  }
});

test('isPersonOnlyCard: asks, relay approvals, Safety checks, cloud permissions and personOnly cards; ordinary cards are not', () => {
  const envelope = (context) => ({ request: JSON.stringify({ request: null, context, allowFreeform: false }) });
  assert.equal(isPersonOnlyCard({ id: 'ask_abc123', kind: 'ask' }), true);
  assert.equal(isPersonOnlyCard({ id: 'ask_abc123' }), true);
  assert.equal(isPersonOnlyCard({ context: { source: REMOTE_RELAY_APPROVAL_SOURCE } }), true);
  assert.equal(isPersonOnlyCard({ context: { source: PERSON_ONLY_QUESTION_SOURCE } }), true);
  assert.equal(isPersonOnlyCard({ context: { source: PERSON_ONLY_QUESTION_SOURCE, kind: 'sensitive-file', personOnly: true } }), true);
  assert.equal(isPersonOnlyCard({ context: { source: CLOUD_PERMISSION_QUESTION_SOURCE } }), true);
  assert.equal(isPersonOnlyCard({ context: { source: 'Anything', personOnly: true } }), true);
  // A stored row keeps its context in the request envelope.
  assert.equal(isPersonOnlyCard(envelope({ source: PERSON_ONLY_QUESTION_SOURCE })), true);
  assert.equal(isPersonOnlyCard(envelope({ source: CLOUD_PERMISSION_QUESTION_SOURCE })), true);
  assert.equal(isPersonOnlyCard(envelope({ header: 'Question' })), false);
  assert.equal(isPersonOnlyCard({ id: 'q-1', context: { header: 'Which theme?' } }), false);
  assert.equal(isPersonOnlyCard({ id: 'q-1', context: { personOnly: 'yes' } }), false, 'only a real true');
  assert.equal(isPersonOnlyCard({ request: '{not json' }), false);
  assert.equal(isPersonOnlyCard(null), false);
});
