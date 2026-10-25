import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeTurnPublisher } from './claude-turn-publisher.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';

const message = { id: 'q-1', conversationId: 'conv-1', relayMode: 'agent', attemptId: 'a-1' };

test('a retried publish reuses the workflow digests drained once, instead of losing them', async () => {
  let drains = 0;
  const bodies = [];
  let failNext = true;
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => {
      if (routePath !== '/api/response') return { ok: true };
      bodies.push(body);
      if (failNext) {
        failNext = false;
        throw new Error('relay 503');
      }
      return { ok: true };
    },
    takeWorkflowRuns: () => {
      drains += 1;
      return drains === 1 ? [{ runId: 'wf-1', status: 'completed' }] : null;
    },
  });

  const workflowRuns = publisher.drainWorkflowRuns();
  assert.equal(await publisher.publishResponse(message, { text: 'merged', kind: 'absorbed', workflowRuns }), 'failed');
  assert.equal(await publisher.publishResponse(message, { text: 'merged', kind: 'absorbed', workflowRuns }), 'published');
  assert.equal(drains, 1, 'drained once');
  assert.deepEqual(bodies[1].workflowRuns, [{ runId: 'wf-1', status: 'completed' }], 'the retry still carries them');
});

test('publishResponse reports outcomes and only requeues an ordinary failed publish', async () => {
  const calls = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => {
      calls.push({ routePath, body });
      if (routePath === '/api/response') throw new Error('relay 503');
      return { ok: true };
    },
  });
  assert.equal(await publisher.publishResponse(message, { text: 'x', kind: 'stopped' }), 'failed');
  assert.equal(await publisher.publishResponse(message, { text: 'x', requeueOnFailure: false }), 'failed');
  assert.equal(calls.filter((call) => call.routePath === '/api/requeue').length, 0);
  assert.equal(await publisher.publishResponse(message, { text: 'x' }), 'requeued');
  assert.equal(calls.filter((call) => call.routePath === '/api/requeue').length, 1);
});

test('consumed steer ids ride the response that finishes their turn', async () => {
  const bodies = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { if (routePath === '/api/response') bodies.push(body); return { ok: true }; },
  });
  await publisher.publishCompletedTurn({
    message,
    state: { result: { text: 'done' }, resultTexts: ['done'], lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
    consumedSteerIds: ['q-2', '', 'q-3'],
  });
  assert.deepEqual(bodies[0].consumedSteerIds, [{ id: 'q-2', attemptId: null }, { id: 'q-3', attemptId: null }]);
});

