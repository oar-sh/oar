import test from 'node:test';
import assert from 'node:assert/strict';

import { createCursorTurnRunner, buildCursorPlanReadyBoardPayload, cursorModeNudge } from './cursor-turn-runner.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';

function makeApiStub({ failRoutes = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (failRoutes.has(routePath)) throw new Error(`stubbed failure for ${routePath}`);
      return { ok: true };
    },
  };
}

function fakeCursorTurn(events, cancels = []) {
  return {
    async* [Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async cancel() { cancels.push('cancel'); },
    get runId() { return 'run-1'; },
  };
}

// The adapter surfaces send/stream failures by rejecting the first next().
function rejectingTurn(error) {
  return {
    // eslint-disable-next-line require-yield
    async* [Symbol.asyncIterator]() { throw error; },
    async cancel() {},
    get runId() { return ''; },
  };
}

function queuedTurns(queue, started = []) {
  return (options) => {
    started.push(options);
    const spec = queue.shift() || [];
    if (typeof spec === 'function') return spec(options);
    return fakeCursorTurn(spec);
  };
}

function recordingHandleFactory({ createCalls, closes, agentIds = ['agent-new'] }) {
  let index = 0;
  return async (options) => {
    createCalls.push(options);
    const agentId = agentIds[Math.min(index, agentIds.length - 1)];
    index += 1;
    return {
      agent: { label: `agent-obj-${index}` },
      agentId,
      close: async () => { closes.push(agentId); },
    };
  };
}

function baseRunnerOptions(stub, overrides = {}) {
  return {
    api: stub.api,
    sdkSessionId: 'sess-1',
    cwd: '/home/dev',
    apiKey: 'cursor-test-key',
    storeDir: '/home/dev/.cursor-agents',
    defaultModel: 'default-cursor-model',
    readContextWindowImpl: async () => null,
    resolveModelParamsImpl: async () => null,
    ...overrides,
  };
}

const evDelta = (text) => ({ source: 'delta', update: { type: 'text-delta', text } });
const evInit = (model = 'sonnet-4.5', sessionId = 'native-1') => ({
  source: 'stream',
  message: { type: 'system', subtype: 'init', session_id: sessionId, model },
});
const evUsage = (usage) => ({ source: 'stream', message: { type: 'usage', usage } });
const evFinished = () => ({ source: 'stream', message: { type: 'status', status: 'FINISHED' } });
const evError = (message) => ({ source: 'stream', message: { type: 'status', status: 'ERROR', message } });

const busyError = () => Object.assign(new Error('agent is busy'), { name: 'AgentBusyError' });

const baseMessage = {
  id: 'q-1',
  conversationId: 'conv-1',
  relayMode: 'agent',
  text: 'hello',
  model: 'cheetah',
  attachments: [],
};

test('first turn creates the agent, persists its id, and later turns reuse the live handle', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const closes = [];
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('first answer.'), evFinished()],
      [evInit(), evDelta('second answer.'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].agentId, '', 'no durable id yet, so a fresh agent is created');
  assert.equal(createCalls[0].apiKey, 'cursor-test-key');
  assert.equal(createCalls[0].cwd, '/home/dev');
  assert.ok(createCalls[0].customTools?.ask_user?.execute, 'ask_user must be registered at creation');
  const persists = stub.calls.filter((call) => call.routePath === '/api/cursor-agent-id');
  assert.equal(persists.length, 1);
  assert.deepEqual(persists[0].body, { conversationId: 'conv-1', cursorAgentId: 'agent-new' });
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'first answer.');

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  assert.equal(createCalls.length, 1, 'the live handle must be reused across turns');
  assert.equal(
    stub.calls.filter((call) => call.routePath === '/api/cursor-agent-id').length,
    1,
    'an already-cached id is not re-persisted',
  );
});

test('the preview tool is registered beside ask_user and runs on the active conversation', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes: [] }),
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('ok.'), evFinished()]]),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const preview = createCalls[0].customTools?.preview;
  assert.ok(preview?.execute, 'preview must be registered at creation');
  assert.equal(preview.inputSchema.properties.action.enum.join(','), 'create,list,close');
  assert.ok(createCalls[0].customTools?.ask_user?.execute, 'ask_user must still be registered');

  const result = await preview.execute({ action: 'list' });
  const listCall = stub.calls.find((call) => call.routePath.startsWith('/api/previews'));
  assert.equal(listCall.method, 'GET');
  assert.equal(result.structuredContent.ok, true);
});

