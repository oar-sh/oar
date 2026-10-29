'use strict';

/**
 * DeepSeek usage for the Check Usage card.
 *
 * DeepSeek is pay-as-you-go: there is no plan, no window and no allowance,
 * so the card has no meters. It shows two things:
 *  - the account balance from `GET /user/balance` (deepseek-balance-service.mjs),
 *    read live with the saved key and kept for a minute;
 *  - what this relay's DeepSeek turns have cost, estimated from the tokens
 *    the workers report after each turn (POST /api/deepseek-plan-usage) and
 *    DeepSeek's published prices (shared/deepseek-pricing.mjs), in the
 *    balance's currency (USD when there is no balance to go by).
 *
 * Money is shown as notes and detail rows: a meter's units have no CNY, and a
 * balance has nothing to be measured against.
 */

import {
  SOURCE_CACHE,
  SOURCE_LIVE,
  SOURCE_WORKER,
  STATUS_NOT_CONFIGURED,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_UNAVAILABLE,
  buildChart,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  buildUnavailableCard,
  formatUtcHourRanges,
  pickNonNegative,
  toFiniteNumber,
  toIsoTimestamp,
  toTrimmedString,
} from './plan-usage-contract.mjs';
import { DEEPSEEK_PROVIDER_LABEL, DEEPSEEK_PROVIDER_TYPE, DEFAULT_DEEPSEEK_MODELS, deepseekModelLabel } from '../../shared/deepseek-models.mjs';
import {
  DEEPSEEK_PEAK_HOURS_UTC,
  DEEPSEEK_PRICE_CURRENCIES,
  DEEPSEEK_PRICING_SOURCE,
  DEEPSEEK_SEARCH_PRICING,
  deepseekPriceFor,
} from '../../shared/deepseek-pricing.mjs';

export const DEEPSEEK_USAGE_URL = 'https://platform.deepseek.com/usage';
export const DEEPSEEK_TOP_UP_URL = 'https://platform.deepseek.com/top_up';

// Same wording in docs/web-ui.md and the CHANGELOG.
export const DEEPSEEK_HOLIDAY_NOTE = 'On Chinese public holidays DeepSeek charges off-peak prices all day; the estimate doesn\'t know those dates, so turns at peak hours on a holiday are counted at double the real price.';
// What runs on DeepSeek's servers and what is billed: only WebSearch is a
// DeepSeek server tool (a server-side fetch tool is refused with a 422), and
// count_tokens requests are free (a session start makes some; a logging
// proxy and the DeepSeek dashboard agreed with the estimate, 2026-10-25).
export const DEEPSEEK_SEARCH_NOTE = `Web searches run on DeepSeek's servers and are counted at $${DEEPSEEK_SEARCH_PRICING.perThousand.USD} / ¥${DEEPSEEK_SEARCH_PRICING.perThousand.CNY} per 1,000 from ${DEEPSEEK_SEARCH_PRICING.chargedFrom.replace('T', ' ').slice(0, 16)} UTC; WebFetch reads the page on the relay host and costs only tokens. DeepSeek does not bill count_tokens requests (Claude Code sends some at each session start).`;

// A turn time this far ahead of the relay's clock is the worker's clock
// being off, not a turn: the relay's own time stands in.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function modelKey(value) {
  const id = String(value ?? '').trim().toLowerCase().replace(/\[1m\]$/, '');
  return MODEL_ID_PATTERN.test(id) ? id : '';
}

function tokens(value) {
  const number = pickNonNegative(value);
  return number === null ? 0 : Math.round(number);
}

/**
 * One worker report: `{ claudeNativeSessionId, runId?, at, totals: [{
 * model, hitTokens, missTokens, outputTokens }], requests?: [{ model,
 * searchRequests, fetchRequests }] }`. The totals are the CLI's RUNNING
 * totals per model for that CLI session (the relay diffs them against the
 * last report of the session). `runId` names the worker's CLI process; with
 * it, the requests are the process's running counts of web searches and
 * fetches, without it (an older worker) the turn's counts. Returns `{ ok:
 * true, report: { nativeSessionId, runId, at, totals, requests } }` or `{
 * ok: false, error }`. A missing `at` is the relay's time; an unreadable one
 * is refused.
 */
export function normalizeDeepSeekUsageReport(body = {}, { now = () => new Date() } = {}) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const clock = now();
  const nowMs = clock instanceof Date && !Number.isNaN(clock.getTime()) ? clock.getTime() : Date.now();
  let at = new Date(nowMs).toISOString();
  if (payload.at !== undefined && payload.at !== null && payload.at !== '') {
    const parsed = toIsoTimestamp(payload.at);
    if (!parsed) return { ok: false, error: 'at must be an ISO time' };
    if (Date.parse(parsed) <= nowMs + FUTURE_TOLERANCE_MS) at = parsed;
  }
  const nativeSessionId = String(payload.claudeNativeSessionId ?? '').trim();
  if (!SESSION_ID_PATTERN.test(nativeSessionId)) return { ok: false, error: 'Missing or invalid claudeNativeSessionId' };
  let runId = '';
  if (payload.runId !== undefined && payload.runId !== null && payload.runId !== '') {
    runId = String(payload.runId).trim();
    if (!SESSION_ID_PATTERN.test(runId)) return { ok: false, error: 'runId must be a short id' };
  }
  if (!Array.isArray(payload.totals)) return { ok: false, error: 'totals must be a list' };
  const byModel = new Map();
  for (const entry of payload.totals) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'Every totals entry must be an object' };
    const model = modelKey(entry.model);
    if (!model) return { ok: false, error: 'Every totals entry needs a valid model id' };
    const current = byModel.get(model) || { model, hitTokens: 0, missTokens: 0, outputTokens: 0 };
    current.hitTokens += tokens(entry.hitTokens);
    current.missTokens += tokens(entry.missTokens);
    current.outputTokens += tokens(entry.outputTokens);
    byModel.set(model, current);
  }
  const totals = [...byModel.values()].filter((entry) => entry.hitTokens + entry.missTokens + entry.outputTokens > 0);
  let requests = [];
  if (payload.requests !== undefined && payload.requests !== null) {
    if (!Array.isArray(payload.requests)) return { ok: false, error: 'requests must be a list' };
    const requestsByModel = new Map();
    for (const entry of payload.requests) {
      if (!entry || typeof entry !== 'object') return { ok: false, error: 'Every requests entry must be an object' };
      const model = modelKey(entry.model);
      if (!model) return { ok: false, error: 'Every requests entry needs a valid model id' };
      const current = requestsByModel.get(model) || { model, searchRequests: 0, fetchRequests: 0 };
      current.searchRequests += tokens(entry.searchRequests);
      current.fetchRequests += tokens(entry.fetchRequests);
      requestsByModel.set(model, current);
    }
    requests = [...requestsByModel.values()].filter((entry) => entry.searchRequests + entry.fetchRequests > 0);
  }
  if (!totals.length && !requests.length) return { ok: false, error: 'Missing usable usage metrics' };
  return { ok: true, report: { nativeSessionId, runId, at, totals, requests } };
}

