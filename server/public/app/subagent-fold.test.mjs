import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTerminalSubagentStatus,
  nextSubagentStatus,
  resolveSubagentFold,
  subagentFoldSummary,
  toggledSubagentFoldChoice,
} from './subagent-fold.mjs';

test('a subagent is folded until the user opens it, whatever it is doing', () => {
  assert.equal(resolveSubagentFold({}), true);
  assert.equal(resolveSubagentFold({ choice: null }), true);
  assert.equal(resolveSubagentFold({ choice: 'folded' }), true);
  assert.equal(resolveSubagentFold({ choice: 'open' }), false);
});

test('the folded header counts the steps and shows the latest', () => {
  assert.equal(subagentFoldSummary({ activities: ['Tool (view): notes.md'] }), '1 step · Tool (view): notes.md');
  assert.equal(
    subagentFoldSummary({ activities: ['Tool (view): notes.md', '', 'Tool (bash):\n  npm   test'] }),
    '2 steps · Tool (bash): npm test',
  );
});

test('a run that has taken no step yet shows the end of what it wrote', () => {
  assert.equal(subagentFoldSummary({ streamText: 'Reading the routes.\n\nThree call sites so far. ' }), 'Three call sites so far.');
  assert.equal(subagentFoldSummary({}), '');
  assert.equal(subagentFoldSummary({ activities: [' '], streamText: '' }), '');
});

test('the line is cut, not left to grow with the step', () => {
  const summary = subagentFoldSummary({ activities: [`Tool (bash): ${'x'.repeat(400)}`] });
  assert.equal(summary.length, 160);
});

test('a tap records the opposite of what is shown', () => {
  assert.equal(toggledSubagentFoldChoice(true), 'open');
  assert.equal(toggledSubagentFoldChoice(false), 'folded');
});

test('an unknown status is not terminal', () => {
  assert.equal(isTerminalSubagentStatus(''), false);
  assert.equal(isTerminalSubagentStatus('queued'), false);
});

test('an update that reports no status leaves the known one alone', () => {
  assert.equal(nextSubagentStatus({ reported: undefined, known: 'completed' }), 'completed');
  assert.equal(nextSubagentStatus({ reported: '', known: 'failed' }), 'failed');
  assert.equal(nextSubagentStatus({ reported: null, known: null }), 'running');
});

test('a reported status is taken, through the caller\'s normalizer', () => {
  const normalize = (value) => (value === 'completed' ? value : 'running');
  assert.equal(nextSubagentStatus({ reported: 'completed', known: 'running', normalize }), 'completed');
  assert.equal(nextSubagentStatus({ reported: 'odd', known: 'completed', normalize }), 'running');
});
