import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMeter,
  buildProviderCard,
  buildDetailSection,
  resolveMeterMath,
  clampPercent,
} from './plan-usage-contract.mjs';
import {
  buildCopilotPlanCard,
  buildCopilotWorkerUsageSection,
  normalizeCopilotWorkerUsage,
  resolvePremiumBucketLabel,
  summarizeBillingUsageItems,
} from './plan-usage-copilot.mjs';
import {
  buildClaudePlanCard,
  claudePlanUsageFromResult,
  normalizeClaudePlanUsage,
} from './plan-usage-claude.mjs';
import {
  applyCursorUsageDelta,
  buildCursorPlanCard,
  classifyCursorModelPool,
  emptyCursorPoolTotals,
  normalizeCursorAllowanceSettings,
  resolveCursorBillingCycle,
} from './plan-usage-cursor.mjs';
import { fetchPersonalBillingUsage } from './github-billing-usage.mjs';

// ─── contract ────────────────────────────────────────────────────────────────

test('resolveMeterMath derives the missing corner of used/allowance/remaining', () => {
  assert.deepEqual(
    resolveMeterMath({ allowance: 100, remaining: 40 }),
    { used: 60, allowance: 100, remaining: 40, utilization: 60 },
  );
  assert.deepEqual(
    resolveMeterMath({ allowance: 50, used: 10 }),
    { used: 10, allowance: 50, remaining: 40, utilization: 20 },
  );
});

test('resolveMeterMath keeps a utilization-only provider usable without inventing a denominator', () => {
  const math = resolveMeterMath({ utilization: 42.5 });
  assert.equal(math.utilization, 42.5);
  assert.equal(math.allowance, null);
  assert.equal(math.used, null);
});

test('resolveMeterMath preserves overage as negative remaining while the bar clamps', () => {
  const math = resolveMeterMath({ allowance: 100, used: 130 });
  assert.equal(math.remaining, -30);
  assert.equal(math.utilization, 100);
  assert.equal(clampPercent(130), 100);
});

test('buildMeter returns null when a bucket carries no signal at all', () => {
  assert.equal(buildMeter({ id: 'x', label: 'X' }), null);
  assert.ok(buildMeter({ id: 'x', label: 'X', unlimited: true }));
  assert.ok(buildMeter({ id: 'x', label: 'X', utilization: 0 }));
});

test('buildProviderCard drops non-https links so hrefs stay safe', () => {
  const card = buildProviderCard({
    provider: 'demo',
    label: 'Demo',
    links: [
      { label: 'ok', url: 'https://example.com' },
      { label: 'bad', url: 'javascript:alert(1)' },
      { label: 'insecure', url: 'http://example.com' },
    ],
  });
  assert.deepEqual(card.links, [{ label: 'ok', url: 'https://example.com' }]);
});

test('buildDetailSection keeps a real zero and drops empty rows', () => {
  const section = buildDetailSection({
    id: 's',
    label: 'S',
    rows: [{ label: 'Zero', value: 0 }, { label: 'Empty', value: '' }, { value: 'orphan' }],
  });
  assert.deepEqual(section.rows, [{ label: 'Zero', value: '0', hint: null }]);
});

// ─── Copilot ─────────────────────────────────────────────────────────────────

const copilotSummary = {
  plan: 'copilot_pro',
  resetDate: '2026-09-01',
  chat: { unlimited: true, remaining: null, entitlement: null, percentRemaining: null },
  premiumInteractions: { unlimited: false, remaining: 400, entitlement: 1500, percentRemaining: 26.666 },
  planQuota: { unlimited: false, remaining: 90, entitlement: 100, percentRemaining: 90 },
};

test('the Copilot card renders quota meters with a UTC-anchored reset', () => {
  const card = buildCopilotPlanCard({ summary: copilotSummary, capturedAt: '2026-08-08T00:00:00.000Z' });
  const premium = card.meters.find((meter) => meter.id === 'copilot-premium');
  assert.equal(premium.label, 'AI credits');
  assert.equal(premium.remaining, 400);
  assert.equal(premium.allowance, 1500);
  assert.equal(premium.utilization, 73.33);
  assert.equal(premium.resetAt, '2026-09-01T00:00:00.000Z');
  assert.equal(card.planName, 'copilot_pro');

  const chat = card.meters.find((meter) => meter.id === 'copilot-chat');
  assert.equal(chat.unlimited, true);
});

