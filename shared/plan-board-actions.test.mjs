import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_BOARD_ACTIONS,
  PLAN_BOARD_LEAVES_PLAN,
  isPendingPlanBoard,
  planBoardActionLabel,
  planBoardActionsFromCli,
  planBoardFollowupMode,
  planBoardFollowupText,
  planBoardShownActions,
  withApproveOnly,
} from './plan-board-actions.mjs';

test('every provider\'s card offers the same four buttons, "Approve plan" first', () => {
  assert.deepEqual(PLAN_BOARD_ACTIONS.map((action) => [action.id, action.label]), [
    ['approve_only', 'Approve plan'],
    ['autopilot', 'Implement in autopilot'],
    ['interactive', 'Stop here and prompt myself'],
    ['exit_only', 'Stop here'],
  ]);
  assert.equal(planBoardActionLabel('autopilot_fleet'), 'Implement with autopilot fleet');
  assert.equal(planBoardActionLabel('APPROVE_ONLY'), 'Approve plan');
  assert.equal(planBoardActionLabel('keep_planning'), 'Keep Planning');
  // Not an own key of the table: spelled out, never an inherited property.
  assert.equal(planBoardActionLabel('constructor'), 'Constructor');
});

test('approve_only says exactly its line, and no follow-up repeats the plan', () => {
  assert.equal(
    planBoardFollowupText('approve_only'),
    'Plan approved by the user. Do not implement. Finish only the plan-only steps you were given, then stop.',
  );
  assert.equal(planBoardFollowupText('autopilot'), 'Please implement the approved plan now.');
  assert.equal(planBoardFollowupText('autopilot_fleet'), 'Please implement the approved plan using autopilot_fleet where useful.');
  assert.equal(planBoardFollowupText('interactive'), 'I approved the plan. Let\'s proceed interactively with implementation.');
  assert.equal(planBoardFollowupText('exit_only'), '');
  assert.equal(planBoardFollowupText('keep_planning'), '');
  for (const id of ['approve_only', 'autopilot', 'autopilot_fleet', 'interactive', 'exit_only']) {
    assert.doesNotMatch(planBoardFollowupText(id), /Plan summary/i);
  }
});

test('the follow-up modes; only the three implement actions leave plan mode', () => {
  assert.equal(planBoardFollowupMode('approve_only'), 'agent');
  assert.equal(planBoardFollowupMode('autopilot'), 'autopilot');
  assert.equal(planBoardFollowupMode('autopilot_fleet'), 'autopilot');
  assert.equal(planBoardFollowupMode('interactive'), 'agent');
  assert.equal(planBoardFollowupMode('exit_only'), null);
  assert.equal(planBoardFollowupMode('keep_planning'), null);
  assert.deepEqual([...PLAN_BOARD_LEAVES_PLAN], ['autopilot', 'autopilot_fleet', 'interactive']);
});

test('withApproveOnly keeps a CLI\'s own list and adds "Approve plan" once, first', () => {
  const cli = [
    { id: 'autopilot_fleet', label: 'Implement with autopilot fleet', mode: 'autopilot' },
    { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
  ];
  const shown = withApproveOnly(cli);
  assert.deepEqual(shown.map((action) => action.id), ['approve_only', 'autopilot_fleet', 'interactive']);
  assert.deepEqual(shown.slice(1), cli);
  assert.deepEqual(withApproveOnly(shown).map((action) => action.id), ['approve_only', 'autopilot_fleet', 'interactive']);
  // Ids work as entries too, and a list that has it keeps its own place for it.
  assert.deepEqual(withApproveOnly(['autopilot', 'approve_only']), ['autopilot', 'approve_only']);
  assert.deepEqual(withApproveOnly(null).map((action) => action.id), ['approve_only']);
});

test('a pending plan card shows "Approve plan"; a settled one shows what it was stored with', () => {
  const stored = [{ id: 'autopilot' }, { id: 'interactive' }, { id: 'exit_only' }];
  assert.equal(isPendingPlanBoard({ boardType: 'plan_ready', status: 'pending' }), true);
  assert.deepEqual(planBoardShownActions({ boardType: 'plan_ready', status: 'pending' }, stored).map((a) => a.id),
    ['approve_only', 'autopilot', 'interactive', 'exit_only']);
  assert.deepEqual(planBoardShownActions({ boardType: 'plan_ready', status: 'acted' }, stored), stored);
  assert.deepEqual(planBoardShownActions({ boardType: 'generic', status: 'pending' }, stored), stored);
});

test('the CLI\'s exit_plan_mode actions keep their order, and "Approve plan" is added', () => {
  assert.deepEqual(planBoardActionsFromCli(['autopilot', 'autopilot_fleet', { id: 'Interactive' }, 'exit_only', 'autopilot']), [
    { id: 'approve_only', label: 'Approve plan', mode: 'agent' },
    { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
    { id: 'autopilot_fleet', label: 'Implement with autopilot fleet', mode: 'autopilot' },
    { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
    { id: 'exit_only', label: 'Stop here', mode: 'agent' },
  ]);
  // Without any: the shared list.
  assert.deepEqual(planBoardActionsFromCli(undefined), PLAN_BOARD_ACTIONS.map((entry) => ({ ...entry })));
  // An id the table does not know keeps no mode: it only settles the card.
  assert.deepEqual(planBoardActionsFromCli([{ actionId: 'keep_planning' }]), [
    { id: 'approve_only', label: 'Approve plan', mode: 'agent' },
    { id: 'keep_planning', label: 'Keep Planning', mode: null },
  ]);
});
