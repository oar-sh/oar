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

// The Claude API booking's report: both Claude billings send it after every
// turn, beside (not instead of) the subscription's plan usage.
function billingPublisher(extra = {}) {
  const calls = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { calls.push({ routePath, body }); return { ok: true }; },
    billingUsageRoute: '/api/claude-api-usage',
    billingKind: 'claude',
    ...extra,
  });
  return { publisher, calls };
}

const sonnetUsage = (input, output, costUSD, extra = {}) => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD, ...extra,
});

function turnState(modelUsage, usage = { input_tokens: 0, output_tokens: 0 }) {
  return {
    result: { sessionId: 'native-1', model: 'claude-sonnet-5-5', modelUsage, usage },
    planUsage: null,
    modelUsage,
  };
}

test('the billing report goes out beside the plan usage, with the worker\'s kind, the run and the turn', async () => {
  const { publisher, calls } = billingPublisher();
  await publisher.publishPlanUsage({
    message, state: turnState({ 'claude-sonnet-5-5': sonnetUsage(1000, 200, 0.05) }), sdkSessionId: 'sid-1', runId: 'run-1',
  });
  assert.deepEqual(calls.map((call) => call.routePath), ['/api/claude-api-usage', '/api/claude-plan-usage']);
  const report = calls[0].body;
  assert.equal(report.billing, 'claude');
  assert.equal(report.runId, 'run-1');
  assert.equal(report.turnId, 'q-1');
  assert.equal(report.claudeNativeSessionId, 'native-1');
  assert.equal(report.firstResultOfRun, true);
  assert.deepEqual(report.runCounts, [{ model: 'claude-sonnet-5-5', hitTokens: 0, missTokens: 1000, outputTokens: 200, costUsd: 0.05, costUnknown: false }]);
  assert.deepEqual(report.sessionTotals, report.runCounts);
});

test('a run counts its own rise, cost included; a turn published twice counts once', async () => {
  const { publisher, calls } = billingPublisher({ billingKind: 'claude-api' });
  const first = turnState({ 'claude-sonnet-5-5': sonnetUsage(1000, 200, 0.05) });
  const second = turnState({ 'claude-sonnet-5-5': sonnetUsage(1600, 330, 0.09), 'claude-haiku-4-5': sonnetUsage(50, 5, 0.001) });
  for (const state of [first, second, second]) {
    await publisher.publishPlanUsage({ message, state, sdkSessionId: 'sid-1', runId: 'run-1' });
  }
  const reports = calls.filter((call) => call.routePath === '/api/claude-api-usage').map((call) => call.body);
  assert.equal(reports[1].firstResultOfRun, false);
  const sonnet = reports[1].runCounts.find((entry) => entry.model === 'claude-sonnet-5-5');
  assert.equal(sonnet.missTokens, 1600);
  assert.equal(sonnet.outputTokens, 330);
  assert.ok(Math.abs(sonnet.costUsd - 0.09) < 1e-9);
  assert.deepEqual(reports[2].runCounts, reports[1].runCounts);
});

test('a resumed run\'s first result: its own counts are the turn\'s main loop, unpriced; the session totals carry the rest', async () => {
  const { publisher, calls } = billingPublisher({ billingKind: 'claude-api' });
  const state = turnState(
    { 'claude-sonnet-5-5': sonnetUsage(3000, 600, 0.3), 'claude-haiku-4-5': sonnetUsage(100, 10, 0.001, { costBasis: 'unknown' }) },
    { input_tokens: 800, output_tokens: 150 },
  );
  await publisher.publishPlanUsage({ message, state, sdkSessionId: 'sid-1', runId: 'run-2', resumedSessionId: 'native-1' });
  const [report] = calls.filter((call) => call.routePath === '/api/claude-api-usage').map((call) => call.body);
  assert.equal(report.resumedSessionId, 'native-1');
  assert.equal(report.firstResultOfRun, true);
  assert.deepEqual(report.runCounts, [{ model: 'claude-sonnet-5-5', hitTokens: 0, missTokens: 800, outputTokens: 150, costUsd: 0, costUnknown: false }]);
  const haiku = report.sessionTotals.find((entry) => entry.model === 'claude-haiku-4-5');
  assert.equal(haiku.costUnknown, true);
  assert.equal(report.sessionTotals.find((entry) => entry.model === 'claude-sonnet-5-5').missTokens, 3000);
});

