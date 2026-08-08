'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_USD_TICKS_PER_USD,
  buildGrokPlanCard,
  costUsdTicksToUsd,
  extractGrokUsageFromPromptResult,
  normalizeGrokAllowanceSettings,
  normalizeGrokTurnUsage,
} from './plan-usage-grok.mjs';

// Live probe fixture (2026-08-08): short "hi" turn on grok-4.5.
const LIVE_PROMPT_META = {
  sessionId: '019fe303-10ab-76d0-8a6a-23391820f85b',
  totalTokens: 14009,
  modelId: 'grok-4.5',
  inputTokens: 13972,
  outputTokens: 36,
  cachedReadTokens: 7808,
  reasoningTokens: 31,
  usage: {
    inputTokens: 13972,
    outputTokens: 36,
    totalTokens: 14008,
    cachedReadTokens: 7808,
    cacheCreationTokens: 0,
    reasoningTokens: 31,
    modelCalls: 1,
    apiDurationMs: 1478,
    costUsdTicks: 148864000,
    modelUsage: {
      'grok-4.5-build': {
        inputTokens: 13972,
        outputTokens: 36,
        totalTokens: 14008,
        cachedReadTokens: 7808,
        cacheCreationTokens: 0,
        reasoningTokens: 31,
        modelCalls: 1,
        apiDurationMs: 1478,
        costUsdTicks: 148864000,
      },
    },
    numTurns: 1,
  },
};

test('costUsdTicksToUsd converts at the assumed rate without per-turn rounding', () => {
  // 1e9 ticks/USD is an ASSUMPTION pending external calibration against a
  // real console.x.ai charge — this test pins the conversion behavior, it is
  // not evidence the rate is right (see the constant's comment).
  assert.equal(COST_USD_TICKS_PER_USD, 1_000_000_000);
  // Full precision: rounding happens at display time, not before the cycle
  // ledger accumulates the values.
  assert.equal(costUsdTicksToUsd(148864000), 0.148864);
  assert.equal(costUsdTicksToUsd(4_000_000), 0.004);
  assert.equal(costUsdTicksToUsd(null), null);
  assert.equal(costUsdTicksToUsd(-1), null);
});

test('normalizeGrokTurnUsage rejects negative token and cost values', () => {
  // Negative values must read as "not reported", never as bookable amounts
  // that would decrement the cycle spend ledger.
  assert.equal(normalizeGrokTurnUsage({ costUsd: -50 }), null);
  assert.equal(normalizeGrokTurnUsage({ inputTokens: -100, outputTokens: -5 }), null);
  const mixed = normalizeGrokTurnUsage({ inputTokens: 10, costUsd: -50 });
  assert.equal(mixed.inputTokens, 10);
  assert.equal(mixed.costUsd, null);
});

test('normalizeGrokTurnUsage ignores duration-only payloads', () => {
  // apiDurationMs alone carries no tokens or cost and must not increment the
  // cycle turn counter.
  assert.equal(normalizeGrokTurnUsage({ apiDurationMs: 1478 }), null);
});

test('sub-cent turn costs survive accumulation', () => {
  // Two 0.4-cent turns must sum to 0.8 cents, not 2x $0.00.
  const first = normalizeGrokTurnUsage({ costUsdTicks: 4_000_000 });
  const second = normalizeGrokTurnUsage({ costUsdTicks: 4_000_000 });
  assert.equal(first.costUsd + second.costUsd, 0.008);
});

test('extractGrokUsageFromPromptResult reads live _meta.usage shape', () => {
  const usage = extractGrokUsageFromPromptResult({ stopReason: 'end_turn', _meta: LIVE_PROMPT_META });
  assert.ok(usage);
  assert.equal(usage.modelId, 'grok-4.5');
  assert.equal(usage.inputTokens, 13972);
  assert.equal(usage.outputTokens, 36);
  assert.equal(usage.costUsd, 0.148864);
  assert.equal(usage.modelUsage.length, 1);
  assert.equal(usage.modelUsage[0].model, 'grok-4.5-build');
  assert.equal(usage.modelUsage[0].costUsd, 0.148864);
});

test('normalizeGrokTurnUsage keeps model names when re-normalizing an array-shaped modelUsage', () => {
  // A worker re-posting an already-normalized blob ships modelUsage as an
  // array; the array indices must not become the model names.
  const usage = normalizeGrokTurnUsage({
    costUsd: 0.2,
    modelUsage: [{ model: 'grok-4.5-build', inputTokens: 10, costUsd: 0.2 }],
  });
  assert.equal(usage.modelUsage.length, 1);
  assert.equal(usage.modelUsage[0].model, 'grok-4.5-build');
});

test('normalizeGrokTurnUsage accepts a flattened worker body', () => {
  const usage = normalizeGrokTurnUsage({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    costUsd: 0.01,
    modelId: 'grok-4.5',
  });
  assert.equal(usage.totalTokens, 12);
  assert.equal(usage.costUsd, 0.01);
});

test('normalizeGrokTurnUsage returns null for empty payloads', () => {
  assert.equal(normalizeGrokTurnUsage(null), null);
  assert.equal(normalizeGrokTurnUsage({}), null);
});

