'use strict';

/**
 * The charts of every Check Usage tab but DeepSeek's (which keeps its own,
 * plan-usage-deepseek.mjs): what the turns on a provider cost or ran per
 * day, and where it went by model, from the token booking's day rows
 * (token-usage-service.mjs `readPeriods`, a group's `days`).
 *
 * Per billing group and per window (7, 30 and 90 relay-local days; the
 * browser shows the one picked), two charts through `buildChart`:
 * - the daily chart, one column per day of the window, oldest first, stacked
 *   by model, every model: the money (`usd`) on the tabs whose turns carry a cost, the
 *   tokens (all four kinds, cache reads included) on the others;
 * - the split, one line over the same window cut into every model, each
 *   part as long as its cost, or its tokens, in the window.
 * The Claude subscription tabs show Claude Code's figure at API prices, said
 * to be not billed. Both charts have the same series, every model of the 90
 * days, largest first, so a model keeps its colour in both and in every
 * window; nothing is folded into "Other models". A window with nothing in it
 * has no charts; a group with nothing in 90 days has none at all.
 *
 * The cost is the one booked per turn (Claude Code's, the provider's, the
 * image price table's): OAR adds no price here. A day without a cost counts
 * 0 in its column, and the note says how many tokens had none.
 */

import { CHART_WINDOW_DAYS, buildChart } from './plan-usage-contract.mjs';
// plan-usage-tokens.mjs imports this module too; both only call each
// other's functions, never at load time.
import { formatTokenCount, ownKeyName } from './plan-usage-tokens.mjs';
import { shiftDay } from './token-usage-service.mjs';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']);

// The tabs whose turns carry a cost; the others chart tokens.
const COST_PROVIDERS = new Set(['claude', 'claude-cloud', 'claude-api', 'grok', 'openai']);
// A subscription billed flat: the cost is what the turns would cost at API prices.
const API_PRICE_PROVIDERS = new Set(['claude', 'claude-cloud']);
const PROVIDER_NAME = Object.freeze({
  claude: 'Claude Code',
  'claude-cloud': 'Claude Code',
  'claude-api': 'Claude Code',
  github: 'Copilot',
  cursor: 'Cursor',
  grok: 'Grok',
  openai: 'OpenAI',
});
const API_PRICE_NOTE = "Claude Code's figure at API prices; the subscription is billed flat, this is not charged.";
const FIGURE_NOTE = Object.freeze({
  claude: API_PRICE_NOTE,
  'claude-cloud': API_PRICE_NOTE,
  'claude-api': "Claude Code's estimate of the turns on this key.",
  grok: "The cost Grok's agent reports per turn.",
  openai: "OAR's estimate of each image call at OpenAI's prices.",
});
const BACKFILL_NOTE = 'On the days copied from before the upgrade, input includes cache writes.';