test('no billing report without the route (DeepSeek) or without a run', async () => {
  const deepseek = billingPublisher({ billingUsageRoute: null, usageRoute: '/api/deepseek-plan-usage' });
  await deepseek.publisher.publishPlanUsage({
    message, state: turnState({ 'claude-sonnet-5-5': sonnetUsage(1, 1, 0) }), sdkSessionId: 'sid-1', runId: 'run-1',
  });
  assert.deepEqual(deepseek.calls.map((call) => call.routePath), ['/api/deepseek-plan-usage']);
  const noRun = billingPublisher();
  await noRun.publisher.publishPlanUsage({ message, state: turnState({ 'claude-sonnet-5-5': sonnetUsage(1, 1, 0) }), sdkSessionId: 'sid-1' });
  assert.deepEqual(noRun.calls.map((call) => call.routePath), ['/api/claude-plan-usage']);
});

// The token booking (POST /api/turn-token-usage): every
// Claude-family worker posts the turn's tokens per model with the four kinds
// apart, the turn's total so far under the turn's id.
function tokenPublisher(extra = {}) {
  const calls = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { calls.push({ routePath, body }); return { ok: true }; },
    billingUsageRoute: '/api/claude-api-usage',
    billingKind: 'claude',
    turnTokenProvider: 'claude',
    ...extra,
  });
  const posts = () => calls.filter((call) => call.routePath === '/api/turn-token-usage').map((call) => call.body);
  return { publisher, calls, posts };
}

const opusUsage = (input, write, read, output, costUSD, extra = {}) => ({
  inputTokens: input, cacheCreationInputTokens: write, cacheReadInputTokens: read, outputTokens: output, costUSD, ...extra,
});
const fields = (entry) => [entry.inputTokens, entry.cacheWriteTokens, entry.cacheReadTokens, entry.outputTokens];

test('the turn\'s tokens go out with cache writes and reads apart, the turn and the run', async () => {
  const { publisher, calls, posts } = tokenPublisher();
  await publisher.publishPlanUsage({
    message, state: turnState({ 'claude-opus-5-5[1m]': opusUsage(100, 2000, 30000, 400, 0.5) }), sdkSessionId: 'sid-1', runId: 'run-1',
  });
  assert.equal(calls[0].routePath, '/api/turn-token-usage');
  const [post] = posts();
  assert.equal(post.conversationId, 'conv-1');
  assert.equal(post.turnId, 'q-1');
  assert.equal(post.runId, 'run-1');
  assert.equal(post.provider, 'claude');
  assert.equal(post.nativeSessionId, 'native-1');
  assert.deepEqual(post.models, [{
    model: 'claude-opus-5-5', inputTokens: 100, cacheWriteTokens: 2000, cacheReadTokens: 30000, outputTokens: 400,
    costUsd: 0.5, costSource: 'claude-code', costUnknown: false,
  }]);
  // The Claude API booking still folds the writes into its misses.
  const billing = calls.find((call) => call.routePath === '/api/claude-api-usage').body;
  assert.equal(billing.runCounts[0].missTokens, 2100);
});

test('each turn posts what the session totals grew by; a sub-agent\'s model is its own entry', async () => {
  const { publisher, posts } = tokenPublisher();
  await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(100, 1000, 0, 50, 0.2) }), sdkSessionId: 'sid-1', runId: 'run-1' });
  await publisher.publishPlanUsage({
    message: { ...message, id: 'q-2' },
    state: turnState({ 'claude-opus-5-5': opusUsage(160, 1200, 9000, 90, 0.35), 'claude-haiku-5-5': opusUsage(10, 0, 0, 5, 0.001) }),
    sdkSessionId: 'sid-1',
    runId: 'run-1',
  });
  const second = posts()[1];
  assert.equal(second.turnId, 'q-2');
  assert.deepEqual(second.models.map((entry) => [entry.model, ...fields(entry)]), [
    ['claude-opus-5-5', 60, 200, 9000, 40],
    ['claude-haiku-5-5', 10, 0, 0, 5],
  ]);
  assert.ok(Math.abs(second.models[0].costUsd - 0.15) < 1e-9);
});

