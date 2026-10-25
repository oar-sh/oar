import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createPlanUsageService } from '../services/plan-usage-service.mjs';
import { makeRouteDeps as baseRouteDeps, invokePost } from './messages-routes-test-harness.mjs';

function makePlanUsageDeps(overrides = {}) {
  const db = new Database(':memory:');
  const planUsageService = createPlanUsageService({ db, now: () => new Date('2026-08-08T12:00:00.000Z') });
  // The grok route validates the conversation's provider binding; 'conv-g' is
  // the well-known grok-bound conversation for these tests.
  const runtimeSessionsByConversation = {
    'conv-g': { id: 'rs-1', provider_type: 'grok', provider_model: 'grok-4.5' },
    'conv-cursor': { id: 'rs-2', provider_type: 'cursor', provider_model: 'composer-2.5' },
    'conv-copilot': { id: 'rs-3', provider_type: 'github', provider_model: 'gpt-5.4-mini' },
    'conv-byok': { id: 'rs-4', provider_type: 'openai', provider_model: 'gpt-5.4-mini' },
    'conv-ds': { id: 'rs-5', provider_type: 'deepseek', provider_model: 'deepseek-flash' },
    'conv-claude': { id: 'rs-6', provider_type: 'claude', provider_model: 'claude-sonnet-5' },
  };
  return {
    db,
    planUsageService,
    deps: baseRouteDeps({
      planUsageService,
      stmts: {
        getRuntimeSessionByConversation: {
          get: (conversationId) => runtimeSessionsByConversation[conversationId] || null,
        },
      },
      getCursorPlanAllowanceSettings: () => ({ cursorModelsUsd: 20, otherModelsUsd: 20, resetDay: 1 }),
      getGrokPlanAllowanceSettings: () => ({ monthlyUsd: 30, resetDay: 1 }),
      ...overrides,
    }),
  };
}

// ─── Claude ──────────────────────────────────────────────────────────────────

test('claude-plan-usage stores a normalized experimental payload', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/claude-plan-usage', deps, {
    conversationId: 'conv-1',
    usage: {
      session: { total_cost_usd: 2, model_usage: {} },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 40, resets_at: '2026-08-08T18:00:00.000Z' } },
    },
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  const stored = planUsageService.readSnapshot('claude');
  assert.equal(stored.payload.subscriptionType, 'max');
  assert.equal(stored.payload.windows[0].utilization, 40);
});

test('claude-plan-usage falls back to the stable result fields', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status } = await invokePost('/api/claude-plan-usage', deps, {
    conversationId: 'conv-1',
    usage: null,
    modelUsage: { 'claude-sonnet-5': { inputTokens: 5, outputTokens: 6, costUSD: 0.02 } },
    totalCostUsd: 0.02,
  });
  assert.equal(status, 200);
  assert.equal(planUsageService.readSnapshot('claude').payload.session.totalCostUsd, 0.02);
});

test('claude-plan-usage rejects a payload with nothing usable', async () => {
  const { deps } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/claude-plan-usage', deps, { conversationId: 'conv-1' });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing usable usage payload');
});

test('claude-plan-usage reports 500 when plan usage storage is absent', async () => {
  const deps = baseRouteDeps({ planUsageService: null });
  const { status, body } = await invokePost('/api/claude-plan-usage', deps, {
    conversationId: 'conv-1',
    totalCostUsd: 1,
    modelUsage: { m: { costUSD: 1 } },
  });
  assert.equal(status, 500);
  assert.equal(body.error, 'Plan usage storage is unavailable');
});

// ─── Cursor ──────────────────────────────────────────────────────────────────

