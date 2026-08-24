'use strict';

/**
 * Claude subscription plan usage.
 *
 * Source is the Agent SDK's structured `/usage` control response
 * (`SDKControlGetUsageResponse`), which is explicitly marked EXPERIMENTAL by
 * the SDK. Everything here is therefore written defensively: each window is
 * optional, the whole `rate_limits` block can be null (API-key, Bedrock and
 * Vertex sessions have no plan limits at all), and a shape change must degrade
 * to "fewer meters" rather than throw.
 *
 * When the experimental call is unavailable the worker still reports the
 * stable `modelUsage` / `total_cost_usd` result fields, which render as session
 * cost details with no plan meters.
 */

import {
  SOURCE_CACHE,
  SOURCE_WORKER,
  STATUS_NOT_CONFIGURED,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_UNAVAILABLE,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  buildUnavailableCard,
  clampPercent,
  roundCurrency,
  toFiniteNumber,
  toIsoTimestamp,
  toTrimmedString,
} from './plan-usage-contract.mjs';

export const CLAUDE_PROVIDER_ID = 'claude';
export const CLAUDE_LABEL = 'Claude';

const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

// Fixed windows, in display order. Model-scoped windows are appended after
// these from the server-supplied `model_scoped[]` array.
const WINDOW_LABELS = [
  ['five_hour', 'Current session (5 h)', 'primary'],
  ['seven_day', 'Weekly limit', 'primary'],
  ['seven_day_sonnet', 'Weekly Sonnet', 'secondary'],
  ['seven_day_opus', 'Weekly Opus', 'secondary'],
  ['seven_day_oauth_apps', 'Weekly (OAuth apps)', 'secondary'],
];

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const utilization = clampPercent(raw.utilization);
  const resetsAt = toIsoTimestamp(raw.resets_at);
  if (utilization === null && !resetsAt) return null;
  return { utilization, resetsAt };
}

function normalizeModelUsageMap(rawModelUsage) {
  if (!rawModelUsage || typeof rawModelUsage !== 'object') return [];
  return Object.entries(rawModelUsage)
    .map(([model, usage]) => {
      if (!usage || typeof usage !== 'object') return null;
      return {
        model: toTrimmedString(model),
        inputTokens: toFiniteNumber(usage.inputTokens),
        outputTokens: toFiniteNumber(usage.outputTokens),
        cacheReadTokens: toFiniteNumber(usage.cacheReadInputTokens),
        cacheWriteTokens: toFiniteNumber(usage.cacheCreationInputTokens),
        webSearchRequests: toFiniteNumber(usage.webSearchRequests),
        costUsd: toFiniteNumber(usage.costUSD),
        contextWindow: toFiniteNumber(usage.contextWindow),
      };
    })
    .filter((entry) => entry && entry.model);
}

function normalizeAttribution(list) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => {
      const name = toTrimmedString(entry?.name) || toTrimmedString(entry?.key);
      const pct = clampPercent(entry?.pct);
      if (!name || pct === null) return null;
      return { name, pct, count: toFiniteNumber(entry?.count) };
    })
    .filter(Boolean)
    .sort((a, b) => b.pct - a.pct);
}

function normalizeBehaviorWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const window = {
    requestCount: toFiniteNumber(raw.request_count),
    sessionCount: toFiniteNumber(raw.session_count),
    behaviors: normalizeAttribution(raw.behaviors),
    agents: normalizeAttribution(raw.agents),
    skills: normalizeAttribution(raw.skills),
    plugins: normalizeAttribution(raw.plugins),
    mcpServers: normalizeAttribution(raw.mcp_servers),
  };
  const hasSignal = window.requestCount !== null
    || window.sessionCount !== null
    || window.behaviors.length
    || window.agents.length
    || window.skills.length
    || window.plugins.length
    || window.mcpServers.length;
  return hasSignal ? window : null;
}

/**
 * Normalize the raw experimental response into the payload the relay persists.
 * Returns null when nothing usable is present, so callers never store noise.
 */