test('two results in one turn post the turn\'s running total; the same result published twice adds nothing', async () => {
  const { publisher, posts } = tokenPublisher();
  const first = turnState({ 'claude-opus-5-5': opusUsage(100, 0, 0, 10, 0.1) });
  const second = turnState({ 'claude-opus-5-5': opusUsage(150, 0, 500, 30, 0.2) });
  for (const state of [first, first, second]) {
    await publisher.publishPlanUsage({ message, state, sdkSessionId: 'sid-1', runId: 'run-1' });
  }
  assert.deepEqual(posts().map((post) => [post.turnId, ...fields(post.models[0])]), [
    ['q-1', 100, 0, 0, 10],
    ['q-1', 100, 0, 0, 10],
    ['q-1', 150, 0, 500, 30],
  ]);
});

test('a resumed process\'s first result posts the turn\'s main loop, unpriced', async () => {
  const { publisher, posts } = tokenPublisher();
  const state = turnState(
    { 'claude-opus-5-5': opusUsage(9000, 50000, 400000, 3000, 4.2) },
    { input_tokens: 80, cache_creation_input_tokens: 300, cache_read_input_tokens: 7000, output_tokens: 60 },
  );
  state.result.model = 'claude-opus-5-5';
  await publisher.publishPlanUsage({ message, state, sdkSessionId: 'sid-1', runId: 'run-2', resumedSessionId: 'native-1' });
  const [entry] = posts()[0].models;
  assert.deepEqual(fields(entry), [80, 300, 7000, 60]);
  assert.equal(entry.costUsd, null);
  assert.equal(entry.costUnknown, true);
  // Its next turn counts from the restored totals, not from zero.
  await publisher.publishPlanUsage({
    message: { ...message, id: 'q-2' }, state: turnState({ 'claude-opus-5-5': opusUsage(9010, 50000, 400000, 3010, 4.25) }), sdkSessionId: 'sid-1', runId: 'run-2', resumedSessionId: 'native-1',
  });
  assert.deepEqual(fields(posts()[1].models[0]), [10, 0, 0, 10]);
});

test('a late result of an older turn below the baseline posts nothing new', async () => {
  const { publisher, posts } = tokenPublisher();
  const older = turnState({ 'claude-opus-5-5': opusUsage(100, 0, 0, 10, 0.1) });
  const newer = turnState({ 'claude-opus-5-5': opusUsage(180, 0, 0, 20, 0.2) });
  await publisher.publishPlanUsage({ message: { ...message, id: 'q-2' }, state: newer, sdkSessionId: 'sid-1', runId: 'run-1' });
  await publisher.publishPlanUsage({ message, state: older, sdkSessionId: 'sid-1', runId: 'run-1' });
  // The newer turn holds the growth; the older one has nothing of its own left.
  assert.deepEqual(posts().map((post) => post.turnId), ['q-2']);
  assert.deepEqual(fields(posts()[0].models[0]), [180, 0, 0, 20]);
});

test('a /clear (a new CLI session id in the same process) starts the count over', async () => {
  const { publisher, posts } = tokenPublisher({ billingKind: 'claude-api', turnTokenProvider: 'claude-api' });
  await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(100, 0, 0, 10, 0.1) }), sdkSessionId: 'sid-1', runId: 'run-1' });
  const cleared = turnState({ 'claude-opus-5-5': opusUsage(20, 0, 0, 2, 0.01) });
  cleared.result.sessionId = 'native-2';
  await publisher.publishPlanUsage({ message: { ...message, id: 'q-2' }, state: cleared, sdkSessionId: 'sid-1', runId: 'run-1' });
  assert.deepEqual(posts().map((post) => [post.provider, post.nativeSessionId, ...fields(post.models[0])]), [
    ['claude-api', 'native-1', 100, 0, 0, 10],
    ['claude-api', 'native-2', 20, 0, 0, 2],
  ]);
});

test('without a run id the publisher names its own, the same for its whole life', async () => {
  const { publisher, posts } = tokenPublisher({ billingUsageRoute: null });
  await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(1, 0, 0, 1, 0) }), sdkSessionId: 'sid-1' });
  await publisher.publishPlanUsage({ message: { ...message, id: 'q-2' }, state: turnState({ 'claude-opus-5-5': opusUsage(2, 0, 0, 2, 0) }), sdkSessionId: 'sid-1' });
  const [a, b] = posts();
  assert.match(a.runId, /^[0-9a-f-]{36}$/);
  assert.equal(a.runId, b.runId);
  const other = tokenPublisher({ billingUsageRoute: null });
  await other.publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(1, 0, 0, 1, 0) }), sdkSessionId: 'sid-1' });
  assert.notEqual(other.posts()[0].runId, a.runId);
});