test('cursor-plan-usage books the delta into the model’s pool', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const first = await invokePost('/api/cursor-plan-usage', deps, {
    agentId: 'agent-1', agentCreated: true,
    model: 'composer-2.5',
    rawCostCents: 250,
    chargedCents: 0,
    totalTokens: 1200,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.pool, 'cursor');
  assert.equal(first.body.changed, true);
  assert.equal(first.body.cycle, '2026-08-01');

  const second = await invokePost('/api/cursor-plan-usage', deps, {
    agentId: 'agent-1', agentCreated: true,
    model: 'claude-opus-5',
    rawCostCents: 600,
    chargedCents: 100,
    totalTokens: 3000,
  });
  assert.equal(second.body.pool, 'other');

  const { totals } = planUsageService.readCursorCycleTotals({ resetDay: 1 });
  assert.equal(totals.cursor.rawCostCents, 250);
  assert.equal(totals.other.rawCostCents, 350);
});

test('cursor-plan-usage requires an agent id', async () => {
  const { deps } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/cursor-plan-usage', deps, { rawCostCents: 100 });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing agentId');
});

test('cursor-plan-usage rejects a report with no metrics', async () => {
  const { deps } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/cursor-plan-usage', deps, {
    agentId: 'agent-1', agentCreated: true,
    model: 'composer-2.5',
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing usable usage metrics');
});

test('cursor-plan-usage honours the configured reset day when picking the cycle', async () => {
  const { deps } = makePlanUsageDeps({
    getCursorPlanAllowanceSettings: () => ({ cursorModelsUsd: null, otherModelsUsd: null, resetDay: 15 }),
  });
  const { body } = await invokePost('/api/cursor-plan-usage', deps, {
    agentId: 'agent-1', agentCreated: true,
    model: 'composer-2.5',
    rawCostCents: 100,
  });
  assert.equal(body.cycle, '2026-07-15');
});

// ─── Grok ────────────────────────────────────────────────────────────────────

// ─── Copilot SDK worker ──────────────────────────────────────────────────────

const copilotUsageBody = (overrides = {}) => ({
  conversationId: 'conv-copilot',
  messageId: 'q-1',
  model: 'gpt-5.4-mini',
  capturedAt: '2026-08-08T12:00:00.000Z',
  usage: {
    totalNanoAiu: 12_000_000,
    inputTokens: 900,
    outputTokens: 120,
    modelCalls: 2,
    quotaSnapshots: { cfi_overage: 3 },
  },
  contextUsage: { currentTokens: 4_200 },
  ...overrides,
});

test('copilot-plan-usage stores the SDK worker last-turn snapshot', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody());
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  const stored = planUsageService.readSnapshot('copilot-sdk');
  assert.equal(stored.payload.totalNanoAiu, 12_000_000);
  assert.equal(stored.payload.contextTokens, 4_200);
  assert.equal(stored.payload.cfiOverage, 3);
});

test('copilot-plan-usage refuses a fabricated conversation id', async () => {
  // `github` is the DEFAULT provider binding, so a missing runtime session
  // must 404 rather than defaulting into "yes, that is Copilot". Without this
  // any authenticated poster could invent an id and overwrite the snapshot the
  // whole relay renders.
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({
    conversationId: 'conv-does-not-exist',
  }));
  assert.equal(status, 404);
  assert.equal(body.error, 'Runtime session not found for conversation');
  assert.equal(planUsageService.readSnapshot('copilot-sdk'), null);
});

test('copilot-plan-usage validates the conversation binding', async () => {
  const { deps } = makePlanUsageDeps();
  const missing = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({ conversationId: '' }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'Missing conversationId');

  // A BYOK conversation spends the user's own key, not Copilot quota.
  const byok = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({ conversationId: 'conv-byok' }));
  assert.equal(byok.status, 409);

  const grokBound = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({ conversationId: 'conv-g' }));
  assert.equal(grokBound.status, 409);
});

test('copilot-plan-usage accepts a payload carrying only subagent model calls', async () => {
  // The acceptance check and the normalizer read ONE field list, so a field
  // the normalizer understands can never be rejected as unusable.
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status } = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({
    usage: { subagentModelCalls: 4 },
    contextUsage: null,
  }));
  assert.equal(status, 200);
  assert.equal(planUsageService.readSnapshot('copilot-sdk').payload.subagentModelCalls, 4);
});

