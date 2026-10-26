import test from 'node:test';
import assert from 'node:assert/strict';

import {
  waitFor,
  makeApiStub,
  scriptedTurn,
  resultMessage,
  assistantText,
  baseMessage,
  makeRunner,
  settled,
} from './claude-session-test-harness.mjs';
import { createClaudeApiClaudeBackend } from '../claude-api-worker/claude-api-backend.mjs';

// The Claude runner with the Claude API backend (claude-api-worker/): the
// chat behaves as a Claude chat (model, effort, thinking, live switches),
// reports nothing of a Claude account, and stops on an init whose key
// source is not the saved key.

const backend = createClaudeApiClaudeBackend({
  env: { OAR_CLAUDE_API_KEY: 'sk-ant-api03-test-0000' },
});

function apiInit(sessionId, apiKeySource = 'ANTHROPIC_API_KEY') {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5', apiKeySource };
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

async function answerTurn(runner, spawns, message, { init = false, apiKeySource = 'ANTHROPIC_API_KEY' } = {}) {
  const before = totalPushes(spawns);
  const done = runner.handlePendingPayload({ message });
  await waitFor(() => totalPushes(spawns) > before, { label: `${message.id} pushed` });
  const { turn } = spawns[spawns.length - 1];
  if (init) turn.emit(apiInit('native-1', apiKeySource));
  turn.emit(pushedReplay(turn.pushed[turn.pushed.length - 1]));
  turn.emit(assistantText(`answer to ${message.id}`));
  turn.emit(resultMessage(`answer to ${message.id}`, 'native-1'));
  assert.equal(await done, true);
}

function routeCalls(stub, routePath) {
  return stub.calls.filter((call) => call.routePath === routePath);
}

test('a Claude API turn spawns the CLI with the backend and the same model, effort and thinking as a Claude turn', async () => {
  const runs = [];
  for (const withBackend of [false, true]) {
    const stub = makeApiStub();
    const { spawns, startImpl } = spawningStart();
    const runner = makeRunner({
      stub, startImpl, defaultModel: 'claude-sonnet-5', ...(withBackend ? { backend } : {}),
    });
    // A subscription turn comes up on the login: on a key it would be stopped.
    await answerTurn(runner, spawns, { ...baseMessage, reasoningEffort: 'medium' }, { init: true, apiKeySource: withBackend ? 'ANTHROPIC_API_KEY' : 'none' });
    runs.push({ stub, params: spawns[0].params });
    spawns[0].turn.endInput();
    await settled(runner);
  }
  const [plain, api] = runs;
  assert.equal(api.params.backend, backend);
  assert.equal(plain.params.backend, null);
  for (const key of ['model', 'reasoningEffort', 'thinkingEnabled', 'thinkingDisplay', 'relayMode', 'resume']) {
    assert.deepEqual(api.params[key], plain.params[key], key);
  }
  assert.equal(api.params.model, 'claude-sonnet-5');
  assert.equal(api.params.reasoningEffort, 'medium');
  assert.equal(routeCalls(api.stub, '/api/response')[0]?.body?.model, routeCalls(plain.stub, '/api/response')[0]?.body?.model);
  // Nothing of a Claude account: no plan windows, no usage limit.
  assert.deepEqual(routeCalls(api.stub, '/api/claude-plan-usage'), []);
  assert.deepEqual(routeCalls(api.stub, '/api/claude-usage-limit'), []);
  // The session id is kept for resume, as for Claude.
  assert.equal(routeCalls(api.stub, '/api/claude-native-session')[0]?.body?.claudeNativeSessionId, 'native-1');
});

test('an effort or model change on a Claude API chat is applied live, as on a Claude chat: no fresh CLI', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'claude-sonnet-5' });
  await answerTurn(runner, spawns, { ...baseMessage, reasoningEffort: 'high' }, { init: true });
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-2', text: 'quick one', reasoningEffort: 'low' });
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-3', text: 'harder', model: 'claude-opus-5' });
  assert.equal(spawns.length, 1, 'no respawn');
  assert.ok(spawns[0].turn.flagCalls.some((flags) => flags.effortLevel === 'low'), 'the effort went live');
  assert.deepEqual(spawns[0].turn.models, ['claude-opus-5']);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('the cold-start line names the Claude API', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'claude-sonnet-5' });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });
  const activity = routeCalls(stub, '/api/activity').find((call) => /cold start/.test(call.body.text || ''));
  assert.equal(activity?.body?.text, 'Starting Claude Code for Claude API (cold start)…');
  spawns[0].turn.endInput();
  await settled(runner);
});

test('an init with another key source ends the turn with a note naming the source, and stops the CLI', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'claude-sonnet-5' });
  const done = runner.handlePendingPayload({ message: { ...baseMessage } });
  await waitFor(() => totalPushes(spawns) > 0, { label: 'q-1 pushed' });
  const { turn } = spawns[0];
  turn.emit(apiInit('native-1', 'apiKeyHelper'));
  // Anything after the init is never read.
  turn.emit(assistantText('should not be published'));
  await done;
  await settled(runner);
  const responses = routeCalls(stub, '/api/response');
  assert.equal(responses.length, 1);
  const body = responses[0].body;
  assert.equal(body.terminalError?.code, 'claude-api-key-source');
  assert.equal(body.terminalError?.stableCode, 'claude-api-key-source');
  assert.match(body.text, /"apiKeyHelper"/);
  assert.match(body.text, /Settings → Providers → Claude API/);
  assert.doesNotMatch(body.text, /At most one request/);
  assert.doesNotMatch(JSON.stringify(stub.calls), /sk-ant-api03-test-0000/);
  assert.doesNotMatch(JSON.stringify(stub.calls), /should not be published/);
  assert.equal(spawns[0].params.abortController.signal.aborted, true, 'the CLI was stopped');
  assert.equal(turn.endInputCalls > 0, true);
});

test('a re-init with another key source after the API answered says one request may have gone out', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'claude-sonnet-5' });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });
  const done = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'again' } });
  await waitFor(() => totalPushes(spawns) > 1, { label: 'q-2 pushed' });
  const { turn } = spawns[0];
  turn.emit(pushedReplay(turn.pushed[1]));
  turn.emit(assistantText('partial'));
  turn.emit(apiInit('native-1', 'none'));
  await done;
  await settled(runner);
  const failed = routeCalls(stub, '/api/response').find((call) => call.body.messageId === 'q-2');
  assert.equal(failed?.body?.terminalError?.code, 'claude-api-key-source');
  assert.match(failed.body.text, /"none"/);
  assert.match(failed.body.text, /At most one request may have gone out/);
});

test('an init with the saved key as its source goes on as a normal turn', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend, defaultModel: 'claude-sonnet-5' });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });
  const response = routeCalls(stub, '/api/response')[0];
  assert.equal(response.body.terminalError, undefined);
  assert.match(response.body.text, /answer to q-1/);
  assert.equal(spawns[0].params.abortController.signal.aborted, false);
  spawns[0].turn.endInput();
  await settled(runner);
});
