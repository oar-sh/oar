import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_BOARD_ACTIONS,
  buildCopilotPlanReadyBoardPayload,
  planTextFromExitRequest,
  shouldPostPlanBoard,
} from './copilot-plan-board.mjs';

const message = { id: 'q-1', conversationId: 'conv-1', relayMode: 'plan' };

test('the board payload matches the contract every other worker posts', () => {
  // The UI renders whatever `actions` the board carries and the relay maps
  // those ids onto relay modes; diverging here would give Copilot plan cards
  // buttons that behave differently from every other provider's.
  const payload = buildCopilotPlanReadyBoardPayload({ message, planText: '- step one\n- step two' });

  assert.equal(payload.boardType, 'plan_ready');
  assert.equal(payload.title, 'Plan ready for review');
  assert.equal(payload.body, '- step one\n- step two');
  assert.equal(payload.recommendedAction, null);
  assert.equal(payload.queueId, 'q-1');
  assert.equal(payload.messageId, 'q-1');
  assert.equal(payload.conversationId, 'conv-1');
  assert.equal(payload.mode, 'plan');
  assert.deepEqual(payload.actions, [
    { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
    { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
    { id: 'exit_only', label: 'Stop here', mode: 'agent' },
  ]);
  assert.equal(payload.context.source, 'plan-mode-fallback');
  assert.equal(payload.context.queueMessageId, 'q-1');
});

test('the autopilot handoff action is present, since that is the point of the board', () => {
  const autopilot = PLAN_BOARD_ACTIONS.find((action) => action.id === 'autopilot');
  assert.equal(autopilot.mode, 'autopilot');
});

test('an empty plan posts nothing at all', () => {
  assert.equal(buildCopilotPlanReadyBoardPayload({ message, planText: '   ' }), null);
  assert.equal(buildCopilotPlanReadyBoardPayload({ message }), null);
});

test('the fallback fires on plan-shaped text in plan and ask modes only', () => {
  const plan = '- research the schema\n- write the migration';

  assert.equal(shouldPostPlanBoard({ relayMode: 'plan', finalText: plan }), true);
  // One mode wider than the Cursor worker: ask mode is read-only and routes its
  // tool approvals to the user, so a plan there is in exactly the position the
  // handoff buttons exist for — described but not started.
  assert.equal(shouldPostPlanBoard({ relayMode: 'ask', finalText: plan }), true);

  assert.equal(shouldPostPlanBoard({ relayMode: 'agent', finalText: plan }), false);
  assert.equal(shouldPostPlanBoard({ relayMode: 'autopilot', finalText: plan }), false);
});

test('prose is not a plan: two list-ish lines are required', () => {
  assert.equal(shouldPostPlanBoard({ relayMode: 'plan', finalText: 'I would rewrite the parser.' }), false);
  assert.equal(shouldPostPlanBoard({ relayMode: 'plan', finalText: '- only one step' }), false);
  assert.equal(shouldPostPlanBoard({ relayMode: 'plan', finalText: '1. first\n2. second' }), true);
  assert.equal(shouldPostPlanBoard({ relayMode: 'plan', finalText: '* a\n* b' }), true);
});

test('a board already posted by the exit-plan hook is not posted twice', () => {
  assert.equal(shouldPostPlanBoard({
    relayMode: 'plan',
    finalText: '- a\n- b',
    alreadyPosted: true,
  }), false);
});

test('the exit-plan request prefers the full plan over the summary', () => {
  assert.equal(
    planTextFromExitRequest({ summary: 'short', planContent: 'the full plan' }),
    'the full plan',
  );
  assert.equal(planTextFromExitRequest({ summary: 'short' }), 'short');
  assert.equal(planTextFromExitRequest({}), '');
});

test('ask mode offers no handoff for work that was already done', () => {
  // The board's precondition is "described but not started". Plan mode
  // guarantees that (mutating tools are denied); ask mode does not, because the
  // user can approve a tool. Offering "Implement in autopilot" for finished
  // work would be worse than offering nothing.
  const summary = '- fixed the parser\n- added a regression test';

  assert.equal(shouldPostPlanBoard({ relayMode: 'ask', finalText: summary, acted: false }), true);
  assert.equal(shouldPostPlanBoard({ relayMode: 'ask', finalText: summary, acted: true }), false);

  // Plan mode is unaffected: nothing mutating can have been approved there.
  assert.equal(shouldPostPlanBoard({ relayMode: 'plan', finalText: summary, acted: true }), true);
});
