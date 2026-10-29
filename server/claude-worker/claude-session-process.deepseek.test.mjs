import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTerminalFailurePayload } from '../routes/messages-routes.mjs';
import { relayErrorCtaActionsForCode } from '../public/app/relay-error-ctas.mjs';

import {
  waitFor,
  makeApiStub,
  scriptedTurn,
  resultMessage,
  assistantText,
  backgroundTasksMessage,
  taskNotificationMessage,
  taskNotificationReplay,
  baseMessage,
  makeRunner,
  settled,
} from './claude-session-test-harness.mjs';
import { createDeepSeekClaudeBackend } from '../deepseek-worker/deepseek-claude-backend.mjs';
import { estimateCost } from '../../shared/deepseek-pricing.mjs';

// The Claude runner with the DeepSeek backend (deepseek-worker/): what it
// hands the CLI, what it leaves out, and when it starts a fresh one.

const backend = createDeepSeekClaudeBackend({
  env: { DEEPSEEK_API_KEY: 'sk-test-7777777777777777', DEEPSEEK_CLAUDE_CONFIG_DIR: '/srv/oar/data/deepseek-claude' },
});

const deepseekMessage = Object.freeze({
  ...baseMessage,
  model: 'deepseek-flash',
  providerType: 'deepseek',
  providerModel: 'deepseek-flash',
});

function deepseekInit(sessionId, model = 'deepseek-flash[1m]') {
  return { type: 'system', subtype: 'init', session_id: sessionId, model };
}

function spawningStart() {
  const spawns = [];
  const startImpl = (params) => {
    const turn = scriptedTurn();
    turn.flagCalls = [];
    turn.models = [];
    turn.applyFlagSettings = async (settings) => { turn.flagCalls.push(settings); };
    turn.setModel = async (model) => { turn.models.push(model); };
    spawns.push({ params, turn });
    return turn;
  };
  return { spawns, startImpl };
}

const pushedReplay = (content) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } });

const totalPushes = (spawns) => spawns.reduce((sum, spawn) => sum + spawn.turn.pushed.length, 0);

async function answerTurn(runner, spawns, message, { init = false, result = null } = {}) {
  const before = totalPushes(spawns);
  const done = runner.handlePendingPayload({ message });
  await waitFor(() => totalPushes(spawns) > before, { label: `${message.id} pushed` });
  const { turn } = spawns[spawns.length - 1];
  if (init) turn.emit(deepseekInit('native-1'));
  // The CLI replays the message as it was pushed: with an attachment the
  // pushed content carries the image note, and a replay of the bare text
  // would not match the delivered message (it would open a continuation,
  // and the message would settle only after the stranded-delivery wait).
  turn.emit(pushedReplay(turn.pushed[turn.pushed.length - 1]));
  turn.emit(assistantText(`answer to ${message.id}`));
  turn.emit(result || resultMessage(`answer to ${message.id}`, 'native-1'));
  assert.equal(await done, true);
}

function routeCalls(stub, routePath) {
  return stub.calls.filter((call) => call.routePath === routePath);
}

test('a DeepSeek turn spawns the CLI with the backend, DeepSeek\'s model and default effort', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage }, { init: true });
  const { params } = spawns[0];
  assert.equal(params.backend, backend);
  assert.equal(params.model, 'deepseek-flash', 'the adapter adds the [1m] suffix itself');
  assert.equal(params.reasoningEffort, 'high');
  assert.equal(params.thinkingEnabled, true);
  // The reply names the relay's id, not the CLI's suffixed one.
  const response = routeCalls(stub, '/api/response')[0];
  assert.equal(response.body.model, 'deepseek-flash');
  // Nothing of Claude's account: no plan windows, no usage limit.
  assert.deepEqual(routeCalls(stub, '/api/claude-plan-usage'), []);
  assert.deepEqual(routeCalls(stub, '/api/claude-usage-limit'), []);
  // The session id is kept for resume, as for Claude.
  assert.equal(routeCalls(stub, '/api/claude-native-session')[0]?.body?.claudeNativeSessionId, 'native-1');
  spawns[0].turn.endInput();
  await settled(runner);
});