test('the payload roster becomes model-pinned subagents on the created handle', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes: [] }),
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('ok.'), evFinished()]]),
  }));

  await runner.handlePendingPayload({
    message: { ...baseMessage, cursorSubagentModels: ['grok-4.5', 'claude-opus-5'] },
  });

  const { agents } = createCalls[0];
  assert.deepEqual(Object.keys(agents), ['grok-4-5', 'claude-opus-5']);
  assert.deepEqual(agents['grok-4-5'].model, { id: 'grok-4.5' });
});

test('a payload with no roster still creates the handle, with no subagents', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes: [] }),
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('ok.'), evFinished()]]),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].agents, {});
});

test('changing the enabled models rebuilds the handle against the same durable agent', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const closes = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes, agentIds: ['agent-a'] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('one.'), evFinished()],
      [evInit(), evDelta('two.'), evFinished()],
      [evInit(), evDelta('three.'), evFinished()],
    ]),
  }));

  await runner.handlePendingPayload({
    message: { ...baseMessage, cursorSubagentModels: ['grok-4.5'] },
  });
  assert.equal(createCalls.length, 1);

  // Same roster: the handle is reused, so a stable selection costs nothing.
  await runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', cursorSubagentModels: ['grok-4.5'] },
  });
  assert.equal(createCalls.length, 1, 'an unchanged roster must not rebuild the handle');

  // Roster changed in the Select Models modal: without a rebuild the session
  // would keep offering the old subagent menu for the rest of its life.
  await runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-3', cursorSubagentModels: ['grok-4.5', 'claude-opus-5'] },
  });
  assert.equal(createCalls.length, 2);
  assert.deepEqual(closes, ['agent-a'], 'the stale handle is closed, not leaked');
  assert.equal(createCalls[1].agentId, 'agent-a', 'the rebuild resumes the same durable agent');
  assert.deepEqual(Object.keys(createCalls[1].agents), ['grok-4-5', 'claude-opus-5']);
});

test('a fresh runner resumes from the server-provided durable agent id', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes: [], agentIds: ['agent-1'] }),
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('resumed fine.'), evFinished()]]),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage, cursorAgentId: 'agent-1' } });
  assert.equal(createCalls[0].agentId, 'agent-1');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'resumed fine.');
});

test('failed persist is retried on the next turn instead of being cached', async () => {
  const failRoutes = new Set(['/api/cursor-agent-id']);
  const stub = makeApiStub({ failRoutes });
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('ok.'), evFinished()],
      [evInit(), evDelta('ok again.'), evFinished()],
    ]),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(stub.calls.filter((call) => call.routePath === '/api/cursor-agent-id').length, 1);

  failRoutes.clear();
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  const persists = stub.calls.filter((call) => call.routePath === '/api/cursor-agent-id');
  assert.equal(persists.length, 2, 'persist must be retried after a failure');
});

test('the model is re-pinned on every send and auto/empty falls back through providerModel', async () => {
  const stub = makeApiStub();
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('one.'), evFinished()],
      [evInit(), evDelta('two.'), evFinished()],
      [evInit(), evDelta('three.'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage, model: 'cheetah' } });
  await runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', model: 'auto', providerModel: 'sonnet-4.5' },
  });
  await runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-3', model: '', providerModel: '' },
  });

  assert.equal(started[0].model, 'cheetah');
  assert.equal(started[1].model, 'sonnet-4.5', 'auto falls back to the conversation provider model');
  assert.equal(started[2].model, 'default-cursor-model', 'empty falls back to the worker default');
  const responses = stub.calls.filter((call) => call.routePath === '/api/response');
  assert.equal(responses[1].body.modelOrigin, 'auto');
  assert.equal(responses[0].body.modelOrigin, 'manual');
});

