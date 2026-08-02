import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCanUseTool,
  normalizeClaudeEffort,
  permissionModeForRelayMode,
  startClaudeTurn,
  systemPromptForRelayMode,
} from './claude-sdk-adapter.mjs';

test('relay modes map to SDK permission modes', () => {
  assert.equal(permissionModeForRelayMode('plan'), 'plan');
  assert.equal(permissionModeForRelayMode('ask'), 'default');
  assert.equal(permissionModeForRelayMode('agent'), 'default');
  assert.equal(permissionModeForRelayMode('autopilot'), 'default');
  assert.equal(permissionModeForRelayMode(''), 'default');
});

test('ask and autopilot get a system prompt append; plan and agent do not', () => {
  assert.ok(systemPromptForRelayMode('ask').append);
  assert.ok(systemPromptForRelayMode('autopilot').append);
  assert.equal(systemPromptForRelayMode('plan').append, undefined);
  assert.equal(systemPromptForRelayMode('agent').append, undefined);
  assert.equal(systemPromptForRelayMode('agent').preset, 'claude_code');
});

test('startClaudeTurn builds streaming-input query options', async () => {
  let captured = null;
  const queryImpl = (params) => {
    captured = params;
    return { async* [Symbol.asyncIterator]() {} };
  };
  const abortController = new AbortController();
  const turn = startClaudeTurn({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    model: 'claude-sonnet-5',
    resume: 'sess-1',
    relayMode: 'plan',
    abortController,
    canUseTool: async () => ({ behavior: 'allow' }),
    queryImpl,
  });
  assert.ok(captured);
  assert.equal(typeof captured.prompt[Symbol.asyncIterator], 'function');
  assert.equal(captured.options.cwd, '/workspace');
  assert.equal(captured.options.model, 'claude-sonnet-5');
  assert.equal(captured.options.resume, 'sess-1');
  assert.equal(captured.options.permissionMode, 'plan');
  assert.equal(captured.options.includePartialMessages, true);
  assert.equal(captured.options.forwardSubagentText, true);
  assert.equal(captured.options.abortController, abortController);
  assert.equal(typeof captured.options.canUseTool, 'function');

  // The prompt stream yields exactly one user message with the given content,
  // then stays open (gated) until endInput releases it.
  assert.equal(typeof turn.endInput, 'function');
  const messages = [];
  const drained = (async () => {
    for await (const message of captured.prompt) messages.push(message);
  })();
  turn.endInput();
  await drained;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'user');
  assert.deepEqual(messages[0].message.content, [{ type: 'text', text: 'hi' }]);
});

test('startClaudeTurn omits model for auto and resume when empty', () => {
  let captured = null;
  startClaudeTurn({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    model: 'auto',
    resume: '',
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal('model' in captured.options, false);
  assert.equal('resume' in captured.options, false);
});

test('canUseTool bridges AskUserQuestion answers into updatedInput', async () => {
  const canUseTool = createCanUseTool({
    askUserBridge: {
      handleAskUserQuestion: async (input) => ({ answers: { 'Q?': 'A' }, timedOut: false }),
    },
  });
  const input = { questions: [{ question: 'Q?' }] };
  const result = await canUseTool('AskUserQuestion', input, { signal: null });
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, { 'Q?': 'A' });
  assert.deepEqual(result.updatedInput.questions, input.questions);
});

test('canUseTool posts plan board on ExitPlanMode and allows', async () => {
  let planInput = null;
  const canUseTool = createCanUseTool({
    onExitPlanMode: async (input) => { planInput = input; },
  });
  const result = await canUseTool('ExitPlanMode', { plan: '1. do\n2. done' }, {});
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(planInput, { plan: '1. do\n2. done' });
});

test('canUseTool allows every other tool (allow-all parity)', async () => {
  const canUseTool = createCanUseTool({});
  for (const toolName of ['Bash', 'Edit', 'Write', 'WebFetch']) {
    const result = await canUseTool(toolName, { any: true }, {});
    assert.equal(result.behavior, 'allow');
  }
});

test('canUseTool denies when the bridge fails', async () => {
  const canUseTool = createCanUseTool({
    askUserBridge: {
      handleAskUserQuestion: async () => { throw new Error('relay down'); },
    },
  });
  const result = await canUseTool('AskUserQuestion', { questions: [] }, {});
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /relay down/);
});

test('reasoning effort maps onto the SDK effort option per turn', () => {
  let captured = null;
  const queryImpl = (params) => { captured = params; return {}; };
  startClaudeTurn({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    reasoningEffort: 'xhigh',
    queryImpl,
  });
  assert.equal(captured.options.effort, 'xhigh');
});

test('none/invalid reasoning effort omits the effort option (SDK default)', () => {
  for (const value of ['none', '', 'auto', 'bogus']) {
    let captured = null;
    startClaudeTurn({
      content: [{ type: 'text', text: 'hi' }],
      cwd: '/workspace',
      reasoningEffort: value,
      queryImpl: (params) => { captured = params; return {}; },
    });
    assert.equal('effort' in captured.options, false, `effort should be omitted for "${value}"`);
  }
});

test('normalizeClaudeEffort accepts exactly the SDK effort ladder', () => {
  for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeClaudeEffort(value), value);
    assert.equal(normalizeClaudeEffort(value.toUpperCase()), value);
  }
  assert.equal(normalizeClaudeEffort('none'), '');
  assert.equal(normalizeClaudeEffort('extreme'), '');
});