test('the cold-start line names the backend: Claude Code for DeepSeek, not the Claude CLI', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage }, { init: true });
  const activity = routeCalls(stub, '/api/activity').find((call) => /cold start/.test(call.body.text || ''));
  assert.equal(activity?.body?.text, 'Starting Claude Code for DeepSeek (cold start)…');
  spawns[0].turn.endInput();
  await settled(runner);
});

test('an effort change starts a fresh CLI on the same session; the same effort keeps it', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage, reasoningEffort: 'high' }, { init: true });
  // "medium" is DeepSeek's high: no respawn.
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-2', text: 'again', reasoningEffort: 'medium' });
  assert.equal(spawns.length, 1);

  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-3', text: 'quick one', reasoningEffort: 'low' }, { init: true });
  assert.equal(spawns.length, 2, 'one respawn');
  assert.ok(spawns[0].turn.endInputCalls > 0, 'the old CLI was released');
  assert.equal(spawns[1].params.resume, 'native-1');
  assert.equal(spawns[1].params.reasoningEffort, 'low');
  assert.equal(spawns[1].params.thinkingEnabled, true);
  // Nothing is sent live: no Claude effort or thinking flags.
  assert.deepEqual(spawns[0].turn.flagCalls.filter((flags) => 'effortLevel' in flags || 'alwaysThinkingEnabled' in flags), []);
  spawns[1].turn.endInput();
  await settled(runner);
});

test('every CLI of a DeepSeek session reports its start with its first init, the resumed one too', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  const before = Date.now();
  await answerTurn(runner, spawns, { ...deepseekMessage, reasoningEffort: 'high' }, { init: true });
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-2', text: 'quick one', reasoningEffort: 'low' }, { init: true });
  assert.equal(spawns.length, 2);
  // The relay records each start to find that CLI's shell snapshot on
  // delete: the session id is the same, so this is not a change of it.
  const starts = routeCalls(stub, '/api/claude-native-session').map((call) => call.body);
  assert.equal(starts.length, 2);
  for (const body of starts) {
    assert.equal(body.claudeNativeSessionId, 'native-1');
    assert.ok(body.cliStartedAt >= before && body.cliStartedAt <= Date.now(), String(body.cliStartedAt));
  }
  assert.ok(starts[1].cliStartedAt >= starts[0].cliStartedAt);
  spawns[1].turn.endInput();
  await settled(runner);
});

test('a model switch between turns starts a fresh CLI on the same session, pinned to the new model', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage }, { init: true });
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-2', text: 'harder', model: 'deepseek-v4-pro' }, { init: true });
  // The CLI reads the model behind "opus" and the rest at spawn: a live
  // setModel would leave the old pins, and a sub-agent on the old model.
  assert.equal(spawns.length, 2, 'one respawn');
  assert.ok(spawns[0].turn.endInputCalls > 0, 'the old CLI was released');
  assert.deepEqual(spawns[0].turn.models, [], 'no live switch on the old CLI');
  assert.equal(spawns[1].params.resume, 'native-1');
  assert.equal(spawns[1].params.model, 'deepseek-v4-pro', 'the adapter adds the [1m] suffix and the pins');
  // The same model spelled by the CLI keeps the process.
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-3', text: 'more', model: 'deepseek-v4-pro[1m]' });
  assert.equal(spawns.length, 2);
  spawns[1].turn.endInput();
  await settled(runner);
});