test('the reasoning effort resolves to model params per turn and reaches the run', async () => {
  const stub = makeApiStub();
  const started = [];
  const resolveCalls = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('one.'), evFinished()],
      [evInit(), evDelta('two.'), evFinished()],
    ], started),
    resolveModelParamsImpl: async (args) => {
      resolveCalls.push(args);
      return args.reasoningEffort === 'high' ? [{ id: 'reasoning', value: 'high' }] : null;
    },
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage, reasoningEffort: 'high' } });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', reasoningEffort: 'none' } });

  assert.equal(resolveCalls.length, 2);
  assert.equal(resolveCalls[0].model, 'cheetah');
  assert.equal(resolveCalls[0].apiKey, 'cursor-test-key');
  assert.equal(resolveCalls[0].reasoningEffort, 'high');
  assert.deepEqual(started[0].modelParams, [{ id: 'reasoning', value: 'high' }]);
  assert.equal(started[1].modelParams, null, 'an unmapped effort sends the model default');
});

test('plan mode with a plan-shaped reply posts the plan_ready board via the fallback source', async () => {
  const stub = makeApiStub();
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('- step one\n- step two'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  assert.equal(started[0].relayMode, 'plan');
  const board = stub.calls.find((call) => call.routePath === '/api/relay-board');
  assert.ok(board, 'the plan board must be posted');
  assert.equal(board.body.boardType, 'plan_ready');
  assert.equal(board.body.title, 'Plan ready for review');
  assert.equal(board.body.context.source, 'plan-mode-fallback');
  assert.ok(stub.calls.find((call) => call.routePath === '/api/response'), 'response still published');

  assert.equal(buildCursorPlanReadyBoardPayload({ message: baseMessage, planText: '' }), null);
});

test('agent creation failures publish classified terminal responses', async () => {
  const authStub = makeApiStub();
  const authRunner = createCursorTurnRunner(baseRunnerOptions(authStub, {
    createAgentHandleImpl: async () => {
      throw Object.assign(new Error('bad api key'), { name: 'AuthenticationError' });
    },
    startCursorRunImpl: queuedTurns([]),
  }));
  const handled = await authRunner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  const authResponse = authStub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(authResponse.body.terminalError.stableCode, 'cursor.authentication_failed');
  assert.match(authResponse.body.text, /Set or renew the Cursor API key/);

  const genericStub = makeApiStub();
  const genericRunner = createCursorTurnRunner(baseRunnerOptions(genericStub, {
    createAgentHandleImpl: async () => { throw new Error('store locked'); },
    startCursorRunImpl: queuedTurns([]),
  }));
  await genericRunner.handlePendingPayload({ message: { ...baseMessage } });
  const genericResponse = genericStub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(genericResponse.body.terminalError.stableCode, 'cursor.turn-error');
  assert.match(genericResponse.body.text, /the Cursor turn failed \(store locked\)/);
  assert.equal(genericResponse.body.terminalError.kind, 'cursor-turn-failed');
});

test('a busy agent is closed and retried; the second retry forces run expiry; a third busy is terminal', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const closes = [];
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes, agentIds: ['agent-b'] }),
    startCursorRunImpl: queuedTurns([
      () => rejectingTurn(busyError()),
      [evInit(), evDelta('recovered fine.'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(closes.length, 1, 'the busy handle must be closed');
  assert.equal(createCalls.length, 2, 'a fresh handle must be created for the retry');
  assert.equal(createCalls[1].agentId, 'agent-b', 'the retry resumes the persisted durable id');
  assert.equal(started.length, 2);
  assert.equal(started[1].sendLocal, null, 'the first retry does not force');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'recovered fine.');
  assert.equal(response.body.terminalError, undefined);

  const busyStub = makeApiStub();
  const busyStarted = [];
  const busyRunner = createCursorTurnRunner(baseRunnerOptions(busyStub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      () => rejectingTurn(busyError()),
      () => rejectingTurn(busyError()),
      () => rejectingTurn(busyError()),
    ], busyStarted),
  }));
  const handled = await busyRunner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  assert.equal(busyStarted.length, 3, 'two retries before going terminal');
  assert.deepEqual(
    busyStarted[2].sendLocal,
    { force: true },
    'the second retry expires the wedged persisted run (the SDK\'s documented recovery)',
  );
  const busyResponse = busyStub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(busyResponse.body.terminalError.stableCode, 'cursor.agent_busy');
});

