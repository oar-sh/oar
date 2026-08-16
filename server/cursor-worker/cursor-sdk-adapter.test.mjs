import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyCursorError,
  isCursorAuthErrorMessage,
  createCursorAgentHandle,
  modeForRelayMode,
  readAgentUsage,
  readModelContextWindow,
  resolveCursorReasoningParams,
  startCursorRun,
} from './cursor-sdk-adapter.mjs';

function createRecordingFactory(agent) {
  const calls = { create: [], resume: [] };
  return {
    calls,
    create: async (options) => {
      calls.create.push(options);
      return agent;
    },
    resume: async (agentId, options) => {
      calls.resume.push({ agentId, options });
      return agent;
    },
  };
}

const askUserTool = { description: 'ask', inputSchema: { type: 'object' }, execute: async () => 'ok' };

test('relay modes map to Cursor send modes', () => {
  assert.equal(modeForRelayMode('plan'), 'plan');
  assert.equal(modeForRelayMode('agent'), 'agent');
  assert.equal(modeForRelayMode('ask'), 'agent');
  assert.equal(modeForRelayMode('autopilot'), 'agent');
  assert.equal(modeForRelayMode(''), 'agent');
});

test('create path assembles options, builds the store under storeDir, and prefers agent ids', async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-test-'));
  try {
    let closed = 0;
    const factory = createRecordingFactory({ agentId: 'agent-created-1', close: () => { closed += 1; } });
    const storeCalls = [];
    const fakeStore = { kind: 'fake-store' };
    const handle = await createCursorAgentHandle({
      apiKey: 'cursor-test-key',
      model: 'composer-1',
      cwd: '/home/dev/project',
      storeDir,
      sdkSessionId: 'sess-1',
      customTools: { ask_user: askUserTool },
      agentFactoryImpl: factory,
      storeFactoryImpl: (storePath, extra) => {
        storeCalls.push({ storePath, extra });
        return fakeStore;
      },
    });

    assert.equal(factory.calls.resume.length, 0);
    assert.equal(factory.calls.create.length, 1);
    const options = factory.calls.create[0];
    assert.equal(options.apiKey, 'cursor-test-key');
    assert.deepEqual(options.model, { id: 'composer-1' });
    assert.equal(options.local.cwd, '/home/dev/project');
    assert.equal(options.local.store, fakeStore);
    assert.equal(options.local.autoReview, false);
    assert.ok(options.local.customTools.ask_user);
    assert.equal(typeof options.local.customTools.ask_user.execute, 'function');

    const expectedStorePath = path.join(storeDir, 'sess-1', 'agent.db');
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].storePath, expectedStorePath);
    assert.ok(fs.existsSync(path.dirname(expectedStorePath)), 'store directory is created');

    assert.equal(handle.agentId, 'agent-created-1');
    await handle.close();
    assert.equal(closed, 1);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('resume path passes the same option shape and keeps customTools', async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-test-'));
  try {
    const factory = createRecordingFactory({ id: 'agent-resumed-id' });
    const handle = await createCursorAgentHandle({
      apiKey: 'cursor-test-key',
      model: 'composer-1',
      cwd: '/home/dev/project',
      storeDir,
      sdkSessionId: 'sess-2',
      agentId: 'agent-9',
      customTools: { ask_user: askUserTool },
      agentFactoryImpl: factory,
      storeFactoryImpl: (storePath) => ({ storePath }),
    });

    assert.equal(factory.calls.create.length, 0);
    assert.equal(factory.calls.resume.length, 1);
    assert.equal(factory.calls.resume[0].agentId, 'agent-9');
    const options = factory.calls.resume[0].options;
    assert.equal(options.apiKey, 'cursor-test-key');
    assert.deepEqual(options.model, { id: 'composer-1' });
    assert.equal(options.local.cwd, '/home/dev/project');
    assert.equal(options.local.autoReview, false);
    assert.ok(options.local.customTools.ask_user);
    assert.equal(options.local.store.storePath, path.join(storeDir, 'sess-2', 'agent.db'));

    // agent.id wins over the passed agentId.
    assert.equal(handle.agentId, 'agent-resumed-id');
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('the subagent roster rides on both create and resume, and an empty one is omitted', async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-test-'));
  const agents = {
    'grok-4-5': { description: 'd', prompt: 'p', model: { id: 'grok-4.5' } },
  };
  try {
    const factory = createRecordingFactory({ agentId: 'agent-1' });
    await createCursorAgentHandle({
      apiKey: 'k',
      model: 'composer-1',
      cwd: '/home/dev/project',
      storeDir,
      sdkSessionId: 'sess-agents-create',
      agents,
      agentFactoryImpl: factory,
      storeFactoryImpl: () => ({}),
    });
    assert.deepEqual(factory.calls.create[0].agents, agents);

    // Resume must carry it too: the SDK persists the roster into store metadata
    // at create time and falls back to that copy when a resume passes none, so
    // omitting it here would pin the session to a stale subagent menu.
    await createCursorAgentHandle({
      apiKey: 'k',
      model: 'composer-1',
      cwd: '/home/dev/project',
      storeDir,
      sdkSessionId: 'sess-agents-resume',
      agentId: 'agent-9',
      agents,
      agentFactoryImpl: factory,
      storeFactoryImpl: () => ({}),
    });
    assert.deepEqual(factory.calls.resume[0].options.agents, agents);

    for (const emptyRoster of [{}, null, undefined]) {
      const bare = createRecordingFactory({ agentId: 'agent-2' });
      await createCursorAgentHandle({
        apiKey: 'k',
        model: 'composer-1',
        cwd: '/home/dev/project',
        storeDir,
        sdkSessionId: 'sess-agents-empty',
        agents: emptyRoster,
        agentFactoryImpl: bare,
        storeFactoryImpl: () => ({}),
      });
      assert.ok(!('agents' in bare.calls.create[0]), 'an empty roster must not reach the SDK');
    }
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('agentId falls back to the passed id and close survives agent.close throwing', async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-test-'));
  try {
    const factory = createRecordingFactory({ close: () => { throw new Error('close exploded'); } });
    const handle = await createCursorAgentHandle({
      apiKey: 'cursor-test-key',
      model: 'composer-1',
      cwd: '/home/dev/project',
      storeDir,
      sdkSessionId: 'sess-3',
      agentId: 'agent-fallback',
      agentFactoryImpl: factory,
      storeFactoryImpl: () => ({}),
    });
    assert.equal(handle.agentId, 'agent-fallback');
    await handle.close();
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('startCursorRun sends the model and mode on every send with an onDelta hook', async () => {
  let sent = null;
  const agent = {
    send: (message, opts) => {
      sent = { message, opts };
      return { id: 'run-1', stream: async function* () {} };
    },
  };
  const turn = startCursorRun({
    agent,
    message: { text: 'hi', images: [] },
    model: 'composer-1',
    relayMode: 'plan',
  });
  for await (const _ of turn) void _;
  assert.deepEqual(sent.message, { text: 'hi', images: [] });
  assert.deepEqual(sent.opts.model, { id: 'composer-1' });
  assert.equal(sent.opts.mode, 'plan');
  assert.equal(typeof sent.opts.onDelta, 'function');

  let sentAgain = null;
  const agent2 = {
    send: (message, opts) => {
      sentAgain = opts;
      return { stream: async function* () {} };
    },
  };
  const turn2 = startCursorRun({ agent: agent2, message: { text: 'go' }, model: 'composer-1', relayMode: 'agent' });
  for await (const _ of turn2) void _;
  assert.equal(sentAgain.mode, 'agent');
});

test('startCursorRun forwards model params only when present', async () => {
  let sent = null;
  const agent = {
    send: (message, opts) => {
      sent = opts;
      return { stream: async function* () {} };
    },
  };
  const params = [{ id: 'reasoning', value: 'high' }];
  const turn = startCursorRun({ agent, message: { text: 'hi' }, model: 'gpt-5.4', modelParams: params });
  for await (const _ of turn) void _;
  assert.deepEqual(sent.model, { id: 'gpt-5.4', params });

  const turn2 = startCursorRun({ agent, message: { text: 'hi' }, model: 'gpt-5.4', modelParams: [] });
  for await (const _ of turn2) void _;
  assert.deepEqual(sent.model, { id: 'gpt-5.4' });

  const turn3 = startCursorRun({ agent, message: { text: 'hi' }, model: 'gpt-5.4', modelParams: null });
  for await (const _ of turn3) void _;
  assert.deepEqual(sent.model, { id: 'gpt-5.4' });
});

test('merged iterator preserves delta/stream arrival order', async () => {
  const agent = {
    send: (message, opts) => ({
      id: 'run-1',
      stream: async function* () {
        opts.onDelta({ update: { seq: 'd1' } });
        yield { seq: 'm1' };
        opts.onDelta({ update: { seq: 'd2' } });
        yield { seq: 'm2' };
      },
    }),
  };
  const turn = startCursorRun({ agent, message: { text: 'hi' }, model: 'composer-1' });
  const events = [];
  for await (const event of turn) events.push(event);
  assert.deepEqual(events, [
    { source: 'delta', update: { seq: 'd1' } },
    { source: 'stream', message: { seq: 'm1' } },
    { source: 'delta', update: { seq: 'd2' } },
    { source: 'stream', message: { seq: 'm2' } },
  ]);
});

test('abort ends iteration even when the stream never ends', async () => {
  const controller = new AbortController();
  const agent = {
    send: () => ({
      id: 'run-1',
      stream: async function* () {
        yield { seq: 'm1' };
        await new Promise(() => {});
      },
    }),
  };
  const turn = startCursorRun({
    agent,
    message: { text: 'hi' },
    model: 'composer-1',
    abortSignal: controller.signal,
  });
  const events = [];
  for await (const event of turn) {
    events.push(event);
    controller.abort();
  }
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { source: 'stream', message: { seq: 'm1' } });
});

test('turn.cancel forwards to run.cancel and is a no-op before the run exists', async () => {
  let cancelled = 0;
  const agent = {
    send: () => ({
      id: 'run-7',
      stream: async function* () { yield { seq: 'm1' }; },
      cancel: async () => { cancelled += 1; },
    }),
  };
  const turn = startCursorRun({ agent, message: { text: 'hi' }, model: 'composer-1' });
  assert.equal(turn.runId, '');
  for await (const _ of turn) void _;
  assert.equal(turn.runId, 'run-7');
  await turn.cancel();
  assert.equal(cancelled, 1);

  // No run yet: send never resolves, cancel must still resolve without throwing.
  const pendingTurn = startCursorRun({
    agent: { send: () => new Promise(() => {}) },
    message: { text: 'hi' },
    model: 'composer-1',
  });
  await pendingTurn.cancel();
  assert.equal(pendingTurn.runId, '');
});

test('turn.cancel swallows run.cancel errors', async () => {
  const agent = {
    send: () => ({
      stream: async function* () {},
      cancel: async () => { throw new Error('cancel exploded'); },
    }),
  };
  const turn = startCursorRun({ agent, message: { text: 'hi' }, model: 'composer-1' });
  for await (const _ of turn) void _;
  await turn.cancel();
});

test('send errors reject the first next() call', async () => {
  const agent = { send: async () => { throw new Error('send exploded'); } };
  const turn = startCursorRun({ agent, message: { text: 'hi' }, model: 'composer-1' });
  await assert.rejects(turn[Symbol.asyncIterator]().next(), /send exploded/);
});

test('classifyCursorError maps auth, busy, coded, and plain errors', () => {
  const auth = classifyCursorError({ name: 'AuthenticationError', message: 'bad key' });
  assert.equal(auth.isAuth, true);
  assert.equal(auth.isBusy, false);
  assert.equal(auth.code, 'authentication_failed');
  assert.equal(auth.stableCode, 'cursor.authentication_failed');
  assert.equal(auth.message, 'bad key');

  const busy = classifyCursorError({ name: 'AgentBusyError', message: 'busy', isRetryable: true });
  assert.equal(busy.isBusy, true);
  assert.equal(busy.isAuth, false);
  assert.equal(busy.isRetryable, true);
  assert.equal(busy.stableCode, 'cursor.agent_busy');

  // The live SDK signals busy as UnknownAgentError("… already has active run").
  const liveBusy = classifyCursorError({
    name: 'UnknownAgentError',
    message: 'Agent agent-1234 already has active run',
  });
  assert.equal(liveBusy.isBusy, true);
  assert.equal(liveBusy.stableCode, 'cursor.agent_busy');

  const coded = classifyCursorError({ code: 'rate_limited', message: 'slow down', isRetryable: true });
  assert.equal(coded.code, 'rate_limited');
  assert.equal(coded.stableCode, 'cursor.rate_limited');
  assert.equal(coded.isRetryable, true);

  // Codes are sanitized to [a-z0-9_-].
  const messy = classifyCursorError({ code: ' Rate/Limited! ', message: 'x' });
  assert.equal(messy.code, 'ratelimited');
  assert.equal(messy.stableCode, 'cursor.ratelimited');

  const plain = classifyCursorError(new Error('boom'));
  assert.equal(plain.isAuth, false);
  assert.equal(plain.isBusy, false);
  assert.equal(plain.isRetryable, false);
  assert.equal(plain.code, 'turn-error');
  assert.equal(plain.stableCode, 'cursor.turn-error');
  assert.equal(plain.message, 'boom');

  const stringy = classifyCursorError('just text');
  assert.equal(stringy.stableCode, 'cursor.turn-error');
  assert.equal(stringy.message, 'just text');

  // Backend auth rejections arrive without the AuthenticationError type; the
  // message text is the only reliable signal.
  const backendAuth = classifyCursorError(
    new Error('Authentication error If you are logged in, try logging out and back in.'),
  );
  assert.equal(backendAuth.isAuth, true);
  assert.equal(backendAuth.stableCode, 'cursor.authentication_failed');
});

test('isCursorAuthErrorMessage matches backend auth rejections and nothing else', () => {
  assert.equal(
    isCursorAuthErrorMessage('Authentication error If you are logged in, try logging out and back in.'),
    true,
  );
  assert.equal(isCursorAuthErrorMessage('[unauthenticated] token rejected'), true);
  assert.equal(isCursorAuthErrorMessage('request failed: not authenticated'), true);
  assert.equal(isCursorAuthErrorMessage('Invalid API key provided'), true);
  assert.equal(isCursorAuthErrorMessage('your API key has expired'), true);
  assert.equal(isCursorAuthErrorMessage('model exploded'), false);
  assert.equal(isCursorAuthErrorMessage('Agent agent-1 already has active run'), false);
  assert.equal(isCursorAuthErrorMessage(''), false);
  assert.equal(isCursorAuthErrorMessage(null), false);
});

test('readModelContextWindow normalizes response shapes and field names', async () => {
  const fromArray = await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'shape-array',
    modelsListImpl: async () => [{ id: 'shape-array', contextWindow: 200000 }],
  });
  assert.equal(fromArray, 200000);

  const fromModels = await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'shape-models',
    modelsListImpl: async () => ({ models: [{ name: 'Shape-Models', context_window: 128000 }] }),
  });
  assert.equal(fromModels, 128000);

  const fromData = await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'shape-data',
    modelsListImpl: async () => ({ data: [{ id: 'shape-data', contextLength: 100000 }] }),
  });
  assert.equal(fromData, 100000);

  const fromMax = await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'shape-max',
    modelsListImpl: async () => [{ id: 'SHAPE-MAX', maxContextTokens: 64000 }],
  });
  assert.equal(fromMax, 64000);
});

