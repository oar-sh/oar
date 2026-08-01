import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuestionRoutingHooks } from './question-routing-hooks.mjs';

function makeHooks({ calls }) {
  return createQuestionRoutingHooks({
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      return { ok: true };
    },
    dbg: () => {},
    forwardRelayQuestion: async () => ({ answer: 'ok', timedOut: false }),
    isAskUserTool: () => false,
    normalizeActivityText: (value) => String(value || '').trim(),
    formatToolActivity: () => 'Tool (bash): npm test',
    formatToolResultActivity: () => 'Tool (bash) result: ok',
    extractQuestionChoices: () => [],
    getRelayTurnActive: () => true,
    getActiveMessage: () => ({ id: 'msg-1', conversationId: 'conv-1', relayMode: 'agent' }),
    setLastAskUserBridge: () => {},
    getLastActivityText: () => '',
    setLastActivityText: () => {},
    setPendingAskUserRequest: () => {},
  });
}

test('onPreToolUse attaches subagentRunId from the request agentId', async () => {
  const calls = [];
  const hooks = makeHooks({ calls });
  await hooks.onPreToolUse({ agentId: 'agent-42', toolName: 'bash' });
  const activity = calls.find((call) => call.routePath === '/api/activity');
  assert.ok(activity, 'expected an activity post');
  assert.equal(activity.body.subagentRunId, 'agent-42');
});

test('onPreToolUse leaves subagentRunId unset for main-thread tools', async () => {
  const calls = [];
  const hooks = makeHooks({ calls });
  await hooks.onPreToolUse({ toolName: 'bash' });
  const activity = calls.find((call) => call.routePath === '/api/activity');
  assert.ok(activity);
  assert.equal(activity.body.subagentRunId, undefined);
});

test('onPostToolUse attaches subagentRunId from the request agentId', async () => {
  const calls = [];
  const hooks = makeHooks({ calls });
  await hooks.onPostToolUse({ agentId: 'agent-42', toolName: 'bash' }, { ok: true });
  const activity = calls.find((call) => call.routePath === '/api/activity');
  assert.ok(activity);
  assert.equal(activity.body.subagentRunId, 'agent-42');
});
