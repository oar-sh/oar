'use strict';

/**
 * Cursor plan usage.
 *
 * The Cursor SDK reports authoritative *spend* (`agent.getUsage()` →
 * `rawCostCents` / `chargedCents` plus token counts) but exposes no documented
 * account API for the monthly included pools, their remaining balance, or the
 * billing reset date — those live only in the Spending dashboard. So the plan
 * side is reconstructed locally:
 *
 *  - the user configures a monthly allowance per pool and a reset day;
 *  - every worker report is diffed against a per-agent cumulative checkpoint;
 *  - the diff is attributed to a pool using the model that ran that turn and
 *    accumulated into the current billing cycle.
 *
 * Diffing per turn (rather than classifying the SDK's `runs[]`, which carry no
 * model) is what makes pool attribution possible at all: the relay knows which
 * model it asked for, and the cumulative delta since the previous checkpoint is
 * exactly that turn's cost.
 *
 * Everything derived this way is flagged `estimated` — the Spending dashboard
 * stays the authoritative source and is linked from the card.
 */

import {
  SOURCE_LIVE,
  SOURCE_MANUAL,
  STATUS_NOT_CONFIGURED,
  STATUS_OK,
  STATUS_PARTIAL,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  buildUnavailableCard,
  roundCurrency,
  toFiniteNumber,
  toIsoTimestamp,
  toTrimmedString,
} from './plan-usage-contract.mjs';

export const CURSOR_PROVIDER_ID = 'cursor';
export const CURSOR_LABEL = 'Cursor';

export const CURSOR_SPENDING_URL = 'https://cursor.com/dashboard/spending';

export const POOL_CURSOR_MODELS = 'cursor';
export const POOL_OTHER_MODELS = 'other';
export const POOL_UNCLASSIFIED = 'unclassified';
export const CURSOR_POOLS = Object.freeze([POOL_CURSOR_MODELS, POOL_OTHER_MODELS, POOL_UNCLASSIFIED]);

export const POOL_LABELS = Object.freeze({
  [POOL_CURSOR_MODELS]: 'Cursor Models',
  [POOL_OTHER_MODELS]: 'Other Models',
  [POOL_UNCLASSIFIED]: 'Unclassified',
});

export const DEFAULT_CURSOR_RESET_DAY = 1;

// Router/auto selections bill to whichever pool served the request, which the
// SDK does not disclose — they must not be silently charged to one pool.
const ROUTER_MODEL_PATTERNS = [/^auto$/i, /router/i, /^cost$/i, /^balance$/i, /^intelligence$/i];
// "Cursor Models" per Cursor's usage-limits docs: Composer plus Cursor's own
// Grok tier.
const FIRST_PARTY_PATTERNS = [/^composer/i, /^cursor-/i, /grok/i, /^cheetah/i, /^sonic/i];
const THIRD_PARTY_PATTERNS = [
  /claude/i, /sonnet/i, /opus/i, /haiku/i, /fable/i,
  /^gpt/i, /^o[1-9]/i, /codex/i,
  /gemini/i, /deepseek/i, /kimi/i, /qwen/i, /llama/i, /mistral/i, /^glm/i, /minimax/i,
];