test('the premium bucket is labelled from the payload, falling back to entitlement size', () => {
  assert.deepEqual(
    resolvePremiumBucketLabel({ premiumInteractions: { unit: 'premium_requests', entitlement: 300 } }),
    { label: 'Premium requests', unit: 'requests' },
  );
  assert.deepEqual(
    resolvePremiumBucketLabel({ premiumInteractions: { entitlement: 300 } }),
    { label: 'Premium requests', unit: 'requests' },
  );
  assert.deepEqual(
    resolvePremiumBucketLabel({ premiumInteractions: { entitlement: 7000 } }),
    { label: 'AI credits', unit: 'credits' },
  );
});

test('billing items fold into product and model totals', () => {
  const summary = summarizeBillingUsageItems([
    { product: 'copilot', model: 'gpt-5', netAmount: 1.5, grossAmount: 2, discountAmount: 0.5, netQuantity: 150 },
    { product: 'copilot', model: 'claude-opus', netAmount: 3, grossAmount: 3, discountAmount: 0, netQuantity: 300 },
    { product: 'actions', netAmount: 0.25, grossAmount: 0.25, discountAmount: 0, quantity: 10 },
  ]);
  assert.equal(summary.netAmount, 4.75);
  assert.equal(summary.byModel[0].name, 'claude-opus');
  assert.equal(summary.byProduct[0].name, 'copilot');
  assert.equal(summary.byProduct[0].net, 4.5);
});

test('a billing failure degrades to quota meters plus an explanatory message', () => {
  const card = buildCopilotPlanCard({
    summary: copilotSummary,
    billing: { items: [], error: 'the token lacks billing permissions' },
  });
  assert.equal(card.status, 'partial');
  assert.ok(card.meters.length >= 2);
  assert.match(card.message, /billing permissions/);
});

// The SDK engine's per-turn ingest. The card's meters come from the
// account-level quota API and cover both engines, so everything below is
// strictly additive detail.
const workerUsagePost = {
  conversationId: 'conv-1',
  messageId: 'q-1',
  model: 'gpt-5.4-mini',
  capturedAt: '2026-08-31T00:00:00.000Z',
  usage: {
    // The premium MULTIPLIER, not money — it must never be read as spend.
    cost: 1,
    totalNanoAiu: 4_500_000,
    inputTokens: 1200,
    outputTokens: 340,
    modelCalls: 3,
    subagentModelCalls: 1,
    quotaSnapshots: { cfi_overage: 2 },
  },
  contextUsage: { currentTokens: 18_000 },
};

test('normalizeCopilotWorkerUsage keeps the fields only the worker can see', () => {
  const usage = normalizeCopilotWorkerUsage(workerUsagePost);
  assert.equal(usage.totalNanoAiu, 4_500_000);
  assert.equal(usage.cfiOverage, 2);
  assert.equal(usage.contextTokens, 18_000);
  assert.equal(usage.model, 'gpt-5.4-mini');
  assert.equal(usage.conversationId, 'conv-1');
  // `cost` is the premium multiplier, so it is deliberately not carried.
  assert.equal('cost' in usage, false);
});

test('normalizeCopilotWorkerUsage rejects payloads with no numbers in them', () => {
  assert.equal(normalizeCopilotWorkerUsage(null), null);
  assert.equal(normalizeCopilotWorkerUsage({}), null);
  assert.equal(normalizeCopilotWorkerUsage({ conversationId: 'conv-1', usage: {} }), null);
});

// Every assertion below pins its own clock: the section is aged against `now`,
// so a wall-clock default would make these tests start failing a week after
// `capturedAt` — with no code change.
const CAPTURED_AT_MS = Date.parse(workerUsagePost.capturedAt);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