test('a failed turn names its failure and brings the advice that fits', async () => {
  const bodies = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { if (routePath === '/api/response') bodies.push(body); return { ok: true }; },
  });
  const refusal = 'Your organization has disabled Claude subscription access for Claude Code';
  await publisher.publishErrorResult({
    message,
    state: {
      result: { text: refusal, isError: true, subtype: 'success', assistantError: 'oauth_org_not_allowed', apiErrorStatus: 403, terminalReason: 'api_error' },
      lastStreamedText: '',
    },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishErrorResult({
    message,
    state: { result: { text: '', isError: true, subtype: 'success' }, lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishErrorResult({
    message,
    state: { result: { text: '', isError: true, subtype: 'error_during_execution' }, lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishTurnException({ message, errorText: 'Not logged in' });
  await publisher.publishTurnException({ message, errorText: 'spawn failed' });

  const failures = bodies.map((body) => body.terminalError);
  assert.deepEqual(failures.map((failure) => failure.stableCode), [
    'claude.oauth_org_not_allowed',
    'claude.turn-error',
    'claude.error_during_execution',
    'claude.authentication_failed',
    'claude.turn-error',
  ]);
  assert.equal(failures[0].message, refusal);
  assert.match(failures[0].guidance, /Check the Claude account/);
  assert.doesNotMatch(failures[0].guidance, /retry/i);
  assert.match(failures[3].guidance, /Settings → Providers → Claude → Relogin/);
  // The rest leave the advice to the relay's default.
  for (const index of [1, 2, 4]) assert.ok(!failures[index].guidance, String(index));
  for (const body of bodies) assert.doesNotMatch(JSON.stringify(body), /restart the relay/i);
});

test('a turn refused at the usage limit goes out as a pause, ahead of the general failure', async () => {
  const bodies = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { if (routePath === '/api/response') bodies.push(body); return { ok: true }; },
  });
  const refusal = 'You have hit your session limit';
  const refused = { text: refusal, isError: true, subtype: 'success', assistantError: 'rate_limit', apiErrorStatus: 429, terminalReason: 'api_error' };
  const usageLimit = { rateLimitType: 'five_hour', resetsAt: '2030-01-01T22:00:00.000Z', text: refusal };

  // Taken by the usage-limit classifier: the relay pauses on this kind.
  await publisher.publishErrorResult({
    message,
    state: { result: { ...refused, usageLimit }, lastStreamedText: `Renaming the module now.\n\n${refusal}` },
    responseModel: 'claude-sonnet-5',
  });
  // Not taken (no report from the CLI, as with an API key): a failure like
  // any other, named after the rate limit.
  await publisher.publishErrorResult({
    message,
    state: { result: { ...refused, usageLimit: null }, lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishTurnException({ message, errorText: `Claude Code returned an error result: ${refusal}`, usageLimit });

  assert.equal(bodies[0].terminalError.kind, 'claude-usage-limit');
  assert.equal(bodies[0].terminalError.stableCode, 'claude.usage-limit');
  assert.equal(bodies[0].terminalError.resetsAt, usageLimit.resetsAt);
  assert.equal(bodies[0].terminalError.rateLimitType, 'five_hour');
  // What the turn wrote, without the CLI's own line about the limit.
  assert.equal(bodies[0].partialText, 'Renaming the module now.');

  assert.equal(bodies[1].terminalError.kind, 'claude-turn-failed');
  assert.equal(bodies[1].terminalError.stableCode, 'claude.rate_limit');
  assert.equal('partialText' in bodies[1], false);

  assert.equal(bodies[2].terminalError.kind, 'claude-usage-limit');
  assert.equal(bodies[2].terminalError.resetsAt, usageLimit.resetsAt);
});

test('a backend usage route gets the CLI\'s totals with its session id, in place of the plan usage', async () => {
  const calls = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => {
      calls.push({ routePath, body });
      if (calls.length === 1) throw new Error('relay 503');
      return { ok: true };
    },
    reportsPlanUsage: false,
    usageRoute: '/api/deepseek-plan-usage',
    usageModelKey: (model) => String(model).replace(/\[1m\]$/, ''),
  });
  const modelUsage = {
    'deepseek-flash[1m]': { inputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, outputTokens: 3, costUSD: 9 },
  };
  const state = {
    result: { sessionId: 'native-1', modelUsage, usage: { input_tokens: 2 }, model: 'deepseek-flash[1m]', totalCostUsd: 9 },
    planUsage: null,
    modelUsage,
  };
  const before = Date.now();
  // A failed post is advisory: it does not throw into the turn.
  await publisher.publishPlanUsage({ message, state, sdkSessionId: 'conv-1' });
  await publisher.publishPlanUsage({ message, state, sdkSessionId: 'conv-1' });
  assert.deepEqual(calls.map((call) => call.routePath), ['/api/deepseek-plan-usage', '/api/deepseek-plan-usage']);
  const { at, ...body } = calls[1].body;
  assert.deepEqual(body, {
    conversationId: 'conv-1',
    sdkSessionId: 'conv-1',
    claudeNativeSessionId: 'native-1',
    totals: [{ model: 'deepseek-flash', hitTokens: 1, missTokens: 2, outputTokens: 3 }],
  });
  assert.ok(Date.parse(at) >= before);
  // No session id or no tokens: nothing posted.
  await publisher.publishPlanUsage({ message, state: { ...state, result: { ...state.result, sessionId: '' } }, sdkSessionId: 'conv-1' });
  await publisher.publishPlanUsage({ message, state: { ...state, result: { ...state.result, modelUsage: {} } }, sdkSessionId: 'conv-1' });
  assert.equal(calls.length, 2);

  // The turn's web searches and fetches go along as `requests`, under the
  // relay's model id; they are enough on their own to post.
  const serverToolUse = [{ model: 'deepseek-flash[1m]', webSearchRequests: 2, webFetchRequests: 1 }];
  await publisher.publishPlanUsage({ message, state: { ...state, result: { ...state.result, serverToolUse } }, sdkSessionId: 'conv-1' });
  assert.deepEqual(calls[2].body.totals, [{ model: 'deepseek-flash', hitTokens: 1, missTokens: 2, outputTokens: 3 }]);
  assert.deepEqual(calls[2].body.requests, [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 1 }]);
  await publisher.publishPlanUsage({ message, state: { ...state, result: { ...state.result, modelUsage: {}, usage: null, serverToolUse } }, sdkSessionId: 'conv-1' });
  assert.deepEqual(calls[3].body.totals, []);
  assert.deepEqual(calls[3].body.requests, [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 1 }]);
  assert.equal('runId' in calls[3].body, false);
});

function usagePublisher(calls) {
  return createClaudeTurnPublisher({
    api: async (method, routePath, body) => {
      calls.push(body);
      return { ok: true };
    },
    reportsPlanUsage: false,
    usageRoute: '/api/deepseek-plan-usage',
    usageModelKey: (model) => String(model).replace(/\[1m\]$/, ''),
  });
}

// A result as the CLI reports it: `modelUsage` the session's running totals
// per model, `usage` the turn's own (main loop only), `serverToolUse` the
// turn's web searches and fetches.
function cliResult({ sessionId = 'native-1', modelUsage, usage = {}, serverToolUse = [], model = 'deepseek-flash[1m]' }) {
  return { result: { sessionId, modelUsage, usage, model, serverToolUse }, planUsage: null, modelUsage: null };
}

const flashTotals = (hit, miss, out) => ({ 'deepseek-flash[1m]': { inputTokens: miss, cacheReadInputTokens: hit, cacheCreationInputTokens: 0, outputTokens: out } });
const turnUsage = (hit, miss, out) => ({ input_tokens: miss, cache_read_input_tokens: hit, cache_creation_input_tokens: 0, output_tokens: out });
const totalsOf = (body) => body.totals.map(({ hitTokens, missTokens, outputTokens }) => [hitTokens, missTokens, outputTokens]);

test('with a run id the report names the CLI process and carries its running search and fetch counts', async () => {
  const calls = [];
  const publisher = usagePublisher(calls);
  const turn = (id, serverToolUse, missTokens) => cliResult({
    modelUsage: { 'deepseek-flash[1m]': { inputTokens: missTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1 } },
    serverToolUse,
  });
  const requestsOf = (body) => body.requests ?? null;
  // Turn 1: two searches and a fetch. Published twice (a stopped turn's
  // chain and the stream's end): the counts are added once.
  const first = turn('q-1', [{ model: 'deepseek-flash[1m]', webSearchRequests: 2, webFetchRequests: 1 }], 10);
  await publisher.publishPlanUsage({ message, state: first, sdkSessionId: 'conv-1', runId: 'run-a' });
  await publisher.publishPlanUsage({ message, state: first, sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.equal(calls[0].runId, 'run-a');
  assert.deepEqual(requestsOf(calls[0]), [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 1 }]);
  assert.deepEqual(requestsOf(calls[1]), [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 1 }]);
  // Turn 2: one more search, on a sub-agent's model too. The counts run on.
  const second = turn('q-2', [
    { model: 'deepseek-flash[1m]', webSearchRequests: 1, webFetchRequests: 0 },
    { model: 'deepseek-v4-pro[1m]', webSearchRequests: 0, webFetchRequests: 2 },
  ], 20);
  await publisher.publishPlanUsage({ message, state: second, sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(requestsOf(calls[2]), [
    { model: 'deepseek-flash', searchRequests: 3, fetchRequests: 1 },
    { model: 'deepseek-v4-pro', searchRequests: 0, fetchRequests: 2 },
  ]);
  // Turn 3 without searches still reports the process's counts.
  await publisher.publishPlanUsage({ message, state: turn('q-3', [], 30), sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(requestsOf(calls[3]), requestsOf(calls[2]));
  // A new process (respawn) counts from zero again.
  await publisher.publishPlanUsage({ message, state: turn('q-4', [{ model: 'deepseek-flash[1m]', webSearchRequests: 1, webFetchRequests: 0 }], 40), sdkSessionId: 'conv-1', runId: 'run-b' });
  assert.equal(calls[4].runId, 'run-b');
  assert.deepEqual(requestsOf(calls[4]), [{ model: 'deepseek-flash', searchRequests: 1, fetchRequests: 0 }]);
  await publisher.publishPlanUsage({ message, state: turn('q-5', [], 50), sdkSessionId: 'conv-1', runId: 'run-b' });
  assert.deepEqual(requestsOf(calls[5]), [{ model: 'deepseek-flash', searchRequests: 1, fetchRequests: 0 }]);
  // The token totals are the process's own, from zero: a fresh process's
  // session totals as they are, the stopped turn's double publish once.
  assert.deepEqual(calls.map(totalsOf), [[[0, 10, 1]], [[0, 10, 1]], [[0, 20, 1]], [[0, 30, 1]], [[0, 40, 1]], [[0, 50, 1]]]);
});

test('with a run id the token totals are the process\'s own: a resumed process reports its first turn\'s usage, then what the session totals grow by', async () => {
  const calls = [];
  const publisher = usagePublisher(calls);
  // Process A, spawned fresh on a new session: the CLI's totals are its own.
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(0, 5000, 400), usage: turnUsage(0, 5000, 400) }), sdkSessionId: 'conv-1', runId: 'run-a' });
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(4000, 5600, 450), usage: turnUsage(4000, 600, 50) }), sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(calls.map(totalsOf), [[[0, 5000, 400]], [[4000, 5600, 450]]]);
  // Process A is killed hard before the CLI writes its cost state; process B
  // resumes the session, whose transcript restored the totals after turn 1
  // only. B's first result carries that older snapshot plus its turn: only
  // the turn's own usage is reported, nothing of the restored history.
  const resumed = { sdkSessionId: 'conv-1', runId: 'run-b', resumedSessionId: 'native-1' };
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(4800, 5700, 490), usage: turnUsage(4800, 700, 90) }), ...resumed });
  assert.deepEqual(totalsOf(calls[2]), [[4800, 700, 90]]);
  // B's next turns add what the session totals grew by, a sub-agent's model
  // from its first appearance.
  await publisher.publishPlanUsage({ message, state: cliResult({
    modelUsage: { ...flashTotals(9000, 5900, 520), 'deepseek-v4-pro[1m]': { inputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 20 } },
    usage: turnUsage(4200, 200, 30),
  }), ...resumed });
  assert.deepEqual(calls[3].totals, [
    { model: 'deepseek-flash', hitTokens: 9000, missTokens: 900, outputTokens: 120 },
    { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 300, outputTokens: 20 },
  ]);
  // A result without `modelUsage` adds its usage, and the next result with
  // the totals adds what they grew by beyond it.
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: null, usage: turnUsage(100, 10, 1) }), ...resumed });
  assert.deepEqual(totalsOf(calls[4]), [[9100, 910, 121], [0, 300, 20]]);
  await publisher.publishPlanUsage({ message, state: cliResult({
    modelUsage: { ...flashTotals(9150, 5915, 522), 'deepseek-v4-pro[1m]': { inputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 20 } },
    usage: turnUsage(50, 5, 1),
  }), ...resumed });
  assert.deepEqual(totalsOf(calls[5]), [[9150, 915, 122], [0, 300, 20]]);
  assert.ok(calls.every((call) => call.claudeNativeSessionId === 'native-1'));
});