export function normalizeClaudePlanUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rawSession = raw.session && typeof raw.session === 'object' ? raw.session : null;
  const session = rawSession
    ? {
      totalCostUsd: toFiniteNumber(rawSession.total_cost_usd),
      totalApiDurationMs: toFiniteNumber(rawSession.total_api_duration_ms),
      totalDurationMs: toFiniteNumber(rawSession.total_duration_ms),
      totalLinesAdded: toFiniteNumber(rawSession.total_lines_added),
      totalLinesRemoved: toFiniteNumber(rawSession.total_lines_removed),
      modelUsage: normalizeModelUsageMap(rawSession.model_usage),
    }
    : null;

  const rawLimits = raw.rate_limits && typeof raw.rate_limits === 'object' ? raw.rate_limits : null;
  const windows = [];
  if (rawLimits) {
    for (const [key, label, emphasis] of WINDOW_LABELS) {
      const normalized = normalizeWindow(rawLimits[key]);
      if (normalized) windows.push({ id: key, label, emphasis, ...normalized });
    }
    for (const entry of (Array.isArray(rawLimits.model_scoped) ? rawLimits.model_scoped : [])) {
      const normalized = normalizeWindow(entry);
      const displayName = toTrimmedString(entry?.display_name);
      if (!normalized || !displayName) continue;
      windows.push({
        id: `model_scoped:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        label: `Weekly ${displayName}`,
        emphasis: 'secondary',
        ...normalized,
      });
    }
  }

  const rawExtra = rawLimits?.extra_usage && typeof rawLimits.extra_usage === 'object'
    ? rawLimits.extra_usage
    : null;
  const extraUsage = rawExtra
    ? {
      isEnabled: rawExtra.is_enabled === true,
      monthlyLimit: toFiniteNumber(rawExtra.monthly_limit),
      usedCredits: toFiniteNumber(rawExtra.used_credits),
      utilization: clampPercent(rawExtra.utilization),
      currency: toTrimmedString(rawExtra.currency),
    }
    : null;

  const rawBehaviors = raw.behaviors && typeof raw.behaviors === 'object' ? raw.behaviors : null;
  const behaviors = rawBehaviors
    ? {
      day: normalizeBehaviorWindow(rawBehaviors.day),
      week: normalizeBehaviorWindow(rawBehaviors.week),
    }
    : null;

  const payload = {
    subscriptionType: toTrimmedString(raw.subscription_type),
    rateLimitsAvailable: raw.rate_limits_available === true,
    windows,
    extraUsage,
    session,
    behaviors: behaviors && (behaviors.day || behaviors.week) ? behaviors : null,
  };
  const hasSignal = payload.windows.length
    || payload.extraUsage
    || payload.session
    || payload.behaviors
    || payload.subscriptionType;
  return hasSignal ? payload : null;
}

/** Build the fallback payload from the stable result-message fields. */
export function claudePlanUsageFromResult({ modelUsage = null, totalCostUsd = null } = {}) {
  const models = normalizeModelUsageMap(modelUsage);
  const cost = toFiniteNumber(totalCostUsd);
  if (!models.length && cost === null) return null;
  return {
    subscriptionType: null,
    rateLimitsAvailable: false,
    windows: [],
    extraUsage: null,
    session: {
      totalCostUsd: cost,
      totalApiDurationMs: null,
      totalDurationMs: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
      modelUsage: models,
    },
    behaviors: null,
  };
}

function formatDuration(ms) {
  const value = toFiniteNumber(ms);
  if (value === null || value < 0) return null;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  const abs = Math.abs(numeric);
  if (abs < 1000) return String(Math.round(numeric));
  if (abs < 1_000_000) return `${(numeric / 1000).toFixed(1)}k`;
  return `${(numeric / 1_000_000).toFixed(1)}M`;
}

function formatUsd(value) {
  const numeric = roundCurrency(value);
  return numeric === null ? null : `$${numeric.toFixed(2)}`;
}

function attributionRows(entries, limit = 6) {
  return entries.slice(0, limit).map((entry) => ({
    label: entry.name,
    value: `${entry.pct.toFixed(1)}%`,
    hint: entry.count === null ? null : `${entry.count} requests`,
  }));
}

function behaviorSections(behaviors) {
  if (!behaviors) return [];
  const sections = [];
  for (const [key, window, windowLabel] of [
    ['day', behaviors.day, 'Last 24 hours'],
    ['week', behaviors.week, 'Last 7 days'],
  ]) {
    if (!window) continue;
    const rows = [];
    if (window.requestCount !== null) rows.push({ label: 'API requests', value: String(window.requestCount) });
    if (window.sessionCount !== null) rows.push({ label: 'Sessions', value: String(window.sessionCount) });
    for (const entry of window.behaviors.slice(0, 6)) {
      rows.push({ label: entry.name, value: `${entry.pct.toFixed(1)}%`, hint: entry.count === null ? null : `${entry.count} requests` });
    }
    sections.push(buildDetailSection({
      id: `claude-behaviors-${key}`,
      label: `What is driving usage — ${windowLabel}`,
      // The SDK is explicit that this comes from a local transcript scan, so it
      // must not be presented as an account-wide figure.
      note: 'Approximate, from local transcripts on this machine only. Categories overlap.',
      rows,
    }));

    for (const [attrKey, attrLabel, list] of [
      ['agents', 'Agents', window.agents],
      ['skills', 'Skills', window.skills],
      ['plugins', 'Plugins', window.plugins],
      ['mcp', 'MCP servers', window.mcpServers],
    ]) {
      if (!list.length) continue;
      sections.push(buildDetailSection({
        id: `claude-${attrKey}-${key}`,
        label: `${attrLabel} — ${windowLabel}`,
        rows: attributionRows(list),
      }));
    }
  }
  return sections;
}

export function buildClaudePlanCard({
  usage = null,
  capturedAt = null,
  stale = false,
  configured = true,
  message = null,
} = {}) {
  if (!configured) {
    return buildUnavailableCard({
      provider: CLAUDE_PROVIDER_ID,
      label: CLAUDE_LABEL,
      status: STATUS_NOT_CONFIGURED,
      message: 'Claude is not enabled in provider settings.',
    });
  }
  if (!usage) {
    return buildUnavailableCard({
      provider: CLAUDE_PROVIDER_ID,
      label: CLAUDE_LABEL,
      status: STATUS_UNAVAILABLE,
      message: toTrimmedString(message)
        || 'No Claude usage captured yet. Run a Claude turn — usage is read from the live session and never from a hidden extra turn.',
      links: [{ label: 'Claude usage settings', url: CLAUDE_USAGE_URL }],
    });
  }

  const meters = [];
  for (const window of (Array.isArray(usage.windows) ? usage.windows : [])) {
    meters.push(buildMeter({
      id: `claude-${window.id}`,
      label: window.label,
      unit: 'percent',
      utilization: window.utilization,
      resetAt: window.resetsAt,
      emphasis: window.emphasis === 'secondary' ? 'secondary' : 'primary',
    }));
  }

  const extra = usage.extraUsage;
  if (extra && (extra.isEnabled || extra.usedCredits !== null || extra.monthlyLimit !== null)) {
    meters.push(buildMeter({
      id: 'claude-extra-usage',
      label: 'Extra usage credits',
      unit: extra.currency && extra.currency.toUpperCase() !== 'USD' ? 'credits' : 'usd',
      used: extra.usedCredits,
      allowance: extra.monthlyLimit,
      utilization: extra.utilization,
      note: extra.isEnabled ? null : 'Extra usage is disabled for this account',
      emphasis: 'secondary',
    }));
  }

  const details = [];
  const session = usage.session;
  if (session) {
    const rows = [];
    const cost = formatUsd(session.totalCostUsd);
    if (cost) rows.push({ label: 'Session cost (estimate)', value: cost, hint: 'Client-side estimate, not a billing statement' });
    const apiDuration = formatDuration(session.totalApiDurationMs);
    if (apiDuration) rows.push({ label: 'API time', value: apiDuration });
    const wallDuration = formatDuration(session.totalDurationMs);
    if (wallDuration) rows.push({ label: 'Wall-clock time', value: wallDuration });
    if (session.totalLinesAdded !== null) rows.push({ label: 'Lines added', value: String(session.totalLinesAdded) });
    if (session.totalLinesRemoved !== null) rows.push({ label: 'Lines removed', value: String(session.totalLinesRemoved) });
    const sessionSection = buildDetailSection({ id: 'claude-session', label: 'Latest session totals', rows });
    if (sessionSection) details.push(sessionSection);

    const modelRows = (session.modelUsage || []).map((entry) => ({
      label: entry.model,
      value: formatUsd(entry.costUsd) ?? '—',
      hint: [
        formatTokens(entry.inputTokens) ? `in ${formatTokens(entry.inputTokens)}` : null,
        formatTokens(entry.outputTokens) ? `out ${formatTokens(entry.outputTokens)}` : null,
        formatTokens(entry.cacheReadTokens) ? `cache r ${formatTokens(entry.cacheReadTokens)}` : null,
        formatTokens(entry.cacheWriteTokens) ? `cache w ${formatTokens(entry.cacheWriteTokens)}` : null,
      ].filter(Boolean).join(' · ') || null,
    }));
    const modelSection = buildDetailSection({ id: 'claude-models', label: 'By model (session)', rows: modelRows });
    if (modelSection) details.push(modelSection);
  }

  details.push(...behaviorSections(usage.behaviors).filter(Boolean));

  const resolvedMeters = meters.filter(Boolean);
  const planLimitsMissing = !resolvedMeters.length;
  return buildProviderCard({
    provider: CLAUDE_PROVIDER_ID,
    label: CLAUDE_LABEL,
    status: planLimitsMissing ? STATUS_PARTIAL : STATUS_OK,
    planName: usage.subscriptionType
      ? `${usage.subscriptionType.charAt(0).toUpperCase()}${usage.subscriptionType.slice(1)}`
      : null,
    message: planLimitsMissing
      ? (usage.rateLimitsAvailable
        ? 'Plan rate limits were not reported for this session.'
        : 'This session authenticates without claude.ai plan limits (API key or third-party provider), so only session cost is available.')
      : null,
    source: stale ? SOURCE_CACHE : SOURCE_WORKER,
    stale,
    capturedAt,
    meters: resolvedMeters,
    details,
    links: [{ label: 'Claude usage settings', url: CLAUDE_USAGE_URL }],
  });
}