test('copilot-plan-usage clamps negative counts to "not reported"', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status } = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({
    usage: { totalNanoAiu: -5_000, inputTokens: -1, outputTokens: 120 },
    contextUsage: null,
  }));
  assert.equal(status, 200);
  const { payload } = planUsageService.readSnapshot('copilot-sdk');
  assert.equal(payload.totalNanoAiu, null);
  assert.equal(payload.inputTokens, null);
  assert.equal(payload.outputTokens, 120);
});

test('copilot-plan-usage rejects a payload with only negative numbers', async () => {
  const { deps } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/copilot-plan-usage', deps, copilotUsageBody({
    usage: { totalNanoAiu: -5_000, modelCalls: -2 },
    contextUsage: null,
  }));
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing usable usage payload');
});

test('grok-plan-usage stores last-turn usage and books cycle spend', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-g',
    model: 'grok-4.5',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsdTicks: 200_000_000, // $0.20
      modelId: 'grok-4.5',
    },
    capturedAt: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.cycle);
  const stored = planUsageService.readSnapshot('grok');
  assert.equal(stored.payload.costUsd, 0.2);
  assert.equal(stored.payload.inputTokens, 100);
  const cycle = planUsageService.readGrokCycleTotals({ resetDay: 1 });
  assert.equal(cycle.totals.costUsd, 0.2);
  assert.equal(cycle.totals.turnCount, 1);
});

test('grok-plan-usage rejects an empty payload', async () => {
  const { deps } = makePlanUsageDeps();
  const { status, body } = await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-g',
    usage: {},
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'Missing usable usage payload');
});

test('grok-plan-usage accumulates across reports', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-g',
    usage: { costUsdTicks: 4_000_000, totalTokens: 100 }, // $0.004
  });
  await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-g',
    usage: { costUsdTicks: 4_000_000, totalTokens: 50 },
  });
  const { totals } = planUsageService.readGrokCycleTotals({ resetDay: 1 });
  // Sub-cent turns must accumulate at full precision, not book as 2x $0.00.
  assert.equal(totals.costUsd, 0.008);
  assert.equal(totals.totalTokens, 150);
  assert.equal(totals.turnCount, 2);
});

test('grok-plan-usage ignores negative values instead of decrementing spend', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-g',
    usage: { costUsd: 0.5, totalTokens: 100 },
  });
  const { status } = await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-g',
    usage: { costUsd: -100, totalTokens: -50 },
  });
  assert.equal(status, 400);
  const { totals } = planUsageService.readGrokCycleTotals({ resetDay: 1 });
  assert.equal(totals.costUsd, 0.5);
});

test('grok-plan-usage validates the conversation binding', async () => {
  const { deps } = makePlanUsageDeps();
  const missingConversation = await invokePost('/api/grok-plan-usage', deps, {
    usage: { costUsd: 0.5 },
  });
  assert.equal(missingConversation.status, 400);

  const unknown = await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-unknown',
    usage: { costUsd: 0.5 },
  });
  assert.equal(unknown.status, 404);

  const wrongProvider = await invokePost('/api/grok-plan-usage', deps, {
    conversationId: 'conv-cursor',
    usage: { costUsd: 0.5 },
  });
  assert.equal(wrongProvider.status, 409);
});

test('buildReport includes Grok only when configured', () => {
  const { planUsageService } = makePlanUsageDeps();
  planUsageService.recordGrokUsageReport({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    costUsd: 0.01,
    modelId: 'grok-4.5',
  }, { resetDay: 1 });

  const hidden = planUsageService.buildReport({
    claudeConfigured: false,
    cursorConfigured: false,
    grokConfigured: false,
  });
  assert.ok(!hidden.providers.some((card) => card.provider === 'grok'));

  const shown = planUsageService.buildReport({
    claudeConfigured: false,
    cursorConfigured: false,
    grokConfigured: true,
    grokAllowances: { monthlyUsd: 30, resetDay: 1 },
  });
  const grok = shown.providers.find((card) => card.provider === 'grok');
  assert.ok(grok);
  assert.equal(grok.meters[0]?.id, 'grok-monthly-spend');
  assert.ok(grok.links.some((link) => link.url === 'https://console.x.ai'));
});