function currencySymbol(currency) {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

/** "$1.23"; an estimate under one cent keeps four decimals ("¥0.0042"). */
export function formatDeepSeekMoney(value, currency, { estimate = false } = {}) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const digits = estimate && number !== 0 && Math.abs(number) < 0.01 ? 4 : 2;
  return `${number < 0 ? '-' : ''}${currencySymbol(currency)}${Math.abs(number).toFixed(digits)}`;
}

function formatTokens(value) {
  const number = toFiniteNumber(value) || 0;
  if (number < 1000) return String(Math.round(number));
  if (number < 1_000_000) return `${(number / 1000).toFixed(1)}k`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}

function day(value) {
  const iso = toIsoTimestamp(value);
  return iso ? iso.slice(0, 10) : null;
}

const hasMoney = (entry) => (toFiniteNumber(entry?.total) || 0) > 0;

/** The balance the spend is shown against: one with money on it, else the first. */
function primaryBalance(balances) {
  const list = (Array.isArray(balances) ? balances : []).filter((entry) => toTrimmedString(entry?.currency));
  return list.find(hasMoney) || list[0] || null;
}

/**
 * The balances worth a line: when one currency has money on it, a zero
 * balance in another says nothing ("Balance (USD): $0.00" next to ¥49.14).
 * All of them when none has money, so an empty account still shows as such.
 */
export function shownBalances(balances) {
  const list = (Array.isArray(balances) ? balances : []).filter((entry) => toTrimmedString(entry?.currency));
  return list.some(hasMoney) ? list.filter(hasMoney) : list;
}

function balanceNote(entry, { readAt = null } = {}) {
  const currency = String(entry.currency).toUpperCase();
  const total = formatDeepSeekMoney(entry.total, currency);
  if (total === null) return null;
  const parts = [
    formatDeepSeekMoney(entry.toppedUp, currency) !== null ? `topped up ${formatDeepSeekMoney(entry.toppedUp, currency)}` : null,
    formatDeepSeekMoney(entry.granted, currency) !== null ? `granted ${formatDeepSeekMoney(entry.granted, currency)}` : null,
  ].filter(Boolean);
  const hint = [parts.join(' · '), readAt ? `as read ${readAt}` : ''].filter(Boolean).join(', ');
  return {
    id: `deepseek-balance-${currency.toLowerCase()}`,
    text: `Balance (${currency}): ${total}${parts.length ? ` (${parts.join(', ')})` : ''}${readAt ? `, as read ${readAt}` : ''}`,
    label: `Balance (${currency})`,
    value: total,
    hint,
  };
}

function normalizeTotals(totals) {
  const models = (Array.isArray(totals?.models) ? totals.models : [])
    .map((entry) => ({
      model: toTrimmedString(entry?.model),
      hitTokens: toFiniteNumber(entry?.hitTokens) || 0,
      missTokens: toFiniteNumber(entry?.missTokens) || 0,
      outputTokens: toFiniteNumber(entry?.outputTokens) || 0,
      searchRequests: toFiniteNumber(entry?.searchRequests) || 0,
      fetchRequests: toFiniteNumber(entry?.fetchRequests) || 0,
      turnCount: toFiniteNumber(entry?.turnCount) || 0,
      // The requests the imported export counted (overlayDeepSeekActuals).
      requestCount: toFiniteNumber(entry?.requestCount) || 0,
      costUsd: toFiniteNumber(entry?.costUsd),
      costCny: toFiniteNumber(entry?.costCny),
      toolsCostUsd: toFiniteNumber(entry?.toolsCostUsd) || 0,
      toolsCostCny: toFiniteNumber(entry?.toolsCostCny) || 0,
      firstSeenAt: toIsoTimestamp(entry?.firstSeenAt),
      lastSeenAt: toIsoTimestamp(entry?.lastSeenAt),
    }))
    .filter((entry) => entry.model && (entry.turnCount > 0 || entry.requestCount > 0));
  const times = (key) => models.map((entry) => entry[key]).filter(Boolean).sort();
  return { models, firstSeenAt: times('firstSeenAt')[0] || null, lastSeenAt: times('lastSeenAt').pop() || null };
}

function balanceProblem(balance) {
  if (!balance || balance.ok !== false) return null;
  if (balance.code === 'not_configured') {
    return { status: STATUS_NOT_CONFIGURED, message: 'No DeepSeek API key is saved. Add one in Settings → Providers → DeepSeek.' };
  }
  const reason = toTrimmedString(balance.error) || 'DeepSeek did not answer';
  return { status: STATUS_PARTIAL, message: `The balance could not be read: ${reason}` };
}