test('a sub-agent\'s badge names the DeepSeek model it runs on, never a Claude name', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  const message = { ...deepseekMessage, model: 'deepseek-v4-pro', providerModel: 'deepseek-v4-pro' };
  const done = runner.handlePendingPayload({ message });
  await waitFor(() => totalPushes(spawns) > 0, { label: 'pushed' });
  const { turn } = spawns[0];
  turn.emit(deepseekInit('native-1', 'deepseek-v4-pro[1m]'));
  // The Agent tool asked for "opus", "haiku" and nothing: with the pins,
  // "opus" and no model run on the session's model, "haiku" on the helper.
  turn.emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_use', id: 'toolu-opus', name: 'Agent', input: { model: 'opus', prompt: 'fix it' } },
        { type: 'tool_use', id: 'toolu-haiku', name: 'Agent', input: { model: 'haiku', prompt: 'look' } },
        { type: 'tool_use', id: 'toolu-plain', name: 'Agent', input: { prompt: 'read' } },
        { type: 'tool_use', id: 'toolu-old', name: 'Agent', input: { model: 'sonnet', prompt: 'old CLI' } },
      ],
    },
  });
  const tasks = [
    { task_id: 'agent-opus', task_type: 'local_agent', description: 'fix it' },
    { task_id: 'agent-haiku', task_type: 'local_agent', description: 'look' },
    { task_id: 'agent-plain', task_type: 'local_agent', description: 'read' },
    { task_id: 'agent-old', task_type: 'local_agent', description: 'old CLI' },
  ];
  turn.emit(backgroundTasksMessage(tasks));
  for (const [taskId, toolUseId] of [['agent-opus', 'toolu-opus'], ['agent-haiku', 'toolu-haiku'], ['agent-plain', 'toolu-plain'], ['agent-old', 'toolu-old']]) {
    turn.emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, task_type: 'local_agent', description: taskId });
  }
  // A CLI spawned before the pins names the Claude id in the sub-agent's
  // frames; DeepSeek served it with Flash.
  turn.emit({
    type: 'assistant',
    parent_tool_use_id: 'toolu-old',
    message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'on it' }] },
  });
  turn.emit(backgroundTasksMessage(tasks));
  turn.emit(resultMessage('spawned', 'native-1'));
  assert.equal(await done, true);

  const publish = await waitFor(() => stub.calls.findLast(
    (call) => call.routePath === '/api/background-tasks' && call.body.tasks?.length === 4 && call.body.tasks.every((task) => task.model),
  ), { label: 'task publish with models' });
  const byId = Object.fromEntries(publish.body.tasks.map((task) => [task.taskId, [task.model, task.modelInherited]]));
  assert.deepEqual(byId, {
    'agent-opus': ['deepseek-v4-pro', false],
    'agent-haiku': ['deepseek-flash', false],
    'agent-plain': ['deepseek-v4-pro', true],
    'agent-old': ['deepseek-flash', false],
  });
  turn.endInput();
  await settled(runner);
});

