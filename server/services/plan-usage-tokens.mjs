'use strict';

/**
 * The Tokens sections of every Check Usage tab: what the turns on
 * a provider ran, from the token booking (token-usage-service.mjs,
 * `readPeriods`), with fresh input, output, cache writes and cache reads
 * apart.
 *
 * Per billing group (the plan, then each own key on Copilot), two sections,
 * `<provider>-token-usage` and `<provider>-token-usage-by-model` (an own
 * key's with `-byok-<type>` after; DeepSeek's own `deepseek-tokens-by-model`
 * stays beside them):
 * - "Tokens": today, this month and all time, with the share of input the
 *   cache served as the hint;
 * - "Tokens by model, this month": one row per model, today and all time in
 *   the hint.
 * A field nobody reported is "—", and the note says why; it also says since
 * when the tab counts, and, on a tab with days copied at the upgrade, that
 * their input includes cache writes. Values stay within the agent card's
 * 120 characters (remote-relay-dispatcher.mjs).
 */

import { buildDetailSection } from './plan-usage-contract.mjs';
import { partlyReportedFields } from './token-usage-service.mjs';

export const TOKEN_SHOWN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']);

const FIELD_SHORT = Object.freeze({
  inputTokens: 'in',
  outputTokens: 'out',
  cacheWriteTokens: 'cache w',
  cacheReadTokens: 'cache r',
});

const FIELD_NAME = Object.freeze({
  inputTokens: 'fresh input',
  outputTokens: 'output',
  cacheWriteTokens: 'cache writes',
  cacheReadTokens: 'cache reads',
});

const PROVIDER_NAME = Object.freeze({
  github: 'Copilot',
  claude: 'Claude',
  'claude-api': 'The Claude API',
  'claude-cloud': 'Claude cloud',
  deepseek: 'DeepSeek',
  cursor: 'Cursor',
  grok: 'Grok',
});

const KEY_NAME = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  azure: 'Azure OpenAI',
});

// Only these tabs carry days copied at the upgrade (migration 0036).
const BACKFILLED_PROVIDERS = Object.freeze(['claude-api', 'deepseek']);

/**
 * A token count for a card: "—" for unknown (null), else 999, 1.2k, 3.4M or
 * 5.6B. Unlike the older card formatters it does not stop at millions and
 * never shows an unknown count as 0.
 */
