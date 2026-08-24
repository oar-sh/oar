import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrokTurnRunner } from './grok-turn-runner.mjs';
import { classifyGrokError } from './grok-sdk-adapter.mjs';

function createMockApi() {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    return { ok: true };
  };
  api.calls = calls;
  return api;
}

test('createGrokTurnRunner streams text and publishes a response', async () => {
  const api = createMockApi();
  const handle = {
    sessionId: 'sess-1',
    model: 'grok-4.5',
    client: { off() {}, on() {}, sessionCancel() {} },
    async close() {},
  };

  async function* fakeTurn() {
    yield { channel: 'init', payload: { sessionId: 'sess-1', model: 'grok-4.5' } };
    yield { channel: 'stream', payload: { text: 'Hi there', done: false, subagentRunId: null } };
    yield { channel: 'stream', payload: { text: 'Hi there from Grok', done: true, subagentRunId: null } };
    yield {
      channel: 'result',
      payload: {
        text: 'Hi there from Grok',
        isError: false,
        errorMessage: '',
        stopReason: 'end_turn',
        model: 'grok-4.5',
      },
    };
  }
  fakeTurn.cancel = async () => {};

  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-1',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => handle,
    startGrokTurnImpl: () => fakeTurn(),
  });

  const ok = await runner.handlePendingPayload({
    message: {
      id: 'msg-1',
      conversationId: 'conv-1',
      text: 'Hello',
      relayMode: 'agent',
      model: 'auto',
    },
  });
  assert.equal(ok, true);

  const paths = api.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.some((p) => p === 'POST /api/grok-native-session'));
  assert.ok(paths.some((p) => p === 'POST /api/stream'));
  assert.ok(paths.some((p) => p === 'POST /api/response'));
  const response = api.calls.find((c) => c.path === '/api/response');
  assert.equal(response.body.text, 'Hi there from Grok');
  assert.equal(response.body.model, 'grok-4.5');
  await runner.dispose();
});

test('createGrokTurnRunner stop/abort publishes partial stream without terminal error', async () => {
  const api = createMockApi();
  const handle = {
    sessionId: 'sess-2',
    model: 'grok-4.5',
    client: { off() {}, on() {}, sessionCancel() {} },
    async close() {},
  };

  let cancelCalled = false;
  async function* fakeTurn() {
    yield { channel: 'stream', payload: { text: 'partial…', done: false, subagentRunId: null } };
    // The stub control poller below drives the real abort (runner aborts its
    // own controller); this error simulates the prompt failing after cancel.
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  // Adapter shape used by the runner: startGrokTurnImpl receives options.
  const startImpl = () => {
    const iter = fakeTurn();
    iter.cancel = async () => { cancelCalled = true; };
    // When control poller aborts, runner calls turn.cancel then abortController.abort.
    // Force abort path by having onAbortTurn fire via a stub poller.
    return iter;
  };

  let abortHandler = null;
  const controlPoller = {
    start({ onAbortTurn }) {
      abortHandler = onAbortTurn;
      // Fire abort after a tick so the first stream action can land.
      queueMicrotask(async () => {
        await onAbortTurn();
      });
      return { stopped: false };
    },
    stop() {},
  };

  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-2',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    controlPoller,
    createAgentHandleImpl: async () => handle,
    startGrokTurnImpl: startImpl,
  });

  const ok = await runner.handlePendingPayload({
    message: {
      id: 'msg-2',
      conversationId: 'conv-2',
      text: 'long task',
      relayMode: 'agent',
    },
  });
  assert.equal(ok, true);
  assert.equal(cancelCalled, true);
  assert.ok(abortHandler);
  // Aborted turns should finalize stream, not post terminalError response in happy abort path.
  const streamCalls = api.calls.filter((c) => c.path === '/api/stream');
  assert.ok(streamCalls.length >= 1);
  await runner.dispose();
});

function makeHandle(sessionId = 'sess-x') {
  return {
    sessionId,
    model: 'grok-4.5',
    client: { off() {}, on() {}, sessionCancel() {} },
    async close() {},
  };
}

