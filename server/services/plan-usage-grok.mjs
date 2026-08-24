'use strict';

/**
 * Grok / xAI plan usage.
 *
 * There is no ACP plan-quota RPC (probed 2026-08-08: session/usage, x.ai/usage,
 * … all Method not found). Authoritative remaining credits live only in the
 * product `/usage` TUI. What the agent *does* return is rich per-prompt usage
 * on the session/prompt result `_meta.usage` (tokens + costUsdTicks).
 *
 * So the Grok card is reconstructed like Cursor's estimated path:
 *  - always show the latest turn's token/cost detail when a snapshot exists;
 *  - optionally accumulate turn cost into a monthly cycle when the user enters
 *    a monthly USD allowance + reset day;
 *  - badge meters as estimated and link to the console for real billing.
 */

import {
  SOURCE_CACHE,
  SOURCE_LIVE,
  SOURCE_MANUAL,
  SOURCE_WORKER,
  STATUS_NOT_CONFIGURED,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_UNAVAILABLE,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  buildUnavailableCard,
  roundCurrency,
  toFiniteNumber,
  toIsoTimestamp,
  toTrimmedString,
} from './plan-usage-contract.mjs';
// Reuse Cursor's cycle calendar (same monthly reset-day semantics).
import {
  DEFAULT_CURSOR_RESET_DAY,
  normalizeCursorResetDay,
  resolveCursorBillingCycle,
} from './plan-usage-cursor.mjs';

export const GROK_PROVIDER_ID = 'grok';
export const GROK_LABEL = 'Grok';

/** Console landing for SuperGrok / API billing (card footer link). */
export const GROK_BILLING_URL = 'https://console.x.ai';

/**
 * ACP reports cost as integer ticks. Working assumption: 1 USD = 1e9 ticks
 * (a live grok-4.5 turn reported costUsdTicks=148864000 for ~14k tokens,
 * which reads as $0.149 at 1e9 ticks/USD).
 *
 * Calibration attempt 2026-08-08: exact USD verification is impossible for
 * OIDC subscription logins — the account has no dollar billing at all, only
 * a weekly SuperGrok percentage quota on grok.com (console.x.ai shows
 * nothing). Magnitude cross-check: ~$2.45 of tick-USD booked locally lined
 * up with 25% of a weekly plan quota, implying a weekly allowance in the
 * $10-40-equivalent range — plausible at 1e9, implausible (<$1/week) at
 * 1e10. So 1e9 is very likely right but unprovable to the cent; everything
 * derived from it stays labeled "estimated".
 */
export const COST_USD_TICKS_PER_USD = 1_000_000_000;

export const DEFAULT_GROK_RESET_DAY = DEFAULT_CURSOR_RESET_DAY;

export function costUsdTicksToUsd(ticks) {
  const numeric = toFiniteNumber(ticks);
  if (numeric === null || numeric < 0) return null;
  // Full precision here: rounding per turn before the cycle ledger sums the
  // values would book every sub-cent turn as $0.00 forever. Display formatting
  // (formatUsd / roundCurrency) rounds at render time.
  return numeric / COST_USD_TICKS_PER_USD;
}

export function normalizeGrokAllowanceSettings(raw = {}) {
  const monthlyUsd = (() => {
    const value = toFiniteNumber(raw?.monthlyUsd);
    // A $0 allowance cannot meter anything ("$X of $0.00 used") — treat it
    // as unset, same as negative or missing.
    if (value === null || value <= 0) return null;
    return Math.round(value * 100) / 100;
  })();
  return {
    monthlyUsd,
    resetDay: normalizeCursorResetDay(
      raw?.resetDay === null || raw?.resetDay === undefined || raw?.resetDay === ''
        ? DEFAULT_GROK_RESET_DAY
        : raw.resetDay,
    ),
  };
}

export function resolveGrokBillingCycle(options = {}) {
  return resolveCursorBillingCycle({
    resetDay: options.resetDay ?? DEFAULT_GROK_RESET_DAY,
    now: options.now,
  });
}

