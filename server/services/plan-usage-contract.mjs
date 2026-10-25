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
 * `{ card: { meters, charts, details, notes, links } }` shape so the browser renderer
 * stays provider-agnostic, and so a provider that can only report *some* of
 * its limits degrades to fewer meters rather than to a special-cased layout.
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

/** The first candidate that is a finite number, or null when none is. */
export function pickNumber(...candidates) {
  for (const candidate of candidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Like `pickNumber`, but a negative result reads as "not reported".
 *
 * Token counts, costs, call counts and durations are all non-negative by
 * definition, and every one of these numbers arrives from a WORKER over HTTP —
 * so a negative is either a bug or a poster trying to decrement a ledger.
 * Rejecting is strictly better than booking it.
 *
 * Note the ordering: the first FINITE candidate wins and is then checked, so a
 * negative does not silently fall through to the next candidate — the payload
 * said something about this field and what it said was nonsense.
 */
export function pickNonNegative(...candidates) {
  const value = pickNumber(...candidates);
  return value === null || value < 0 ? null : value;
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
 * A provider's severity word as a plain lowercase token ("normal",
 * "warning", …). The vocabulary is the provider's; anything that is not a
 * simple word is dropped rather than shown.
 */
export function toSeverity(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,23}$/.test(text) ? text : null;
}

/**
 * @param {object} spec
 * @param {string} spec.id            stable key, used by tests and DOM ids
 * @param {string} spec.label         human label
 * @param {'credits'|'requests'|'usd'|'cny'|'percent'|'tokens'} [spec.unit]
 * @param {boolean} [spec.unlimited]  plan grants unlimited use of this bucket
 * @param {boolean} [spec.estimated]  derived/manual rather than provider-authoritative
 * @param {string} [spec.severity]    the provider's own word for how close the limit is
 * @param {'expiry'} [spec.resetKind] `resetAt` is when the allowance ends for good, not when it refills
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
  severity = null,
  resetKind = null,
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
    resetKind: resetKind === 'expiry' ? 'expiry' : null,
    severity: toSeverity(severity),
    note: toTrimmedString(note),
  };
}

/**
 * Hour ranges of a day as `[start, end)` whole hours (0–24), or null when the
 * input is not a list of such pairs.
 */
export function normalizeHourRanges(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const ranges = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const start = toFiniteNumber(entry[0]);
    const end = toFiniteNumber(entry[1]);
    if (start === null || end === null || !Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end > 24 || start >= end) return null;
    ranges.push([start, end]);
  }
  return ranges;
}