test('a process spawned without resume reports its totals in full, a session id change within a process counts from zero', async () => {
  const calls = [];
  const publisher = usagePublisher(calls);
  // A respawn without resume (the session's transcript is gone) whose first
  // turn's totals are above anything booked before: all its own.
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(7000, 8000, 900), usage: turnUsage(7000, 8000, 900) }), sdkSessionId: 'conv-1', runId: 'run-c', resumedSessionId: '' });
  assert.deepEqual(totalsOf(calls[0]), [[7000, 8000, 900]]);
  // A /clear: the CLI moves to a new session id and starts its totals over,
  // under the same process. The publisher counts from zero with it, tokens
  // and requests alike; nothing of the old session goes under the new id.
  const searched = [{ model: 'deepseek-flash[1m]', webSearchRequests: 2, webFetchRequests: 0 }];
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(7000, 8100, 910), usage: turnUsage(0, 100, 10), serverToolUse: searched }), sdkSessionId: 'conv-1', runId: 'run-c' });
  assert.deepEqual(calls[1].requests, [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 0 }]);
  await publisher.publishPlanUsage({ message, state: cliResult({ sessionId: 'native-2', modelUsage: flashTotals(0, 300, 30), usage: turnUsage(0, 300, 30), serverToolUse: searched }), sdkSessionId: 'conv-1', runId: 'run-c' });
  assert.equal(calls[2].claudeNativeSessionId, 'native-2');
  assert.equal(calls[2].runId, 'run-c');
  assert.deepEqual(totalsOf(calls[2]), [[0, 300, 30]]);
  assert.deepEqual(calls[2].requests, [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 0 }]);
  await publisher.publishPlanUsage({ message, state: cliResult({ sessionId: 'native-2', modelUsage: flashTotals(250, 350, 35), usage: turnUsage(250, 50, 5) }), sdkSessionId: 'conv-1', runId: 'run-c' });
  assert.deepEqual(totalsOf(calls[3]), [[250, 350, 35]]);
  assert.deepEqual(calls[3].requests, [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 0 }]);
  // The session the process was spawned to resume only matters for its
  // first result: a later result on that id is not read as restored totals.
  const fresh = usagePublisher(calls);
  await fresh.publishPlanUsage({ message, state: cliResult({ sessionId: 'native-3', modelUsage: flashTotals(0, 100, 10), usage: turnUsage(0, 100, 10) }), sdkSessionId: 'conv-1', runId: 'run-d', resumedSessionId: 'native-1' });
  await fresh.publishPlanUsage({ message, state: cliResult({ sessionId: 'native-1', modelUsage: flashTotals(0, 900, 90), usage: turnUsage(0, 100, 10) }), sdkSessionId: 'conv-1', runId: 'run-d', resumedSessionId: 'native-1' });
  assert.deepEqual(calls.slice(4).map(totalsOf), [[[0, 100, 10]], [[0, 900, 90]]]);
});