test('a thrown turn error publishes the full terminal-error shape in the response text', async () => {
  const api = createMockApi();
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-err',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => makeHandle(),
    startGrokTurnImpl: () => {
      throw new Error('Grok authentication failed for this account');
    },
  });
  const ok = await runner.handlePendingPayload({
    message: { id: 'msg-e', conversationId: 'conv-err', text: 'x', relayMode: 'agent' },
  });
  assert.equal(ok, true);
  // No phantom /api/system-note endpoint: the guidance rides on the response.
  assert.ok(!api.calls.some((c) => c.path === '/api/system-note'));
  const response = api.calls.find((c) => c.path === '/api/response');
  assert.ok(response.body.text.startsWith('System note: the Grok agent could not authenticate'));
  const terminalError = response.body.terminalError;
  assert.equal(terminalError.kind, 'grok-turn-failed');
  assert.equal(terminalError.code, 'grok.authentication_failed');
  assert.equal(terminalError.stableCode, 'grok.authentication_failed');
  assert.equal(terminalError.queueMessageId, 'msg-e');
  assert.ok(terminalError.failedAt);
  await runner.dispose();
});

test('classifyGrokError maps watchdog messages to grok.turn-stalled', () => {
  const stalled = classifyGrokError(new Error('grok turn stalled: no ACP activity for 120s'));
  assert.equal(stalled.code, 'grok.turn-stalled');
  assert.equal(stalled.isStalled, true);
  assert.equal(stalled.isBusy, false);
  const ceiling = classifyGrokError(new Error('grok turn exceeded the 30-minute turn ceiling'));
  assert.equal(ceiling.code, 'grok.turn-stalled');
  assert.equal(ceiling.isStalled, true);
});

test('a stalled turn publishes the partial stream and a grok.turn-stalled terminal error', async () => {
  const api = createMockApi();
  async function* stalledTurn() {
    yield { channel: 'stream', payload: { text: 'partial before hang', done: false, subagentRunId: null } };
    throw new Error('grok turn stalled: no ACP activity for 120s');
  }
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-stall',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => makeHandle(),
    startGrokTurnImpl: () => stalledTurn(),
  });
  const ok = await runner.handlePendingPayload({
    message: { id: 'msg-s', conversationId: 'conv-stall', text: 'x', relayMode: 'agent' },
  });
  assert.equal(ok, true);
  // Whatever streamed before the hang must survive next to the system note.
  const finalStream = api.calls.find((c) => c.path === '/api/stream' && c.body.done === true);
  assert.ok(finalStream, 'partial stream should be finalized');
  assert.equal(finalStream.body.text, 'partial before hang');
  const response = api.calls.find((c) => c.path === '/api/response');
  assert.ok(response.body.text.includes('stalled'));
  assert.equal(response.body.terminalError.stableCode, 'grok.turn-stalled');
  assert.ok(!api.calls.some((c) => c.path === '/api/requeue'), 'stalls fail terminally, no auto-requeue');
  await runner.dispose();
});

test('a turn without result or streamed text requeues instead of failing terminally', async () => {
  const api = createMockApi();
  async function* emptyTurn() {
    yield { channel: 'init', payload: { sessionId: 'sess-x', model: 'grok-4.5' } };
  }
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-empty',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => makeHandle(),
    startGrokTurnImpl: () => emptyTurn(),
  });
  const ok = await runner.handlePendingPayload({
    message: { id: 'msg-q', conversationId: 'conv-empty', text: 'x', relayMode: 'agent' },
  });
  assert.equal(ok, true);
  assert.ok(api.calls.some((c) => c.path === '/api/requeue'));
  assert.ok(!api.calls.some((c) => c.path === '/api/response'));
  await runner.dispose();
});