// Stale handles surface backend auth rejections as terminal ERROR results,
// not thrown AuthenticationErrors; the API key is usually still valid.
const authErrorResult = () => evError('Authentication error If you are logged in, try logging out and back in.');

test('an auth error result closes and recreates the handle, and the retry recovers', async () => {
  const stub = makeApiStub();
  const createCalls = [];
  const closes = [];
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls, closes, agentIds: ['agent-a'] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), authErrorResult()],
      [evInit(), evDelta('recovered on a fresh handle.'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(closes.length, 1, 'the stale handle must be closed');
  assert.equal(createCalls.length, 2, 'a fresh handle must be created for the retry');
  assert.equal(createCalls[1].agentId, 'agent-a', 'the retry resumes the persisted durable id');
  assert.equal(started.length, 2);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'recovered on a fresh handle.');
  assert.equal(response.body.terminalError, undefined);
});

test('exhausting the auth-retry budget is terminal with the key renewal hint', async () => {
  const stub = makeApiStub();
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), authErrorResult()],
      [evInit(), authErrorResult()],
      [evInit(), authErrorResult()],
    ], started),
  }));

  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  assert.equal(started.length, 3, 'two recreate-and-retry attempts before going terminal');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.terminalError.stableCode, 'cursor.authentication_failed');
  assert.equal(response.body.terminalError.code, 'authentication_failed');
  assert.match(response.body.text, /Set or renew the Cursor API key/);
});

test('a thrown AuthenticationError gets the same recreate-and-retry as the result-shaped failure', async () => {
  const stub = makeApiStub();
  const closes = [];
  const started = [];
  const authThrow = () => {
    const error = new Error('AuthenticationError: token exchange expired');
    error.name = 'AuthenticationError';
    return error;
  };
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes, agentIds: ['agent-a'] }),
    startCursorRunImpl: queuedTurns([
      () => rejectingTurn(authThrow()),
      [evInit(), evDelta('recovered after the thrown auth error.'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(closes.length, 1, 'the stale handle must be closed');
  assert.equal(started.length, 2);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'recovered after the thrown auth error.');
  assert.equal(response.body.terminalError, undefined);
});

test('an auth error hidden behind streamed text still triggers the handle retry', async () => {
  const stub = makeApiStub();
  const started = [];
  const closes = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes, agentIds: ['agent-a'] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('partial before auth died'), authErrorResult()],
      [evInit(), evDelta('clean second attempt.'), evFinished()],
    ], started),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(closes.length, 1);
  assert.equal(started.length, 2);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(
    response.body.text,
    'clean second attempt.',
    'the failed attempt\'s partial text must not leak into the retried turn',
  );
  assert.equal(response.body.terminalError, undefined);
});

test('abort cancels the run, republishes partial text as done, and skips the response', async () => {
  const stub = makeApiStub();
  let captured = null;
  const controlPoller = {
    start(options) { captured = options; return { id: 'ctl-1' }; },
    stop() {},
  };
  const cancels = [];
  const abortingTurn = {
    async* [Symbol.asyncIterator]() {
      yield evDelta('partial answer before stop.');
      // Trigger the same path the control poller drives mid-turn; the real
      // adapter then ends the merged stream on abort.
      await captured.onAbortTurn();
    },
    async cancel() { cancels.push('cancel'); },
    get runId() { return 'run-1'; },
  };
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    controlPoller,
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: () => abortingTurn,
  }));

  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  assert.deepEqual(cancels, ['cancel'], 'turn.cancel must be invoked on abort');
  const finalStream = stub.calls.find(
    (call) => call.routePath === '/api/stream' && call.body.done === true,
  );
  assert.equal(finalStream.body.text, 'partial answer before stop.');
  assert.ok(!stub.calls.find((call) => call.routePath === '/api/response'), 'no response after abort');
});

test('a stream that ends without a result falls back to streamed text or requeues', async () => {
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('only streamed text.')],
    ]),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'only streamed text.');

  const emptyStub = makeApiStub();
  const emptyRunner = createCursorTurnRunner(baseRunnerOptions(emptyStub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([[]]),
  }));
  await emptyRunner.handlePendingPayload({ message: { ...baseMessage } });
  const requeue = emptyStub.calls.find((call) => call.routePath === '/api/requeue');
  assert.deepEqual(requeue.body, { messageId: 'q-1' });
  assert.ok(!emptyStub.calls.find((call) => call.routePath === '/api/response'));
});