/** "01:00–04:00 and 06:00–10:00 UTC" for `[[1, 4], [6, 10]]`. */
export function formatUtcHourRanges(ranges) {
  const list = normalizeHourRanges(ranges);
  if (!list) return null;
  const clock = (hour) => `${String(hour % 24).padStart(2, '0')}:00`;
  const parts = list.map(([start, end]) => `${clock(start)}–${clock(end)}`);
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${joined} UTC`;
}

/**
 * A line of text on the card itself (not inside a collapsed section), with an
 * optional link behind it. Same link rule as the card's footer: https only.
 *
 * `hours`: `{ utcRanges: [[start, end], …] }` when the text names hours of the
 * day. The text itself carries them in UTC (`formatUtcHourRanges`), complete
 * for any reader; the note then also carries the ranges as data, with the
 * exact UTC wording, so the browser can show them in its own time zone.
 */
export function buildCardNote({ id, text, link = null, hours = null, label = null, value = null, hint = null } = {}) {
  const noteId = toTrimmedString(id);
  const noteText = toTrimmedString(text);
  if (!noteId || !noteText) return null;
  const linkLabel = toTrimmedString(link?.label);
  const url = toTrimmedString(link?.url);
  const utcRanges = normalizeHourRanges(hours?.utcRanges);
  const utcText = utcRanges ? formatUtcHourRanges(utcRanges) : null;
  // A note that is a figure (a balance, a total) may say so as a label and a
  // value, with a hint; the card shows it as a row of figures, and `text`
  // stays the whole sentence for every other reader.
  const factLabel = toTrimmedString(label);
  const factValue = toTrimmedString(value);
  return {
    id: noteId,
    text: noteText,
    link: linkLabel && url && /^https:\/\//i.test(url) ? { label: linkLabel, url } : null,
    hours: utcRanges && noteText.includes(utcText) ? { utcRanges, utcText } : null,
    ...(factLabel && factValue ? { label: factLabel, value: factValue, hint: toTrimmedString(hint) } : {}),
  };
}

/** A collapsible block of label/value rows shown under the meters. */
export function buildDetailSection({ id, label, rows = [], note = null, open = false } = {}) {
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
  return { id: sectionId, label: sectionLabel, rows: normalizedRows, note: toTrimmedString(note), ...(open === true ? { open: true } : {}) };
}

export const CHART_KINDS = Object.freeze(['columns', 'bars']);

/**
 * A small chart drawn by the browser from data, never from markup: stacked
 * `columns` (one per item, e.g. days) or horizontal stacked `bars` (one per
 * item, e.g. models). Every item holds one value per series, in `unit`
 * (`buildMeter`'s units); the renderer draws the shares and writes the text
 * equivalents, so the card payload carries numbers only.
 *
 * `series`: `[{ key, label }]` in the order the colours are assigned, which
 * never changes between reads. `items`: `[{ key, label, values: { <series
 * key>: number } }]`; a value that is missing or not a number counts as 0.
 * `note`: one sentence under the chart. `summary`: a figure the chart adds
 * up to, shown with it (e.g. "Cache saved about ¥1.20").
 */
export function buildChart({ id, label, kind = 'columns', unit = 'credits', series = [], items = [], note = null, summary = null } = {}) {
  const chartId = toTrimmedString(id);
  const chartLabel = toTrimmedString(label);
  if (!chartId || !chartLabel || !CHART_KINDS.includes(kind)) return null;
  const normalizedSeries = (Array.isArray(series) ? series : [])
    .map((entry) => ({ key: toTrimmedString(entry?.key), label: toTrimmedString(entry?.label) }))
    .filter((entry) => entry.key && entry.label);
  const keys = normalizedSeries.map((entry) => entry.key);
  if (!keys.length || new Set(keys).size !== keys.length) return null;
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => {
      const itemKey = toTrimmedString(item?.key);
      const itemLabel = toTrimmedString(item?.label);
      if (!itemKey || !itemLabel) return null;
      const values = {};
      for (const key of keys) {
        const value = toFiniteNumber(item?.values?.[key]);
        values[key] = value === null || value < 0 ? 0 : value;
      }
      return { key: itemKey, label: itemLabel, values };
    })
    .filter(Boolean);
  if (!normalizedItems.length) return null;
  return {
    id: chartId,
    label: chartLabel,
    kind,
    unit: toTrimmedString(unit) || 'credits',
    series: normalizedSeries,
    items: normalizedItems,
    note: toTrimmedString(note),
    summary: toTrimmedString(summary),
  };
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
  charts = [],
  details = [],
  notes = [],
  links = [],
} = {}) {
  const providerId = toTrimmedString(provider);
  const providerLabel = toTrimmedString(label) || providerId;
  if (!providerId) return null;

  const normalizedMeters = (Array.isArray(meters) ? meters : []).filter(Boolean);
  const normalizedCharts = (Array.isArray(charts) ? charts : []).filter(Boolean);
  const normalizedDetails = (Array.isArray(details) ? details : []).filter(Boolean);
  const normalizedNotes = (Array.isArray(notes) ? notes : []).map((note) => buildCardNote(note || {})).filter(Boolean);
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
    charts: normalizedCharts,
    details: normalizedDetails,
    notes: normalizedNotes,
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