test('a sub-agent\'s usage under a Claude name is reported under the DeepSeek model that served it', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage }, {
    init: true,
    result: usageResult('q-1', {
      'deepseek-flash[1m]': flashUsage(12_000, 0, 800),
      'claude-sonnet-5-5': flashUsage(300, 0, 20),
      'claude-opus-5-5': flashUsage(4_000, 0, 100),
    }),
  });
  await waitFor(() => routeCalls(stub, '/api/deepseek-plan-usage').length === 1, { label: 'usage report' });
  const [report] = routeCalls(stub, '/api/deepseek-plan-usage').map((call) => call.body);
  assert.deepEqual(report.totals, [
    { model: 'deepseek-flash', hitTokens: 0, missTokens: 12_300, outputTokens: 820 },
    { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 4_000, outputTokens: 100 },
  ]);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a DeepSeek turn\'s tokens are booked under the models that served it, at DeepSeek\'s prices', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage }, {
    init: true,
    result: usageResult('q-1', {
      'deepseek-flash[1m]': flashUsage(12_000, 5_000, 800),
      'claude-sonnet-5-5': flashUsage(300, 0, 20),
      'claude-opus-5-5': flashUsage(4_000, 0, 100),
    }),
  });
  await waitFor(() => routeCalls(stub, '/api/turn-token-usage').length === 1, { label: 'token report' });
  const [report] = routeCalls(stub, '/api/turn-token-usage').map((call) => call.body);
  assert.equal(report.provider, 'deepseek');
  assert.equal(report.turnId, deepseekMessage.id);
  assert.match(report.runId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(report.models.map((entry) => [entry.model, entry.inputTokens, entry.cacheWriteTokens, entry.cacheReadTokens, entry.outputTokens]), [
    ['deepseek-flash', 12_300, 0, 5_000, 820],
    ['deepseek-v4-pro', 4_000, 0, 0, 100],
  ]);
  // Priced from DeepSeek's table, not Claude Code's figure at Claude's prices.
  for (const entry of report.models) {
    const expected = estimateCost({ model: entry.model, at: report.at, hitTokens: entry.cacheReadTokens, missTokens: entry.inputTokens, outputTokens: entry.outputTokens });
    assert.equal(entry.costSource, 'oar-deepseek-table');
    assert.ok(Math.abs(entry.costUsd - expected) < 1e-9, `${entry.model}: ${entry.costUsd} vs ${expected}`);
  }
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a DeepSeek turn priced from OAR\'s table is not "cost unknown", whatever Claude Code\'s cost basis says', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  // Claude Code has no price for DeepSeek's ids and says so.
  const unpriced = (input, output) => ({ ...flashUsage(input, 0, output), costUSD: 0, costBasis: 'unknown' });
  await answerTurn(runner, spawns, { ...deepseekMessage }, {
    init: true,
    result: usageResult('q-1', { 'deepseek-flash[1m]': unpriced(12_000, 800) }),
  });
  await waitFor(() => routeCalls(stub, '/api/turn-token-usage').length === 1, { label: 'token report' });
  const [entry] = routeCalls(stub, '/api/turn-token-usage')[0].body.models;
  assert.equal(entry.costSource, 'oar-deepseek-table');
  assert.ok(entry.costUsd > 0);
  assert.equal(entry.costUnknown, false);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a model without image input gets the image by its path, flash gets it embedded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-deepseek-image-'));
  const imagePath = path.join(dir, 'screen.png');
  fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  try {
    const attachments = [{ name: 'screen.png', type: 'image/png', path: imagePath }];
    for (const [model, embedded] of [['deepseek-v4-pro', false], ['deepseek-flash', true]]) {
      const stub = makeApiStub();
      const { spawns, startImpl } = spawningStart();
      const runner = makeRunner({ stub, startImpl, backend, defaultModel: model });
      await answerTurn(runner, spawns, { ...deepseekMessage, model, providerModel: model, attachments }, { init: true });
      const content = spawns[0].turn.pushed[0];
      assert.equal(content.some((block) => block.type === 'image'), embedded, model);
      const note = content.find((block) => block.type === 'text').text;
      assert.match(note, embedded ? /is embedded in this message/ : new RegExp(`Attached image "screen\\.png" \\(image/png\\): ${imagePath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`), model);
      spawns[0].turn.endInput();
      await settled(runner);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty DeepSeek balance fails the turn with DeepSeek\'s advice', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  const refused = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'API Error: 402 {"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
    api_error_status: 402,
    session_id: 'native-1',
    num_turns: 1,
    duration_api_ms: 100,
  };
  await answerTurn(runner, spawns, { ...deepseekMessage }, { init: true, result: refused });
  const response = routeCalls(stub, '/api/response')[0];
  assert.equal(response.body.terminalError.code, 'deepseek-balance');
  // Printed as relay.deepseek-balance, the code its buttons (top up,
  // settings) are keyed on; it used to be relay.claude-deepseek-balance.
  assert.equal(response.body.terminalError.stableCode, 'deepseek-balance');
  const resolved = resolveTerminalFailurePayload(response.body, { inferFromText: false });
  assert.equal(resolved.stableCode, 'relay.deepseek-balance');
  assert.deepEqual(relayErrorCtaActionsForCode(resolved.code).map((item) => item.action), ['open-deepseek-top-up', 'open-deepseek-settings']);
  assert.match(response.body.terminalError.guidance, /platform\.deepseek\.com\/top_up/);
  // Not Claude's usage limit, and no pause.
  assert.notEqual(response.body.terminalError.kind, 'usage-limit');
  spawns[0].turn.endInput();
  await settled(runner);
});