test('no token post without a provider (Claude cloud\'s publisher) or without a result', async () => {
  const { publisher, posts } = tokenPublisher({ turnTokenProvider: null });
  await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(1, 0, 0, 1, 0) }), sdkSessionId: 'sid-1', runId: 'run-1' });
  assert.equal(posts().length, 0);
  const noResult = tokenPublisher();
  await noResult.publisher.publishPlanUsage({ message, state: { result: null, planUsage: null, modelUsage: null }, sdkSessionId: 'sid-1', runId: 'run-1' });
  assert.equal(noResult.posts().length, 0);
});

test('a turn re-run by a new CLI process posts that run\'s tokens only, under its own run', async () => {
  const { publisher, posts } = tokenPublisher();
  // q-1 ends with an error result under run-1; the worker's next CLI process re-runs it.
  await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(1_000, 0, 0, 10, 0.1) }), sdkSessionId: 'sid-1', runId: 'run-1' });
  await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(500, 0, 0, 5, 0.05) }), sdkSessionId: 'sid-1', runId: 'run-2' });
  assert.deepEqual(posts().map((post) => [post.turnId, post.runId, ...fields(post.models[0])]), [
    ['q-1', 'run-1', 1_000, 0, 0, 10],
    ['q-1', 'run-2', 500, 0, 0, 5],
  ]);
});

test('a result without modelUsage raises the baseline: modelUsage, then usage alone, then modelUsage counts each turn once', async () => {
  const { publisher, calls, posts } = tokenPublisher({ billingKind: 'claude-api', turnTokenProvider: 'claude-api' });
  const withTotals = (input) => turnState({ 'claude-opus-5-5': opusUsage(input, 0, 0, 0, input / 1000) });
  const usageOnly = turnState(null, { input_tokens: 50, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  usageOnly.result.model = 'claude-opus-5-5';
  await publisher.publishPlanUsage({ message, state: withTotals(100), sdkSessionId: 'sid-1', runId: 'run-1' });
  await publisher.publishPlanUsage({ message: { ...message, id: 'q-2' }, state: usageOnly, sdkSessionId: 'sid-1', runId: 'run-1' });
  // The CLI's running totals now hold both turns: 100 + 50 + this turn's 30.
  await publisher.publishPlanUsage({ message: { ...message, id: 'q-3' }, state: withTotals(180), sdkSessionId: 'sid-1', runId: 'run-1' });
  assert.deepEqual(posts().map((post) => [post.turnId, post.models[0].inputTokens]), [['q-1', 100], ['q-2', 50], ['q-3', 30]]);
  // The Claude API booking's run counts mirror it: 100, 150, 180, never 230.
  const billing = calls.filter((call) => call.routePath === '/api/claude-api-usage').map((call) => call.body.runCounts[0].missTokens);
  assert.deepEqual(billing, [100, 150, 180]);
});

test('the token post never holds the turn: a hanging or failing post, or a throwing price, still lets the publish go on', async () => {
  for (const mode of ['hang', 'reject', 'throw-price']) {
    const calls = [];
    const publisher = createClaudeTurnPublisher({
      api: (method, routePath, body) => {
        calls.push(routePath);
        if (routePath === '/api/turn-token-usage' && mode === 'hang') return new Promise(() => {});
        if (routePath === '/api/turn-token-usage' && mode === 'reject') return Promise.reject(new Error('relay away'));
        return Promise.resolve({ ok: true });
      },
      billingUsageRoute: '/api/claude-api-usage',
      billingKind: 'claude',
      turnTokenProvider: 'claude',
      ...(mode === 'throw-price' ? { turnTokenCost: () => { throw new Error('odd model'); } } : {}),
    });
    await publisher.publishPlanUsage({ message, state: turnState({ 'claude-opus-5-5': opusUsage(1, 0, 0, 1, 0) }), sdkSessionId: 'sid-1', runId: 'run-1' });
    // The bookings after it went out, and the publish returned.
    assert.ok(calls.includes('/api/claude-api-usage'), `${mode}: ${calls.join(', ')}`);
    assert.ok(calls.includes('/api/claude-plan-usage'), `${mode}: ${calls.join(', ')}`);
  }
});