test('a busy agent gets one close-and-recreate retry', async () => {
  const api = createMockApi();
  let handleCreations = 0;
  let attempts = 0;
  async function* goodTurn() {
    yield {
      channel: 'result',
      payload: { text: 'done after retry', isError: false, errorMessage: '', stopReason: 'end_turn', model: 'grok-4.5' },
    };
  }
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-busy',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => {
      handleCreations += 1;
      return makeHandle(`sess-busy-${handleCreations}`);
    },
    startGrokTurnImpl: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('session already has an active prompt');
      return goodTurn();
    },
  });
  const ok = await runner.handlePendingPayload({
    message: { id: 'msg-b', conversationId: 'conv-busy', text: 'x', relayMode: 'agent' },
  });
  assert.equal(ok, true);
  assert.equal(handleCreations, 2);
  const response = api.calls.find((c) => c.path === '/api/response');
  assert.equal(response.body.text, 'done after retry');
  assert.equal(response.body.terminalError, undefined);
  await runner.dispose();
});

test('plan mode posts a plan_ready board for plan-shaped replies', async () => {
  const api = createMockApi();
  const planText = '1. Add the setting\n2. Wire the toggle\n3. Test both paths';
  async function* planTurn() {
    yield {
      channel: 'result',
      payload: { text: planText, isError: false, errorMessage: '', stopReason: 'end_turn', model: 'grok-4.5' },
    };
  }
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-plan',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => makeHandle(),
    startGrokTurnImpl: () => planTurn(),
  });
  await runner.handlePendingPayload({
    message: { id: 'msg-p', conversationId: 'conv-plan', text: 'plan it', relayMode: 'plan' },
  });
  const board = api.calls.find((c) => c.path === '/api/relay-board');
  assert.ok(board);
  assert.equal(board.body.boardType, 'plan_ready');
  assert.equal(board.body.body, planText);
  await runner.dispose();
});

test('turn usage publishes context usage and plan usage', async () => {
  const api = createMockApi();
  async function* usageTurn() {
    yield {
      channel: 'result',
      payload: {
        text: 'answer',
        isError: false,
        errorMessage: '',
        stopReason: 'end_turn',
        model: 'grok-4.5',
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1050,
          cachedReadTokens: 200,
          costUsdTicks: 4_000_000,
          modelId: 'grok-4.5',
        },
      },
    };
  }
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-usage',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => makeHandle(),
    startGrokTurnImpl: () => usageTurn(),
  });
  await runner.handlePendingPayload({
    message: { id: 'msg-u', conversationId: 'conv-usage', text: 'x', relayMode: 'agent' },
  });
  const contextCall = api.calls.find((c) => c.path === '/api/grok-context-usage');
  assert.ok(contextCall, 'context usage should be published');
  assert.equal(contextCall.body.model, 'grok-4.5');
  // Occupancy = input + cache reads + cache writes + output.
  assert.equal(contextCall.body.contextUsage.totalTokens, 1250);
  // grok-4.5 has a known fallback window, so the fill metric is present.
  assert.equal(contextCall.body.contextUsage.maxTokens, 256000);
  const planCall = api.calls.find((c) => c.path === '/api/grok-plan-usage');
  assert.ok(planCall, 'plan usage should be published');
  assert.equal(planCall.body.usage.costUsd, 0.004);
  await runner.dispose();
});

test('the composer reasoning effort is forwarded to the turn starter', async () => {
  const api = createMockApi();
  let seenEffort = null;
  async function* quickTurn() {
    yield {
      channel: 'result',
      payload: { text: 'ok', isError: false, errorMessage: '', stopReason: 'end_turn', model: 'grok-4.5' },
    };
  }
  const runner = createGrokTurnRunner({
    api,
    sdkSessionId: 'conv-effort',
    cwd: process.cwd(),
    defaultModel: 'grok-4.5',
    createAgentHandleImpl: async () => makeHandle(),
    startGrokTurnImpl: (opts) => {
      seenEffort = opts.reasoningEffort;
      return quickTurn();
    },
  });
  await runner.handlePendingPayload({
    message: { id: 'msg-f', conversationId: 'conv-effort', text: 'x', relayMode: 'agent', reasoningEffort: 'high' },
  });
  assert.equal(seenEffort, 'high');
  await runner.dispose();
});