test('a turn that finishes on tool activity alone publishes instead of requeueing', async () => {
  // Regression: conv 1e497a75. "do nothing else than spawning a grok-4.5 sub
  // agent" makes the model end its turn with no prose (the SDK recorded
  // `status: FINISHED, result: null`). Requeuing re-ran the subagent on every
  // attempt and then failed the message with a bogus "Relay timeout".
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([[evInit(), evFinished()]]),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/requeue'),
    'a completed turn must never be requeued',
  );
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, EMPTY_TURN_COMPLETION_NOTE);
  // `/api/response` rejects an empty body, so the note is what makes the
  // completion publishable at all.
  assert.ok(response.body.text.trim(), 'the published text must be non-empty');
  assert.ok(!response.body.terminalError, 'a silent turn is a success, not a failure');
});

test('result usage publishes the context breakdown without disturbing the response', async () => {
  const stub = makeApiStub({ failRoutes: new Set(['/api/cursor-context-usage']) });
  const windowCalls = [];
  const usageEvents = [
    evInit('sonnet-4.5'),
    evDelta('usage answer.'),
    evUsage({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500, cacheWriteTokens: 100 }),
    evFinished(),
  ];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([usageEvents.slice()]),
    readContextWindowImpl: async ({ model, apiKey }) => {
      windowCalls.push({ model, apiKey });
      return 200000;
    },
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const failedPost = stub.calls.find((call) => call.routePath === '/api/cursor-context-usage');
  assert.ok(failedPost, 'the publish was attempted');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'usage answer.', 'a failed usage publish must not disturb the response');

  const okStub = makeApiStub();
  const okRunner = createCursorTurnRunner(baseRunnerOptions(okStub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([usageEvents.slice()]),
    readContextWindowImpl: async () => 200000,
  }));
  await okRunner.handlePendingPayload({ message: { ...baseMessage } });
  const post = okStub.calls.find((call) => call.routePath === '/api/cursor-context-usage');
  assert.equal(post.body.conversationId, 'conv-1');
  assert.equal(post.body.sdkSessionId, 'sess-1');
  assert.equal(post.body.model, 'sonnet-4.5');
  assert.equal(post.body.contextUsage.totalTokens, 2100);
  assert.equal(post.body.contextUsage.maxTokens, 200000);
  assert.equal(post.body.modelUsage['sonnet-4.5'].contextWindow, 200000);
  assert.deepEqual(windowCalls[0], { model: 'sonnet-4.5', apiKey: 'cursor-test-key' });

  const noUsageStub = makeApiStub();
  const noUsageRunner = createCursorTurnRunner(baseRunnerOptions(noUsageStub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('no usage.'), evFinished()]]),
    readContextWindowImpl: async () => 200000,
  }));
  await noUsageRunner.handlePendingPayload({ message: { ...baseMessage } });
  assert.ok(
    !noUsageStub.calls.find((call) => call.routePath === '/api/cursor-context-usage'),
    'nothing to publish without usage',
  );
});