export function formatTokenCount(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '—';
  const scaled = (divisor, unit) => `${(number / divisor).toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (number < 1000) return String(Math.round(number));
  if (number < 999_950) return scaled(1000, 'k');
  if (number < 999_950_000) return scaled(1_000_000, 'M');
  return scaled(1_000_000_000, 'B');
}

/** "in 1.2M · out 340k · cache w 1.1M · cache r 45.3M". */
export function formatTokenSplit(totals) {
  return TOKEN_SHOWN_FIELDS.map((field) => `${FIELD_SHORT[field]} ${formatTokenCount(totals?.[field])}`).join(' · ');
}

function totalTokens(totals) {
  let sum = null;
  for (const field of TOKEN_SHOWN_FIELDS) {
    const value = totals?.[field];
    if (value !== null && value !== undefined) sum = (sum ?? 0) + value;
  }
  return sum;
}

/** "45% of input from the cache", or null when there is nothing to say. */
function cacheShareHint(totals) {
  if (totals?.cacheReadTokens === null || totals?.cacheReadTokens === undefined) return null;
  const input = (totals.inputTokens || 0) + (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0);
  if (input <= 0) return null;
  return `${Math.round((totals.cacheReadTokens / input) * 100)}% of input from the cache`;
}

/** "Oct 1, 2026" for a `YYYY-MM-DD` day (a calendar date, no zone). */
export function tokenDayLabel(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(day || '');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function keyName(billing) {
  const type = String(billing || '').replace(/^byok-/, '');
  return KEY_NAME[type] || (type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Own key');
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The note under a group's "Tokens" section: why a field is "—", which
 * fields some turns left out, the copied days, since when it counts.
 */
export function tokenSectionNote(group) {
  const who = group.billing ? keyName(group.billing) : (PROVIDER_NAME[group.provider] || group.provider);
  const backfill = BACKFILLED_PROVIDERS.includes(group.provider) && group.backfilled?.allTime === true;
  const allTime = group.periods.allTime;
  const partly = new Set(partlyReportedFields(allTime));
  const lines = [];
  for (const field of TOKEN_SHOWN_FIELDS) {
    // The copied days never split cache writes out; the backfill line says so.
    const explainedByBackfill = backfill && field === 'cacheWriteTokens';
    if (allTime[field] === null && !explainedByBackfill) {
      lines.push(`${who} does not report ${FIELD_NAME[field]}.`);
    } else if (partly.has(field) && !explainedByBackfill) {
      lines.push(`${capitalize(FIELD_NAME[field])} not reported for some turns.`);
    }
  }
  if (backfill) {
    lines.push(group.firstTurnsDay
      ? `Before ${tokenDayLabel(group.firstTurnsDay)}, input includes cache writes.`
      : 'On the days copied from before the upgrade, input includes cache writes.');
  }
  if (group.since) lines.push(`Counting since ${tokenDayLabel(group.since)}.`);
  return lines.join(' ');
}

// `a` and `b` (a model's totals of one period, emptyTotals() of
// token-usage-service.mjs) added up as the booking adds its rows: a field
// nobody reported stays null.
function addTotals(a, b) {
  const sum = { ...a, reported: { ...(a.reported || {}) } };
  for (const field of Object.keys(b || {})) {
    if (field === 'reported') {
      for (const [name, count] of Object.entries(b.reported || {})) sum.reported[name] = (sum.reported[name] || 0) + count;
    } else if (b[field] !== null && b[field] !== undefined) {
      sum[field] = (sum[field] ?? 0) + b[field];
    }
  }
  return sum;
}

/**
 * A group's models by the name the tab shows: ids with one name (a dated and
 * an undated Claude id) become one entry, with their totals added up and the
 * ids in `models`; sorted by that name.
 */
export function mergeModelsByLabel(models, modelLabel = null) {
  const byLabel = new Map();
  for (const entry of models || []) {
    const label = (typeof modelLabel === 'function' ? String(modelLabel(entry.model) || '').trim() : '') || entry.model;
    const merged = byLabel.get(label);
    if (!merged) {
      byLabel.set(label, { label, models: [entry.model], today: entry.today, month: entry.month, allTime: entry.allTime });
      continue;
    }
    merged.models.push(entry.model);
    for (const period of ['today', 'month', 'allTime']) merged[period] = addTotals(merged[period], entry[period]);
  }
  return [...byLabel.values()]
    .map((entry) => ({ ...entry, models: [...entry.models].sort() }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

/**
 * The two sections of one billing group, open. `modelLabel(model)` names a
 * model as the tab does elsewhere (the Claude API tab: the Console's display
 * name); the raw id where it has none. Ids with one name are one row, the ids
 * in its title.
 */
export function buildTokenSections(group, { modelLabel = null } = {}) {
  if (!group || !group.periods) return [];
  const suffix = group.billing ? `-${group.billing}` : '';
  const labelSuffix = group.billing ? ` — own ${keyName(group.billing)} key` : '';
  const periodRow = (label, totals) => ({
    label,
    value: totals.rows ? formatTokenSplit(totals) : 'no turns',
    hint: totals.rows ? cacheShareHint(totals) : null,
  });
  const sections = [
    buildDetailSection({
      id: `${group.provider}-token-usage${suffix}`,
      label: `Tokens${labelSuffix}`,
      rows: [
        periodRow('Today', group.periods.today),
        periodRow('This month', group.periods.month),
        periodRow('All time', group.periods.allTime),
      ],
      note: tokenSectionNote(group),
      open: true,
    }),
    buildDetailSection({
      id: `${group.provider}-token-usage-by-model${suffix}`,
      label: `Tokens by model, this month${labelSuffix}`,
      rows: mergeModelsByLabel(group.models, modelLabel)
        .filter((entry) => entry.month.rows > 0)
        .map((entry) => ({
          label: entry.label,
          value: formatTokenSplit(entry.month),
          hint: `today ${entry.today.rows ? formatTokenCount(totalTokens(entry.today)) : 'none'} · all time ${formatTokenCount(totalTokens(entry.allTime))}`,
          ...(entry.models.length > 1 ? { title: `Model ids: ${entry.models.join(', ')}` } : {}),
        })),
      open: true,
    }),
  ];
  return sections.filter(Boolean);
}

/**
 * Append the Tokens sections to every provider card the report holds,
 * from `readPeriods({ provider })`; `modelLabelFor(provider)` may give a
 * tab its model names. A provider with nothing booked gets
 * none; the plan's group comes before the own keys'. Cards are changed in
 * place; a failing read leaves them as they were.
 */
export function appendTokenSections(cards, readPeriods, { modelLabelFor = null } = {}) {
  if (!Array.isArray(cards) || typeof readPeriods !== 'function') return cards;
  for (const card of cards) {
    if (!card || !card.provider) continue;
    let periods = null;
    try {
      periods = readPeriods({ provider: card.provider });
    } catch {
      periods = null;
    }
    const groups = periods?.groups || [];
    if (!groups.length) continue;
    const modelLabel = typeof modelLabelFor === 'function' ? modelLabelFor(card.provider) : null;
    const sections = groups.flatMap((group) => buildTokenSections(group, { modelLabel }));
    if (sections.length) card.details = [...(Array.isArray(card.details) ? card.details : []), ...sections];
  }
  return cards;
}