test('the worker snapshot renders as an additive detail section', () => {
  const section = buildCopilotWorkerUsageSection(
    normalizeCopilotWorkerUsage(workerUsagePost),
    { now: CAPTURED_AT_MS + 3 * HOUR_MS },
  );
  const rows = Object.fromEntries(section.rows.map((row) => [row.label, row.value]));
  // A turn costs a fraction of a credit; 2-decimal rounding would report "0".
  assert.equal(rows['AI credits'], '0.004500');
  assert.equal(rows['Input tokens'], '1200');
  assert.equal(rows.Overage, '2');
  assert.match(section.note, /gpt-5\.4-mini/);
});

test('the worker section dates itself, because it is one turn and not a total', () => {
  const usage = normalizeCopilotWorkerUsage(workerUsagePost);
  const relative = (offsetMs) => buildCopilotWorkerUsageSection(usage, { now: CAPTURED_AT_MS + offsetMs }).note;

  assert.match(relative(30_000), /as of just now$/);
  assert.match(relative(5 * 60_000), /as of 5 minutes ago$/);
  assert.match(relative(HOUR_MS), /as of 1 hour ago$/);
  assert.match(relative(3 * DAY_MS), /as of 3 days ago$/);
  // Model and age share one note, so neither costs the section a second row.
  assert.equal(relative(HOUR_MS), 'Model gpt-5.4-mini · as of 1 hour ago');
});

test('a worker snapshot older than a week stops being rendered at all', () => {
  // Nothing ever clears this row — switching back to the extension engine just
  // stops writing it — so without a cutoff one turn's numbers would sit under
  // live meters forever, reading as though they were live too.
  const usage = normalizeCopilotWorkerUsage(workerUsagePost);
  assert.ok(buildCopilotWorkerUsageSection(usage, { now: CAPTURED_AT_MS + 7 * DAY_MS - 1 }));
  assert.equal(buildCopilotWorkerUsageSection(usage, { now: CAPTURED_AT_MS + 7 * DAY_MS + 1 }), null);

  const card = buildCopilotPlanCard({
    summary: copilotSummary,
    workerUsage: usage,
    now: CAPTURED_AT_MS + 8 * DAY_MS,
  });
  assert.equal(card.details.some((d) => d.id === 'copilot-sdk-last-turn'), false);
});

test('an undated worker snapshot still renders, without an age', () => {
  // The numbers are real even when the timestamp is missing or unparseable;
  // expiring them would discard good data on the strength of a bad field.
  const undated = { ...normalizeCopilotWorkerUsage(workerUsagePost), capturedAt: null };
  const section = buildCopilotWorkerUsageSection(undated, { now: CAPTURED_AT_MS + 90 * DAY_MS });
  assert.equal(section.note, 'Model gpt-5.4-mini');

  const unparseable = { ...undated, capturedAt: 'last tuesday' };
  assert.equal(
    buildCopilotWorkerUsageSection(unparseable, { now: CAPTURED_AT_MS }).note,
    'Model gpt-5.4-mini · as of last tuesday',
  );
});

test('the Copilot card gains the worker section only when a snapshot exists', () => {
  const now = CAPTURED_AT_MS + HOUR_MS;
  const withoutWorker = buildCopilotPlanCard({ summary: copilotSummary, now });
  assert.equal((withoutWorker.details || []).some((d) => d.id === 'copilot-sdk-last-turn'), false);
  assert.ok(withoutWorker.meters.length >= 2);

  const withWorker = buildCopilotPlanCard({
    summary: copilotSummary,
    workerUsage: normalizeCopilotWorkerUsage(workerUsagePost),
    now,
  });
  assert.ok(withWorker.details.some((d) => d.id === 'copilot-sdk-last-turn'));
  // The meters are untouched by the addition.
  assert.deepEqual(withWorker.meters, withoutWorker.meters);
});

test('a failed quota fetch produces an error card rather than throwing', () => {
  const card = buildCopilotPlanCard({ summary: null, error: 'GitHub token unavailable' });
  assert.equal(card.status, 'error');
  assert.equal(card.meters.length, 0);
  assert.match(card.message, /token unavailable/);
});

