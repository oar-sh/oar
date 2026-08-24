'use strict';

/**
 * Provider-neutral plan-usage contract.
 *
 * "Plan usage" is deliberately NOT the same thing as context usage (see
 * `context-usage-view.mjs`): this describes what a *subscription* has left —
 * credits, request allowances, rate-limit windows and their reset times —
 * while context usage describes one session's token window.
 *
 * Every provider normalizer in `plan-usage-<provider>.mjs` emits the same
 * `{ card: { meters, details, links } }` shape so the browser renderer stays
 * provider-agnostic, and so a provider that can only report *some* of its
 * limits degrades to fewer meters rather than to a special-cased layout.
 */

export const PLAN_USAGE_VERSION = 2;

/** Where a number came from. The UI badges anything that is not authoritative. */
export const SOURCE_LIVE = 'live';
export const SOURCE_CACHE = 'cache';
export const SOURCE_WORKER = 'worker';
export const SOURCE_MANUAL = 'manual';

/** Card-level availability. `partial` means some meters resolved and some did not. */
export const STATUS_OK = 'ok';
export const STATUS_PARTIAL = 'partial';
export const STATUS_UNAVAILABLE = 'unavailable';
export const STATUS_NOT_CONFIGURED = 'not-configured';
export const STATUS_ERROR = 'error';

export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function toTrimmedString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

/** ISO-8601 passthrough that rejects unparseable timestamps instead of rendering "Invalid Date". */
export function toIsoTimestamp(value) {
  const text = toTrimmedString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function clampPercent(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

export function roundCurrency(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  return Math.round(numeric * 100) / 100;
}

/**
 * Resolve the used/remaining/utilization triangle from whichever two corners a
 * provider actually reports.
 *
 * Providers are inconsistent here: GitHub reports remaining + entitlement,
 * Claude reports utilization only (no denominator at all), and Cursor's manual
 * mode reports used + a user-entered allowance. Deriving the missing corner
 * centrally is what lets one renderer draw all three.
 */
export function resolveMeterMath({
  used = null,
  allowance = null,
  remaining = null,
  utilization = null,
} = {}) {
  let usedValue = toFiniteNumber(used);
  let allowanceValue = toFiniteNumber(allowance);
  let remainingValue = toFiniteNumber(remaining);
  let utilizationValue = clampPercent(utilization);

  if (allowanceValue !== null && allowanceValue < 0) allowanceValue = null;

  if (usedValue === null && allowanceValue !== null && remainingValue !== null) {
    usedValue = allowanceValue - remainingValue;
  }
  if (remainingValue === null && allowanceValue !== null && usedValue !== null) {
    remainingValue = allowanceValue - usedValue;
  }
  // A utilization-only provider (Claude) still gets a usable bar; the absolute
  // numbers stay null so the UI does not invent a denominator.
  if (utilizationValue === null && allowanceValue !== null && allowanceValue > 0 && usedValue !== null) {
    utilizationValue = clampPercent((usedValue / allowanceValue) * 100);
  }
  if (usedValue === null && allowanceValue !== null && allowanceValue > 0 && utilizationValue !== null) {
    usedValue = (utilizationValue / 100) * allowanceValue;
    if (remainingValue === null) remainingValue = allowanceValue - usedValue;
  }

  // Overage is real on several plans, so remaining is allowed to go negative
  // while the bar itself clamps at 100%.
  return {
    used: usedValue === null ? null : Math.round(usedValue * 1000) / 1000,
    allowance: allowanceValue,
    remaining: remainingValue === null ? null : Math.round(remainingValue * 1000) / 1000,
    utilization: utilizationValue,
  };
}

/**
 * @param {object} spec
 * @param {string} spec.id            stable key, used by tests and DOM ids
 * @param {string} spec.label         human label
 * @param {'credits'|'requests'|'usd'|'percent'|'tokens'} [spec.unit]
 * @param {boolean} [spec.unlimited]  plan grants unlimited use of this bucket
 * @param {boolean} [spec.estimated]  derived/manual rather than provider-authoritative
 * @returns {object|null} null when the meter carries no usable signal at all
 */
export function buildMeter({
  id,
  label,
  unit = 'credits',
  used = null,
  allowance = null,
  remaining = null,
  utilization = null,
  resetAt = null,
  note = null,
  unlimited = false,
  estimated = false,
  emphasis = 'primary',
} = {}) {
  const meterId = toTrimmedString(id);
  const meterLabel = toTrimmedString(label);
  if (!meterId || !meterLabel) return null;

  const math = resolveMeterMath({ used, allowance, remaining, utilization });
  const hasSignal = unlimited
    || math.used !== null
    || math.allowance !== null
    || math.remaining !== null
    || math.utilization !== null;
  if (!hasSignal) return null;

  return {
    id: meterId,
    label: meterLabel,
    unit,
    unlimited: unlimited === true,
    estimated: estimated === true,
    emphasis: emphasis === 'secondary' ? 'secondary' : 'primary',
    used: math.used,
    allowance: math.allowance,
    remaining: math.remaining,
    utilization: math.utilization,
    resetAt: toIsoTimestamp(resetAt),
    note: toTrimmedString(note),
  };
}

/** A collapsible block of label/value rows shown under the meters. */
export function buildDetailSection({ id, label, rows = [], note = null } = {}) {
  const sectionId = toTrimmedString(id);
  const sectionLabel = toTrimmedString(label);
  if (!sectionId || !sectionLabel) return null;
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const rowLabel = toTrimmedString(row?.label);
      const rowValue = row?.value === 0 ? '0' : toTrimmedString(row?.value);
      if (!rowLabel || rowValue === null) return null;
      return { label: rowLabel, value: rowValue, hint: toTrimmedString(row?.hint) };
    })
    .filter(Boolean);
  if (!normalizedRows.length) return null;
  return { id: sectionId, label: sectionLabel, rows: normalizedRows, note: toTrimmedString(note) };
}

export function buildProviderCard({
  provider,
  label,
  status = STATUS_OK,
  planName = null,
  accountLabel = null,
  message = null,
  source = SOURCE_LIVE,
  capturedAt = null,
  stale = false,
  meters = [],
  details = [],
  links = [],
} = {}) {
  const providerId = toTrimmedString(provider);
  const providerLabel = toTrimmedString(label) || providerId;
  if (!providerId) return null;

  const normalizedMeters = (Array.isArray(meters) ? meters : []).filter(Boolean);
  const normalizedDetails = (Array.isArray(details) ? details : []).filter(Boolean);
  const normalizedLinks = (Array.isArray(links) ? links : [])
    .map((link) => {
      const linkLabel = toTrimmedString(link?.label);
      const url = toTrimmedString(link?.url);
      // Only absolute http(s) links are emitted; the renderer inserts these
      // into href attributes.
      if (!linkLabel || !url || !/^https:\/\//i.test(url)) return null;
      return { label: linkLabel, url };
    })
    .filter(Boolean);

  return {
    provider: providerId,
    label: providerLabel,
    status,
    planName: toTrimmedString(planName),
    accountLabel: toTrimmedString(accountLabel),
    message: toTrimmedString(message),
    source,
    capturedAt: toIsoTimestamp(capturedAt),
    stale: stale === true,
    meters: normalizedMeters,
    details: normalizedDetails,
    links: normalizedLinks,
  };
}

export function buildUnavailableCard({
  provider,
  label,
  status = STATUS_UNAVAILABLE,
  message,
  links = [],
  details = [],
  capturedAt = null,
} = {}) {
  return buildProviderCard({
    provider,
    label,
    status,
    message,
    links,
    details,
    capturedAt,
    meters: [],
  });
}