test('readModelContextWindow derives the window from the context parameter', async () => {
  // Current SDK builds ship no window field; the window is encoded in the
  // 'context' parameter values ('300k' / '1m'), with the default variant
  // deciding what an unmodified send runs with.
  const entry = {
    id: 'param-model',
    parameters: [
      { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
      { id: 'context', values: [{ value: '300k', displayName: '300K' }, { value: '1m', displayName: '1M' }] },
    ],
    variants: [
      { params: [{ id: 'context', value: '300k' }], displayName: 'Param Model' },
      { params: [{ id: 'context', value: '1m' }], displayName: 'Param Model', isDefault: true },
    ],
  };
  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'param-model',
    modelsListImpl: async () => [entry],
  }), 1_000_000);

  // No flagged default: fall back to the largest advertised context.
  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'param-model-nodefault',
    modelsListImpl: async () => [{
      id: 'param-model-nodefault',
      parameters: [{ id: 'context', values: [{ value: '128k' }, { value: '300k' }] }],
      variants: [],
    }],
  }), 300_000);
});

test('readModelContextWindow caches per model', async () => {
  let calls = 0;
  const modelsListImpl = async () => {
    calls += 1;
    return [{ id: 'cached-model', contextWindow: 32000 }];
  };
  assert.equal(await readModelContextWindow({ apiKey: 'cursor-test-key', model: 'cached-model', modelsListImpl }), 32000);
  assert.equal(await readModelContextWindow({ apiKey: 'cursor-test-key', model: 'cached-model', modelsListImpl }), 32000);
  assert.equal(calls, 1);
});