test('a bare percent_remaining of 0 reads as unknown, not as fully consumed', () => {
  const card = buildCopilotPlanCard({
    summary: {
      ...copilotSummary,
      premiumInteractions: { remaining: null, entitlement: null, percentRemaining: 0 },
    },
  });
  const premium = card.meters.find((meter) => meter.id === 'copilot-premium');
  assert.equal(premium, undefined);
});

test('percent_remaining of 0 with a denominator still reads as fully consumed', () => {
  const card = buildCopilotPlanCard({
    summary: {
      ...copilotSummary,
      premiumInteractions: { remaining: 0, entitlement: 1500, percentRemaining: 0 },
    },
  });
  const premium = card.meters.find((meter) => meter.id === 'copilot-premium');
  assert.equal(premium.utilization, 100);
  assert.equal(premium.remaining, 0);
});

// ─── Claude ──────────────────────────────────────────────────────────────────

const claudeUsageResponse = {
  session: {
    total_cost_usd: 1.2345,
    total_api_duration_ms: 65_000,
    total_duration_ms: 130_000,
    total_lines_added: 40,
    total_lines_removed: 7,
    model_usage: {
      'claude-opus-5': {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
        webSearchRequests: 0,
        costUSD: 1.2,
        contextWindow: 200_000,
      },
    },
  },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 32, resets_at: '2026-08-08T20:00:00.000Z' },
    seven_day: { utilization: 61.5, resets_at: '2026-08-12T00:00:00.000Z' },
    seven_day_opus: { utilization: 12, resets_at: '2026-08-12T00:00:00.000Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: '2026-08-12T00:00:00.000Z' }],
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'USD' },
  },
  behaviors: {
    day: {
      request_count: 120,
      session_count: 4,
      behaviors: [{ key: 'long_context', pct: 40, count: 48 }],
      agents: [{ name: 'explore', pct: 22 }],
      skills: [],
      plugins: [],
      mcp_servers: [],
    },
  },
};

test('the Claude card exposes every reported limit window plus extra-usage credits', () => {
  const usage = normalizeClaudePlanUsage(claudeUsageResponse);
  const card = buildClaudePlanCard({ usage, capturedAt: '2026-08-08T12:00:00.000Z' });
  const ids = card.meters.map((meter) => meter.id);
  assert.deepEqual(ids, [
    'claude-five_hour',
    'claude-seven_day',
    'claude-seven_day_opus',
    'claude-model_scoped:fable',
    'claude-extra-usage',
  ]);
  const weekly = card.meters.find((meter) => meter.id === 'claude-seven_day');
  assert.equal(weekly.utilization, 61.5);
  assert.equal(weekly.resetAt, '2026-08-12T00:00:00.000Z');
  const extra = card.meters.find((meter) => meter.id === 'claude-extra-usage');
  assert.equal(extra.used, 12.5);
  assert.equal(extra.allowance, 50);
  assert.equal(card.planName, 'Max');
});

test('Claude behaviour attribution is shown but labelled as a local approximation', () => {
  const usage = normalizeClaudePlanUsage(claudeUsageResponse);
  const card = buildClaudePlanCard({ usage });
  const behaviours = card.details.find((section) => section.id === 'claude-behaviors-day');
  assert.ok(behaviours);
  assert.match(behaviours.note, /local transcripts/i);
  assert.ok(card.details.some((section) => section.id === 'claude-agents-day'));
});

test('an API-key Claude session reports session cost with no plan meters', () => {
  const usage = normalizeClaudePlanUsage({
    session: { total_cost_usd: 0.5, model_usage: {} },
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  });
  const card = buildClaudePlanCard({ usage });
  assert.equal(card.meters.length, 0);
  assert.equal(card.status, 'partial');
  assert.match(card.message, /API key or third-party provider/);
});

test('the stable result fields provide a fallback when the experimental call is unavailable', () => {
  const usage = claudePlanUsageFromResult({
    modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 20, costUSD: 0.01 } },
    totalCostUsd: 0.01,
  });
  assert.ok(usage);
  const card = buildClaudePlanCard({ usage });
  assert.ok(card.details.some((section) => section.id === 'claude-models'));
  assert.equal(claudePlanUsageFromResult({}), null);
});