export function classifyCursorModelPool(model) {
  const id = toTrimmedString(model);
  if (!id) return POOL_UNCLASSIFIED;
  if (ROUTER_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return POOL_UNCLASSIFIED;
  if (FIRST_PARTY_PATTERNS.some((pattern) => pattern.test(id))) return POOL_CURSOR_MODELS;
  if (THIRD_PARTY_PATTERNS.some((pattern) => pattern.test(id))) return POOL_OTHER_MODELS;
  return POOL_UNCLASSIFIED;
}

export function centsToUsd(cents) {
  const numeric = toFiniteNumber(cents);
  return numeric === null ? null : Math.round(numeric) / 100;
}

export function normalizeCursorResetDay(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return DEFAULT_CURSOR_RESET_DAY;
  return Math.max(1, Math.min(31, Math.round(numeric)));
}

export function normalizeAllowanceUsd(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
}

export function normalizeCursorAllowanceSettings(raw = {}) {
  return {
    cursorModelsUsd: normalizeAllowanceUsd(raw?.cursorModelsUsd),
    otherModelsUsd: normalizeAllowanceUsd(raw?.otherModelsUsd),
    resetDay: normalizeCursorResetDay(raw?.resetDay),
  };
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Resolve the billing cycle that `now` falls into for a recurring monthly reset
 * day. A reset day past the end of a short month clamps to that month's last
 * day, so a "31st" cycle still works in February.
 */
export function resolveCursorBillingCycle({ resetDay = DEFAULT_CURSOR_RESET_DAY, now = new Date() } = {}) {
  const day = normalizeCursorResetDay(resetDay);
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();

  const anchorFor = (targetYear, targetMonth) => {
    const normalizedYear = targetYear + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;
    const clampedDay = Math.min(day, daysInMonth(normalizedYear, normalizedMonth));
    return new Date(Date.UTC(normalizedYear, normalizedMonth, clampedDay, 0, 0, 0, 0));
  };

  const thisMonthAnchor = anchorFor(year, month);
  const startsAt = reference.getTime() >= thisMonthAnchor.getTime()
    ? thisMonthAnchor
    : anchorFor(year, month - 1);
  const endsAt = anchorFor(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1);

  return {
    key: startsAt.toISOString().slice(0, 10),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    resetDay: day,
  };
}

const NUMERIC_REPORT_FIELDS = [
  'rawCostCents',
  'chargedCents',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'runCount',
];

export function normalizeCursorUsageReport(raw = {}) {
  const agentId = toTrimmedString(raw?.agentId);
  if (!agentId) return null;
  const report = {
    agentId,
    model: toTrimmedString(raw?.model),
    capturedAt: toIsoTimestamp(raw?.capturedAt) || new Date().toISOString(),
  };
  let hasMetric = false;
  for (const field of NUMERIC_REPORT_FIELDS) {
    const value = toFiniteNumber(raw?.[field]);
    // Negative cumulative counters are nonsense; treat them as "not reported"
    // rather than letting them drive a negative delta.
    report[field] = value === null || value < 0 ? null : value;
    if (report[field] !== null) hasMetric = true;
  }
  return hasMetric ? report : null;
}

/**
 * Diff a cumulative per-agent report against the stored checkpoint.
 *
 * `agent.getUsage()` returns totals for the agent's whole lifetime, so only the
 * increase since the previous report belongs to the current cycle. A field that
 * moves *backwards* means the backend restated it (cost is documented as
 * eventually consistent) or that reports arrived out of order; the checkpoint
 * then holds its previous high-water mark and nothing is booked. Lowering the
 * baseline instead would re-book the difference when the value recovered.
 *
 * Known limit of the "diff per turn" approach: cost that lands after the turn
 * that incurred it is attributed to whichever turn's model/cycle observes it.
 * That is inherent to a locally reconstructed figure and is why the whole
 * Cursor card is flagged as estimated.
 */
export function applyCursorUsageDelta({ checkpoint = null, report = null } = {}) {
  // Always normalize: the worker sends raw values, and skipping this for
  // anything that merely carries an agentId would let unvalidated (or entirely
  // metric-free) payloads through.
  const normalized = normalizeCursorUsageReport(report);
  if (!normalized) return null;

  const previous = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const delta = {};
  const nextCheckpoint = { agentId: normalized.agentId, capturedAt: normalized.capturedAt };
  let restated = false;
  let hasIncrease = false;

  for (const field of NUMERIC_REPORT_FIELDS) {
    const current = normalized[field];
    const priorRaw = toFiniteNumber(previous?.[field]);
    const prior = priorRaw === null || priorRaw < 0 ? null : priorRaw;
    if (current === null) {
      // Not reported this time (cost lags behind a finished run) — keep the
      // baseline so the value is picked up whole on a later report.
      delta[field] = 0;
      nextCheckpoint[field] = prior;
      continue;
    }
    const increase = prior === null ? current : current - prior;
    if (increase < 0) restated = true;
    delta[field] = increase > 0 ? increase : 0;
    if (delta[field] > 0) hasIncrease = true;
    // High-water mark: never lower the baseline, or a value that dips and then
    // recovers would be counted a second time on the way back up.
    nextCheckpoint[field] = increase < 0 ? prior : current;
  }

  return {
    agentId: normalized.agentId,
    model: normalized.model,
    pool: classifyCursorModelPool(normalized.model),
    capturedAt: normalized.capturedAt,
    delta,
    checkpoint: nextCheckpoint,
    restated,
    changed: hasIncrease,
  };
}

export function emptyCursorPoolTotals() {
  const totals = {};
  for (const pool of CURSOR_POOLS) {
    totals[pool] = {
      rawCostCents: 0,
      chargedCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      runCount: 0,
    };
  }
  return totals;
}

function formatUsd(value) {
  const numeric = roundCurrency(value);
  return numeric === null ? null : `$${numeric.toFixed(2)}`;
}

function formatTokens(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  if (numeric < 1000) return String(Math.round(numeric));
  if (numeric < 1_000_000) return `${(numeric / 1000).toFixed(1)}k`;
  return `${(numeric / 1_000_000).toFixed(1)}M`;
}

function poolTotals(totals, pool) {
  const entry = totals?.[pool];
  if (!entry || typeof entry !== 'object') return null;
  return {
    rawCostUsd: centsToUsd(entry.rawCostCents) ?? 0,
    chargedUsd: centsToUsd(entry.chargedCents) ?? 0,
    inputTokens: toFiniteNumber(entry.inputTokens) || 0,
    outputTokens: toFiniteNumber(entry.outputTokens) || 0,
    cacheReadTokens: toFiniteNumber(entry.cacheReadTokens) || 0,
    cacheWriteTokens: toFiniteNumber(entry.cacheWriteTokens) || 0,
    totalTokens: toFiniteNumber(entry.totalTokens) || 0,
    runCount: toFiniteNumber(entry.runCount) || 0,
  };
}

export function buildCursorPlanCard({
  totals = null,
  allowances = null,
  cycle = null,
  capturedAt = null,
  configured = true,
  message = null,
  // normalizeCursorDashboardUsage() — live plan quota from cursor.com's
  // dashboard API (requires the user-provided session token).
  dashboard = null,
  // { configured, source } from the dashboard-token settings. Lets the card
  // explain an empty panel instead of silently showing $0.00 estimates; null
  // when the caller cannot tell.
  dashboardAuth = null,
} = {}) {
  if (!configured) {
    return buildUnavailableCard({
      provider: CURSOR_PROVIDER_ID,
      label: CURSOR_LABEL,
      status: STATUS_NOT_CONFIGURED,
      message: 'Cursor is not enabled in provider settings.',
      links: [{ label: 'Cursor Spending dashboard', url: CURSOR_SPENDING_URL }],
    });
  }

  const settings = normalizeCursorAllowanceSettings(allowances || {});
  const resolvedCycle = cycle || resolveCursorBillingCycle({ resetDay: settings.resetDay });
  const resolvedTotals = totals || emptyCursorPoolTotals();

  const allowanceByPool = {
    [POOL_CURSOR_MODELS]: settings.cursorModelsUsd,
    [POOL_OTHER_MODELS]: settings.otherModelsUsd,
    [POOL_UNCLASSIFIED]: null,
  };

  const meters = [];
  const hasLiveQuota = toFiniteNumber(dashboard?.totalPercentUsed) !== null
    || toFiniteNumber(dashboard?.apiPercentUsed) !== null
    || toFiniteNumber(dashboard?.autoPercentUsed) !== null;
  if (hasLiveQuota) {
    const resetAt = dashboard.billingCycleEnd || null;
    if (toFiniteNumber(dashboard.totalPercentUsed) !== null) {
      meters.push(buildMeter({
        id: 'cursor-plan-total',
        label: 'Plan usage (total)',
        unit: 'percent',
        utilization: dashboard.totalPercentUsed,
        resetAt,
        estimated: false,
        emphasis: 'primary',
        note: 'Live from the Cursor dashboard.',
      }));
    }
    if (toFiniteNumber(dashboard.autoPercentUsed) !== null) {
      meters.push(buildMeter({
        id: 'cursor-plan-auto',
        label: 'Auto + Composer',
        unit: 'percent',
        utilization: dashboard.autoPercentUsed,
        resetAt,
        estimated: false,
        emphasis: 'secondary',
      }));
    }
    if (toFiniteNumber(dashboard.apiPercentUsed) !== null) {
      meters.push(buildMeter({
        id: 'cursor-plan-api',
        label: 'API',
        unit: 'percent',
        utilization: dashboard.apiPercentUsed,
        resetAt,
        estimated: false,
        emphasis: 'secondary',
      }));
    }
  }
  let unclassifiedSpend = 0;
  for (const pool of CURSOR_POOLS) {
    const entry = poolTotals(resolvedTotals, pool);
    if (!entry) continue;
    const allowance = allowanceByPool[pool];
    if (pool === POOL_UNCLASSIFIED) {
      unclassifiedSpend = entry.rawCostUsd;
      if (entry.rawCostUsd <= 0) continue;
      meters.push(buildMeter({
        id: 'cursor-unclassified',
        label: POOL_LABELS[pool],
        unit: 'usd',
        used: entry.rawCostUsd,
        estimated: true,
        emphasis: 'secondary',
        note: 'Router/auto or unrecognized models — Cursor does not disclose which pool served these.',
      }));
      continue;
    }
    // Local pool estimates step back to secondary once the dashboard supplies
    // the authoritative plan percentages.
    if (hasLiveQuota && entry.rawCostUsd <= 0 && allowance === null) continue;
    meters.push(buildMeter({
      id: `cursor-${pool}`,
      label: POOL_LABELS[pool],
      unit: 'usd',
      used: entry.rawCostUsd,
      allowance,
      resetAt: resolvedCycle.endsAt,
      estimated: true,
      emphasis: hasLiveQuota ? 'secondary' : 'primary',
      note: allowance === null && !hasLiveQuota
        ? 'Set this pool’s monthly allowance in Settings to track what is left.'
        : null,
    }));
  }

  const details = [];
  const perPoolRows = [];
  for (const pool of CURSOR_POOLS) {
    const entry = poolTotals(resolvedTotals, pool);
    if (!entry || (entry.rawCostUsd <= 0 && entry.totalTokens <= 0)) continue;
    perPoolRows.push({
      label: POOL_LABELS[pool],
      value: formatUsd(entry.rawCostUsd) ?? '$0.00',
      hint: [
        formatTokens(entry.totalTokens) ? `${formatTokens(entry.totalTokens)} tokens` : null,
        entry.chargedUsd > 0 ? `charged ${formatUsd(entry.chargedUsd)}` : 'charged $0.00',
      ].filter(Boolean).join(' · '),
    });
  }
  const poolSection = buildDetailSection({
    id: 'cursor-pools',
    label: 'This cycle by pool',
    // rawCost is the undiscounted model price and is what the included pools
    // are measured against; chargedCents is what Cursor actually bills after
    // discounts, plan inclusion and BYOK, and is often $0.
    note: 'Allowance consumption uses raw model cost; “charged” is what Cursor actually bills.',
    rows: perPoolRows,
  });
  if (poolSection) details.push(poolSection);

  const combined = CURSOR_POOLS.reduce((acc, pool) => {
    const entry = poolTotals(resolvedTotals, pool);
    if (!entry) return acc;
    acc.rawCostUsd += entry.rawCostUsd;
    acc.chargedUsd += entry.chargedUsd;
    acc.inputTokens += entry.inputTokens;
    acc.outputTokens += entry.outputTokens;
    acc.cacheReadTokens += entry.cacheReadTokens;
    acc.cacheWriteTokens += entry.cacheWriteTokens;
    acc.totalTokens += entry.totalTokens;
    acc.runCount += entry.runCount;
    return acc;
  }, {
    rawCostUsd: 0,
    chargedUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    runCount: 0,
  });

  const totalRows = [
    { label: 'Raw model cost', value: formatUsd(combined.rawCostUsd) ?? '$0.00' },
    { label: 'Actually charged', value: formatUsd(combined.chargedUsd) ?? '$0.00', hint: 'Zero for plan-included, BYOK and credit-grant usage' },
  ];
  if (combined.runCount > 0) totalRows.push({ label: 'Runs', value: String(Math.round(combined.runCount)) });
  for (const [label, value] of [
    ['Input tokens', combined.inputTokens],
    ['Output tokens', combined.outputTokens],
    ['Cache read', combined.cacheReadTokens],
    ['Cache write', combined.cacheWriteTokens],
  ]) {
    const formatted = formatTokens(value);
    if (formatted) totalRows.push({ label, value: formatted });
  }
  const totalsSection = buildDetailSection({
    id: 'cursor-totals',
    label: 'This cycle in total',
    rows: totalRows,
  });
  if (totalsSection) details.push(totalsSection);

  if (hasLiveQuota) {
    const planRows = [];
    const includedSpend = toFiniteNumber(dashboard.includedSpendCents);
    const limit = toFiniteNumber(dashboard.limitCents);
    if (includedSpend !== null) {
      planRows.push({
        label: 'Included spend',
        value: formatUsd(includedSpend / 100) ?? '$0.00',
        hint: limit !== null ? `of ${formatUsd(limit / 100)} included` : null,
      });
    }
    const onDemandUsed = toFiniteNumber(dashboard.onDemand?.usedCents);
    if (onDemandUsed !== null) {
      const onDemandLimit = toFiniteNumber(dashboard.onDemand?.limitCents);
      planRows.push({
        label: 'On-demand spend',
        value: formatUsd(onDemandUsed / 100) ?? '$0.00',
        hint: onDemandLimit !== null ? `cap ${formatUsd(onDemandLimit / 100)}` : null,
      });
    }
    if (dashboard.displayMessage) {
      planRows.push({ label: 'Cursor says', value: dashboard.displayMessage });
    }
    const planSection = buildDetailSection({
      id: 'cursor-plan',
      label: 'Plan (live)',
      rows: planRows,
    });
    if (planSection) details.push(planSection);
  }

  const cycleStartsAt = (hasLiveQuota && dashboard.billingCycleStart) || resolvedCycle.startsAt;
  const cycleEndsAt = (hasLiveQuota && dashboard.billingCycleEnd) || resolvedCycle.endsAt;
  const cycleSection = buildDetailSection({
    id: 'cursor-cycle',
    label: 'Billing cycle',
    rows: [
      { label: 'Cycle started', value: cycleStartsAt.slice(0, 10) },
      {
        label: 'Resets',
        value: cycleEndsAt.slice(0, 10),
        hint: hasLiveQuota && dashboard.billingCycleEnd
          ? 'From the Cursor dashboard'
          : `Day ${resolvedCycle.resetDay} of each month`,
      },
    ],
  });
  if (cycleSection) details.push(cycleSection);

  const notes = [];
  // Cursor's API key exposes no plan surface, so without a dashboard token the
  // card can only show locally reconstructed spend — which is $0.00 on a relay
  // that has not run a Cursor turn yet, and reads as "broken" unless we say so.
  if (!hasLiveQuota && dashboardAuth) {
    notes.push(dashboardAuth.configured === true
      ? 'Live plan bars unavailable — Cursor did not accept the stored dashboard token. It has most likely expired; save a fresh one in Settings.'
      : 'Live plan bars need a Cursor dashboard token. This host has no Cursor IDE login to read one from — paste the WorkosCursorSessionToken cookie in Settings, or set CURSOR_SESSION_TOKEN on the relay.');
  }
  if (!hasLiveQuota && settings.cursorModelsUsd === null && settings.otherModelsUsd === null) {
    notes.push('No monthly allowance configured — showing spend only.');
  }
  if (unclassifiedSpend > 0) {
    notes.push('Some spend could not be attributed to a pool.');
  }
  const explicitMessage = toTrimmedString(message);

  const planName = hasLiveQuota
    ? (dashboard.membershipType
      ? `Cursor ${dashboard.membershipType}`
      : 'Cursor plan')
    // Everything else on this card is locally reconstructed, so the plan name
    // says so rather than implying Cursor reported a tier.
    : 'Manual allowance';

  return buildProviderCard({
    provider: CURSOR_PROVIDER_ID,
    label: CURSOR_LABEL,
    status: meters.filter(Boolean).length ? STATUS_OK : STATUS_PARTIAL,
    planName,
    source: hasLiveQuota ? SOURCE_LIVE : SOURCE_MANUAL,
    capturedAt,
    message: [explicitMessage, ...notes].filter(Boolean).join(' ') || null,
    meters: meters.filter(Boolean),
    details,
    links: [{ label: 'Cursor Spending dashboard', url: CURSOR_SPENDING_URL }],
  });
}