test('readAgentUsage flattens the SDK usage shape', async () => {
  const agent = {
    getUsage: async () => ({
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 36 },
      cost: { rawCostCents: 250, chargedCents: 0 },
      runs: [{ runId: 'a' }, { runId: 'b' }],
    }),
  };
  assert.deepEqual(await readAgentUsage({ agent }), {
    rawCostCents: 250,
    chargedCents: 0,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 36,
    runCount: 2,
  });
});

test('readAgentUsage reports absent cost as null rather than zero', async () => {
  // Cost is eventually consistent, so "not reported yet" must not be booked as
  // a real $0 or the checkpoint diff would swallow the spend when it lands.
  const agent = { getUsage: async () => ({ usage: { totalTokens: 12 }, runs: [] }) };
  const usage = await readAgentUsage({ agent });
  assert.equal(usage.rawCostCents, null);
  assert.equal(usage.chargedCents, null);
  assert.equal(usage.totalTokens, 12);
});

test('readAgentUsage gives up rather than holding the turn open', async () => {
  // getUsage() is a remote read issued while the turn is still finalizing, and
  // the SDK sends it with no abort signal, so a hung Cursor API must cost the
  // usage reading and never the reply.
  const started = Date.now();
  const agent = { getUsage: () => new Promise(() => {}) };
  assert.equal(await readAgentUsage({ agent, timeoutMs: 40 }), null);
  assert.ok(Date.now() - started < 2000, 'timed out promptly instead of hanging');
});