test('normalizeClaudePlanUsage rejects unusable payloads and tolerates partial ones', () => {
  assert.equal(normalizeClaudePlanUsage(null), null);
  assert.equal(normalizeClaudePlanUsage({}), null);
  const partial = normalizeClaudePlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 5 } } });
  assert.equal(partial.windows.length, 1);
  assert.equal(partial.windows[0].resetsAt, null);
});

test('a Claude session with no captured usage explains that no hidden turn is run', () => {
  const card = buildClaudePlanCard({ usage: null });
  assert.equal(card.status, 'unavailable');
  assert.match(card.message, /never from a hidden extra turn/);
});

// ─── Cursor ──────────────────────────────────────────────────────────────────

test('model pools are classified best effort, with router models left unattributed', () => {
  assert.equal(classifyCursorModelPool('composer-2.5'), 'cursor');
  assert.equal(classifyCursorModelPool('cursor-grok-4.5'), 'cursor');
  assert.equal(classifyCursorModelPool('claude-opus-5'), 'other');
  assert.equal(classifyCursorModelPool('gpt-5.6-sol'), 'other');
  assert.equal(classifyCursorModelPool('auto'), 'unclassified');
  assert.equal(classifyCursorModelPool(''), 'unclassified');
  assert.equal(classifyCursorModelPool('something-new'), 'unclassified');
});

test('every model Cursor currently offers lands in a pool, and "default" stays unattributed', () => {
  // Sampled from a live discovered model list. An unrecognized id is not a bug
  // — it surfaces under Unclassified instead of being charged to the wrong
  // pool — but a family the relay routinely runs should be classified.
  const expected = {
    cursor: ['composer-2.5', 'composer-2', 'grok-4.5'],
    other: [
      'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5', 'gpt-5.6-sol', 'gpt-5.3-codex',
      'gemini-3.1-pro', 'kimi-k3', 'glm-5.2',
    ],
    // Router aliases bill to whichever pool served the request, which the SDK
    // never discloses.
    unclassified: ['default', 'auto'],
  };
  for (const [pool, models] of Object.entries(expected)) {
    for (const model of models) {
      assert.equal(classifyCursorModelPool(model), pool, `${model} should classify as ${pool}`);
    }
  }
});

test('the billing cycle follows the configured reset day', () => {
  const cycle = resolveCursorBillingCycle({ resetDay: 15, now: new Date('2026-08-20T10:00:00.000Z') });
  assert.equal(cycle.key, '2026-08-15');
  assert.equal(cycle.endsAt, '2026-09-15T00:00:00.000Z');

  const beforeAnchor = resolveCursorBillingCycle({ resetDay: 15, now: new Date('2026-08-02T10:00:00.000Z') });
  assert.equal(beforeAnchor.key, '2026-07-15');
});

test('a reset day past the end of a short month clamps to its last day', () => {
  const cycle = resolveCursorBillingCycle({ resetDay: 31, now: new Date('2026-02-15T00:00:00.000Z') });
  assert.equal(cycle.key, '2026-01-31');
  assert.equal(cycle.endsAt, '2026-02-28T00:00:00.000Z');
});

test('a cumulative report is diffed against the checkpoint', () => {
  const first = applyCursorUsageDelta({
    checkpoint: null,
    report: { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 120, chargedCents: 0, totalTokens: 900 },
  });
  assert.equal(first.delta.rawCostCents, 120);
  assert.equal(first.pool, 'cursor');
  assert.equal(first.changed, true);

  const second = applyCursorUsageDelta({
    checkpoint: first.checkpoint,
    report: { agentId: 'a1', agentCreated: true, model: 'claude-opus-5', rawCostCents: 200, chargedCents: 30, totalTokens: 1500 },
  });
  assert.equal(second.delta.rawCostCents, 80);
  assert.equal(second.delta.totalTokens, 600);
  assert.equal(second.pool, 'other');
});