test('buildGrokPlanCard hides nothing when configured=false (caller filters)', () => {
  assert.equal(buildGrokPlanCard({ configured: false }), null);
});

test('buildGrokPlanCard shows unavailable without snapshot', () => {
  const card = buildGrokPlanCard({ configured: true, usage: null, cycleTotals: null });
  assert.equal(card.provider, 'grok');
  assert.equal(card.status, 'unavailable');
  assert.ok(card.links.some((link) => link.url === 'https://console.x.ai'));
});

test('buildGrokPlanCard shows last-turn detail without allowance meter', () => {
  const usage = extractGrokUsageFromPromptResult({ _meta: LIVE_PROMPT_META });
  const card = buildGrokPlanCard({
    configured: true,
    usage,
    cycleTotals: { costUsd: 0.15, inputTokens: 13972, outputTokens: 36, totalTokens: 14008, turnCount: 1 },
  });
  assert.equal(card.provider, 'grok');
  assert.equal(card.status, 'partial');
  assert.equal(card.meters.length, 0);
  assert.ok(card.details.some((d) => d.id === 'grok-last-turn'));
  assert.ok(card.links[0].url.includes('console.x.ai'));
});

test('buildGrokPlanCard adds estimated monthly meter when allowance is set', () => {
  const usage = extractGrokUsageFromPromptResult({ _meta: LIVE_PROMPT_META });
  const card = buildGrokPlanCard({
    configured: true,
    usage,
    cycleTotals: { costUsd: 5, inputTokens: 1000, outputTokens: 100, totalTokens: 1100, turnCount: 3 },
    allowances: { monthlyUsd: 30, resetDay: 1 },
  });
  assert.equal(card.status, 'ok');
  assert.equal(card.meters.length, 1);
  assert.equal(card.meters[0].id, 'grok-monthly-spend');
  assert.equal(card.meters[0].estimated, true);
  assert.equal(card.meters[0].allowance, 30);
  assert.equal(card.meters[0].used, 5);
});

test('normalizeGrokAllowanceSettings clamps reset day', () => {
  assert.deepEqual(normalizeGrokAllowanceSettings({ monthlyUsd: 10, resetDay: 40 }), {
    monthlyUsd: 10,
    resetDay: 31,
  });
  assert.equal(normalizeGrokAllowanceSettings({ monthlyUsd: -1 }).monthlyUsd, null);
});

test('normalizeGrokAllowanceSettings treats a $0 allowance as unset', () => {
  assert.equal(normalizeGrokAllowanceSettings({ monthlyUsd: 0 }).monthlyUsd, null);
});

test('buildGrokPlanCard shows the live weekly quota bar with reset date', () => {
  const card = buildGrokPlanCard({
    configured: true,
    usage: null,
    cycleTotals: null,
    billing: {
      usagePercent: 25,
      periodType: 'weekly',
      periodStart: '2026-08-04T15:53:24.625Z',
      periodEnd: '2026-08-11T15:53:24.625Z',
      products: [{ product: 'GrokBuild', usagePercent: 25 }],
    },
  });
  // Live quota alone is enough for a full card — no turn snapshot required.
  assert.equal(card.status, 'ok');
  assert.equal(card.source, 'live');
  const meter = card.meters.find((m) => m.id === 'grok-plan-quota');
  assert.ok(meter);
  assert.equal(meter.unit, 'percent');
  assert.equal(meter.utilization, 25);
  assert.equal(meter.estimated, false);
  assert.equal(meter.resetAt, '2026-08-11T15:53:24.625Z');
  assert.match(meter.note, /GrokBuild 25%/);
});

test('buildGrokPlanCard demotes the estimated meter when the live quota is present', () => {
  const card = buildGrokPlanCard({
    configured: true,
    usage: null,
    cycleTotals: { costUsd: 2.45, inputTokens: 1, outputTokens: 1, totalTokens: 2, turnCount: 5 },
    allowances: { monthlyUsd: 30, resetDay: 1 },
    billing: { usagePercent: 25, periodType: 'weekly', periodStart: null, periodEnd: null, products: [] },
  });
  const quota = card.meters.find((m) => m.id === 'grok-plan-quota');
  const spend = card.meters.find((m) => m.id === 'grok-monthly-spend');
  assert.equal(quota.emphasis, 'primary');
  assert.equal(spend.emphasis, 'secondary');
  assert.equal(card.source, 'live');
});

test('buildGrokPlanCard reports worker source for a fresh snapshot without allowance', () => {
  const usage = extractGrokUsageFromPromptResult({ _meta: LIVE_PROMPT_META });
  const card = buildGrokPlanCard({
    configured: true,
    usage,
    cycleTotals: { costUsd: 0.15, inputTokens: 13972, outputTokens: 36, totalTokens: 14008, turnCount: 1 },
  });
  // A last-turn snapshot is worker-reported data, not a cached copy of some
  // fresher source — the "Cached" badge would be wrong.
  assert.equal(card.source, 'worker');
  assert.equal(card.stale, false);
});