const DAY_MS = 86_400_000;
const CHART_DAYS = 30;
// How many models get a colour of their own on the charts; the rest share one.
const CHART_MODEL_SERIES = 4;
// A Sunday noon: off-peak. Peak prices are exactly double for every part of a
// price, so the split of a cost into cache hit, cache miss and output is the
// same at any time; the off-peak prices give the proportions.
const OFF_PEAK_REFERENCE_AT = '2026-01-04T12:00:00.000Z';

const SHARE_SERIES = Object.freeze([
  { key: 'hit', label: 'Cache hit' },
  { key: 'miss', label: 'Cache miss' },
  { key: 'output', label: 'Output' },
  { key: 'tools', label: 'Search' },
]);

function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/** "Oct 21" for a `YYYY-MM-DD` day, in English and UTC like the booking. */
function dayLabel(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The charts' model order, fixed so a model keeps its colour between reads:
 * the models DeepSeek is known for first, in their order, then the others
 * alphabetically. Beyond `CHART_MODEL_SERIES` models they fold into "Other".
 */
function chartModelSeries(models) {
  const known = DEFAULT_DEEPSEEK_MODELS.map((model) => model.toLowerCase());
  const keys = [...new Set(models.map((model) => String(model).toLowerCase()))]
    .sort((a, b) => {
      const ka = known.indexOf(a);
      const kb = known.indexOf(b);
      if (ka !== -1 || kb !== -1) return (ka === -1 ? known.length : ka) - (kb === -1 ? known.length : kb);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const own = keys.length > CHART_MODEL_SERIES ? keys.slice(0, CHART_MODEL_SERIES - 1) : keys;
  const seriesKeyOf = (model) => (own.includes(String(model).toLowerCase()) ? String(model).toLowerCase() : 'other');
  const series = own.map((key) => ({ key, label: deepseekModelLabel(key) }));
  if (own.length < keys.length) series.push({ key: 'other', label: 'Other models' });
  return { series, seriesKeyOf };
}

/**
 * Whether the starting balance from the DeepSeek tab (`{ amount, setAt }`)
 * is what the balance bar measures from: until a top-up (or a grant) after
 * it was set replaces it. From that rise on, the balance after it is the
 * reference again, as without a starting balance. `{ applies, replacedAt }`.
 *
 * The relay sees a rise only at its next balance read (`reference.roseAt`),
 * which can be after the setting even when the top-up was before it: top up,
 * enter the new balance, then open the card. So a rise first seen after the
 * setting replaces it only when the balance before the rise was read after
 * the setting too (`reference.roseFromAt`: the setting already covered that
 * balance, the money came later). Saving a starting balance reads the
 * balance right then (sessions-routes.mjs), so every later top-up has such a
 * read before it. Only a rise whose earlier read is not known (a reference
 * from before that was noted) falls back to the balance: it replaces the
 * starting balance when the balance after it is above it.
 */
export function deepseekStartingBalanceState(startingBalance, reference) {
  const amount = toFiniteNumber(startingBalance?.amount);
  if (amount === null || amount <= 0) return { applies: false, replacedAt: null };
  const setAt = Date.parse(String(startingBalance?.setAt ?? ''));
  const roseAt = Date.parse(String(reference?.roseAt ?? ''));
  if (!Number.isFinite(setAt) || !Number.isFinite(roseAt) || roseAt <= setAt) return { applies: true, replacedAt: null };
  const roseFromAt = Date.parse(String(reference?.roseFromAt ?? ''));
  const afterRise = toFiniteNumber(reference?.referenceTotal);
  const replaced = Number.isFinite(roseFromAt) ? roseFromAt >= setAt : (afterRise !== null && afterRise > amount);
  if (replaced) {
    return { applies: false, replacedAt: new Date(roseAt).toISOString() };
  }
  return { applies: true, replacedAt: null };
}

/**
 * The currency the starting balance is in, and the only balance bar it
 * applies to: the balance's main currency (the one with money on it, else
 * the first), upper case; null without a balance.
 */
export function deepseekStartingBalanceCurrency(balances) {
  const currency = toTrimmedString(primaryBalance(balances)?.currency);
  return currency ? currency.toUpperCase() : null;
}

/**
 * What the DeepSeek tab says under the starting balance once a rise has
 * replaced it, or null while it applies (or none is set). Only a rise of the
 * balance's main currency counts, as for the bar: from `balances` (the last
 * balance read), or without one from the references' last balances.
 */
export function deepseekStartingBalanceNote(startingBalance, references = [], { balances = null } = {}) {
  const amount = toFiniteNumber(startingBalance?.amount);
  if (amount === null || amount <= 0) return null;
  const list = (Array.isArray(references) ? references : []).filter((reference) => toTrimmedString(reference?.currency));
  const currency = deepseekStartingBalanceCurrency(
    Array.isArray(balances) && balances.length
      ? balances
      : list.map((reference) => ({ currency: reference.currency, total: reference.lastTotal })),
  );
  const reference = list.find((entry) => String(entry.currency).toUpperCase() === currency);
  const replaced = reference ? deepseekStartingBalanceState(startingBalance, reference).replacedAt : null;
  return replaced
    ? `No longer used: the balance rose on ${day(replaced)} (a top-up), so the bar measures from the balance after it. Enter an amount again to measure from it.`
    : null;
}

/**
 * The balance meter of a currency: what is left of the balance after its
 * last rise (`reference`, kept by the relay), or of the starting balance from
 * the DeepSeek tab while it applies (deepseekStartingBalanceState), as a bar
 * that fills with the spend like the Claude bars do.
 */
function balanceMeter(entry, reference, startingBalance = null) {
  const currency = String(entry.currency).toUpperCase();
  const total = toFiniteNumber(entry.total);
  const unit = currency.toLowerCase();
  if (total === null || !DEEPSEEK_PRICE_CURRENCIES.includes(currency)) return null;
  if (startingBalance && deepseekStartingBalanceState(startingBalance, reference).applies) {
    const amount = toFiniteNumber(startingBalance.amount);
    return buildMeter({
      id: `deepseek-balance-${unit}`,
      label: `Balance (${currency})`,
      unit,
      used: Math.max(0, amount - total),
      allowance: amount,
      remaining: total,
      note: `Measured from ${formatDeepSeekMoney(amount, currency)}, the starting balance set on the DeepSeek tab.`,
    });
  }
  const referenceTotal = toFiniteNumber(reference?.referenceTotal);
  if (referenceTotal === null || referenceTotal <= 0) return null;
  const since = day(reference.referenceAt);
  const atReference = formatDeepSeekMoney(referenceTotal, currency);
  return buildMeter({
    id: `deepseek-balance-${unit}`,
    label: `Balance (${currency})`,
    unit,
    used: Math.max(0, referenceTotal - total),
    allowance: referenceTotal,
    remaining: total,
    note: total >= referenceTotal
      ? `Measured from ${atReference}, the highest balance seen${since ? ` (${since})` : ''}.`
      : `Measured from ${atReference}, the balance after its last rise${since ? ` (${since})` : ''}.`,
  });
}

/** The first day of the next UTC month, as the budget meter's reset. */
function nextMonthStart(today) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

function spendOf(row, costKey, toolsCostKey) {
  return (row[costKey] ?? 0) + (row[toolsCostKey] || 0);
}

/** The daily and per-model rows' cost fields for a currency. */
function costKeysFor(currency) {
  return currency === 'CNY'
    ? { costKey: 'costCny', toolsCostKey: 'toolsCostCny' }
    : { costKey: 'costUsd', toolsCostKey: 'toolsCostUsd' };
}

function priceCurrency(value) {
  const currency = String(value || '').toUpperCase();
  return DEEPSEEK_PRICE_CURRENCIES.includes(currency) ? currency : null;
}

/**
 * The optional monthly budget, against this calendar month's spend (UTC)
 * from the daily table in the budget's own currency: amber from 75%, red
 * from 90% or over. The label names the currency, so a budget saved in one
 * is not read in the other.
 */
function budgetMeter({ budget, days, today, currency, actualDays = [] }) {
  const allowance = toFiniteNumber(budget);
  if (allowance === null || allowance <= 0) return null;
  const { costKey, toolsCostKey } = costKeysFor(currency);
  const monthStart = `${today.slice(0, 7)}-01`;
  const spent = days.filter((row) => row.day >= monthStart && row.day <= today)
    .reduce((sum, row) => sum + spendOf(row, costKey, toolsCostKey), 0);
  // With export days in the month the spend is partly DeepSeek's own: the
  // note says which, the "estimated" flag would say all of it is.
  const actual = actualDays.some((value) => value >= monthStart && value <= today);
  return buildMeter({
    id: 'deepseek-monthly-budget',
    label: `Monthly budget (${currency})`,
    unit: currency.toLowerCase(),
    used: Math.round(spent * 100) / 100,
    allowance,
    remaining: Math.round((allowance - spent) * 100) / 100,
    resetAt: nextMonthStart(today),
    estimated: !actual,
    note: actual
      ? `Spend since ${dayLabel(monthStart)}: actual on the days of the DeepSeek export, estimated on the others; starts over on the 1st.`
      : `This relay's estimated spend since ${dayLabel(monthStart)} (UTC); starts over on the 1st.`,
  });
}

/**
 * The last 30 days' spend per day, stacked by model. A day without turns is
 * an empty column, so the chart always spans the 30 days.
 */
function dailyChart({ days, firstDay, today, unit, costKey, toolsCostKey, actual = false }) {
  const end = Date.parse(`${today}T00:00:00.000Z`);
  const start = end - (CHART_DAYS - 1) * DAY_MS;
  const startDay = utcDay(start);
  const rows = days.filter((row) => row.day >= startDay && row.day <= today);
  if (!rows.some((row) => spendOf(row, costKey, toolsCostKey) > 0)) return null;
  const { series, seriesKeyOf } = chartModelSeries(rows.map((row) => row.model));
  const items = [];
  for (let time = start; time <= end; time += DAY_MS) {
    const key = utcDay(time);
    const values = {};
    for (const row of rows) {
      if (row.day !== key) continue;
      const seriesKey = seriesKeyOf(row.model);
      values[seriesKey] = (values[seriesKey] || 0) + spendOf(row, costKey, toolsCostKey);
    }
    items.push({ key, label: dayLabel(key), values });
  }
  // The daily history began with the relay that keeps it; the totals above
  // may reach further back.
  const shortHistory = firstDay && firstDay > startDay;
  return buildChart({
    id: 'deepseek-daily-spend',
    label: `Daily spend, last ${CHART_DAYS} days`,
    kind: 'columns',
    unit,
    series,
    items,
    note: actual
      ? `Actual from the DeepSeek export on the days it covers, by its days; estimated on the others, by UTC day, from the turns of this relay${shortHistory ? ` (kept by day since ${dayLabel(firstDay)})` : ''}.`
      : (shortHistory
        ? `Daily history on this relay starts ${dayLabel(firstDay)}; earlier turns are only in the totals.`
        : 'Estimated, by UTC day, from the turns of this relay.'),
  });
}

/**
 * Where the money went per model: the cost split into cache hits, cache
 * misses and output (and the searches and fetches once there are any), from
 * the token counts at DeepSeek's prices. The summary says what the cache
 * saved: the hit tokens at the miss price, less what they cost.
 */
function sharesChart({ models, currency, unit, costKey, toolsCostKey }) {
  const priced = models.filter((entry) => entry[costKey] !== null && entry[costKey] > 0);
  if (!priced.length) return null;
  const anyTools = models.some((entry) => entry[toolsCostKey] > 0);
  let saved = 0;
  const items = priced.map((entry) => {
    const price = deepseekPriceFor({ model: entry.model, at: OFF_PEAK_REFERENCE_AT, currency });
    const values = { hit: 0, miss: 0, output: 0, tools: entry[toolsCostKey] || 0 };
    if (price) {
      const weights = {
        hit: entry.hitTokens * price.hit,
        miss: entry.missTokens * price.miss,
        output: entry.outputTokens * price.output,
      };
      const weightSum = weights.hit + weights.miss + weights.output;
      if (weightSum > 0) {
        for (const key of ['hit', 'miss', 'output']) values[key] = entry[costKey] * (weights[key] / weightSum);
        saved += values.hit * (price.miss / price.hit - 1);
      }
    } else {
      // No price for the split: the whole cost in one piece.
      values.miss = entry[costKey];
    }
    return { key: entry.model.toLowerCase(), label: deepseekModelLabel(entry.model), values };
  });
  return buildChart({
    id: 'deepseek-spend-shares',
    label: 'Where the money goes',
    kind: 'bars',
    unit,
    series: SHARE_SERIES.filter((entry) => entry.key !== 'tools' || anyTools),
    items,
    summary: saved > 0 ? `Cache saved about ${formatDeepSeekMoney(saved, currency, { estimate: true })}` : null,
    note: 'Cache saved: the cache hits at the cache-miss price, less what they cost.',
  });
}

const tenDecimals = (value) => Math.round(Number(value) * 1e10) / 1e10;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A failed read still shows the last balance that was read, with its time.
function balanceShown(balance) {
  return balance?.ok === true ? balance : (balance?.previous?.ok === true ? balance.previous : null);
}

/**
 * The usage card's currency for a balance read (deepseek-balance-service.mjs
 * getBalance()): the balance's with money on it, USD without one. The
 * import uses it to say whether the card can use the export's rows.
 */
export function deepseekCardCurrency(balance) {
  const shown = balanceShown(balance);
  return priceCurrency(primaryBalance(Array.isArray(shown?.balances) ? shown.balances : [])?.currency) || 'USD';
}

/** "2026-10-25 00:00 UTC+01:00" for an export period's ISO time with its offset. */
function exportTime(value) {
  const text = toTrimmedString(value);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(text || '');
  if (!match) return text || '';
  return `${match[1]} ${match[2]} UTC${match[3] === 'Z' ? '' : match[3]}`;
}

/**
 * The imported DeepSeek export over the estimate, at read time
 * (services/deepseek-usage-import.mjs; nothing booked is changed). `actuals`
 * is `readActuals()`: the saved key's `{ through, rows: [{ day, model,
 * hitTokens, missTokens, outputTokens, requestCount, cost, currency }],
 * coveredDays: [{ day, currency }] }` per export day. Rows in another
 * currency than the card's are not used.
 *
 * The export covers the days the imports have rows for, for any key
 * (`coveredDays`; without it, the saved key's days), so a gap between two
 * imports keeps its estimate. On a covered day each model's daily row is
 * the export's (none in the export is none spent), with the web search
 * estimate dropped, since the export's cost is everything charged.
 * Each model's totals lose the estimate of the covered days and gain the
 * export's.
 *
 * The totals hold every turn, the daily rows only start with `days.firstDay`
 * (when the relay began keeping them, with no backfill), so a covered day
 * before it has no estimate to take out and that first day only part of
 * one: those days, the first included, are left out, the first day named
 * in `actual.leftOutBefore` (or `actual.leftOutAll` with no daily history and
 * turns in the totals). Returns `{ totals, days, actual }` in the shapes the
 * card takes, `actual` null when nothing was used.
 */
export function overlayDeepSeekActuals({ totals = null, days = null, actuals = null, currency = 'USD' } = {}) {
  const usable = (Array.isArray(actuals?.rows) ? actuals.rows : [])
    .map((row) => ({
      day: toTrimmedString(row?.day),
      model: String(toTrimmedString(row?.model) || '').toLowerCase(),
      hitTokens: toFiniteNumber(row?.hitTokens) || 0,
      missTokens: toFiniteNumber(row?.missTokens) || 0,
      outputTokens: toFiniteNumber(row?.outputTokens) || 0,
      requestCount: toFiniteNumber(row?.requestCount) || 0,
      cost: toFiniteNumber(row?.cost) || 0,
      currency: String(row?.currency || '').toUpperCase(),
    }))
    .filter((row) => row.currency === currency && DAY_PATTERN.test(row.day || '') && row.model);
  if (!usable.length) return { totals, days, actual: null };
  const { costKey, toolsCostKey } = costKeysFor(currency);
  // The days before the daily history have no estimate to replace, and its
  // first day only the turns booked after the upgrade (no backfill): the
  // earlier ones are only in the totals. Both are left out.
  const historyStart = toTrimmedString(days?.firstDay);
  const hasTurns = (Array.isArray(totals?.models) ? totals.models : []).some((entry) => (toFiniteNumber(entry?.turnCount) || 0) > 0);
  const inHistory = (value) => (historyStart ? value > historyStart : !hasTurns);
  const coveredList = Array.isArray(actuals?.coveredDays)
    ? actuals.coveredDays
      .filter((entry) => String(entry?.currency || '').toUpperCase() === currency)
      .map((entry) => toTrimmedString(entry?.day))
    : [];
  const allCovered = new Set([...coveredList, ...usable.map((row) => row.day)].filter((value) => DAY_PATTERN.test(value || '')));
  const coveredDays = new Set([...allCovered].filter(inHistory));
  const leftOut = allCovered.size - coveredDays.size;
  const leftOutNote = leftOut ? (historyStart ? { leftOutBefore: historyStart } : { leftOutAll: true }) : {};
  const used = usable.filter((row) => coveredDays.has(row.day));
  if (!used.length) return { totals, days, actual: null, ...(leftOut ? { leftOut: leftOutNote } : {}) };
  const dayList = [...coveredDays].sort();
  const firstDay = dayList[0];
  const lastDay = dayList[dayList.length - 1];
  const covered = (value) => coveredDays.has(value);
  const keyOf = (dayValue, model) => `${dayValue}\u0000${model}`;
  const actualByDay = new Map();
  for (const row of used) {
    const key = keyOf(row.day, row.model);
    const current = actualByDay.get(key);
    if (!current) actualByDay.set(key, { ...row });
    else for (const field of ['hitTokens', 'missTokens', 'outputTokens', 'requestCount', 'cost']) current[field] += row[field];
  }

  // The daily rows: the export's on the days it covers.
  const removed = new Map();
  const add = (map, model, entry) => {
    const current = map.get(model) || { hitTokens: 0, missTokens: 0, outputTokens: 0, searchRequests: 0, fetchRequests: 0, requestCount: 0, cost: 0, toolsCost: 0, firstDay: null, lastDay: null, priced: false };
    for (const field of ['hitTokens', 'missTokens', 'outputTokens', 'searchRequests', 'fetchRequests', 'requestCount', 'cost', 'toolsCost']) current[field] += entry[field] || 0;
    if (entry.priced) current.priced = true;
    if (entry.day && (!current.firstDay || entry.day < current.firstDay)) current.firstDay = entry.day;
    if (entry.day && (!current.lastDay || entry.day > current.lastDay)) current.lastDay = entry.day;
    map.set(model, current);
  };
  const usedDays = new Set();
  const outDays = [];
  for (const row of Array.isArray(days?.days) ? days.days : []) {
    const rowDay = toTrimmedString(row?.day) || '';
    const model = String(toTrimmedString(row?.model) || '').toLowerCase();
    if (!covered(rowDay) || !model) {
      outDays.push(row);
      continue;
    }
    add(removed, model, {
      hitTokens: toFiniteNumber(row.hitTokens) || 0,
      missTokens: toFiniteNumber(row.missTokens) || 0,
      outputTokens: toFiniteNumber(row.outputTokens) || 0,
      searchRequests: toFiniteNumber(row.searchRequests) || 0,
      fetchRequests: toFiniteNumber(row.fetchRequests) || 0,
      cost: toFiniteNumber(row[costKey]) || 0,
      toolsCost: toFiniteNumber(row[toolsCostKey]) || 0,
    });
    const actual = actualByDay.get(keyOf(rowDay, model));
    if (actual) usedDays.add(keyOf(rowDay, model));
    outDays.push({
      ...row,
      hitTokens: actual?.hitTokens || 0,
      missTokens: actual?.missTokens || 0,
      outputTokens: actual?.outputTokens || 0,
      searchRequests: 0,
      fetchRequests: 0,
      requestCount: actual?.requestCount || 0,
      [costKey]: tenDecimals(actual?.cost || 0),
      [toolsCostKey]: 0,
    });
  }
  const added = new Map();
  for (const [key, actual] of actualByDay) {
    add(added, actual.model, { ...actual, priced: true });
    if (usedDays.has(key)) continue;
    outDays.push({
      day: actual.day,
      model: actual.model,
      hitTokens: actual.hitTokens,
      missTokens: actual.missTokens,
      outputTokens: actual.outputTokens,
      searchRequests: 0,
      fetchRequests: 0,
      requestCount: actual.requestCount,
      costUsd: null,
      costCny: null,
      toolsCostUsd: 0,
      toolsCostCny: 0,
      [costKey]: tenDecimals(actual.cost),
    });
  }
  outDays.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.model) < String(b.model) ? -1 : String(a.model) > String(b.model) ? 1 : 0));

  // The totals: less the covered days' estimate, plus the export.
  const keep = (value) => Math.max(0, tenDecimals(value));
  const seen = new Set();
  const models = (Array.isArray(totals?.models) ? totals.models : []).map((entry) => {
    const model = String(toTrimmedString(entry?.model) || '').toLowerCase();
    seen.add(model);
    const minus = removed.get(model);
    const plus = added.get(model);
    if (!minus && !plus) return entry;
    const less = (field) => (toFiniteNumber(entry?.[field]) || 0) - (minus?.[field] || 0) + (plus?.[field] || 0);
    const estimate = toFiniteNumber(entry?.[costKey]);
    return {
      ...entry,
      hitTokens: keep(less('hitTokens')),
      missTokens: keep(less('missTokens')),
      outputTokens: keep(less('outputTokens')),
      searchRequests: keep((toFiniteNumber(entry?.searchRequests) || 0) - (minus?.searchRequests || 0)),
      fetchRequests: keep((toFiniteNumber(entry?.fetchRequests) || 0) - (minus?.fetchRequests || 0)),
      requestCount: plus?.requestCount || 0,
      [costKey]: estimate === null && !plus ? null : keep((estimate || 0) - (minus?.cost || 0) + (plus?.cost || 0)),
      [toolsCostKey]: keep((toFiniteNumber(entry?.[toolsCostKey]) || 0) - (minus?.toolsCost || 0)),
    };
  });
  for (const [model, plus] of added) {
    if (seen.has(model)) continue;
    models.push({
      model,
      hitTokens: plus.hitTokens,
      missTokens: plus.missTokens,
      outputTokens: plus.outputTokens,
      searchRequests: 0,
      fetchRequests: 0,
      turnCount: 0,
      requestCount: plus.requestCount,
      costUsd: null,
      costCny: null,
      toolsCostUsd: 0,
      toolsCostCny: 0,
      [costKey]: tenDecimals(plus.cost),
      firstSeenAt: `${plus.firstDay}T00:00:00.000Z`,
      lastSeenAt: `${plus.lastDay}T00:00:00.000Z`,
    });
  }
  return {
    totals: { ...(totals || {}), models },
    days: { ...(days || {}), days: outDays },
    actual: { firstDay, lastDay, days: dayList, through: toTrimmedString(actuals?.through) || null, ...leftOutNote },
  };
}