function pickNumber(...candidates) {
  for (const candidate of candidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}

// Negative token counts, costs, or durations are nonsense — treat them as
// "not reported" rather than booking them (they would otherwise decrement
// the cycle spend ledger). Mirrors normalizeCursorUsageReport.
function pickNonNegative(...candidates) {
  const value = pickNumber(...candidates);
  return value === null || value < 0 ? null : value;
}

/**
 * Normalize a single turn's usage from ACP prompt-result `_meta` (or a
 * usage_update payload). Returns null when nothing usable is present.
 */
export function normalizeGrokTurnUsage(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;

  // Accept both the nested `_meta.usage` shape and a flattened worker body.
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : raw;
  const meta = raw._meta && typeof raw._meta === 'object' ? raw._meta : raw;

  const inputTokens = pickNonNegative(
    usage.inputTokens,
    usage.input_tokens,
    meta.inputTokens,
    meta.input_tokens,
  );
  const outputTokens = pickNonNegative(
    usage.outputTokens,
    usage.output_tokens,
    meta.outputTokens,
    meta.output_tokens,
  );
  const totalTokens = pickNonNegative(
    usage.totalTokens,
    usage.total_tokens,
    meta.totalTokens,
    meta.total_tokens,
  );
  const cachedReadTokens = pickNonNegative(
    usage.cachedReadTokens,
    usage.cacheReadTokens,
    usage.cache_read_tokens,
    meta.cachedReadTokens,
  );
  const cacheCreationTokens = pickNonNegative(
    usage.cacheCreationTokens,
    usage.cacheWriteTokens,
    usage.cache_creation_tokens,
    meta.cacheCreationTokens,
  );
  const reasoningTokens = pickNonNegative(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    meta.reasoningTokens,
  );
  const costUsd = pickNonNegative(
    usage.costUsd,
    usage.cost_usd,
    meta.costUsd,
  ) ?? costUsdTicksToUsd(
    pickNumber(usage.costUsdTicks, usage.cost_usd_ticks, meta.costUsdTicks),
  );
  const apiDurationMs = pickNonNegative(usage.apiDurationMs, usage.api_duration_ms, meta.apiDurationMs);
  const modelCalls = pickNonNegative(usage.modelCalls, usage.model_calls);
  const numTurns = pickNonNegative(usage.numTurns, usage.num_turns, meta.numTurns);
  const modelId = toTrimmedString(
    usage.modelId
    || usage.model
    || meta.modelId
    || meta.model
    || raw.modelId
    || raw.model,
  );

  const modelUsageRaw = usage.modelUsage || usage.model_usage || meta.modelUsage || null;
  const modelUsage = [];
  if (modelUsageRaw && typeof modelUsageRaw === 'object') {
    for (const [model, entry] of Object.entries(modelUsageRaw)) {
      if (!entry || typeof entry !== 'object') continue;
      // ACP `_meta` ships a { modelName: entry } map, but a worker re-posting
      // an already-normalized blob ships an array — whose Object.entries keys
      // are indices ("0"), so the entry's own model field must win there.
      const modelName = toTrimmedString(Array.isArray(modelUsageRaw) ? entry.model : model);
      if (!modelName) continue;
      modelUsage.push({
        model: modelName,
        inputTokens: pickNonNegative(entry.inputTokens, entry.input_tokens),
        outputTokens: pickNonNegative(entry.outputTokens, entry.output_tokens),
        totalTokens: pickNonNegative(entry.totalTokens, entry.total_tokens),
        cachedReadTokens: pickNonNegative(entry.cachedReadTokens, entry.cacheReadTokens),
        cacheCreationTokens: pickNonNegative(entry.cacheCreationTokens, entry.cacheWriteTokens),
        reasoningTokens: pickNonNegative(entry.reasoningTokens),
        costUsd: pickNonNegative(entry.costUsd)
          ?? costUsdTicksToUsd(pickNumber(entry.costUsdTicks, entry.cost_usd_ticks)),
        modelCalls: pickNonNegative(entry.modelCalls),
        apiDurationMs: pickNonNegative(entry.apiDurationMs),
      });
    }
  }

  // apiDurationMs is deliberately not a signal: a duration-only payload has
  // no tokens or cost and would only inflate the cycle's turn count.
  const hasSignal = [
    inputTokens, outputTokens, totalTokens, cachedReadTokens, cacheCreationTokens,
    reasoningTokens, costUsd,
  ].some((value) => value !== null) || modelUsage.length > 0;

  if (!hasSignal) return null;

  return {
    modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    costUsd,
    apiDurationMs,
    modelCalls,
    numTurns,
    modelUsage,
    capturedAt: toIsoTimestamp(raw.capturedAt) || new Date().toISOString(),
  };
}

/**
 * Extract usage from a live ACP session/prompt result object.
 */
export function extractGrokUsageFromPromptResult(promptResult = null) {
  if (!promptResult || typeof promptResult !== 'object') return null;
  const meta = promptResult._meta && typeof promptResult._meta === 'object'
    ? promptResult._meta
    : null;
  if (!meta) return null;
  return normalizeGrokTurnUsage({
    ...meta,
    usage: meta.usage,
    modelId: meta.modelId,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    totalTokens: meta.totalTokens,
    cachedReadTokens: meta.cachedReadTokens,
    reasoningTokens: meta.reasoningTokens,
    costUsdTicks: meta.usage?.costUsdTicks ?? meta.costUsdTicks,
  });
}

function formatUsd(value) {
  const numeric = roundCurrency(value);
  return numeric === null ? null : `$${numeric.toFixed(2)}`;
}

function formatTokens(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 0) return null;
  if (numeric < 1000) return String(Math.round(numeric));
  if (numeric < 1_000_000) return `${(numeric / 1000).toFixed(1)}k`;
  return `${(numeric / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms) {
  const value = toFiniteNumber(ms);
  if (value === null || value < 0) return null;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * @param {object} options
 * @param {object|null} options.usage         last-turn snapshot (normalizeGrokTurnUsage)
 * @param {object|null} options.cycleTotals   { costUsd, inputTokens, outputTokens, totalTokens, turnCount }
 * @param {object|null} options.allowances    normalizeGrokAllowanceSettings()
 * @param {object|null} options.cycle         resolveGrokBillingCycle()
 * @param {object|null} options.billing       normalizeGrokBillingCredits() — live plan quota
 * @param {string|null} options.capturedAt
 * @param {boolean} options.configured        Grok provider enabled
 * @param {string|null} options.message
 */
export function buildGrokPlanCard({
  usage = null,
  cycleTotals = null,
  allowances = null,
  cycle = null,
  billing = null,
  capturedAt = null,
  configured = true,
  message = null,
  stale = false,
} = {}) {
  if (!configured) {
    // Caller usually filters Grok out when disabled; this is a defensive path.
    return null;
  }

  const settings = normalizeGrokAllowanceSettings(allowances || {});
  const resolvedCycle = cycle || resolveGrokBillingCycle({ resetDay: settings.resetDay });
  const totals = cycleTotals && typeof cycleTotals === 'object'
    ? {
      costUsd: toFiniteNumber(cycleTotals.costUsd) || 0,
      inputTokens: toFiniteNumber(cycleTotals.inputTokens) || 0,
      outputTokens: toFiniteNumber(cycleTotals.outputTokens) || 0,
      totalTokens: toFiniteNumber(cycleTotals.totalTokens) || 0,
      turnCount: toFiniteNumber(cycleTotals.turnCount) || 0,
    }
    : { costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 };

  const liveQuotaPercent = toFiniteNumber(billing?.usagePercent);
  const hasLiveQuota = liveQuotaPercent !== null;

  if (!hasLiveQuota && !usage && totals.turnCount <= 0 && totals.costUsd <= 0) {
    return buildUnavailableCard({
      provider: GROK_PROVIDER_ID,
      label: GROK_LABEL,
      status: STATUS_UNAVAILABLE,
      message: toTrimmedString(message)
        || 'No Grok usage captured yet. Run a Grok turn — per-prompt tokens and cost come from the agent result (there is no live plan-quota API).',
      links: [{ label: 'xAI console / billing', url: GROK_BILLING_URL }],
    });
  }

  const meters = [];
  if (hasLiveQuota) {
    const periodLabel = billing.periodType === 'weekly'
      ? 'Weekly plan usage'
      : `Plan usage${billing.periodType ? ` (${billing.periodType})` : ''}`;
    const productBits = (billing.products || [])
      .map((entry) => `${entry.product} ${entry.usagePercent}%`)
      .join(' · ');
    meters.push(buildMeter({
      id: 'grok-plan-quota',
      label: periodLabel,
      unit: 'percent',
      utilization: liveQuotaPercent,
      resetAt: billing.periodEnd || null,
      estimated: false,
      emphasis: 'primary',
      note: productBits
        ? `Live from the Grok subscription (${productBits}).`
        : 'Live from the Grok subscription.',
    }));
  }
  if (settings.monthlyUsd !== null) {
    meters.push(buildMeter({
      id: 'grok-monthly-spend',
      label: 'Estimated monthly spend',
      unit: 'usd',
      used: totals.costUsd,
      allowance: settings.monthlyUsd,
      resetAt: resolvedCycle.endsAt,
      estimated: true,
      emphasis: hasLiveQuota ? 'secondary' : 'primary',
      note: 'Local estimate from relay turns. xAI does not expose remaining plan credits over ACP.',
    }));
  }

  const details = [];
  if (usage) {
    const rows = [];
    const cost = formatUsd(usage.costUsd);
    if (cost) rows.push({ label: 'Last turn cost (estimate)', value: cost });
    if (usage.modelId) rows.push({ label: 'Model', value: usage.modelId });
    const tokenBits = [
      formatTokens(usage.inputTokens) ? `in ${formatTokens(usage.inputTokens)}` : null,
      formatTokens(usage.outputTokens) ? `out ${formatTokens(usage.outputTokens)}` : null,
      formatTokens(usage.cachedReadTokens) ? `cache r ${formatTokens(usage.cachedReadTokens)}` : null,
      formatTokens(usage.reasoningTokens) ? `reason ${formatTokens(usage.reasoningTokens)}` : null,
      formatTokens(usage.totalTokens) ? `total ${formatTokens(usage.totalTokens)}` : null,
    ].filter(Boolean);
    if (tokenBits.length) rows.push({ label: 'Tokens', value: tokenBits.join(' · ') });
    const apiDuration = formatDuration(usage.apiDurationMs);
    if (apiDuration) rows.push({ label: 'API time', value: apiDuration });
    if (usage.numTurns !== null) rows.push({ label: 'Agent turns', value: String(usage.numTurns) });
    const lastSection = buildDetailSection({
      id: 'grok-last-turn',
      label: 'Latest turn',
      rows,
      note: 'From the last Grok agent prompt result on this relay host.',
    });
    if (lastSection) details.push(lastSection);

    const modelRows = (usage.modelUsage || []).map((entry) => ({
      label: entry.model,
      value: formatUsd(entry.costUsd) ?? '—',
      hint: [
        formatTokens(entry.inputTokens) ? `in ${formatTokens(entry.inputTokens)}` : null,
        formatTokens(entry.outputTokens) ? `out ${formatTokens(entry.outputTokens)}` : null,
        formatTokens(entry.cachedReadTokens) ? `cache r ${formatTokens(entry.cachedReadTokens)}` : null,
      ].filter(Boolean).join(' · ') || null,
    }));
    const modelSection = buildDetailSection({
      id: 'grok-models',
      label: 'By model (last turn)',
      rows: modelRows,
    });
    if (modelSection) details.push(modelSection);
  }

  if (totals.turnCount > 0 || totals.costUsd > 0) {
    const cycleRows = [];
    const cycleCost = formatUsd(totals.costUsd);
    if (cycleCost) cycleRows.push({ label: 'Cycle spend (estimate)', value: cycleCost });
    if (totals.turnCount > 0) cycleRows.push({ label: 'Turns tracked', value: String(Math.round(totals.turnCount)) });
    const cycleTokens = formatTokens(totals.totalTokens);
    if (cycleTokens) cycleRows.push({ label: 'Tokens (sum)', value: cycleTokens });
    if (resolvedCycle.startsAt && resolvedCycle.endsAt) {
      cycleRows.push({
        label: 'Billing cycle',
        value: `${resolvedCycle.startsAt.slice(0, 10)} → ${resolvedCycle.endsAt.slice(0, 10)}`,
      });
    }
    const cycleSection = buildDetailSection({
      id: 'grok-cycle',
      label: 'Current cycle (local)',
      rows: cycleRows,
      note: settings.monthlyUsd === null
        ? 'Set a monthly allowance in Settings to show a remaining-budget meter.'
        : 'Accumulated from Grok turns on this relay. Not an xAI statement.',
    });
    if (cycleSection) details.push(cycleSection);
  }

  const hasMeter = meters.filter(Boolean).length > 0;
  return buildProviderCard({
    provider: GROK_PROVIDER_ID,
    label: GROK_LABEL,
    status: hasMeter ? STATUS_OK : STATUS_PARTIAL,
    message: hasMeter
      ? null
      : 'No live plan-quota data for Grok right now. Showing last-turn cost/tokens; set a monthly allowance in Settings for an estimated budget meter.',
    source: hasLiveQuota
      ? SOURCE_LIVE
      : (settings.monthlyUsd !== null ? SOURCE_MANUAL : (stale ? SOURCE_CACHE : SOURCE_WORKER)),
    stale: stale === true,
    capturedAt: capturedAt || usage?.capturedAt || null,
    meters: meters.filter(Boolean),
    details,
    links: [{ label: 'xAI console / billing', url: GROK_BILLING_URL }],
  });
}