test('any other refused DeepSeek request is a DeepSeek failure, not a Claude one', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  // What DeepSeek answers to a server-side fetch tool it does not offer.
  const refused = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'API Error: 422 {"error":{"message":"unknown variant `web_fetch_20250910`, expected `web_search_20250305` or `web_search_20260209`"}}',
    api_error_status: 422,
    session_id: 'native-1',
    num_turns: 1,
    duration_api_ms: 100,
  };
  await answerTurn(runner, spawns, { ...deepseekMessage }, { init: true, result: refused });
  const failure = routeCalls(stub, '/api/response')[0].body.terminalError;
  assert.equal(failure.code, 'deepseek-api-error');
  assert.equal(resolveTerminalFailurePayload({ terminalError: failure }, { inferFromText: false }).stableCode, 'relay.deepseek-api-error');
  // No Claude account advice for a DeepSeek chat.
  assert.equal(failure.guidance ?? null, null);
  assert.doesNotMatch(JSON.stringify(failure), /claude-api-error|Claude account|Relogin/);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a CLI that refused the backend\'s live connection settings fails the turn with that note, not as a stop', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  const done = runner.handlePendingPayload({ message: { ...deepseekMessage } });
  await waitFor(() => totalPushes(spawns) > 0, { label: 'q-1 pushed' });
  const { params, turn } = spawns[0];
  // What the adapter does on a refusal (claude-sdk-adapter.mjs): it notes
  // the error on the turn and fails the prompt stream, and the SDK aborts.
  const refused = new Error('Claude Code did not take the DeepSeek connection settings before the first message, so nothing was sent.');
  refused.code = 'claude-live-flag-settings';
  turn.liveFlagSettingsError = refused;
  params.abortController.abort(refused);
  turn.fail(new Error('Claude Code process aborted by user'));
  await done;
  await settled(runner);
  const responses = routeCalls(stub, '/api/response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].body.terminalError?.code, 'claude-live-flag-settings');
  assert.match(responses[0].body.text, /nothing was sent/);
  assert.match(responses[0].body.terminalError.guidance, /update the relay/);
  assert.doesNotMatch(JSON.stringify(stub.calls), /sk-test-7777777777777777/);
});

function usageResult(id, modelUsage, usage = null) {
  return { ...resultMessage(`answer to ${id}`, 'native-1'), modelUsage, ...(usage ? { usage } : {}), total_cost_usd: 4.2 };
}

function flashUsage(input, cacheRead, output) {
  // What Claude Code reports: its running totals, at Claude's prices.
  return { inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: 0, outputTokens: output, costUSD: 3.1, contextWindow: 1_048_576 };
}

test('every DeepSeek turn posts the process\'s totals per model with its session id and the time', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  const before = Date.now();
  await answerTurn(runner, spawns, { ...deepseekMessage }, {
    init: true,
    result: usageResult('q-1', { 'deepseek-flash[1m]': flashUsage(12_000, 0, 800), 'deepseek-flash': flashUsage(300, 0, 20) }),
  });
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-2', text: 'again' }, {
    result: usageResult('q-2', { 'deepseek-flash[1m]': flashUsage(13_000, 11_500, 1_100), 'deepseek-flash': flashUsage(300, 0, 20) }),
  });
  await waitFor(() => routeCalls(stub, '/api/deepseek-plan-usage').length === 2, { label: 'two usage reports' });
  const [first, second] = routeCalls(stub, '/api/deepseek-plan-usage').map((call) => call.body);
  assert.equal(first.conversationId, deepseekMessage.conversationId);
  assert.equal(first.claudeNativeSessionId, 'native-1');
  // A fresh process: the CLI's running totals are its own, and the relay
  // books what each report adds under the run id.
  assert.deepEqual(first.totals, [{ model: 'deepseek-flash', hitTokens: 0, missTokens: 12_300, outputTokens: 820 }]);
  assert.deepEqual(second.totals, [{ model: 'deepseek-flash', hitTokens: 11_500, missTokens: 13_300, outputTokens: 1_120 }]);
  // Both turns ran in one CLI process, named by one run id.
  assert.match(first.runId, /^[0-9a-f-]{36}$/);
  assert.equal(second.runId, first.runId);
  const at = Date.parse(first.at);
  assert.ok(at >= before && at <= Date.now(), 'the turn\'s time');
  // Claude's cost figure goes nowhere: the relay estimates from the tokens.
  assert.equal(JSON.stringify(first).includes('costUSD'), false);
  assert.deepEqual(routeCalls(stub, '/api/claude-plan-usage'), []);
  // The context panel still gets the CLI's model usage.
  assert.ok(routeCalls(stub, '/api/claude-context-usage').length >= 1);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a respawned CLI reports its own totals from zero under the same session id: its first turn\'s usage, then what the session totals grow by', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash' });
  await answerTurn(runner, spawns, { ...deepseekMessage, reasoningEffort: 'high' }, {
    init: true,
    result: usageResult('q-1', { 'deepseek-flash[1m]': flashUsage(5_000, 0, 400) }),
  });
  // An effort change respawns the CLI with resume. Its first result carries
  // the session's restored totals (here an older snapshot than the relay
  // booked: the first process died before it wrote its cost state) plus the
  // turn; only the turn's own usage is reported.
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-2', text: 'quick', reasoningEffort: 'low' }, {
    init: true,
    result: usageResult('q-2', { 'deepseek-flash[1m]': flashUsage(4_700, 4_800, 390) }, { input_tokens: 700, cache_read_input_tokens: 4_800, cache_creation_input_tokens: 0, output_tokens: 90 }),
  });
  // The next turn in that process adds what the session totals grew by.
  await answerTurn(runner, spawns, { ...deepseekMessage, id: 'q-3', text: 'more', reasoningEffort: 'low' }, {
    result: usageResult('q-3', { 'deepseek-flash[1m]': flashUsage(4_900, 9_000, 420) }, { input_tokens: 200, cache_read_input_tokens: 4_200, cache_creation_input_tokens: 0, output_tokens: 30 }),
  });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].params.resume, 'native-1');
  await waitFor(() => routeCalls(stub, '/api/deepseek-plan-usage').length === 3, { label: 'three usage reports' });
  const reports = routeCalls(stub, '/api/deepseek-plan-usage').map((call) => [call.body.claudeNativeSessionId, call.body.totals]);
  assert.deepEqual(reports, [
    ['native-1', [{ model: 'deepseek-flash', hitTokens: 0, missTokens: 5_000, outputTokens: 400 }]],
    ['native-1', [{ model: 'deepseek-flash', hitTokens: 4_800, missTokens: 700, outputTokens: 90 }]],
    ['native-1', [{ model: 'deepseek-flash', hitTokens: 9_000, missTokens: 900, outputTokens: 120 }]],
  ]);
  // The new process reports under its own run id, for both of its turns.
  const runIds = routeCalls(stub, '/api/deepseek-plan-usage').map((call) => call.body.runId);
  assert.ok(runIds.every((runId) => /^[0-9a-f-]{36}$/.test(runId)));
  assert.notEqual(runIds[0], runIds[1]);
  assert.equal(runIds[2], runIds[1]);
  spawns[1].turn.endInput();
  await settled(runner);
});