/**
 * @param {object} options
 * @param {object|null} options.balance  deepseek-balance-service.mjs answer:
 *   `{ ok: true, isAvailable, balances, fetchedAt, cached }`,
 *   `{ ok: false, code, error, fetchedAt, previous }`, or null (not read)
 * @param {Array} [options.balanceReferences]  planUsageService.recordDeepSeekBalance():
 *   `[{ currency, referenceTotal, lastTotal, referenceAt }]`
 * @param {object|null} options.totals   planUsageService.readDeepSeekUsageTotals()
 * @param {object|null} [options.days]   planUsageService.readDeepSeekUsageDays():
 *   `{ days, firstDay }` reaching back to the first of this month or 30 days
 * @param {number|null} [options.monthlyBudget]  the DeepSeek tab's budget
 * @param {string|null} [options.monthlyBudgetCurrency]  its currency, `USD` or
 *   `CNY`; null for a budget saved before the currency was stored, which is
 *   read in the balance's currency
 * @param {object|null} [options.startingBalance]  the DeepSeek tab's
 *   starting balance, `{ amount, setAt }`, in the balance's currency: the
 *   bar of the balance's currency measures from it while it applies
 * @param {string} [options.now]         the report's time (UTC today for the charts)
 * @param {boolean} options.configured   DeepSeek is on
 * @param {object|null} [options.actuals] the imported export's figures of the
 *   saved key (deepseek-usage-import.mjs readActuals()), laid over the
 *   estimate by overlayDeepSeekActuals; null for the estimate alone
 */