test('a backend restatement re-baselines without counting spend twice', () => {
  const restated = applyCursorUsageDelta({
    checkpoint: { agentId: 'a1', agentCreated: true, rawCostCents: 500, totalTokens: 1000 },
    report: { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 450, totalTokens: 900 },
  });
  assert.equal(restated.delta.rawCostCents, 0);
  assert.equal(restated.restated, true);
  // High-water mark: the baseline must not drop, or the recovery back to 500
  // would be booked as fresh spend.
  assert.equal(restated.checkpoint.rawCostCents, 500);
  assert.equal(restated.changed, false);
});

test('recovering after a restatement books nothing until the previous peak is passed', () => {
  let checkpoint = null;
  const observe = (rawCostCents) => {
    const applied = applyCursorUsageDelta({
      checkpoint,
      report: { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents },
    });
    checkpoint = applied.checkpoint;
    return applied.delta.rawCostCents;
  };
  // A dip and recovery must total exactly the real spend, not 550.
  assert.equal(observe(500), 500);
  assert.equal(observe(450), 0);
  assert.equal(observe(500), 0);
  assert.equal(observe(560), 60);
});

test('out-of-order reports from concurrent turns do not inflate the total', () => {
  let checkpoint = null;
  const observe = (rawCostCents) => {
    const applied = applyCursorUsageDelta({
      checkpoint,
      report: { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents },
    });
    checkpoint = applied.checkpoint;
    return applied.delta.rawCostCents;
  };
  const total = observe(100) + observe(300) + observe(200) + observe(300);
  assert.equal(total, 300);
});

test('cost that lags behind a run is picked up whole on the next report', () => {
  const noCost = applyCursorUsageDelta({
    checkpoint: null,
    report: { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: null, totalTokens: 400 },
  });
  assert.equal(noCost.delta.rawCostCents, 0);
  assert.equal(noCost.checkpoint.rawCostCents, null);

  const withCost = applyCursorUsageDelta({
    checkpoint: noCost.checkpoint,
    report: { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 75, totalTokens: 400 },
  });
  assert.equal(withCost.delta.rawCostCents, 75);
});

test('applyCursorUsageDelta rejects reports with no agent or no metrics', () => {
  assert.equal(applyCursorUsageDelta({ report: { model: 'composer-2.5' } }), null);
  assert.equal(applyCursorUsageDelta({ report: { agentId: 'a1' } }), null);
});

test('the Cursor card measures raw cost against the manual allowance and links to Spending', () => {
  const totals = emptyCursorPoolTotals();
  totals.cursor.rawCostCents = 500;
  totals.cursor.chargedCents = 0;
  totals.other.rawCostCents = 1500;
  totals.other.chargedCents = 250;
  const card = buildCursorPlanCard({
    totals,
    allowances: { cursorModelsUsd: 20, otherModelsUsd: 20, resetDay: 1 },
    cycle: resolveCursorBillingCycle({ resetDay: 1, now: new Date('2026-08-08T00:00:00.000Z') }),
  });
  const cursorPool = card.meters.find((meter) => meter.id === 'cursor-cursor');
  assert.equal(cursorPool.used, 5);
  assert.equal(cursorPool.remaining, 15);
  assert.equal(cursorPool.estimated, true);
  assert.equal(cursorPool.resetAt, '2026-09-01T00:00:00.000Z');
  assert.ok(card.links.some((link) => link.url.includes('dashboard/spending')));
  const poolSection = card.details.find((section) => section.id === 'cursor-pools');
  assert.match(poolSection.note, /raw model cost/);
});

test('unattributed spend is surfaced rather than folded into a pool', () => {
  const totals = emptyCursorPoolTotals();
  totals.unclassified.rawCostCents = 300;
  const card = buildCursorPlanCard({ totals, allowances: { resetDay: 1 } });
  const meter = card.meters.find((entry) => entry.id === 'cursor-unclassified');
  assert.equal(meter.used, 3);
  assert.match(card.message, /could not be attributed/);
});

