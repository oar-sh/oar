'use strict';

/**
 * Claude API spend for the Check Usage card and the monthly cap (plan
 * decisions 10 and 12).
 *
 * The figures are what claude-api-usage-service.mjs booked into
 * claude_api_usage_totals (migration 0034): per local day of the relay and
 * model, Claude Code's own cost estimate (`modelUsage[*].costUSD`), and the
 * tokens of turns it could not price (`unknown_cost_tokens`). OAR keeps no
 * price table of its own.
 *
 * - **Today and this month** are the relay's local days, as the booking
 *   writes them: the month is the local days `YYYY-MM-01` to `YYYY-MM-31` of
 *   today's local month, read with the booking's own `localDay`, never from
 *   UTC dates. A 23 or 25 hour day (DST) is one day like any other.
 * - **Unpriced** tokens (a model Claude Code has no price for, a resumed
 *   turn booked without its mark) are not $0: the card says the estimate is
 *   incomplete, and the cap counts only what is priced.
 * - **No turn count.** `turn_count` counts the posts that booked something
 *   per model, so a turn on two models counts twice; the card shows spend and
 *   tokens only.
 * - **The cap** is reached when this month's priced estimate, in cents, is
 *   at or above `claude_api_monthly_cap_usd`. The runtime asks it through
 *   getClaudeApiCapState: the claim of a Claude API row, the billing switch
 *   to the key, an agent's send to a chat on the key and a new Claude API
 *   chat are refused while it is reached. A running turn finishes.
 */

import {
  SOURCE_WORKER,
  STATUS_OK,
  STATUS_UNAVAILABLE,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  roundCurrency,
  toFiniteNumber,
  toIsoTimestamp,
} from './plan-usage-contract.mjs';
import { CLAUDE_API_PROVIDER_LABEL, CLAUDE_API_PROVIDER_TYPE } from './claude-api-settings-service.mjs';
import { claudeAttributionModelLabel } from '../../shared/claude-attribution.mjs';

export const CLAUDE_API_CONSOLE_BILLING_URL = 'https://platform.claude.com/settings/billing';
export const CLAUDE_API_CONSOLE_LIMITS_URL = 'https://platform.claude.com/settings/limits';
export const CLAUDE_API_CAP_REACHED_CODE = 'CLAUDE_API_CAP_REACHED';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_MS = 3_600_000;

function count(value) {
  const number = toFiniteNumber(value);
  return number !== null && number > 0 ? Math.round(number) : 0;
}

function money(value) {
  const number = toFiniteNumber(value);
  return number !== null && number > 0 ? number : 0;
}

/** "$1.23"; an amount under one cent keeps four decimals ("$0.0042"). */
export function formatClaudeApiUsd(value) {
  const number = money(value);
  const digits = number !== 0 && number < 0.01 ? 4 : 2;
  return `$${number.toFixed(digits)}`;
}

function formatTokens(value) {
  const number = count(value);
  if (number < 1000) return String(number);
  if (number < 1_000_000) return `${(number / 1000).toFixed(1)}k`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}