export function buildDeepSeekPlanCard({
  balance = null,
  balanceReferences = [],
  totals = null,
  days = null,
  monthlyBudget = null,
  monthlyBudgetCurrency = null,
  startingBalance = null,
  now = null,
  configured = true,
  actuals = null,
} = {}) {
  if (!configured) return null;
  const today = day(now) || new Date().toISOString().slice(0, 10);
  const references = (Array.isArray(balanceReferences) ? balanceReferences : [])
    .filter((entry) => toTrimmedString(entry?.currency));
  const problem = balanceProblem(balance);
  const shownBalance = balanceShown(balance);
  const balances = Array.isArray(shownBalance?.balances) ? shownBalance.balances : [];
  const currency = deepseekCardCurrency(balance);
  const overlay = overlayDeepSeekActuals({ totals, days, actuals, currency });
  const actual = overlay.actual;
  const spend = normalizeTotals(overlay.totals);
  const dayRows = (Array.isArray(overlay.days?.days) ? overlay.days.days : [])
    .map((row) => ({
      day: toTrimmedString(row?.day),
      model: toTrimmedString(row?.model),
      costUsd: toFiniteNumber(row?.costUsd),
      costCny: toFiniteNumber(row?.costCny),
      toolsCostUsd: toFiniteNumber(row?.toolsCostUsd) || 0,
      toolsCostCny: toFiniteNumber(row?.toolsCostCny) || 0,
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day) && row.model);
  const links = [
    { label: 'DeepSeek usage', url: DEEPSEEK_USAGE_URL },
    { label: 'Top up', url: DEEPSEEK_TOP_UP_URL },
  ];

  if (!balances.length && !spend.models.length) {
    return buildUnavailableCard({
      provider: DEEPSEEK_PROVIDER_TYPE,
      label: DEEPSEEK_PROVIDER_LABEL,
      status: problem?.status || STATUS_UNAVAILABLE,
      message: problem?.message || 'No DeepSeek balance or usage yet. The balance is read with the saved key; the spend is counted from DeepSeek turns on this relay.',
      links,
      capturedAt: balance?.fetchedAt || null,
    });
  }

  const readAt = shownBalance && shownBalance !== balance && shownBalance.fetchedAt
    ? `${String(shownBalance.fetchedAt).replace('T', ' ').slice(0, 16)} UTC`
    : null;
  const notes = shownBalances(balances).map((entry) => balanceNote(entry, { readAt })).filter(Boolean);
  let message = problem?.message || null;
  if (!problem && shownBalance && shownBalance.isAvailable === false) {
    message = 'DeepSeek reports this balance as not enough for API calls: DeepSeek turns fail until it is topped up.';
    notes.push({ id: 'deepseek-top-up', text: 'Add money to the account to use DeepSeek again.', link: { label: 'Top up', url: DEEPSEEK_TOP_UP_URL } });
  }

  const { costKey, toolsCostKey } = costKeysFor(currency);
  const unit = currency.toLowerCase();
  const priced = spend.models.filter((entry) => entry[costKey] !== null);
  // The balance bar of each currency with money on it, against the balance
  // after its last rise (the balance's main currency against the starting
  // balance while it applies, as the DeepSeek tab's note judges it); then the
  // budget, when one is set, in its own currency.
  const startingCurrency = deepseekStartingBalanceCurrency(balances);
  const meters = shownBalances(balances).filter(hasMoney)
    .map((entry) => balanceMeter(
      entry,
      references.find((ref) => String(ref.currency).toUpperCase() === String(entry.currency).toUpperCase()),
      String(entry.currency).toUpperCase() === startingCurrency ? startingBalance : null,
    ))
    .filter(Boolean);
  const budgetCurrency = priceCurrency(monthlyBudgetCurrency) || currency;
  meters.push(budgetMeter({ budget: monthlyBudget, days: dayRows, today, currency: budgetCurrency, actualDays: actual && budgetCurrency === currency ? actual.days : [] }));
  const charts = [
    dailyChart({ days: dayRows, firstDay: toTrimmedString(days?.firstDay), today, unit, costKey, toolsCostKey, actual: !!actual }),
    sharesChart({ models: spend.models, currency, unit, costKey, toolsCostKey }),
  ];
  const details = [];
  if (spend.models.length) {
    // The web searches of every model, in one line: they are priced the same
    // whatever the model (0 before DeepSeek charged for them). The fetch count
    // stays in the books and shows only if DeepSeek ever reports one: its API
    // refuses a server-side fetch tool, and WebFetch is plain tokens.
    const searches = spend.models.reduce((sum, entry) => sum + entry.searchRequests, 0);
    const fetches = spend.models.reduce((sum, entry) => sum + entry.fetchRequests, 0);
    const toolsTotal = spend.models.reduce((sum, entry) => sum + entry[toolsCostKey], 0);
    const total = priced.reduce((sum, entry) => sum + entry[costKey], 0) + toolsTotal;
    const unpriced = spend.models.length - priced.length;
    // With an export, the spend starts at its first day if that is earlier.
    const since = [day(spend.firstSeenAt), actual?.firstDay].filter(Boolean).sort()[0] || '';
    const spendValue = priced.length || toolsTotal > 0 ? formatDeepSeekMoney(total, currency, { estimate: true }) : 'no price known';
    const unpricedText = unpriced ? `${unpriced} model${unpriced === 1 ? '' : 's'} without a known price not included` : '';
    const spendLabel = actual ? 'Spend, actual and estimated' : 'Estimated spend on this relay';
    notes.push({
      id: 'deepseek-spend',
      text: `${spendLabel}: ${spendValue}${since ? ` since ${since}` : ''}${unpricedText ? ` (${unpricedText})` : ''}`,
      label: spendLabel,
      value: spendValue,
      hint: [since ? `since ${since}` : '', unpricedText].filter(Boolean).join(', '),
    });
    const count = (number, noun) => `${Math.round(number)} ${noun}${number === 1 ? '' : 'es'}`;
    details.push(buildDetailSection({
      id: 'deepseek-spend-by-model',
      label: actual ? 'Spend by model, actual and estimated' : 'Estimated spend by model',
      rows: [
        ...spend.models.map((entry) => ({
          label: deepseekModelLabel(entry.model),
          value: entry[costKey] !== null ? formatDeepSeekMoney(entry[costKey], currency, { estimate: true }) : 'no price known',
          hint: [
            entry.turnCount > 0 ? `${Math.round(entry.turnCount)} turn${entry.turnCount === 1 ? '' : 's'}${day(entry.firstSeenAt) ? ` since ${day(entry.firstSeenAt)}` : ''}` : '',
            entry.requestCount > 0 ? `${Math.round(entry.requestCount)} request${entry.requestCount === 1 ? '' : 's'} in the export` : '',
          ].filter(Boolean).join(' · '),
        })),
        ...(searches + fetches > 0 ? [{
          label: 'Search',
          value: formatDeepSeekMoney(toolsTotal, currency, { estimate: true }),
          hint: fetches > 0 ? `${count(searches, 'search')} · ${count(fetches, 'fetch')}` : count(searches, 'search'),
        }] : []),
      ],
      note: actual
        ? 'The export\'s figures are the saved key\'s, from wherever it was used; the estimate counts DeepSeek turns on this relay only.'
        : 'DeepSeek turns on this relay only; the DeepSeek platform\'s usage page has every request on the account.',
      open: true,
    }));
    details.push(buildDetailSection({
      id: 'deepseek-tokens-by-model',
      label: 'Priced tokens by model',
      rows: spend.models.map((entry) => {
        const input = entry.hitTokens + entry.missTokens;
        return {
          label: deepseekModelLabel(entry.model),
          value: `cache hit ${formatTokens(entry.hitTokens)} · cache miss ${formatTokens(entry.missTokens)} · output ${formatTokens(entry.outputTokens)}`,
          hint: input > 0 ? `${Math.round((entry.hitTokens / input) * 100)}% of input from the cache` : null,
        };
      }),
      open: true,
    }));
    const leftOut = actual || overlay.leftOut || {};
    const leftOutText = leftOut.leftOutBefore
      ? ` Export days through ${dayLabel(leftOut.leftOutBefore)}, the day this relay's daily history starts, are left out: their turns are not all in that history, only in the estimate.`
      : (leftOut.leftOutAll ? ' The export is left out: this relay keeps no daily history to set it against.' : '');
    if (actual) {
      notes.push({
        id: 'deepseek-actual',
        text: `Actual figures from the DeepSeek export on the days it covers (the last through ${exportTime(actual.through) || actual.lastDay}), estimated on the others. On export days the export's cost includes the web searches. Export days follow the export's time zone, the estimate's UTC.${leftOutText}`,
        link: { label: 'DeepSeek usage', url: DEEPSEEK_USAGE_URL },
      });
    } else if (leftOutText) {
      notes.push({ id: 'deepseek-actual', text: leftOutText.trim(), link: { label: 'DeepSeek usage', url: DEEPSEEK_USAGE_URL } });
    }
    notes.push({
      id: 'deepseek-estimate',
      text: `Estimated from DeepSeek's published prices (${DEEPSEEK_PRICING_SOURCE.date}); peak or off-peak by the time of each turn. Peak is ${formatUtcHourRanges(DEEPSEEK_PEAK_HOURS_UTC)} on weekdays (Monday to Friday by UTC). ${DEEPSEEK_HOLIDAY_NOTE} ${DEEPSEEK_SEARCH_NOTE}`,
      link: { label: 'Prices', url: DEEPSEEK_PRICING_SOURCE.url },
      // The browser shows the peak hours in its own time zone.
      hours: { utcRanges: DEEPSEEK_PEAK_HOURS_UTC },
    });
  }

  let source = SOURCE_WORKER;
  if (balance?.ok === true) source = balance.cached === true ? SOURCE_CACHE : SOURCE_LIVE;
  else if (shownBalance) source = SOURCE_CACHE;

  return buildProviderCard({
    provider: DEEPSEEK_PROVIDER_TYPE,
    label: DEEPSEEK_PROVIDER_LABEL,
    status: problem && problem.status !== STATUS_NOT_CONFIGURED ? STATUS_PARTIAL : (problem?.status || STATUS_OK),
    message,
    source,
    stale: !!shownBalance && shownBalance !== balance,
    capturedAt: shownBalance?.fetchedAt || spend.lastSeenAt || null,
    meters: meters.filter(Boolean),
    charts: charts.filter(Boolean),
    details: details.filter(Boolean),
    notes,
    links,
  });
}