// ─── DeepSeek ────────────────────────────────────────────────────────────────

const deepseekUsageBody = (overrides = {}) => ({
  conversationId: 'conv-ds',
  sdkSessionId: 'conv-ds',
  claudeNativeSessionId: 'native-1',
  // A Wednesday, 02:00 UTC: peak.
  at: '2026-08-05T02:00:00.000Z',
  totals: [{ model: 'deepseek-flash', hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 }],
  ...overrides,
});

test('deepseek-plan-usage books what the session\'s totals add, at the price of the report\'s time', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const peak = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody());
  assert.equal(peak.status, 200);
  assert.deepEqual(peak.body, { ok: true, at: '2026-08-05T02:00:00.000Z', models: ['deepseek-flash'] });
  // Saturday: off-peak, half the price; the session's totals doubled.
  const offPeak = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({
    at: '2026-08-08T02:00:00.000Z',
    totals: [{ model: 'deepseek-flash', hitTokens: 2_000_000, missTokens: 2_000_000, outputTokens: 2_000_000 }],
  }));
  assert.equal(offPeak.status, 200);
  // The same totals again (a restarted worker): accepted, nothing booked.
  const repeated = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({
    at: '2026-08-08T02:01:00.000Z',
    totals: [{ model: 'deepseek-flash', hitTokens: 2_000_000, missTokens: 2_000_000, outputTokens: 2_000_000 }],
  }));
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.models, []);
  // Totals below the checkpoint: a CLI counting from zero again on the same
  // session, booked in full (Saturday, off-peak).
  const restarted = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({
    at: '2026-08-08T03:00:00.000Z',
    totals: [{ model: 'deepseek-flash', hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 }],
  }));
  assert.equal(restarted.status, 200);
  assert.deepEqual(restarted.body.models, ['deepseek-flash']);
  // The turn's web searches and fetches ride along; before 2026-10-31 16:00
  // UTC they are counted and cost nothing, and the totals unchanged book no tokens.
  const searched = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({
    at: '2026-08-08T04:00:00.000Z',
    totals: [{ model: 'deepseek-flash', hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 }],
    requests: [{ model: 'deepseek-flash', searchRequests: 3, fetchRequests: 1 }],
  }));
  assert.equal(searched.status, 200);
  assert.deepEqual(searched.body.models, ['deepseek-flash']);
  const [flash] = planUsageService.readDeepSeekUsageTotals().models;
  assert.deepEqual(flash, {
    model: 'deepseek-flash',
    hitTokens: 3_000_000,
    missTokens: 3_000_000,
    outputTokens: 3_000_000,
    searchRequests: 3,
    fetchRequests: 1,
    turnCount: 4,
    // Peak 1.506 + off-peak 0.753 + off-peak 0.753 (flash: $0.006/$0.30/$1.20 and $0.003/$0.15/$0.60 per 1M).
    costUsd: 3.012,
    costCny: 20.08,
    toolsCostUsd: 0,
    toolsCostCny: 0,
    firstSeenAt: '2026-08-05T02:00:00.000Z',
    lastSeenAt: '2026-08-08T04:00:00.000Z',
  });
  // Requests alone, on a model without token totals, are a turn of their own.
  // (The price from the cutoff is the service test's: a turn time ahead of
  // the relay's clock is taken as the relay's time here.)
  const requestsOnly = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({
    at: '2026-08-08T05:00:00.000Z',
    totals: [],
    requests: [{ model: 'deepseek-v4-pro', searchRequests: 100, fetchRequests: 100 }],
  }));
  assert.equal(requestsOnly.status, 200);
  assert.deepEqual(requestsOnly.body.models, ['deepseek-v4-pro']);
  const pro = planUsageService.readDeepSeekUsageTotals().models.find((entry) => entry.model === 'deepseek-v4-pro');
  assert.deepEqual([pro.searchRequests, pro.fetchRequests, pro.toolsCostUsd, pro.toolsCostCny, pro.costUsd, pro.turnCount], [100, 100, 0, 0, null, 1]);
});

