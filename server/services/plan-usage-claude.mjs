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
 *
 * A second, live source exists while the Claude Cloud provider is switched on
 * (the switch is the consent to use the Claude CLI's login): the account's
 * usage as claude.ai's own endpoint reports it, read without a model turn
 * (`claude-account-usage-service.mjs`). It carries the same window keys, so
 * the meters are then built from it and the SDK snapshot only supplies the
 * session details.
 */

import {
  SOURCE_CACHE,
  SOURCE_LIVE,
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
  toSeverity,
  toTrimmedString,
} from './plan-usage-contract.mjs';

export const CLAUDE_PROVIDER_ID = 'claude';
export const CLAUDE_LABEL = 'Claude';

export const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';

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
        id: modelScopedWindowId(displayName),
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
      decimalPlaces: toFiniteNumber(rawExtra.decimal_places),
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

function modelScopedWindowId(displayName) {
  return `model_scoped:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

// `limits[]` of the account endpoint names the two fixed windows by kind.
const LIMIT_KIND_WINDOW_IDS = Object.freeze({ session: 'five_hour', weekly_all: 'seven_day' });

/**
 * Normalize the live account usage (the body of claude.ai's usage endpoint).
 *
 * Its top level is what the SDK response carries under `rate_limits`, so the
 * windows and the extra usage come from the same normalizer. On top of that:
 * `limits[]` adds a severity per window and the model-scoped weekly windows,
 * and `seven_day_breakdown.rows` says which product the week went to.
 * Returns `{ windows, extraUsage, breakdown }`, or null when nothing usable
 * is present.
 */
export function normalizeClaudeAccountUsage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const base = normalizeClaudePlanUsage({ rate_limits: body, rate_limits_available: true });
  const windows = (base?.windows || []).map((window) => ({ ...window, severity: null }));

  for (const entry of (Array.isArray(body.limits) ? body.limits : [])) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = toTrimmedString(entry.kind);
    let target = null;
    if (kind === 'weekly_scoped') {
      const displayName = toTrimmedString(entry.scope?.model?.display_name)
        || toTrimmedString(entry.scope?.surface?.display_name);
      if (!displayName) continue;
      const label = `Weekly ${displayName}`;
      target = windows.find((window) => window.label.toLowerCase() === label.toLowerCase()) || null;
      if (!target) {
        const reading = normalizeWindow({ utilization: entry.percent, resets_at: entry.resets_at });
        if (!reading) continue;
        target = { id: modelScopedWindowId(displayName), label, emphasis: 'secondary', ...reading, severity: null };
        windows.push(target);
      }
    } else if (kind && LIMIT_KIND_WINDOW_IDS[kind]) {
      target = windows.find((window) => window.id === LIMIT_KIND_WINDOW_IDS[kind]) || null;
    }
    if (target) target.severity = toSeverity(entry.severity);
  }

  const breakdown = (Array.isArray(body.seven_day_breakdown?.rows) ? body.seven_day_breakdown.rows : [])
    .map((row) => {
      const name = toTrimmedString(row?.display_name) || toTrimmedString(row?.key);
      const percent = clampPercent(row?.percent);
      return name && percent !== null ? { name, percent } : null;
    })
    .filter(Boolean);

  const extraUsage = base?.extraUsage || null;
  if (!windows.length && !extraUsage && !breakdown.length) return null;
  return { windows, extraUsage, breakdown };
}

/**
 * The prepaid credits of the organisation as `{ amount, currency }` in major
 * units, or null. The API sends the balance as `amount` in minor units (the
 * Claude CLI reads it as cents).
 */
export function normalizeClaudePrepaidCredits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const minor = toFiniteNumber(raw.amount);
  if (minor === null) return null;
  return { amount: minor / 100, currency: toTrimmedString(raw.currency) };
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

/** "$12.50" for dollars (or an unnamed currency), "12.50 EUR" for any other. */
export function formatClaudeMoney(amount, currency = null) {
  const numeric = roundCurrency(amount);
  if (numeric === null) return null;
  const code = toTrimmedString(currency)?.toUpperCase() || 'USD';
  return code === 'USD' ? `$${numeric.toFixed(2)}` : `${numeric.toFixed(2)} ${code}`;
}

/**
 * Extra-usage amounts arrive in minor units of the currency (cents for USD;
 * the SDK's response schema says so, and the account endpoint names the
 * exponent in `decimal_places`).
 */
function extraUsageAmount(value, decimalPlaces) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  const places = Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= 4 ? decimalPlaces : 2;
  return numeric / (10 ** places);
}

/**
 * The detail sections for one session's totals (`session` as
 * `normalizeClaudePlanUsage` / `claudePlanUsageFromResult` store it). The
 * Claude Cloud card shows its own latest snapshot through the same sections,
 * under its own ids and wording.
 */
export function buildClaudeSessionSections(session, {
  idPrefix = 'claude',
  sessionLabel = 'Latest session totals',
  modelsLabel = 'By model (session)',
  costLabel = 'Session cost (estimate)',
  costHint = 'Client-side estimate, not a billing statement',
} = {}) {
  if (!session || typeof session !== 'object') return [];
  const sections = [];
  const rows = [];
  const cost = formatUsd(session.totalCostUsd);
  if (cost) rows.push({ label: costLabel, value: cost, hint: costHint });
  const apiDuration = formatDuration(session.totalApiDurationMs);
  if (apiDuration) rows.push({ label: 'API time', value: apiDuration });
  const wallDuration = formatDuration(session.totalDurationMs);
  if (wallDuration) rows.push({ label: 'Wall-clock time', value: wallDuration });
  if (toFiniteNumber(session.totalLinesAdded) !== null) rows.push({ label: 'Lines added', value: String(session.totalLinesAdded) });
  if (toFiniteNumber(session.totalLinesRemoved) !== null) rows.push({ label: 'Lines removed', value: String(session.totalLinesRemoved) });
  const sessionSection = buildDetailSection({ id: `${idPrefix}-session`, label: sessionLabel, rows });
  if (sessionSection) sections.push(sessionSection);

  const modelRows = (Array.isArray(session.modelUsage) ? session.modelUsage : []).map((entry) => ({
    label: entry.model,
    value: formatUsd(entry.costUsd) ?? '—',
    hint: [
      formatTokens(entry.inputTokens) ? `in ${formatTokens(entry.inputTokens)}` : null,
      formatTokens(entry.outputTokens) ? `out ${formatTokens(entry.outputTokens)}` : null,
      formatTokens(entry.cacheReadTokens) ? `cache r ${formatTokens(entry.cacheReadTokens)}` : null,
      formatTokens(entry.cacheWriteTokens) ? `cache w ${formatTokens(entry.cacheWriteTokens)}` : null,
    ].filter(Boolean).join(' · ') || null,
  }));
  const modelSection = buildDetailSection({ id: `${idPrefix}-models`, label: modelsLabel, rows: modelRows });
  if (modelSection) sections.push(modelSection);
  return sections;
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

/**
 * @param {object} options
 * @param {object|null} options.usage     the stored snapshot of the last SDK turn
 * @param {object|null} options.account   live account usage
 *   (`{ usage, prepaid, offer, fetchedAt, error }` from
 *   claude-account-usage-service.mjs), or null when it was not read
 */
export function buildClaudePlanCard({
  usage = null,
  capturedAt = null,
  stale = false,
  configured = true,
  message = null,
  account = null,
} = {}) {
  if (!configured) {
    return buildUnavailableCard({
      provider: CLAUDE_PROVIDER_ID,
      label: CLAUDE_LABEL,
      status: STATUS_NOT_CONFIGURED,
      message: 'Claude is not enabled in provider settings.',
    });
  }
  const live = normalizeClaudeAccountUsage(account?.usage);
  // Live windows replace the snapshot's; a live answer without a single
  // window (it should not happen for a plan login) leaves the snapshot in place.
  const hasLive = !!live && live.windows.length > 0;
  if (!usage && !hasLive) {
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
  const windows = hasLive ? live.windows : (Array.isArray(usage.windows) ? usage.windows : []);
  for (const window of windows) {
    meters.push(buildMeter({
      id: `claude-${window.id}`,
      label: window.label,
      unit: 'percent',
      utilization: window.utilization,
      resetAt: window.resetsAt,
      emphasis: window.emphasis === 'secondary' ? 'secondary' : 'primary',
      severity: window.severity,
    }));
  }

  const extra = hasLive ? live.extraUsage : usage.extraUsage;
  if (extra && (extra.isEnabled || extra.usedCredits !== null || extra.monthlyLimit !== null)) {
    meters.push(buildMeter({
      id: 'claude-extra-usage',
      label: 'Extra usage credits',
      unit: extra.currency && extra.currency.toUpperCase() !== 'USD' ? 'credits' : 'usd',
      used: extraUsageAmount(extra.usedCredits, extra.decimalPlaces),
      allowance: extraUsageAmount(extra.monthlyLimit, extra.decimalPlaces),
      utilization: extra.utilization,
      note: extra.isEnabled ? null : 'Extra usage is disabled for this account',
      emphasis: 'secondary',
    }));
  }

  const details = [];
  if (hasLive && live.breakdown.length) {
    details.push(buildDetailSection({
      id: 'claude-week-by-product',
      label: 'This week by product',
      note: 'Share of this week’s usage per product, as claude.ai reports it. Cloud sessions count under Claude Code.',
      rows: live.breakdown.map((row) => ({ label: row.name, value: `${Math.round(row.percent * 10) / 10}%` })),
    }));
  }
  const prepaid = normalizeClaudePrepaidCredits(account?.prepaid);
  if (prepaid && prepaid.amount !== 0) {
    details.push(buildDetailSection({
      id: 'claude-credits',
      label: 'Credits',
      rows: [{ label: 'Prepaid credits', value: formatClaudeMoney(prepaid.amount, prepaid.currency), hint: 'Balance of the organisation' }],
    }));
  }
  details.push(...buildClaudeSessionSections(usage?.session));
  details.push(...behaviorSections(usage?.behaviors));

  const notes = [];
  if (hasLive) {
    // The claude.ai usage page also lists limit-reset vouchers; no endpoint
    // the CLI login reaches has a field for them.
    notes.push({
      id: 'claude-limit-resets',
      text: 'Limit resets (full / 5-hour) are shown on claude.ai only.',
      link: { label: 'Open the usage page', url: CLAUDE_USAGE_URL },
    });
  } else if (toTrimmedString(account?.error)) {
    notes.push({
      id: 'claude-live-unavailable',
      text: `Live account usage could not be read, so this is the reading of the last Claude turn. ${toTrimmedString(account.error)}`,
    });
  }

  const resolvedMeters = meters.filter(Boolean);
  const planLimitsMissing = !resolvedMeters.length;
  const subscriptionType = toTrimmedString(usage?.subscriptionType);
  return buildProviderCard({
    provider: CLAUDE_PROVIDER_ID,
    label: CLAUDE_LABEL,
    status: planLimitsMissing ? STATUS_PARTIAL : STATUS_OK,
    planName: subscriptionType
      ? `${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)}`
      : null,
    message: planLimitsMissing
      ? (hasLive || usage?.rateLimitsAvailable
        ? 'Plan rate limits were not reported for this session.'
        : 'This session authenticates without claude.ai plan limits (API key or third-party provider), so only session cost is available.')
      : null,
    source: hasLive ? SOURCE_LIVE : (stale ? SOURCE_CACHE : SOURCE_WORKER),
    stale: hasLive ? false : stale,
    capturedAt: hasLive ? (toIsoTimestamp(account?.fetchedAt) || capturedAt) : capturedAt,
    meters: resolvedMeters,
    details: details.filter(Boolean),
    notes,
    links: [{ label: 'Claude usage settings', url: CLAUDE_USAGE_URL }],
  });
}