test('usage seen mid-turn is published even when no terminal status arrives', async () => {
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([[
      evInit(),
      evDelta('answer without a status message.'),
      evUsage({ inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      // stream ends here — no status message, so no result action
    ]]),
    readContextWindowImpl: async () => 200000,
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const post = stub.calls.find((call) => call.routePath === '/api/cursor-context-usage');
  assert.ok(post, 'the normalizer-held usage must still be published');
  assert.equal(post.body.contextUsage.totalTokens, 1000);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'answer without a status message.');
});

test('multi-step turns publish a per-call estimate, flagged as such', async () => {
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([[
      evInit(),
      { source: 'delta', update: { type: 'step-started', stepId: 1 } },
      { source: 'delta', update: { type: 'step-started', stepId: 2 } },
      evDelta('two-call answer.'),
      evUsage({ inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 1000 }),
      evFinished(),
    ]]),
    readContextWindowImpl: async () => 200000,
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const post = stub.calls.find((call) => call.routePath === '/api/cursor-context-usage');
  // (2000 + 1000 + 1000) / 2 steps + 100 output
  assert.equal(post.body.contextUsage.totalTokens, 2100);
  assert.equal(post.body.contextUsage.estimateKind, 'cursor-per-call-average');
});

test('the static fallback window applies when the provider lookup returns null', async () => {
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([[
      evInit('grok-4.5'),
      evDelta('fallback window answer.'),
      evUsage({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      evFinished(),
    ]]),
    readContextWindowImpl: async () => null,
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const post = stub.calls.find((call) => call.routePath === '/api/cursor-context-usage');
  assert.equal(post.body.contextUsage.maxTokens, 256000, 'grok-4.5 comes from the shared fallback table');
  assert.equal(post.body.modelUsage['grok-4.5'].contextWindow, 256000);
});

test('an error result publishes a terminal response and republishes the partial text', async () => {
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('partial work'), evError('model exploded')],
    ]),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const finalStream = stub.calls.find(
    (call) => call.routePath === '/api/stream' && call.body.done === true,
  );
  assert.equal(finalStream.body.text, 'partial work');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.terminalError.stableCode, 'cursor.error');
  assert.equal(response.body.terminalError.code, 'error');
  assert.equal(response.body.terminalError.kind, 'cursor-turn-failed');
});

test('thought, activity, and subagent actions pass subagentRunId through; subagent text never stands in for the answer', async () => {
  const stub = makeApiStub();
  const events = [
    { actions: [{ channel: 'stream', payload: { text: 'Main thread answer.', done: false, subagentRunId: null } }] },
    { actions: [{ channel: 'subagent', payload: { subagentRunId: 'call-9', parentSubagentId: null, displayName: 'Investigator', status: 'running' } }] },
    { actions: [{ channel: 'thought', payload: { reasoningId: 'r-1', text: 'weighing options', done: true, subagentRunId: 'call-9' } }] },
    { actions: [{ channel: 'activity', payload: { text: 'Tool (shell): ls', subagentRunId: 'call-9' } }] },
    { actions: [{ channel: 'stream', payload: { text: 'Subagent chatter here.', done: false, subagentRunId: 'call-9' } }] },
    { actions: [{ channel: 'result', payload: { text: '', isError: false, subtype: 'finished', usage: null, totalCostUsd: null } }] },
  ];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([events]),
    createNormalizerImpl: () => ({
      normalize: (event) => (Array.isArray(event?.actions) ? event.actions : []),
      finalStreamText: () => '',
      get model() { return 'sonnet-4.5'; },
    }),
  }));

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const thought = stub.calls.find((call) => call.routePath === '/api/thought');
  assert.equal(thought.body.reasoningId, 'r-1');
  assert.equal(thought.body.subagentRunId, 'call-9');
  const activity = stub.calls.find((call) => call.routePath === '/api/activity');
  assert.equal(activity.body.subagentRunId, 'call-9');
  const subagent = stub.calls.find((call) => call.routePath === '/api/subagent-run');
  assert.equal(subagent.body.subagentRunId, 'call-9');
  assert.equal(subagent.body.displayName, 'Investigator');
  assert.equal(subagent.body.status, 'running');
  const subagentStream = stub.calls.find(
    (call) => call.routePath === '/api/stream' && call.body.subagentRunId,
  );
  assert.equal(subagentStream.body.subagentRunId, 'call-9');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'Main thread answer.', 'subagent text must not become the reply');
  assert.equal(response.body.model, 'sonnet-4.5');
});

test('dispose closes the handle, and a failed resume falls back to create and persists the new id', async () => {
  const stub = makeApiStub();
  const closes = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes }),
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('done.'), evFinished()]]),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  await runner.dispose();
  assert.deepEqual(closes, ['agent-new']);

  const fallbackStub = makeApiStub();
  const createCalls = [];
  const fallbackRunner = createCursorTurnRunner(baseRunnerOptions(fallbackStub, {
    createAgentHandleImpl: async (options) => {
      createCalls.push(options);
      if (createCalls.length === 1) throw new Error('agent not found');
      return { agent: {}, agentId: 'agent-2', close: async () => {} };
    },
    startCursorRunImpl: queuedTurns([[evInit(), evDelta('fresh agent answer.'), evFinished()]]),
  }));
  await fallbackRunner.handlePendingPayload({ message: { ...baseMessage, cursorAgentId: 'agent-1' } });
  assert.equal(createCalls[0].agentId, 'agent-1');
  assert.equal(createCalls[1].agentId, '', 'resume failure falls back to a fresh agent');
  const persist = fallbackStub.calls.find((call) => call.routePath === '/api/cursor-agent-id');
  assert.deepEqual(persist.body, { conversationId: 'conv-1', cursorAgentId: 'agent-2' });
  const response = fallbackStub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'fresh agent answer.');
});