test('deepseek-plan-usage reads a drop by the run id: stale under the same process, a fresh run under another', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const flash = (missTokens, searchRequests = 0) => ({
    totals: [{ model: 'deepseek-flash', hitTokens: 0, missTokens, outputTokens: 0 }],
    ...(searchRequests ? { requests: [{ model: 'deepseek-flash', searchRequests, fetchRequests: 0 }] } : {}),
  });
  // Turn 2's report reaches the relay before turn 1's (a retried post).
  const second = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ runId: 'run-a', ...flash(2_000_000, 2) }));
  assert.deepEqual(second.body.models, ['deepseek-flash']);
  const first = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ runId: 'run-a', ...flash(1_000_000, 1) }));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.models, []);
  // The same report twice adds nothing either, searches included.
  const again = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ runId: 'run-a', ...flash(2_000_000, 2) }));
  assert.deepEqual(again.body.models, []);
  let [row] = planUsageService.readDeepSeekUsageTotals().models;
  assert.deepEqual([row.missTokens, row.searchRequests, row.turnCount], [2_000_000, 2, 1]);
  // A respawned CLI (another run id) counting from zero on the same session
  // is a fresh run, booked in full, its searches from zero too.
  const fresh = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ runId: 'run-b', ...flash(500_000, 1) }));
  assert.deepEqual(fresh.body.models, ['deepseek-flash']);
  [row] = planUsageService.readDeepSeekUsageTotals().models;
  assert.deepEqual([row.missTokens, row.searchRequests, row.turnCount], [2_500_000, 3, 2]);
  const malformed = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ runId: 'run a' }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, 'runId must be a short id');
});

test('deepseek-plan-usage validates the conversation binding', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  const missing = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ conversationId: '' }));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'Missing conversationId');
  const unknown = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ conversationId: 'conv-unknown' }));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'Runtime session not found for conversation');
  for (const conversationId of ['conv-claude', 'conv-g', 'conv-copilot']) {
    const wrong = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody({ conversationId }));
    assert.equal(wrong.status, 409, conversationId);
    assert.equal(wrong.body.error, 'Conversation is not bound to the DeepSeek provider');
  }
  assert.deepEqual(planUsageService.readDeepSeekUsageTotals().models, []);
});

test('deepseek-plan-usage refuses a malformed body and books nothing', async () => {
  const { deps, planUsageService } = makePlanUsageDeps();
  for (const [overrides, error] of [
    [{ totals: null }, 'totals must be a list'],
    [{ totals: [{ model: '', missTokens: 5 }] }, 'Every totals entry needs a valid model id'],
    [{ totals: [{ model: 'deepseek-flash', missTokens: -5 }] }, 'Missing usable usage metrics'],
    [{ requests: 'two' }, 'requests must be a list'],
    [{ requests: [{ model: 'x y', searchRequests: 1 }] }, 'Every requests entry needs a valid model id'],
    [{ claudeNativeSessionId: undefined }, 'Missing or invalid claudeNativeSessionId'],
    [{ at: 'soon' }, 'at must be an ISO time'],
  ]) {
    const { status, body } = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody(overrides));
    assert.equal(status, 400, error);
    assert.equal(body.error, error);
  }
  assert.deepEqual(planUsageService.readDeepSeekUsageTotals().models, []);
});

test('deepseek-plan-usage reports 500 when plan usage storage is absent', async () => {
  const { deps } = makePlanUsageDeps({ planUsageService: null });
  const { status, body } = await invokePost('/api/deepseek-plan-usage', deps, deepseekUsageBody());
  assert.equal(status, 500);
  assert.equal(body.error, 'Plan usage storage is unavailable');
});