test('readAgentUsage swallows a rejection that lands after the timeout', async () => {
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    const agent = {
      getUsage: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20)),
    };
    assert.equal(await readAgentUsage({ agent, timeoutMs: 5 }), null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('readAgentUsage returns null for an agent that cannot report usage', async () => {
  assert.equal(await readAgentUsage({ agent: {} }), null);
  assert.equal(await readAgentUsage({ agent: { getUsage: async () => null } }), null);
  assert.equal(await readAgentUsage({ agent: { getUsage: async () => { throw new Error('nope'); } } }), null);
});

// Parameter shapes mirror live Cursor models.list entries: GPT models expose a
// 'reasoning' parameter, Claude models 'thinking' + 'effort', Grok 'effort'.
const GPT_ENTRY = {
  id: 'gpt-params-model',
  parameters: [
    { id: 'context', values: [{ value: '272k' }, { value: '1m' }] },
    { id: 'reasoning', values: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'extra-high' }] },
    { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
  ],
};
const CLAUDE_ENTRY = {
  id: 'claude-params-model',
  parameters: [
    { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
    { id: 'effort', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }] },
  ],
};
const GROK_ENTRY = {
  id: 'grok-params-model',
  parameters: [
    { id: 'effort', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
  ],
};
const PLAIN_ENTRY = { id: 'plain-params-model' };

test('resolveCursorReasoningParams maps composer efforts onto model params', async () => {
  const modelsListImpl = async () => [GPT_ENTRY, CLAUDE_ENTRY, GROK_ENTRY, PLAIN_ENTRY];
  const base = { apiKey: 'cursor-test-key', modelsListImpl };

  // 'reasoning' models pass the value straight through; 'extra-high' is xhigh.
  assert.deepEqual(
    await resolveCursorReasoningParams({ ...base, model: 'gpt-params-model', reasoningEffort: 'medium' }),
    [{ id: 'reasoning', value: 'medium' }],
  );
  assert.deepEqual(
    await resolveCursorReasoningParams({ ...base, model: 'gpt-params-model', reasoningEffort: 'xhigh' }),
    [{ id: 'reasoning', value: 'extra-high' }],
  );
  // 'none' is a real value for reasoning models.
  assert.deepEqual(
    await resolveCursorReasoningParams({ ...base, model: 'gpt-params-model', reasoningEffort: 'none' }),
    [{ id: 'reasoning', value: 'none' }],
  );

  // Thinking models pair the effort with thinking=true; 'none' disables thinking.
  assert.deepEqual(
    await resolveCursorReasoningParams({ ...base, model: 'claude-params-model', reasoningEffort: 'max' }),
    [{ id: 'thinking', value: 'true' }, { id: 'effort', value: 'max' }],
  );
  assert.deepEqual(
    await resolveCursorReasoningParams({ ...base, model: 'claude-params-model', reasoningEffort: 'none' }),
    [{ id: 'thinking', value: 'false' }],
  );

  // Effort-only models with no 'none' value fall back to the default variant.
  assert.deepEqual(
    await resolveCursorReasoningParams({ ...base, model: 'grok-params-model', reasoningEffort: 'high' }),
    [{ id: 'effort', value: 'high' }],
  );
  assert.equal(
    await resolveCursorReasoningParams({ ...base, model: 'grok-params-model', reasoningEffort: 'none' }),
    null,
  );
  // Unsupported tiers are omitted rather than guessed.
  assert.equal(
    await resolveCursorReasoningParams({ ...base, model: 'grok-params-model', reasoningEffort: 'max' }),
    null,
  );
});

test('resolveCursorReasoningParams is null without a model, effort, params, or on failure', async () => {
  const modelsListImpl = async () => [PLAIN_ENTRY];
  assert.equal(await resolveCursorReasoningParams({
    apiKey: 'cursor-test-key', model: 'plain-params-model', reasoningEffort: 'high', modelsListImpl,
  }), null);
  assert.equal(await resolveCursorReasoningParams({
    apiKey: 'cursor-test-key', model: '', reasoningEffort: 'high', modelsListImpl,
  }), null);
  assert.equal(await resolveCursorReasoningParams({
    apiKey: 'cursor-test-key', model: 'plain-params-model', reasoningEffort: '', modelsListImpl,
  }), null);
  assert.equal(await resolveCursorReasoningParams({
    apiKey: 'cursor-test-key',
    model: 'unlisted-model-that-throws',
    reasoningEffort: 'high',
    modelsListImpl: async () => { throw new Error('network down'); },
  }), null);
});

test('resolveCursorReasoningParams caches parameter definitions per model', async () => {
  let calls = 0;
  const modelsListImpl = async () => {
    calls += 1;
    return [{ id: 'cached-params-model', parameters: [{ id: 'reasoning', values: [{ value: 'low' }] }] }];
  };
  const base = { apiKey: 'cursor-test-key', model: 'cached-params-model', modelsListImpl };
  assert.deepEqual(await resolveCursorReasoningParams({ ...base, reasoningEffort: 'low' }), [{ id: 'reasoning', value: 'low' }]);
  assert.deepEqual(await resolveCursorReasoningParams({ ...base, reasoningEffort: 'low' }), [{ id: 'reasoning', value: 'low' }]);
  assert.equal(calls, 1);
});

test('readModelContextWindow returns null on failure, no match, or unusable entries', async () => {
  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'missing-model',
    modelsListImpl: async () => [{ id: 'other-model', contextWindow: 1000 }],
  }), null);

  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'throwing-model',
    modelsListImpl: async () => { throw new Error('network down'); },
  }), null);

  // Bare string ids carry no context-window field.
  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'string-model',
    modelsListImpl: async () => ['string-model'],
  }), null);

  // Matching entry without a positive numeric field.
  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: 'no-window-model',
    modelsListImpl: async () => [{ id: 'no-window-model', contextWindow: 'huge' }],
  }), null);

  assert.equal(await readModelContextWindow({
    apiKey: 'cursor-test-key',
    model: '',
    modelsListImpl: async () => [{ id: '', contextWindow: 1 }],
  }), null);
});