/** "Oct 1" for a `YYYY-MM-DD` day (a calendar date, no zone). */
function dayLabel(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The local month around `today` (`YYYY-MM-DD`, the relay's local date):
 * `{ today, month, monthStart, monthEnd, nextMonthStart }`. `monthEnd` is
 * day 31, which as a text bound holds every month's last day.
 */
export function claudeApiMonthBounds(today) {
  const day = String(today || '');
  if (!DAY_PATTERN.test(day)) return null;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const ym = day.slice(0, 7);
  return {
    today: day,
    month: ym,
    monthStart: `${ym}-01`,
    monthEnd: `${ym}-31`,
    nextMonthStart: `${String(next.year).padStart(4, '0')}-${String(next.month).padStart(2, '0')}-01`,
  };
}

/**
 * The first instant whose local day (by `localDay`, the booking's) is `day`
 * or later, as an ISO time: when a local month starts. Searched between 15
 * hours before and 13 hours after that day's UTC midnight, which brackets
 * every zone's midnight, so the answer follows the zone and its DST rules
 * without knowing them.
 */
export function claudeApiLocalDayStart(localDay, day) {
  if (typeof localDay !== 'function' || !DAY_PATTERN.test(String(day || ''))) return null;
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  let lo = midnight - 15 * HOUR_MS; // local day before `day` in every zone
  let hi = midnight + 13 * HOUR_MS; // `day` or later in every zone
  if (localDay(new Date(lo).toISOString()) >= day || localDay(new Date(hi).toISOString()) < day) return null;
  // To the millisecond: about 27 steps.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDay(new Date(mid).toISOString()) >= day) hi = mid;
    else lo = mid;
  }
  return new Date(hi).toISOString();
}

function sumModels(rows) {
  const byModel = new Map();
  for (const row of rows) {
    const model = String(row?.model || '').trim().toLowerCase();
    if (!model) continue;
    const current = byModel.get(model) || {
      model, hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0, unknownCostTokens: 0, lastSeenAt: null,
    };
    current.hitTokens += count(row.hit_tokens);
    current.missTokens += count(row.miss_tokens);
    current.outputTokens += count(row.output_tokens);
    current.costUsd += money(row.cost_usd);
    current.unknownCostTokens += count(row.unknown_cost_tokens);
    const seen = toIsoTimestamp(row.last_seen_at);
    if (seen && (!current.lastSeenAt || seen > current.lastSeenAt)) current.lastSeenAt = seen;
    byModel.set(model, current);
  }
  return [...byModel.values()].sort((a, b) => (b.costUsd - a.costUsd) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

function totalOf(models) {
  return {
    costUsd: models.reduce((sum, entry) => sum + entry.costUsd, 0),
    unknownCostTokens: models.reduce((sum, entry) => sum + entry.unknownCostTokens, 0),
  };
}

/**
 * This month's and today's booked spend, from the booking service
 * (`readDaysBetween`, `localDay`). Returns `{ bounds, today, month }`, each
 * of `today`/`month` being `{ models, costUsd, unknownCostTokens }`, plus
 * `lastSeenAt`.
 */
export function readClaudeApiSpend({ usageService, now = Date.now() } = {}) {
  if (typeof usageService?.localDay !== 'function' || typeof usageService?.readDaysBetween !== 'function') {
    throw new Error('readClaudeApiSpend requires the Claude API usage service');
  }
  const bounds = claudeApiMonthBounds(usageService.localDay(new Date(now).toISOString()));
  if (!bounds) throw new Error('The relay\'s local date could not be read');
  const rows = usageService.readDaysBetween(bounds.monthStart, bounds.monthEnd)
    .filter((row) => DAY_PATTERN.test(String(row?.day || '')) && row.day >= bounds.monthStart && row.day <= bounds.monthEnd);
  const monthModels = sumModels(rows);
  const todayModels = sumModels(rows.filter((row) => row.day === bounds.today));
  const lastSeenAt = monthModels.map((entry) => entry.lastSeenAt).filter(Boolean).sort().pop() || null;
  return {
    bounds,
    today: { models: todayModels, ...totalOf(todayModels) },
    month: { models: monthModels, ...totalOf(monthModels) },
    lastSeenAt,
  };
}

/** The cap from the settings: a positive number of US dollars, or null. */
function capOf(value) {
  const number = toFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

/**
 * The cap against this month's spend: `{ reached, capUsd, spentUsd,
 * incomplete, error? }`. `error` (only when reached) is the refusal's first
 * sentence; the callers add what did not happen and the way out.
 */
export function claudeApiCapStateFrom({ capUsd = null, spend = null } = {}) {
  const cap = capOf(capUsd);
  const spentUsd = roundCurrency(money(spend?.month?.costUsd)) || 0;
  const incomplete = count(spend?.month?.unknownCostTokens) > 0;
  if (cap === null) return { reached: false, capUsd: null, spentUsd, incomplete };
  const reached = spentUsd >= cap;
  return {
    reached,
    capUsd: cap,
    spentUsd,
    incomplete,
    // One stretch at the cap: this local month and this cap. A note said once
    // per chat per episode (messages-routes.mjs, continuations on the key).
    episode: `${String(spend?.bounds?.month || '')}:${cap}`,
    // `reason` without the place, for a message that names it in its remedy.
    ...(reached
      ? {
        error: `This month's estimated Claude API spend, ${formatClaudeApiUsd(spentUsd)}, has reached the monthly cap of ${formatClaudeApiUsd(cap)} set in Settings → Providers → Claude API.`,
        reason: `This month's estimated Claude API spend, ${formatClaudeApiUsd(spentUsd)}, has reached the monthly cap of ${formatClaudeApiUsd(cap)}.`,
      }
      : {}),
  };
}

function modelLabel(model, settings) {
  const detail = settings?.modelDetails?.[String(model).toLowerCase()];
  return String(detail?.displayName || '').trim() || claudeAttributionModelLabel(model);
}

/** "$1.23", "$1.23 + unpriced tokens" or "no price known". */
function spendValue({ costUsd, unknownCostTokens }) {
  if (unknownCostTokens > 0 && costUsd <= 0) return 'no price known';
  return `${formatClaudeApiUsd(costUsd)}${unknownCostTokens > 0 ? ' (estimate incomplete)' : ''}`;
}

function incompleteText(unknownCostTokens) {
  return `${formatTokens(unknownCostTokens)} tokens had no known price and are not in this figure`;
}

/**
 * @param {object} options
 * @param {object} options.settings  claude-api-settings-service getSettings():
 *   `configured`, `enabled`, `monthlyCapUsd`, `modelDetails`
 * @param {object|null} options.spend  readClaudeApiSpend()
 * @param {string|null} [options.resetAt]  when the local month starts over (ISO)
 * @param {string|null} [options.timeZone]  the relay's zone name, for the note
 * @param {string|null} [options.error]  why the spend could not be read
 */
export function buildClaudeApiPlanCard({
  settings = null,
  spend = null,
  resetAt = null,
  timeZone = null,
  error = null,
} = {}) {
  if (settings?.configured !== true && settings?.enabled !== true) return null;
  const links = [
    { label: 'Console billing', url: CLAUDE_API_CONSOLE_BILLING_URL },
    { label: 'Console limits', url: CLAUDE_API_CONSOLE_LIMITS_URL },
  ];
  if (!spend) {
    return buildProviderCard({
      provider: CLAUDE_API_PROVIDER_TYPE,
      label: CLAUDE_API_PROVIDER_LABEL,
      status: STATUS_UNAVAILABLE,
      message: `This relay's Claude API spend could not be read${error ? `: ${error}` : ''}.${capOf(settings?.monthlyCapUsd) !== null ? ' While a monthly cap is set, new turns on the key are refused until it can be read.' : ''}`,
      source: SOURCE_WORKER,
      links,
    });
  }
  const { bounds, today, month } = spend;
  const cap = claudeApiCapStateFrom({ capUsd: settings?.monthlyCapUsd, spend });
  const zone = String(timeZone || '').trim();
  const since = dayLabel(bounds.monthStart);

  const messages = [];
  if (settings?.enabled !== true) messages.push('Claude API is switched off; these are the turns it ran this month.');
  if (cap.reached) {
    messages.push(`This month's estimate has reached the cap: new Claude API turns, agents' new Claude API sessions and switches to the API key are refused until ${dayLabel(bounds.nextMonthStart)} or until the cap is raised. Turns already running finish, and their cost is added when they end.`);
  }
  if (!month.models.length) messages.push('No turns on the Claude API key this month yet.');

  const meters = [];
  if (cap.capUsd !== null) {
    meters.push(buildMeter({
      id: 'claude-api-monthly-cap',
      label: 'Monthly cap',
      unit: 'usd',
      used: cap.spentUsd,
      allowance: cap.capUsd,
      remaining: roundCurrency(cap.capUsd - cap.spentUsd),
      resetAt,
      estimated: true,
      note: [
        `This relay's estimated spend since ${since}${zone ? ` (${zone})` : ''}; starts over on the 1st. At the cap, new Claude API turns are refused. A turn's cost is booked when it ends, so turns already running finish and can take the month past the cap.`,
        cap.incomplete ? `Estimate incomplete: ${incompleteText(month.unknownCostTokens)}.` : '',
      ].filter(Boolean).join(' '),
    }));
  }

  const notes = [
    {
      id: 'claude-api-spend-today',
      label: 'Estimated today',
      value: spendValue(today),
      hint: today.unknownCostTokens > 0 ? incompleteText(today.unknownCostTokens) : null,
      text: `Estimated spend today: ${spendValue(today)}${today.unknownCostTokens > 0 ? ` (${incompleteText(today.unknownCostTokens)})` : ''}`,
    },
    {
      id: 'claude-api-spend-month',
      label: 'Estimated this month',
      value: spendValue(month),
      hint: [`since ${since}`, month.unknownCostTokens > 0 ? incompleteText(month.unknownCostTokens) : ''].filter(Boolean).join(', '),
      text: `Estimated spend this month: ${spendValue(month)} since ${since}${month.unknownCostTokens > 0 ? ` (${incompleteText(month.unknownCostTokens)})` : ''}`,
    },
    {
      id: 'claude-api-estimate',
      // The card's links already name Console billing: not twice.
      text: `Estimated by Claude Code from its own price table, for the turns on the saved key on this relay (sub-agents, compaction and web search included). Days and the month follow the relay's clock${zone ? ` (${zone})` : ''}. Turns paid from the subscriber API credit of a Max or Team plan are counted too; OAR cannot see that credit or the Console balance, and Console spend limits apply on top of the cap.`,
    },
  ];

  const details = [];
  if (month.models.length) {
    details.push(buildDetailSection({
      id: 'claude-api-spend-by-model',
      label: 'Estimated spend by model, this month',
      rows: month.models.map((entry) => {
        const todayEntry = today.models.find((candidate) => candidate.model === entry.model);
        return {
          label: modelLabel(entry.model, settings),
          value: spendValue(entry),
          hint: [
            todayEntry ? `today ${spendValue(todayEntry)}` : 'nothing today',
            entry.unknownCostTokens > 0 ? incompleteText(entry.unknownCostTokens) : '',
          ].filter(Boolean).join(' · '),
        };
      }),
      note: 'Claude API turns on this relay only; the Console has every request on the key.',
      open: true,
    }));
    // Tokens by model: the Tokens sections every tab gets (plan-usage-tokens.mjs).
  }

  return buildProviderCard({
    provider: CLAUDE_API_PROVIDER_TYPE,
    label: CLAUDE_API_PROVIDER_LABEL,
    status: STATUS_OK,
    message: messages.join(' ') || null,
    source: SOURCE_WORKER,
    capturedAt: spend.lastSeenAt || null,
    meters: meters.filter(Boolean),
    details: details.filter(Boolean),
    notes,
    links,
  });
}

/**
 * The card and the cap over the booking service and the settings. The days,
 * and the zone the card names, are the booking service's own (`localDay`,
 * `timeZone`), so the two never disagree.
 */
export function createClaudeApiPlanUsage({
  usageService,
  getSettings = () => null,
  now = () => Date.now(),
} = {}) {
  if (!usageService) throw new Error('createClaudeApiPlanUsage requires the Claude API usage service');
  const zoneName = String(usageService.timeZone || '').trim();

  function readSpend() {
    return readClaudeApiSpend({ usageService, now: now() });
  }

  /** `{ reached, capUsd, spentUsd, incomplete, error? }`; throws when the totals cannot be read. */
  function getCapState() {
    const capUsd = capOf(getSettings()?.monthlyCapUsd);
    if (capUsd === null) return { reached: false, capUsd: null };
    return claudeApiCapStateFrom({ capUsd, spend: readSpend() });
  }

  /** The Check Usage card, or null while Claude API has no key and is off. */
  function buildCard() {
    const settings = getSettings();
    if (settings?.configured !== true && settings?.enabled !== true) return null;
    let spend = null;
    let error = null;
    try {
      spend = readSpend();
    } catch (readError) {
      error = String(readError?.message || readError);
    }
    const resetAt = spend ? claudeApiLocalDayStart(usageService.localDay, spend.bounds.nextMonthStart) : null;
    return buildClaudeApiPlanCard({ settings, spend, resetAt, timeZone: zoneName, error });
  }

  /**
   * A model's name as the card shows it: the Console's display name, else
   * the Claude label for the id (the Tokens sections use it too).
   */
  function labelModel(model) {
    try {
      return modelLabel(model, getSettings());
    } catch {
      return null;
    }
  }

  return { readSpend, getCapState, buildCard, modelLabel: labelModel };
}

/**
 * Tells when the cap flips, either way: the composer's toggle and the
 * usage-limit banner's switch button read a chat's billing state, whose
 * `switchable` follows the cap, so the runtime re-announces the Claude chats'
 * states then. `check(reason)` after anything that moves the cap (a booked
 * report, the cap setting, the clock passing into a new month) returns
 * `{ reached, changed }`; a cap that cannot be read counts as reached. The
 * first check only sets where it stands.
 */
export function createClaudeApiCapWatch({ getCapState, onChange = () => {}, logger = console } = {}) {
  if (typeof getCapState !== 'function') throw new Error('createClaudeApiCapWatch requires getCapState');
  let last = null;
  function check(reason = '') {
    let reached = true;
    try { reached = getCapState()?.reached === true; } catch { reached = true; }
    const changed = last !== null && reached !== last;
    last = reached;
    if (changed) {
      try {
        onChange({ reached, reason });
      } catch (error) {
        try { logger.warn?.(`[claude-api-cap] announcing the cap ${reached ? 'reached' : 'cleared'} failed: ${error?.message || error}`); } catch {}
      }
    }
    return { reached, changed };
  }
  return { check };
}

/**
 * Which chats already have the note for a self-started turn stopped on the
 * key, per episode of the refusal (`episode`: the cap's month and value, or
 * the refusal's code): later stops in the same episode stay quiet. An
 * episode ends for every chat when the cap clears or the Claude API
 * settings are saved, and for one chat when a turn of it on the key answers.
 */
export function createClaudeApiStopNoteLedger() {
  const noted = new Map();
  return {
    has: (conversationId, episode) => noted.get(String(conversationId || '')) === String(episode || ''),
    note: (conversationId, episode) => { noted.set(String(conversationId || ''), String(episode || '')); },
    clear: (conversationId) => { noted.delete(String(conversationId || '')); },
    clearAll: () => { noted.clear(); },
  };
}
