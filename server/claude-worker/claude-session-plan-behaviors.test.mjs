import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  fakeTurn,
  initMessage,
  makeApiStub,
  makeRunner,
  resultMessage,
  waitFor,
} from './claude-session-test-harness.mjs';

const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

const PLAN_ANSWER = {
  session: { total_cost_usd: 0.3, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 12, resets_at: '2099-01-01T05:00:00.000Z' } },
  behaviors: null,
};
const SCANNED = { day: { request_count: 4 } };

// A turn whose CLI answers the usage control request and records how it
// was asked.
function turnWithUsage(calls) {
  const turn = fakeTurn([initMessage('native-1'), { ...resultMessage('done', 'native-1'), total_cost_usd: 0.3 }]);
  turn[USAGE_METHOD] = async (options) => {
    calls.push(options ?? null);
    return options?.skipBehaviors ? PLAN_ANSWER : { ...PLAN_ANSWER, behaviors: SCANNED };
  };
  return turn;
}

// The scan's own process is stood in for: it records what it was asked
// with and answers the full usage, behaviors included.
function runnerWith(stubOptions, calls, scans = []) {
  const stub = makeApiStub(stubOptions);
  const runner = makeRunner({
    stub,
    startImpl: () => turnWithUsage(calls),
    scanPlanBehaviorsImpl: async (...args) => {
      scans.push(args);
      return { ...PLAN_ANSWER, behaviors: SCANNED };
    },
  });
  return { stub, runner };
}

const planPosts = (stub) => stub.calls.filter((call) => call.routePath === '/api/claude-plan-usage');

test('a worker scans only when the relay hands it the scan, and sends the result at once', async () => {
  const calls = [];
  const scans = [];
  const { stub, runner } = runnerWith({
    routeResponses: {
      '/api/claude-plan-usage': (body) => ({ ok: true, behaviorsDue: !body.usage?.behaviors }),
    },
  }, calls, scans);
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  await waitFor(() => planPosts(stub).length === 2, { label: 'the scan result is posted' });
  assert.equal(scans.length, 1);
  assert.equal(scans[0].length, 1, 'the scan gets only the log function, no session Query');
  assert.equal(typeof scans[0][0], 'function');
  assert.deepEqual(calls, [{ skipBehaviors: true }], 'the session\'s CLI saw only its fast read');
  const [turnReport, scanReport] = planPosts(stub);
  assert.equal(turnReport.body.totalCostUsd, 0.3);
  assert.equal(turnReport.body.usage.behaviors, null);
  assert.deepEqual(scanReport.body.usage.behaviors, SCANNED);
  assert.equal(scanReport.body.totalCostUsd, undefined, 'the scan report books no turn cost');
  assert.equal(scanReport.body.conversationId, turnReport.body.conversationId);
});

test('a reply without behaviorsDue, or none at all, starts no scan', async () => {
  for (const reply of [{ ok: true }, { ok: true, behaviorsDue: false }, null]) {
    const calls = [];
    const scans = [];
    const { stub, runner } = runnerWith({ routeResponses: { '/api/claude-plan-usage': reply } }, calls, scans);
    assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(scans.length, 0, `no scan for ${JSON.stringify(reply)}`);
    assert.deepEqual(calls, [{ skipBehaviors: true }]);
    assert.equal(planPosts(stub).length, 1);
  }
});

test('a failed plan usage post starts no scan', async () => {
  const calls = [];
  const scans = [];
  const { runner } = runnerWith({ failRoutes: new Set(['/api/claude-plan-usage']) }, calls, scans);
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scans.length, 0);
});

test('a worker on another backend never scans', async () => {
  const { createClaudeTurnPublisher } = await import('./claude-turn-publisher.mjs');
  for (const backend of [{ reportsPlanUsage: false }, { usageRoute: '/api/deepseek-plan-usage' }]) {
    const scans = [];
    const stub = makeApiStub({ routeResponses: { '/api/claude-plan-usage': { ok: true, behaviorsDue: true } } });
    const publisher = createClaudeTurnPublisher({
      api: stub.api,
      ...backend,
      scanPlanBehaviorsImpl: async (turn) => { scans.push(turn); return null; },
    });
    await publisher.publishPlanUsage({
      message: { ...baseMessage },
      state: { planUsage: PLAN_ANSWER, modelUsage: null, result: { totalCostUsd: 0.3 } },
      sdkSessionId: 'conv-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(scans.length, 0, JSON.stringify(backend));
    assert.equal(planPosts(stub).length, 0);
  }
});
