// The relay's own `ask_user` for Copilot SDK sessions: the pure module, and
// the runner wiring (registration, the card it raises, the hold while it is
// open, the fallback when a runtime refuses the override).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RELAY_ASK_USER_TOOL_PARAMETERS,
  formatAskUserToolResult,
  isToolOverrideRejection,
  parseAskUserToolArguments,
} from './copilot-ask-user-tool.mjs';
import {
  baseMessage,
  createFakeCopilotClient,
  makeApiStub,
  makeFakeQuestionBridge,
  makeRunner,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import { USER_INPUT_UNSUPPORTED_ANSWER } from './copilot-sdk-adapter.mjs';

test('the schema is the built-in ask_user plus multi_select', () => {
  assert.deepEqual(Object.keys(RELAY_ASK_USER_TOOL_PARAMETERS.properties), ['question', 'choices', 'multi_select']);
  assert.deepEqual(RELAY_ASK_USER_TOOL_PARAMETERS.required, ['question']);
  assert.equal(RELAY_ASK_USER_TOOL_PARAMETERS.properties.multi_select.type, 'boolean');
});

test('arguments are normalized; either spelling of the flag counts, only as a real true', () => {
  assert.deepEqual(parseAskUserToolArguments({ question: ' Which? ', choices: ['a', ' b ', ''], multi_select: true }), {
    question: 'Which?', choices: ['a', 'b'], multiSelect: true,
  });
  assert.equal(parseAskUserToolArguments({ question: 'q', multiSelect: true }).multiSelect, true);
  assert.equal(parseAskUserToolArguments({ question: 'q', multi_select: 'true' }).multiSelect, false);
  assert.deepEqual(parseAskUserToolArguments(null), { question: '', choices: [], multiSelect: false });
});

test('the result reads like the built-in: a choice is "selected", anything else "responded"', () => {
  // The bridge's wasFreeform decides (its deriveWasFreeform owns the rule).
  assert.equal(formatAskUserToolResult({ answer: 'staging', wasFreeform: false }), 'User selected: staging');
  assert.equal(formatAskUserToolResult({ answer: 'staging, prod', wasFreeform: true }), 'User responded: staging, prod');
  assert.equal(formatAskUserToolResult({ answer: 'no idea' }), 'User responded: no idea');
  assert.equal(formatAskUserToolResult({ answer: 'The user did not answer in time.', timedOut: true }), 'The user did not answer in time.');
  assert.equal(formatAskUserToolResult({ answer: '' }), 'User responded with an empty answer.');
});

test('only an override refusal counts as one', () => {
  assert.equal(isToolOverrideRejection(new Error('Tool "ask_user" clashes with a built-in tool; set overridesBuiltInTool')), true);
  assert.equal(isToolOverrideRejection(new Error('Unknown field overridesBuiltInTool')), true);
  assert.equal(isToolOverrideRejection(new Error('Session not found: conv-1')), false);
  assert.equal(isToolOverrideRejection(new Error('Pending response rejected since connection got disposed')), false);
  // Mentioning the tool, or a generic "already exists", is not a refusal.
  assert.equal(isToolOverrideRejection(new Error('history replay failed at ask_user call 3')), false);
  assert.equal(isToolOverrideRejection(new Error('Session conv-1 already exists')), false);
});

// ------------------------------------------------------------ the runner --

function setup({ questionBridge = makeFakeQuestionBridge(), ...overrides } = {}) {
  const stub = makeApiStub();
  const client = createFakeCopilotClient();
  const readiness = [];
  const { runner } = makeRunner({ stub, client, questionBridge, onDeliveryReadinessChange: (ready) => readiness.push(ready), ...overrides });
  return { stub, client, runner, questionBridge, readiness };
}

/**
 * Start a turn and wait until its prompt is sent. The delivery's promise is
 * returned wrapped: an async function returning a bare promise would wait for
 * it — i.e. for the whole turn — before handing it back.
 */
async function openTurn(client, runner, message = baseMessage) {
  const pending = runner.handlePendingPayload({ message });
  await waitFor(() => client.session?.sends.length >= 1 && runner.isTurnActive(), { label: 'prompt sent' });
  return { pending };
}

test('the session registers the relay ask_user as an override of the built-in', async () => {
  const { client, runner } = setup();
  const { pending } = await openTurn(client, runner);
  const tools = client.createAttempts[0].tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ask_user');
  assert.equal(tools[0].overridesBuiltInTool, true);
  assert.equal(tools[0].skipPermission, true);
  assert.equal(typeof tools[0].handler, 'function');
  // The built-in path stays wired for a runtime that refuses the override.
  assert.equal(typeof client.createAttempts[0].onUserInputRequest, 'function');
  client.session.emit({ type: 'assistant.idle', data: {} });
  await pending;
});

test('a multi_select call raises a multi-select card, holds steering while it is open, and answers in the built-in wording', async () => {
  let answer = () => {};
  const card = new Promise((resolve) => { answer = resolve; });
  const questionBridge = makeFakeQuestionBridge({ userInputAnswer: 'cheese, mushrooms', onAsk: () => card });
  const { client, runner, readiness } = setup({ questionBridge });
  const { pending } = await openTurn(client, runner);
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'steerable' });

  const handler = client.createAttempts[0].tools[0].handler;
  const result = handler({ question: 'Which toppings?', choices: ['cheese', 'ham', 'mushrooms'], multi_select: true }, { toolCallId: 'c1' });
  await waitFor(() => questionBridge.userInputCalls.length === 1, { label: 'card raised' });
  const request = questionBridge.userInputCalls[0].request;
  assert.equal(request.question, 'Which toppings?');
  assert.deepEqual(request.choices, ['cheese', 'ham', 'mushrooms']);
  assert.equal(request.multiSelect, true);
  assert.equal(request.source, 'relay-ask-user-tool');
  // An open card holds steering, exactly as the built-in path does.
  assert.equal(runner.isDeliveryHeld(), true);
  assert.equal(runner.steeringState().holdReason, 'question');

  answer();
  assert.equal(await result, 'User responded: cheese, mushrooms');
  assert.equal(runner.isDeliveryHeld(), false);
  assert.deepEqual(readiness.slice(-2), [false, true]);
  client.session.emit({ type: 'assistant.idle', data: {} });
  await pending;
});