test('a continuation that finishes after its CLI died reports under that process, and leaves the next process\'s count alone', async () => {
  // A background agent's continuation ends while its row is still being
  // registered; a delivered message's replay then detaches it (its answer
  // waits for the registration), the CLI dies, and a new one is spawned for
  // the next message. The late report names the process the turn ran in.
  let releaseRegistration = null;
  const stub = makeApiStub({
    routeResponses: {
      '/api/continuation-turn': () => new Promise((resolve) => {
        releaseRegistration = () => resolve({ messageId: 'cont-1', attemptId: 'attempt-cont-1' });
      }),
    },
  });
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'deepseek-flash', continuationRegistrationWaitMs: 20 });
  const first = runner.handlePendingPayload({ message: { ...deepseekMessage } });
  await waitFor(() => totalPushes(spawns) === 1, { label: 'q-1 pushed' });
  const turnA = spawns[0].turn;
  turnA.emit(deepseekInit('native-1'));
  turnA.emit(pushedReplay(turnA.pushed[0]));
  turnA.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turnA.emit(usageResult('q-1', { 'deepseek-flash[1m]': flashUsage(5_000, 0, 400) }));
  assert.equal(await first, true);
  await waitFor(() => routeCalls(stub, '/api/deepseek-plan-usage').length === 1, { label: 'q-1 reported' });
  // The agent settles; the continuation's turn ends with its row registering.
  turnA.emit(backgroundTasksMessage([]));
  turnA.emit(taskNotificationMessage('agent-1'));
  turnA.emit(taskNotificationReplay());
  turnA.emit(assistantText('the agent is done'));
  turnA.emit({ ...resultMessage('the agent is done', 'native-1'), modelUsage: { 'deepseek-flash[1m]': flashUsage(5_600, 4_000, 450) }, total_cost_usd: 4.2 });
  await waitFor(() => releaseRegistration && runner._getProcess().activeCtx?.resultBuffered, { label: 'continuation finished, still registering' });
  // The next message's replay opens its own turn over the finished
  // continuation, and the CLI dies in that turn.
  const second = runner.handlePendingPayload({ message: { ...deepseekMessage, id: 'q-2', text: 'status?' } });
  await waitFor(() => totalPushes(spawns) === 2, { label: 'q-2 pushed' });
  turnA.emit(pushedReplay(turnA.pushed[1]));
  await waitFor(() => runner._getProcess().activeCtx?.message?.id === 'q-2', { label: 'q-2 attached' });
  turnA.endInput();
  await second;
  await settled(runner);
  // Process B starts for the next message, resumed on the session; its row
  // is pushed and the CLI is up when the continuation's registration lands.
  const third = runner.handlePendingPayload({ message: { ...deepseekMessage, id: 'q-3', text: 'more' } });
  await waitFor(() => spawns.length === 2 && totalPushes(spawns) === 3, { label: 'q-3 pushed' });
  const turnB = spawns[1].turn;
  assert.equal(spawns[1].params.resume, 'native-1');
  turnB.emit(deepseekInit('native-1'));
  releaseRegistration();
  await waitFor(() => routeCalls(stub, '/api/deepseek-plan-usage').length === 2, { label: 'the continuation reported' });
  turnB.emit(pushedReplay(turnB.pushed[0]));
  turnB.emit(assistantText('answer to q-3'));
  turnB.emit(usageResult('q-3', { 'deepseek-flash[1m]': flashUsage(5_800, 9_000, 500) }, { input_tokens: 200, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_tokens: 50 }));
  assert.equal(await third, true);
  await waitFor(() => routeCalls(stub, '/api/deepseek-plan-usage').length === 3, { label: 'three usage reports' });
  const reports = routeCalls(stub, '/api/deepseek-plan-usage').map((call) => call.body);
  // The continuation's report is process A's, running on from its first
  // turn; B's first report is its own turn's usage, as if nothing had come
  // in between.
  assert.deepEqual(reports.map((body) => body.totals), [
    [{ model: 'deepseek-flash', hitTokens: 0, missTokens: 5_000, outputTokens: 400 }],
    [{ model: 'deepseek-flash', hitTokens: 4_000, missTokens: 5_600, outputTokens: 450 }],
    [{ model: 'deepseek-flash', hitTokens: 9_000, missTokens: 200, outputTokens: 50 }],
  ]);
  assert.ok(reports.every((body) => /^[0-9a-f-]{36}$/.test(body.runId)));
  assert.equal(reports[1].runId, reports[0].runId, 'the late report names the process the turn ran in');
  assert.notEqual(reports[2].runId, reports[0].runId);
  // The continuation's answer went out on its own row.
  const continuationResponse = routeCalls(stub, '/api/response').find((call) => call.body.messageId === 'cont-1');
  assert.equal(continuationResponse?.body?.text, 'the agent is done');
  turnB.endInput();
  await settled(runner);
});

