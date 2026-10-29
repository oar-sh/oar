import test from 'node:test';
import assert from 'node:assert/strict';

import * as mirror from './plan-board-shared.mjs';
import * as shared from '../../../shared/plan-board-actions.mjs';

test('the browser mirror matches shared/plan-board-actions.mjs', () => {
  assert.deepEqual([...mirror.PLAN_BOARD_LEAVES_PLAN], [...shared.PLAN_BOARD_LEAVES_PLAN]);
  assert.deepEqual({ ...mirror.PLAN_BOARD_LABELS }, { ...shared.PLAN_BOARD_LABELS });
  for (const id of ['approve_only', 'autopilot', 'autopilot_fleet', 'interactive', 'exit_only', 'keep_planning', '', 'constructor']) {
    assert.equal(mirror.planBoardActionLabel(id), shared.planBoardActionLabel(id), id);
  }
});

test('on a plan-only session only the actions that leave plan mode ask first', () => {
  for (const actionId of ['autopilot', 'autopilot_fleet', 'interactive']) {
    assert.match(mirror.planBoardConfirmText({ planOnly: true, actionId }), /^This session is plan-only\. .+ leaves plan mode\. Go on\?$/);
    assert.equal(mirror.planBoardConfirmText({ planOnly: false, actionId }), '');
  }
  assert.equal(
    mirror.planBoardConfirmText({ planOnly: true, actionId: 'autopilot', label: 'Implement in autopilot' }),
    'This session is plan-only. Implement in autopilot leaves plan mode. Go on?',
  );
  for (const actionId of ['approve_only', 'exit_only', 'keep_planning', '']) {
    assert.equal(mirror.planBoardConfirmText({ planOnly: true, actionId }), '', actionId);
  }
});

test('the mode select\'s hint, and a broadcast without the flag keeps the known one', () => {
  assert.deepEqual(mirror.planOnlyModeHint(true), { title: 'Mode · plan-only: agents can\'t take this session out of plan mode', planLabel: 'Plan 🔒' });
  assert.deepEqual(mirror.planOnlyModeHint(false), { title: 'Mode', planLabel: 'Plan' });
  assert.equal(mirror.planOnlyAfterBroadcast(undefined, true), true);
  assert.equal(mirror.planOnlyAfterBroadcast(null, true), true);
  assert.equal(mirror.planOnlyAfterBroadcast(false, true), false);
  assert.equal(mirror.planOnlyAfterBroadcast(true, false), true);
  assert.equal(mirror.planOnlyAfterBroadcast(undefined, undefined), false);
});