test('cursorModeNudge injects on mode entry and cancels on mode exit', () => {
  assert.match(cursorModeNudge('ask', ''), /^\[Relay mode: ask\]/);
  assert.match(cursorModeNudge('autopilot', 'ask'), /^\[Relay mode: autopilot\]/);
  assert.equal(cursorModeNudge('ask', 'ask'), '');
  assert.match(cursorModeNudge('agent', 'autopilot'), /no longer apply/);
  // No standing instruction to cancel: agent/plan need no injection.
  assert.equal(cursorModeNudge('agent', ''), '');
  assert.equal(cursorModeNudge('plan', 'agent'), '');
});

test('ask/autopilot nudges ride on the message text and dedupe until the mode changes', async () => {
  const stub = makeApiStub();
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('a.'), evFinished()],
      [evInit(), evDelta('b.'), evFinished()],
      [evInit(), evDelta('c.'), evFinished()],
    ], started),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } });
  assert.match(started[0].message.text, /^\[Relay mode: ask\][\s\S]*hello$/);
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'ask' } });
  assert.equal(started[1].message.text, 'hello', 'same mode must not re-inject');
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', relayMode: 'agent' } });
  assert.match(started[2].message.text, /^\[Relay mode: agent\][\s\S]*hello$/);
});

test('auth vocabulary in the model prose does not trigger the auth retry when the error has no message', async () => {
  const stub = makeApiStub();
  const started = [];
  const closes = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes }),
    startCursorRunImpl: queuedTurns([
      // The model was *talking about* auth failures; the bare ERROR status
      // carries no message, so nothing here is an auth classification.
      [evInit(), evDelta('The log shows "invalid api key" from the previous run.'), evError('')],
    ], started),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(started.length, 1, 'no silent re-run on prose-only auth vocabulary');
  assert.equal(closes.length, 0, 'the handle must not be recreated');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.notEqual(response.body.terminalError?.code, 'authentication_failed');
  assert.doesNotMatch(response.body.text, /Set or renew the Cursor API key/);
});

test('the auth retry clears the failed attempt\'s stream and leaves an activity trace', async () => {
  const stub = makeApiStub();
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [], agentIds: ['agent-a', 'agent-b'] }),
    startCursorRunImpl: queuedTurns([
      [evInit(), evDelta('partial before auth died'), authErrorResult()],
      [evInit(), evDelta('clean second attempt.'), evFinished()],
    ]),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const streams = stub.calls.filter((call) => call.routePath === '/api/stream');
  const reset = streams.find((call) => call.body.text === '' && call.body.done === true);
  assert.ok(reset, 'an empty done stream snapshot must clear the failed attempt');
  const lastStream = streams[streams.length - 1];
  assert.equal(lastStream.body.text, 'clean second attempt.');
  const note = stub.calls.find((call) => call.routePath === '/api/activity'
    && /re-authenticated; retrying/.test(call.body.text));
  assert.ok(note, 'the retry must leave an activity trace');
});

test('a mode nudge swallowed by a failed turn is re-injected on the next attempt', async () => {
  const stub = makeApiStub();
  const started = [];
  const runner = createCursorTurnRunner(baseRunnerOptions(stub, {
    createAgentHandleImpl: recordingHandleFactory({ createCalls: [], closes: [] }),
    startCursorRunImpl: queuedTurns([
      () => rejectingTurn(new Error('transport exploded')),
      [evInit(), evDelta('ok now.'), evFinished()],
    ], started),
  }));
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } });
  assert.match(started[0].message.text, /^\[Relay mode: ask\]/, 'first attempt carries the nudge');
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'ask' } });
  assert.match(
    started[1].message.text,
    /^\[Relay mode: ask\]/,
    'the failed turn must not consume the mode change; the nudge is re-injected',
  );
});