test('a Claude turn posts no DeepSeek usage and keeps its plan usage', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl });
  await answerTurn(runner, spawns, { ...baseMessage }, {
    result: usageResult('q-1', { 'claude-sonnet-5': { inputTokens: 900, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } }),
  });
  await waitFor(() => routeCalls(stub, '/api/claude-plan-usage').length === 1, { label: 'claude plan usage' });
  assert.deepEqual(routeCalls(stub, '/api/deepseek-plan-usage'), []);
  // Its tokens are booked under the subscription, with Claude Code's cost.
  await waitFor(() => routeCalls(stub, '/api/turn-token-usage').length === 1, { label: 'token report' });
  const [tokens] = routeCalls(stub, '/api/turn-token-usage').map((call) => call.body);
  assert.equal(tokens.provider, 'claude');
  assert.deepEqual(tokens.models, [{
    model: 'claude-sonnet-5', inputTokens: 900, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 60, costUsd: 0.01, costSource: 'claude-code', costUnknown: false,
  }]);
  assert.equal(spawns[0].params.backend ?? null, null);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('the context report names the relay\'s model id, without the CLI\'s [1m]', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({
    stub,
    startImpl,
    backend,
    defaultModel: 'deepseek-flash',
    readContextUsageImpl: async () => ({ model: 'deepseek-flash[1m]', totalTokens: 1200, maxTokens: 1048576 }),
  });
  await answerTurn(runner, spawns, { ...deepseekMessage }, { init: true });
  const posted = routeCalls(stub, '/api/claude-context-usage')[0];
  assert.equal(posted.body.model, 'deepseek-flash');
  assert.equal(posted.body.contextUsage.model, 'deepseek-flash');
  assert.equal(posted.body.contextUsage.totalTokens, 1200);
  spawns[0].turn.endInput();
  await settled(runner);
});
