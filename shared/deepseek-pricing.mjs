// DeepSeek's published prices, for the usage card's estimate of what this
// relay's DeepSeek turns cost. DeepSeek reports no cost per request, and
// Claude Code's own `total_cost_usd` is computed at Claude's prices, so the
// estimate is tokens times this table.
//
// Source: api-docs.deepseek.com/quick_start/pricing (USD) and its zh-cn page
// (CNY), built 2026-10-19. Prices are per 1M tokens: a cache hit, a cache
// miss (input DeepSeek had not cached) and output. Peak hours cost exactly
// twice the off-peak price. Peak is Monday to Friday 01:00–04:00 and
// 06:00–10:00 UTC (09:00–12:00 and 14:00–18:00 Beijing time); everything else
// is off-peak. On Chinese public holidays DeepSeek charges off-peak prices all
// day; the estimate doesn't know those dates, so turns at peak hours on a
// holiday are counted at double the real price.
//
// A model the table does not know gets no estimate (null), never a guess.
//
// Claude Code's WebSearch runs on DeepSeek's Search API. Source:
// api-docs.deepseek.com/guides/search (USD) and its zh-cn page (CNY), read
// 2026-10-24: $0.75 / ¥5 per 1,000 successful requests for each of Search
// and Fetch, charged from 2026-11-01 00:00 Beijing time (2026-10-31 16:00
// UTC), no peak or off-peak. Requests before that are counted but cost 0.
// Claude Code's WebFetch is not a Fetch request: it reads the page on the
// relay host and sends the text to the model (plain tokens), and DeepSeek's
// API refuses the server-side fetch tool (422, checked 2026-10-25). The Fetch
// price stays for a fetch DeepSeek might report one day.

export const DEEPSEEK_PRICING_SOURCE = Object.freeze({
  url: 'https://api-docs.deepseek.com/quick_start/pricing',
  date: '2026-10-19',
});

export const DEEPSEEK_SEARCH_PRICING = Object.freeze({
  url: 'https://api-docs.deepseek.com/guides/search',
  date: '2026-10-24',
  chargedFrom: '2026-10-31T16:00:00.000Z',
  // Per 1,000 successful requests, the same for a search and a fetch.
  perThousand: Object.freeze({ USD: 0.75, CNY: 5 }),
});

export const DEEPSEEK_PRICE_CURRENCIES = Object.freeze(['USD', 'CNY']);

const TOKENS_PER_PRICE_UNIT = 1_000_000;

function prices(hit, miss, output) {
  return Object.freeze({ hit, miss, output });
}

const PRICE_TABLE = Object.freeze({
  'deepseek-flash': Object.freeze({
    offPeak: Object.freeze({ USD: prices(0.003, 0.15, 0.60), CNY: prices(0.02, 1, 4) }),
    peak: Object.freeze({ USD: prices(0.006, 0.30, 1.20), CNY: prices(0.04, 2, 8) }),
  }),
  'deepseek-v4-pro': Object.freeze({
    offPeak: Object.freeze({ USD: prices(0.022, 0.66, 1.98), CNY: prices(0.15, 4.5, 13.5) }),
    peak: Object.freeze({ USD: prices(0.044, 1.32, 3.96), CNY: prices(0.30, 9, 27) }),
  }),
});

// Ids DeepSeek still accepts and serves with the Flash model.
const PRICE_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
});

// [start, end) hours in UTC, Monday to Friday. The card shows them in the
// browser's time zone (plan-usage-view.mjs).
export const DEEPSEEK_PEAK_HOURS_UTC = Object.freeze([Object.freeze([1, 4]), Object.freeze([6, 10])]);
const PEAK_HOURS_UTC = DEEPSEEK_PEAK_HOURS_UTC;

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The id the table prices a model under ("deepseek-v4-flash[1m]" → "deepseek-flash"), or '' when unknown. */
export function deepseekPricedModel(value) {
  const id = String(value ?? '').trim().toLowerCase().replace(/\[1m\]$/, '');
  if (PRICE_TABLE[id]) return id;
  return PRICE_ALIASES[id] || '';
}

/** Whether DeepSeek bills an instant at its peak price; null for an unreadable time. */
export function isDeepSeekPeakTime(at) {
  const date = toDate(at);
  if (!date) return null;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return PEAK_HOURS_UTC.some(([start, end]) => minutes >= start * 60 && minutes < end * 60);
}

/**
 * The prices per 1M tokens for a model at an instant: `{ hit, miss, output,
 * peak }`, or null for an unknown model, currency or time.
 */
export function deepseekPriceFor({ model, at, currency = 'USD' } = {}) {
  const entry = PRICE_TABLE[deepseekPricedModel(model)];
  const unit = String(currency ?? '').trim().toUpperCase();
  const peak = isDeepSeekPeakTime(at);
  if (!entry || !DEEPSEEK_PRICE_CURRENCIES.includes(unit) || peak === null) return null;
  return { ...entry[peak ? 'peak' : 'offPeak'][unit], peak };
}

function tokenCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * What the tokens of one request (or one turn) cost at DeepSeek's price for
 * its time, in `currency` (USD or CNY). A missing count is 0. Null when the
 * model, the currency or the time is unknown.
 */
export function estimateCost({ model, at, hitTokens = 0, missTokens = 0, outputTokens = 0, currency = 'USD' } = {}) {
  const price = deepseekPriceFor({ model, at, currency });
  if (!price) return null;
  const cost = (
    tokenCount(hitTokens) * price.hit
    + tokenCount(missTokens) * price.miss
    + tokenCount(outputTokens) * price.output
  ) / TOKENS_PER_PRICE_UNIT;
  // Ten decimals: enough for a single token, and no binary-float tails.
  return Math.round(cost * 1e10) / 1e10;
}

/**
 * What the web searches and fetches of one turn cost at the time `at`, in
 * `currency`: 0 before DeepSeek started charging for them, null for an
 * unreadable time or an unknown currency. Flat per request, peak or not.
 */
export function estimateSearchCost({ at, searchRequests = 0, fetchRequests = 0, currency = 'USD' } = {}) {
  const date = toDate(at);
  const unit = String(currency ?? '').trim().toUpperCase();
  const price = DEEPSEEK_SEARCH_PRICING.perThousand[unit];
  if (!date || price === undefined) return null;
  if (date.getTime() < Date.parse(DEEPSEEK_SEARCH_PRICING.chargedFrom)) return 0;
  const cost = (tokenCount(searchRequests) + tokenCount(fetchRequests)) * price / 1000;
  return Math.round(cost * 1e10) / 1e10;
}