test('a WebSearch tool call is counted from the CLI\'s totals, where its own request shows up, once across turns, resume and late results', async () => {
  const calls = [];
  const publisher = usagePublisher(calls);
  const normalizer = createSdkMessageNormalizer();
  const noTools = { web_search_requests: 0, web_fetch_requests: 0 };
  const assistant = (id, content) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id, model: 'deepseek-flash[1m]', content, usage: { input_tokens: 40, output_tokens: 8, server_tool_use: noTools } },
  });
  // A turn as the CLI streams it: the main loop's messages, whose usage
  // counts no search, and a result whose `modelUsage` holds the CLI's running
  // totals, the WebSearch tool's internal request (tokens and its search)
  // included. Its `usage` is the main loop's alone.
  const turn = (index, { search = false, totalSearches, missTokens }) => {
    normalizer.normalize({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'deepseek-flash[1m]' });
    if (search) {
      normalizer.normalize(assistant(`msg_${index}a`, [{ type: 'tool_use', id: `toolu_${index}`, name: 'WebSearch', input: { query: 'deepseek pricing' } }]));
      normalizer.normalize({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content: 'Web search results for query: "deepseek pricing" ...' }] },
      });
    }
    normalizer.normalize(assistant(`msg_${index}b`, [{ type: 'text', text: 'Here is what I found.' }]));
    const [action] = normalizer.normalize({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Here is what I found.',
      session_id: 'native-1',
      usage: { input_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 16, server_tool_use: noTools },
      modelUsage: {
        'deepseek-flash[1m]': { inputTokens: missTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 30 * index, webSearchRequests: totalSearches, costUSD: 0 },
      },
    });
    assert.equal(action.channel, 'result');
    assert.deepEqual(action.payload.serverToolUse, [], 'the stream counts no search');
    return { result: action.payload, planUsage: null, modelUsage: null };
  };
  const searchesOf = (body) => (body.requests ?? []).map(({ model, searchRequests, fetchRequests }) => [model, searchRequests, fetchRequests]);

  // Process A: a turn with one WebSearch, then a turn without.
  const searched = turn(1, { search: true, totalSearches: 1, missTokens: 2000 });
  await publisher.publishPlanUsage({ message, state: searched, sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(searchesOf(calls[0]), [['deepseek-flash', 1, 0]]);
  assert.deepEqual(totalsOf(calls[0]), [[0, 2000, 30]], 'the internal request\'s tokens are in the totals');
  const quiet = turn(2, { totalSearches: 1, missTokens: 2500 });
  await publisher.publishPlanUsage({ message, state: quiet, sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(searchesOf(calls[1]), [['deepseek-flash', 1, 0]], 'the running count, not one more');
  // The first turn's result published late, behind the second: nothing more.
  await publisher.publishPlanUsage({ message, state: searched, sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(searchesOf(calls[2]), [['deepseek-flash', 1, 0]]);
  const late = turn(1, { search: true, totalSearches: 1, missTokens: 2000 });
  await publisher.publishPlanUsage({ message, state: late, sdkSessionId: 'conv-1', runId: 'run-a' });
  assert.deepEqual(searchesOf(calls[3]), [['deepseek-flash', 1, 0]], 'an older snapshot under the baseline adds nothing');

  // Process B resumes the session: its first result carries the restored
  // count, which the relay has booked under run A, so it adds no search.
  const resumed = { sdkSessionId: 'conv-1', runId: 'run-b', resumedSessionId: 'native-1' };
  await publisher.publishPlanUsage({ message, state: turn(3, { totalSearches: 1, missTokens: 3000 }), ...resumed });
  assert.deepEqual(searchesOf(calls[4]), []);
  // B's next WebSearch is what the count grows by.
  await publisher.publishPlanUsage({ message, state: turn(4, { search: true, totalSearches: 2, missTokens: 4000 }), ...resumed });
  assert.deepEqual(searchesOf(calls[5]), [['deepseek-flash', 1, 0]]);
});

test('a result published behind a newer one never lowers the baseline: out-of-order snapshots book the growth once', async () => {
  const calls = [];
  const publisher = usagePublisher(calls);
  // A stopped turn's publish chain waits on its usage reads while the next
  // turn finishes: the CLI's totals arrive as 150, then 100 (the stopped
  // turn's, late), then 200. The process spent 200 in all.
  const run = { sdkSessionId: 'conv-1', runId: 'run-e' };
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(0, 150, 15), usage: turnUsage(0, 150, 15) }), ...run });
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(0, 100, 10), usage: turnUsage(0, 100, 10) }), ...run });
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(0, 200, 20), usage: turnUsage(0, 50, 5) }), ...run });
  assert.deepEqual(calls.map(totalsOf), [[[0, 150, 15]], [[0, 150, 15]], [[0, 200, 20]]]);
  // Per field and per model: a late snapshot behind on one model and one
  // field lowers nothing, and a model it does not know is kept.
  const pro = (hit, miss, out) => ({ 'deepseek-v4-pro[1m]': { inputTokens: miss, cacheReadInputTokens: hit, cacheCreationInputTokens: 0, outputTokens: out } });
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: { ...flashTotals(500, 200, 20), ...pro(0, 300, 30) }, usage: turnUsage(500, 0, 0) }), ...run });
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: flashTotals(400, 210, 20), usage: turnUsage(0, 10, 0) }), ...run });
  await publisher.publishPlanUsage({ message, state: cliResult({ modelUsage: { ...flashTotals(500, 210, 21), ...pro(0, 300, 30) }, usage: turnUsage(0, 0, 1) }), ...run });
  assert.deepEqual(calls.slice(3).map((call) => call.totals), [
    [{ model: 'deepseek-flash', hitTokens: 500, missTokens: 200, outputTokens: 20 }, { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 300, outputTokens: 30 }],
    [{ model: 'deepseek-flash', hitTokens: 500, missTokens: 210, outputTokens: 20 }, { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 300, outputTokens: 30 }],
    [{ model: 'deepseek-flash', hitTokens: 500, missTokens: 210, outputTokens: 21 }, { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 300, outputTokens: 30 }],
  ]);
});