// ---------------------------------------------------------------------------
// 2026-08-16 review hardening

test('the merged iterator drains buffered events before surfacing a producer failure', async () => {
  // The consumer awaits an HTTP post per action, so a terminal status frame is
  // often still buffered when the stream throws. Dropping it turned completed
  // turns into hard failures.
  const agent = {
    send: () => ({
      id: 'run-drain',
      stream: async function* () {
        yield { seq: 'partial-text' };
        yield { seq: 'terminal-status' };
        throw new Error('transport died after the terminal frame');
      },
    }),
  };
  const turn = startCursorRun({ agent, message: { text: 'hi' }, model: 'composer-1' });
  // Let the producer finish before the consumer starts, so both frames and the
  // failure are already recorded when iteration begins.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const seen = [];
  let thrown = null;
  try {
    for await (const event of turn) seen.push(event.message?.seq);
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(seen, ['partial-text', 'terminal-status'], 'buffered frames must be delivered');
  assert.match(String(thrown?.message || ''), /transport died/, 'the failure still surfaces after the drain');
});

test('readModelContextWindow caches a resolved-but-absent window without re-hitting the network', async () => {
  let calls = 0;
  const modelsListImpl = async () => {
    calls += 1;
    return [{ id: 'windowless-model', parameters: [], variants: [] }];
  };
  assert.equal(await readModelContextWindow({ apiKey: 'k', model: 'windowless-model', modelsListImpl }), null);
  assert.equal(await readModelContextWindow({ apiKey: 'k', model: 'windowless-model', modelsListImpl }), null);
  assert.equal(calls, 1, 'a structural miss must be cached, not re-fetched every turn');
});

test('readModelContextWindow times out instead of gating the turn, and never caches the failure', async () => {
  let hangs = 0;
  const hangingImpl = () => { hangs += 1; return new Promise(() => {}); };
  const started = Date.now();
  assert.equal(
    await readModelContextWindow({ apiKey: 'k', model: 'timeout-model', modelsListImpl: hangingImpl, timeoutMs: 30 }),
    null,
  );
  assert.ok(Date.now() - started < 5_000, 'a hung models.list must not stall the caller');
  // The failure was transient: a later working lookup succeeds.
  assert.equal(
    await readModelContextWindow({
      apiKey: 'k',
      model: 'timeout-model',
      modelsListImpl: async () => [{ id: 'timeout-model', contextWindow: 64000 }],
    }),
    64000,
  );
  assert.equal(hangs, 1);
});
