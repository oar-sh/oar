import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupIsActive,
  groupSummaryText,
  memberStateClass,
  parseGroupFoldChoices,
  pruneGroupFoldChoices,
  resolveGroupFold,
  summarizeGroupMembers,
  toggledGroupFoldChoice,
} from './conversation-group-state.mjs';

test('a member is waiting before running before error before idle', () => {
  assert.equal(memberStateClass({ pendingCount: 1, processing: true }), 'waiting');
  assert.equal(memberStateClass({ visualState: 'question' }), 'waiting');
  assert.equal(memberStateClass({ processing: true, visualState: 'error' }), 'running');
  assert.equal(memberStateClass({ activeTurn: true }), 'running');
  assert.equal(memberStateClass({ sessionState: 'background_only' }), 'running');
  assert.equal(memberStateClass({ sessionState: 'running_turn' }), 'running');
  assert.equal(memberStateClass({ visualState: 'error' }), 'error');
  assert.equal(memberStateClass({ visualState: 'ready', sessionState: 'idle' }), 'idle');
  assert.equal(memberStateClass(), 'idle');
});

test('the summary counts the classes and names the strongest', () => {
  const summary = summarizeGroupMembers(['idle', 'running', 'waiting', 'running', 'error']);
  assert.deepEqual(summary, { count: 5, waiting: 1, running: 2, error: 1, idle: 1, strongest: 'waiting' });
  assert.equal(groupSummaryText(summary), '5 · 1 waiting for you, 2 running, 1 failed');
  assert.equal(groupSummaryText(summarizeGroupMembers(['idle', 'idle', 'idle'])), '3 sessions');
  assert.equal(groupSummaryText(summarizeGroupMembers(['idle'])), '1 session');
  assert.equal(groupSummaryText(summarizeGroupMembers(['running'])), '1 · 1 running');
  assert.equal(groupSummaryText(summarizeGroupMembers([])), '');
  assert.equal(summarizeGroupMembers(['running', 'error']).strongest, 'running');
  assert.equal(groupIsActive(summarizeGroupMembers(['error', 'idle'])), false);
  assert.equal(groupIsActive(summarizeGroupMembers(['waiting'])), true);
});

test('the fold: folded once finished, open while active, the user\'s choice wins, the open chat and a filter force open', () => {
  assert.equal(resolveGroupFold({ active: false }), false);
  assert.equal(resolveGroupFold({ active: true }), true);
  assert.equal(resolveGroupFold({ active: true, choice: 'folded' }), false);
  assert.equal(resolveGroupFold({ active: false, choice: 'open' }), true);
  assert.equal(resolveGroupFold({ active: false, choice: 'folded', holdsOpenConversation: true }), true);
  assert.equal(resolveGroupFold({ active: false, choice: 'folded', filterActive: true }), true);
  assert.equal(toggledGroupFoldChoice(true), 'folded');
  assert.equal(toggledGroupFoldChoice(false), 'open');
});

test('fold choices in storage: parsed strictly and pruned to the groups still listed', () => {
  assert.deepEqual(parseGroupFoldChoices('{"grp_a":"open","grp_b":"folded","grp_c":"maybe","grp_d":1}'), { grp_a: 'open', grp_b: 'folded' });
  assert.deepEqual(parseGroupFoldChoices('not json'), {});
  assert.deepEqual(parseGroupFoldChoices('[1,2]'), {});
  assert.deepEqual(parseGroupFoldChoices(''), {});
  assert.deepEqual(pruneGroupFoldChoices({ grp_a: 'open', grp_b: 'folded' }, ['grp_b']), { grp_b: 'folded' });
});