test('a failing card answers in-band instead of throwing into the runtime', async () => {
  const questionBridge = makeFakeQuestionBridge();
  questionBridge.askUserInput = async () => { throw new Error('relay down'); };
  const { client, runner } = setup({ questionBridge });
  const { pending } = await openTurn(client, runner);
  const handler = client.createAttempts[0].tools[0].handler;
  assert.equal(await handler({ question: 'q?' }), USER_INPUT_UNSUPPORTED_ANSWER);
  client.session.emit({ type: 'assistant.idle', data: {} });
  await pending;
});

test('a runtime that refuses the override gets a session without it; the next runtime tries again', async () => {
  const { client, runner } = setup();
  // An older runtime: it refuses the override on create AND on resume.
  const createSession = client.createSession.bind(client);
  const resumeSession = client.resumeSession.bind(client);
  let refusals = 0;
  const refuseTools = (config) => {
    if (!config.tools?.length) return;
    refusals += 1;
    throw new Error('Tool "ask_user" clashes with a built-in tool');
  };
  client.createSession = async (config) => {
    if (config.tools?.length) client.createAttempts.push(config);
    refuseTools(config);
    return createSession(config);
  };
  client.resumeSession = async (sessionId, config) => {
    if (client.resumeAvailable) refuseTools(config);
    return resumeSession(sessionId, config);
  };
  const { pending } = await openTurn(client, runner);
  assert.equal(refusals, 1);
  assert.equal('tools' in client.session.config, false, 'the fallback session has no custom tools');
  assert.equal(typeof client.session.config.onUserInputRequest, 'function', 'the built-in path answers instead');
  client.session.emit({ type: 'assistant.idle', data: {} });
  await pending;
  await runner.dispose();
  // A stopped runtime may come back auto-updated: the next one tries again.
  const again = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await waitFor(() => client.sessions.length === 2 && client.session.sends.length === 1, { label: 'second session' });
  assert.equal(refusals, 2);
  client.session.emit({ type: 'assistant.idle', data: {} });
  await again;
});

test('the override can be switched off', async () => {
  const { client, runner } = setup({ relayAskUserTool: false });
  const { pending } = await openTurn(client, runner);
  assert.equal('tools' in client.createAttempts[0], false);
  client.session.emit({ type: 'assistant.idle', data: {} });
  await pending;
});

test('a card is cancelled when the runtime aborts the tool call, not only when the turn ends', async () => {
  let answer = () => {};
  const card = new Promise((resolve) => { answer = resolve; });
  const questionBridge = makeFakeQuestionBridge({ onAsk: () => card });
  const { client, runner } = setup({ questionBridge });
  const { pending } = await openTurn(client, runner);
  const invocationAbort = new AbortController();
  const handler = client.createAttempts[0].tools[0].handler;
  const result = handler({ question: 'q?', choices: ['a', 'b'] }, { toolCallId: 'c1', signal: invocationAbort.signal });
  await waitFor(() => questionBridge.userInputCalls.length === 1, { label: 'card raised' });
  const cardSignal = questionBridge.userInputCalls[0].options.signal;
  assert.equal(cardSignal.aborted, false);
  // A subagent cancelled via tasks.cancel, or a disconnect: the runtime aborts the call.
  invocationAbort.abort();
  assert.equal(cardSignal.aborted, true, 'the card is told to stop waiting');
  answer();
  await result;
  client.session.emit({ type: 'assistant.idle', data: {} });
  await pending;
});