/** "Oct 29" for a `YYYY-MM-DD` day (a calendar date, no zone). */
function dayLabel(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const sumOf = (rows, valueOf) => rows.reduce((sum, row) => sum + valueOf(row), 0);
const tokensOf = (row) => TOKEN_FIELDS.reduce((sum, field) => sum + (Number(row[field]) || 0), 0);
const costOf = (row) => Number(row.costUsd) || 0;
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The charts' series, the same in every window and in both charts: every
 * model of the 90 days with something to show, largest first (ties by
 * name), so a model keeps its colour everywhere. None is folded away; the
 * page colours the first eight and draws the rest grey.
 */
function modelSeries(rows, labelOf, valueOf) {
  const totals = new Map();
  for (const row of rows) {
    const label = labelOf(row);
    totals.set(label, (totals.get(label) || 0) + valueOf(row));
  }
  const labels = [...totals.keys()]
    .filter((label) => totals.get(label) > 0)
    .sort((a, b) => totals.get(b) - totals.get(a) || a.localeCompare(b, 'en'));
  return labels.map((label) => ({ key: `model:${label}`, label }));
}

/** Per model name, the rows of a window, ordered by name. */
function byModel(rows, labelOf) {
  const models = new Map();
  for (const row of rows) {
    const label = labelOf(row);
    if (!models.has(label)) models.set(label, []);
    models.get(label).push(row);
  }
  return [...models.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
}

/**
 * The charts of one billing group (a `readPeriods` group with `days`): two
 * per window with something in it, each with `windowDays`. `today` is the
 * relay's local day (`readPeriods().today`); `modelLabel(model)` names a
 * model as the tab does, the raw id where it gives none. `[]` when the group
 * has nothing in its longest window.
 */
export function buildTokenCharts(group, { today, modelLabel = null, windows = CHART_WINDOW_DAYS } = {}) {
  const windowList = [...new Set((Array.isArray(windows) ? windows : []).filter((days) => CHART_WINDOW_DAYS.includes(days)))]
    .sort((a, b) => a - b);
  if (!group?.provider || !DAY_PATTERN.test(String(today || '')) || !windowList.length) return [];
  const longestStart = shiftDay(today, -(windowList[windowList.length - 1] - 1));
  const rows = (Array.isArray(group.days) ? group.days : [])
    .filter((row) => row && DAY_PATTERN.test(String(row.day || '')) && row.day >= longestStart && row.day <= today);
  if (!rows.length) return [];

  const provider = group.provider;
  const costTab = COST_PROVIDERS.has(provider);
  // A cost tab whose turns carried no cost at all charts their tokens.
  const usd = costTab && rows.some((row) => costOf(row) > 0);
  const valueOf = usd ? costOf : tokensOf;
  const labelOf = (row) => (typeof modelLabel === 'function' ? String(modelLabel(row.model) || '').trim() : '') || row.model;
  const series = modelSeries(rows, labelOf, valueOf);
  const keyOf = (label) => `model:${label}`;
  if (!series.length) return [];

  const ownKey = String(group.billing || '').startsWith('byok-');
  const idSuffix = group.billing ? `-${group.billing}` : '';
  const labelSuffix = ownKey ? ` — own ${ownKeyName(group.billing)} key` : '';
  const apiPrices = usd && API_PRICE_PROVIDERS.has(provider);
  const who = ownKey ? `The own ${ownKeyName(group.billing)} key` : (PROVIDER_NAME[provider] || provider);
  let figureNote;
  if (usd) figureNote = FIGURE_NOTE[provider];
  else if (costTab) figureNote = `${who} reported no cost for these turns; tokens are what they ran.`;
  else figureNote = `${who} reports no cost per turn; tokens are what the turns ran.`;
  const names = apiPrices
    ? { daily: 'Daily use at API prices', split: 'Where it would go at API prices' }
    : (usd ? { daily: 'Daily spend', split: 'Where the money goes' } : { daily: 'Daily tokens', split: 'Where the tokens go' });
  const ids = usd
    ? { daily: `${provider}-daily-spend${idSuffix}`, split: `${provider}-spend-shares${idSuffix}` }
    : { daily: `${provider}-daily-tokens${idSuffix}`, split: `${provider}-token-shares${idSuffix}` };
  const unit = usd ? 'usd' : 'tokens';

  const charts = [];
  for (const windowDays of windowList) {
    const start = shiftDay(today, -(windowDays - 1));
    const inWindow = rows.filter((row) => row.day >= start);
    if (!(sumOf(inWindow, valueOf) > 0)) continue;
    const label = (name) => `${name}, last ${windowDays} days${labelSuffix}`;

    const items = [];
    for (let day = start; day <= today; day = shiftDay(day, 1)) {
      const values = {};
      for (const row of inWindow) {
        if (row.day !== day) continue;
        const key = keyOf(labelOf(row));
        values[key] = (values[key] || 0) + valueOf(row);
      }
      items.push({ key: day, label: dayLabel(day), values });
    }
    // A day without a cost counts 0; its tokens are named instead.
    const unpricedTokens = usd
      ? sumOf(inWindow, (row) => (row.costUsd === null || row.costUsd === undefined ? tokensOf(row) : Number(row.unknownCostTokens) || 0))
      : 0;
    const dailyNote = [
      figureNote,
      group.since && group.since > start ? `Counting since ${dayLabel(group.since)}.` : '',
      unpricedTokens > 0 ? `${formatTokenCount(unpricedTokens)} tokens without a price are not in the chart.` : '',
    ].filter(Boolean).join(' ');
    charts.push(buildChart({
      id: `${ids.daily}-${windowDays}d`,
      label: label(names.daily),
      kind: 'columns',
      unit,
      series,
      items,
      note: dailyNote,
      windowDays,
    }));

    // One line for the window, cut into every model.
    const shares = {};
    for (const row of inWindow) {
      const key = keyOf(labelOf(row));
      shares[key] = (shares[key] || 0) + valueOf(row);
    }
    let splitNote = null;
    if (usd) {
      const models = byModel(inWindow, labelOf);
      const unpricedModels = models.filter(([, modelRows]) => !(sumOf(modelRows, costOf) > 0) && sumOf(modelRows, tokensOf) > 0).length;
      if (unpricedModels) splitNote = `${plural(unpricedModels, 'model')} without a cost ${unpricedModels === 1 ? 'is' : 'are'} not in the chart.`;
    } else if (inWindow.some((row) => row.backfill)) {
      splitNote = BACKFILL_NOTE;
    }
    const split = {
      series,
      items: [{ key: `last-${windowDays}d`, label: `Last ${windowDays} days`, values: shares }],
      note: splitNote,
    };
    charts.push(buildChart({
      id: `${ids.split}-${windowDays}d`,
      label: label(names.split),
      kind: 'share',
      unit,
      ...split,
      windowDays,
    }));
  }
  return charts.filter(Boolean);
}