test('a Cursor card without allowances shows spend only', () => {
  const card = buildCursorPlanCard({ totals: emptyCursorPoolTotals(), allowances: {} });
  const cursorPool = card.meters.find((meter) => meter.id === 'cursor-cursor');
  assert.equal(cursorPool.allowance, null);
  assert.match(cursorPool.note, /Set this pool/);
  assert.match(card.message, /No monthly allowance configured/);
});

test('a disabled provider renders a not-configured card', () => {
  const card = buildCursorPlanCard({ configured: false });
  assert.equal(card.status, 'not-configured');
  assert.equal(card.meters.length, 0);
});

test('allowance settings normalize out negatives and clamp the reset day', () => {
  assert.deepEqual(
    normalizeCursorAllowanceSettings({ cursorModelsUsd: -5, otherModelsUsd: '12.345', resetDay: 99 }),
    { cursorModelsUsd: null, otherModelsUsd: 12.35, resetDay: 31 },
  );
  assert.deepEqual(
    normalizeCursorAllowanceSettings({}),
    { cursorModelsUsd: null, otherModelsUsd: null, resetDay: 1 },
  );
});

// ─── github billing ──────────────────────────────────────────────────────────
// `denied` is what lets the relay stop re-issuing requests it already knows
// will fail, so it must only be set when the refusal is about access.

const failWith = (status) => async () => ({
  ok: false,
  status,
  text: async () => '{"message":"nope"}',
});

test('a token without billing scope is reported as denied so it can be cached', async () => {
  const result = await fetchPersonalBillingUsage({ token: 't', login: 'octocat', fetchImpl: failWith(403) });
  assert.equal(result.denied, true);
  assert.equal(result.items.length, 0);
  assert.match(result.error, /manage_billing/);
});

test('a transient server error is not treated as a denial', async () => {
  const result = await fetchPersonalBillingUsage({ token: 't', login: 'octocat', fetchImpl: failWith(500) });
  assert.equal(result.denied, false);
});

test('an endpoint that answers with no usage is not a denial', async () => {
  // Access is fine, this period is simply empty — caching that would hide the
  // first real usage of the month.
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ usageItems: [] }) });
  const result = await fetchPersonalBillingUsage({ token: 't', login: 'octocat', fetchImpl });
  assert.equal(result.denied, false);
  assert.match(result.error, /no billed usage/);
});

test('a supplied login skips the user lookup', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ usageItems: [{ product: 'copilot', netAmount: 1 }] }) };
  };
  const result = await fetchPersonalBillingUsage({ token: 't', login: 'octocat', fetchImpl });
  assert.equal(result.scope, 'octocat');
  assert.equal(urls.some((url) => url.endsWith('/user')), false);
});

test('the first candidate that reports usage wins and reports no error', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('ai_credit')
      ? { usageItems: [], timePeriod: null }
      : { usageItems: [{ product: 'copilot', netAmount: 2 }], timePeriod: { year: 2026, month: 8 } }),
  });
  const result = await fetchPersonalBillingUsage({ token: 't', login: 'octocat', fetchImpl });
  assert.equal(result.error, null);
  assert.equal(result.denied, false);
  assert.deepEqual(result.timePeriod, { year: 2026, month: 8 });
});

test('an agent resumed without a checkpoint seeds the baseline instead of booking its lifetime', () => {
  // getUsage() is a lifetime total: on a fresh install / restored DB the
  // first report for a long-lived agent must not dump historic spend into
  // the current cycle.
  const first = applyCursorUsageDelta({
    checkpoint: null,
    report: { agentId: 'a-resumed', model: 'composer-2.5', rawCostCents: 12_000, totalTokens: 900_000 },
  });
  assert.equal(first.delta.rawCostCents, 0, 'lifetime totals seed, never book');
  assert.equal(first.changed, false);
  assert.equal(first.checkpoint.rawCostCents, 12_000, 'the baseline is the current total');
  // The next report books only the increase since the seed.
  const second = applyCursorUsageDelta({
    checkpoint: first.checkpoint,
    report: { agentId: 'a-resumed', model: 'composer-2.5', rawCostCents: 12_150, totalTokens: 905_000 },
  });
  assert.equal(second.delta.rawCostCents, 150);
  assert.equal(second.changed, true);
});
