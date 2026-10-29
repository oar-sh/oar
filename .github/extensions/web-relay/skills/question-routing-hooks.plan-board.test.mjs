import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuestionRoutingHooks } from './question-routing-hooks.mjs';

function makeHooks({ calls, relayMode = 'plan' }) {
  return createQuestionRoutingHooks({
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      return { ok: true };
    },
    dbg: () => {},
    forwardRelayQuestion: async () => ({ answer: 'ok', timedOut: false }),
    isAskUserTool: () => false,
    normalizeActivityText: (value) => String(value || '').trim(),
    formatToolActivity: () => '',
    formatToolResultActivity: () => '',
    extractQuestionChoices: () => [],
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({ id: 'msg-1', conversationId: 'conv-1', relayMode }),
    setLastAskUserBridge: () => {},
    getLastActivityText: () => '',
    setLastActivityText: () => {},
    setPendingAskUserRequest: () => {},
  });
}

const boardOf = (calls) => calls.find((call) => call.routePath === '/api/relay-board')?.body || null;

test('the Copilot CLI\'s own actions keep their order and recommendation, and "Approve plan" is added', async () => {
  const calls = [];
  await makeHooks({ calls }).onPreToolUse({
    toolName: 'exit_plan_mode',
    toolArgs: { summary: '- a\n- b', actions: ['autopilot_fleet', 'interactive', 'exit_only'], recommendedAction: 'autopilot_fleet' },
  });
  const board = boardOf(calls);
  assert.ok(board, 'a card is posted');
  assert.deepEqual(board.actions.map((action) => action.id), ['approve_only', 'autopilot_fleet', 'interactive', 'exit_only']);
  assert.deepEqual(board.actions.map((action) => action.label), ['Approve plan', 'Implement with autopilot fleet', 'Stop here and prompt myself', 'Stop here']);
  // The relay overrides this on a plan-only session; the extension passes the CLI's.
  assert.equal(board.recommendedAction, 'autopilot_fleet');
});

test('exit_plan_mode posts a card in any relay mode, the approve_only agent turn included', async () => {
  const calls = [];
  await makeHooks({ calls, relayMode: 'agent' }).onPreToolUse({
    toolName: 'exit_plan_mode',
    toolArgs: { summary: '- a\n- b' },
  });
  const board = boardOf(calls);
  assert.ok(board);
  assert.equal(board.mode, 'agent');
  assert.deepEqual(board.actions.map((action) => action.id), ['approve_only', 'autopilot', 'interactive', 'exit_only']);
});

test('an action id the relay does not know keeps no mode', async () => {
  const calls = [];
  await makeHooks({ calls }).onPreToolUse({
    toolName: 'exit_plan_mode',
    toolArgs: { summary: '- a\n- b', actions: [{ id: 'keep_planning' }] },
  });
  const custom = boardOf(calls).actions.find((action) => action.id === 'keep_planning');
  assert.equal(custom.mode, null);
  assert.equal(custom.prompt, undefined);
});
