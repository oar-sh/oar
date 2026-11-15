import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTokenCharts } from './plan-usage-token-charts.mjs';

// Counts and costs are made up. Today is Nov 15: the 7 days start Nov 9, the
// 30 Oct 17, the 90 Aug 18.
const TODAY = '2026-11-15';

function row(day, model, { input = null, output = null, cacheWrite = null, cacheRead = null, cost = null, unknown = 0, backfill = false } = {}) {
  return {
    day,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    reasoningTokens: null,
    costUsd: cost,
    unknownCostTokens: unknown,
    turnCount: 1,
    backfill,
  };
}

const groupOf = (provider, days, { billing = '', since = days.map((entry) => entry.day).sort()[0] } = {}) => ({ provider, billing, since, days });
const byId = (charts) => Object.fromEntries(charts.map((chart) => [chart.id, chart]));
const itemTotal = (item) => Object.values(item.values).reduce((sum, value) => sum + value, 0);
const chartTotal = (chart) => chart.items.reduce((sum, item) => sum + itemTotal(item), 0);
const round = (value) => Math.round(value * 1e9) / 1e9;

// One day in each window's own stretch: Nov 12 (7), Oct 20 (30), Sep 1 (90).
const SPREAD = [
  row('2026-11-12', 'm', { input: 100, output: 10, cost: 1 }),
  row('2026-10-20', 'm', { input: 200, output: 20, cost: 2 }),
  row('2026-09-01', 'm', { input: 400, output: 40, cost: 4 }),
];

test('per provider: money on the tabs whose turns carry a cost, tokens on Copilot and Cursor', () => {
  const cases = [
    ['claude-api', 'usd', 'claude-api-daily-spend-30d', 'Daily spend, last 30 days', 'claude-api-spend-shares-30d', 'Where the money goes, last 30 days'],
    ['grok', 'usd', 'grok-daily-spend-30d', 'Daily spend, last 30 days', 'grok-spend-shares-30d', 'Where the money goes, last 30 days'],
    ['openai', 'usd', 'openai-daily-spend-30d', 'Daily spend, last 30 days', 'openai-spend-shares-30d', 'Where the money goes, last 30 days'],
    ['claude', 'usd', 'claude-daily-spend-30d', 'Daily use at API prices, last 30 days', 'claude-spend-shares-30d', 'Where it would go at API prices, last 30 days'],
    ['claude-cloud', 'usd', 'claude-cloud-daily-spend-30d', 'Daily use at API prices, last 30 days', 'claude-cloud-spend-shares-30d', 'Where it would go at API prices, last 30 days'],
    ['github', 'tokens', 'github-daily-tokens-30d', 'Daily tokens, last 30 days', 'github-token-shares-30d', 'Where the tokens go, last 30 days'],
    ['cursor', 'tokens', 'cursor-daily-tokens-30d', 'Daily tokens, last 30 days', 'cursor-token-shares-30d', 'Where the tokens go, last 30 days'],
  ];
  for (const [provider, unit, dailyId, dailyLabel, splitId, splitLabel] of cases) {
    const charts = byId(buildTokenCharts(groupOf(provider, SPREAD), { today: TODAY }));
    const daily = charts[dailyId];
    const split = charts[splitId];
    assert.ok(daily && split, provider);
    assert.deepEqual([daily.kind, daily.unit, daily.label, split.kind, split.unit, split.label], ['columns', unit, dailyLabel, 'share', unit, splitLabel], provider);
  }
  const claude = byId(buildTokenCharts(groupOf('claude', SPREAD), { today: TODAY }));
  assert.match(claude['claude-daily-spend-30d'].note, /^Claude Code's figure at API prices; the subscription is billed flat, this is not charged\./);
  assert.match(byId(buildTokenCharts(groupOf('claude-api', SPREAD), { today: TODAY }))['claude-api-daily-spend-30d'].note, /^Claude Code's estimate of the turns on this key\./);
  assert.match(byId(buildTokenCharts(groupOf('github', SPREAD), { today: TODAY }))['github-daily-tokens-30d'].note, /^Copilot reports no cost per turn; tokens are what the turns ran\./);
  // Tokens: all four kinds summed, cache reads included.
  const cursor = byId(buildTokenCharts(groupOf('cursor', [row('2026-11-15', 'm', { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, cost: 9 })]), { today: TODAY }));
  assert.deepEqual(cursor['cursor-daily-tokens-7d'].items.at(-1).values, { 'model:m': 10 });
});

test('per window: 7, 30 and 90 columns, oldest first, empty days at 0, ids unique', () => {
  const charts = buildTokenCharts(groupOf('grok', SPREAD), { today: TODAY });
  assert.deepEqual(charts.map((chart) => [chart.id, chart.windowDays, chart.items.length]), [
    ['grok-daily-spend-7d', 7, 7],
    ['grok-spend-shares-7d', 7, 1],
    ['grok-daily-spend-30d', 30, 30],
    ['grok-spend-shares-30d', 30, 1],
    ['grok-daily-spend-90d', 90, 90],
    ['grok-spend-shares-90d', 90, 1],
  ]);
  const [week, , month, , quarter] = charts;
  assert.deepEqual([week.items[0].key, week.items[0].label, week.items.at(-1).key, week.items.at(-1).label], ['2026-11-09', 'Nov 9', '2026-11-15', 'Nov 15']);
  assert.equal(month.items[0].key, '2026-10-17');
  assert.equal(quarter.items[0].key, '2026-08-18');
  // Every day is there once, in order, and a day without turns is 0.
  assert.deepEqual(quarter.items.map((item) => item.key), [...quarter.items.map((item) => item.key)].sort());
  assert.equal(new Set(quarter.items.map((item) => item.key)).size, 90);
  assert.deepEqual(month.items.find((item) => item.key === '2026-11-01').values, { 'model:m': 0 });
  assert.deepEqual([chartTotal(week), chartTotal(month), chartTotal(quarter)], [1, 3, 7]);
  // A DST change inside the window neither drops nor doubles a day.
  assert.deepEqual(month.items.filter((item) => item.key >= '2026-10-24' && item.key <= '2026-10-26').map((item) => item.label), ['Oct 24', 'Oct 25', 'Oct 26']);
  // Unique across windows and groups (an own key's carry its billing).
  const all = [...charts, ...buildTokenCharts(groupOf('grok', SPREAD, { billing: 'byok-openai' }), { today: TODAY })];
  assert.equal(new Set(all.map((chart) => chart.id)).size, all.length);
});

test('a window with nothing in it has no charts; 90 days with nothing, none at all', () => {
  const older = [row('2026-10-20', 'm', { input: 5, cost: 0.5 })];
  assert.deepEqual(buildTokenCharts(groupOf('grok', older), { today: TODAY }).map((chart) => chart.windowDays), [30, 30, 90, 90]);
  // 90 days back and earlier: out of every window.
  assert.deepEqual(buildTokenCharts(groupOf('grok', [row('2026-08-17', 'm', { input: 5, cost: 0.5 })]), { today: TODAY }), []);
  assert.deepEqual(buildTokenCharts(groupOf('grok', []), { today: TODAY }), []);
  assert.deepEqual(buildTokenCharts({ provider: 'grok', billing: '' }, { today: TODAY }), []);
  assert.deepEqual(buildTokenCharts(groupOf('grok', older), { today: 'not a day' }), []);
  // A day after today (a clock change) is not drawn.
  assert.deepEqual(buildTokenCharts(groupOf('grok', [row('2026-11-16', 'm', { input: 5, cost: 0.5 })]), { today: TODAY }), []);
});

test('series: every model of the 90 days, largest first, the same in every window and in both charts', () => {
  const four = ['d', 'c', 'b', 'a'].map((model) => row('2026-11-15', model, { input: 1, cost: 1 }));
  assert.deepEqual(buildTokenCharts(groupOf('grok', four), { today: TODAY })[0].series.map((entry) => entry.label), ['a', 'b', 'c', 'd']);
  // Five: all of them, by their 90 days (e's cost is all before the 30
  // days, yet it keeps its place, so its colour, there too).
  const five = [
    row('2026-11-15', 'a', { cost: 1 }),
    row('2026-11-15', 'b', { cost: 5 }),
    row('2026-11-15', 'c', { cost: 2 }),
    row('2026-11-15', 'd', { cost: 6 }),
    row('2026-09-01', 'e', { cost: 9 }),
  ];
  const charts = buildTokenCharts(groupOf('grok', five), { today: TODAY });
  const dailies = charts.filter((chart) => chart.kind === 'columns');
  assert.equal(dailies.length, 3);
  for (const chart of dailies) {
    assert.deepEqual(chart.series.map((entry) => entry.key), ['model:e', 'model:d', 'model:b', 'model:c', 'model:a'], chart.id);
  }
  assert.deepEqual(dailies[0].items.at(-1).values, { 'model:e': 0, 'model:d': 6, 'model:b': 5, 'model:c': 2, 'model:a': 1 });
  // The split is one line cut into the same series, so in the same colours.
  assert.equal(charts[1].kind, 'share');
  assert.deepEqual(charts[1].series, dailies[0].series);
  assert.deepEqual(charts[1].items, [{ key: 'last-7d', label: 'Last 7 days', values: { 'model:e': 0, 'model:d': 6, 'model:b': 5, 'model:c': 2, 'model:a': 1 } }]);
  // A dated and an undated id with one name are one series and one bar.
  const label = (model) => (model.startsWith('claude-opus-5-5') ? 'Opus 5.5' : model);
  const merged = buildTokenCharts(groupOf('claude', [
    row('2026-11-15', 'claude-opus-5-5', { cost: 1 }),
    row('2026-11-15', 'claude-opus-5-5-20261101', { cost: 2 }),
  ]), { today: TODAY, modelLabel: label });
  assert.deepEqual(merged[0].series, [{ key: 'model:Opus 5.5', label: 'Opus 5.5' }]);
  assert.deepEqual(merged[0].items.at(-1).values, { 'model:Opus 5.5': 3 });
  assert.deepEqual(merged[1].items, [{ key: 'last-7d', label: 'Last 7 days', values: { 'model:Opus 5.5': 3 } }]);
});

test('the split adds up to the daily chart over the same window, money and tokens', () => {
  const rows = [
    row('2026-11-14', 'a', { input: 10, output: 5, cacheRead: 100, cost: 0.25 }),
    row('2026-11-14', 'b', { input: 3, output: 1, cacheWrite: 7, cost: 0.003 }),
    row('2026-10-30', 'a', { input: 20, output: 2, cacheRead: 50, cost: 1.5 }),
    row('2026-09-10', 'c', { input: 1, output: 1, cost: null }),
  ];
  for (const provider of ['claude-api', 'cursor']) {
    const charts = buildTokenCharts(groupOf(provider, rows), { today: TODAY });
    for (const days of [7, 30, 90]) {
      const [daily, split] = charts.filter((chart) => chart.windowDays === days);
      assert.equal(round(chartTotal(split)), round(chartTotal(daily)), `${provider} ${days}`);
    }
  }
  const cursor = byId(buildTokenCharts(groupOf('cursor', rows), { today: TODAY }));
  assert.equal(chartTotal(cursor['cursor-token-shares-7d']), 126);
});

test('cost: NULL counts 0 and the unpriced tokens are named; a cost tab without any cost charts tokens', () => {
  // Claude: a turn without a known cost basis books its tokens as unknown.
  const claude = byId(buildTokenCharts(groupOf('claude', [
    row('2026-11-15', 'opus', { input: 1000, output: 200, cost: 0.5, unknown: 12_300 }),
  ]), { today: TODAY }));
  assert.match(claude['claude-daily-spend-7d'].note, /12\.3k tokens without a price are not in the chart\.$/);
  // Grok: a day with tokens and no cost counts 0, and its tokens are named.
  const grok = byId(buildTokenCharts(groupOf('grok', [
    row('2026-11-14', 'grok-5', { input: 900, output: 100, cost: 0.2 }),
    row('2026-11-15', 'grok-5', { input: 4000, output: 600, cost: null }),
    row('2026-11-15', 'grok-mini', { input: 50, output: 5, cost: null }),
  ]), { today: TODAY }));
  const daily = grok['grok-daily-spend-7d'];
  assert.deepEqual(daily.items.at(-1).values, { 'model:grok-5': 0 });
  assert.equal(daily.note, "The cost Grok's agent reports per turn. Counting since Nov 14. 4.7k tokens without a price are not in the chart.");
  // The split gives the model without a cost no part and counts it.
  const split = grok['grok-spend-shares-7d'];
  assert.deepEqual(split.items.map((item) => item.values), [{ 'model:grok-5': 0.2 }]);
  assert.equal(split.note, '1 model without a cost is not in the chart.');
  // No cost in the 90 days at all: tokens, with a note saying why.
  const fallback = byId(buildTokenCharts(groupOf('grok', [row('2026-11-15', 'grok-5', { input: 10, output: 2 })]), { today: TODAY }));
  assert.equal(fallback['grok-daily-tokens-7d'].unit, 'tokens');
  assert.match(fallback['grok-daily-tokens-7d'].note, /^Grok reported no cost for these turns; tokens are what they ran\./);
  assert.ok(fallback['grok-token-shares-7d']);
});

test('the tokens split: one line by model, all four kinds of tokens; copied days say their input holds cache writes', () => {
  const charts = byId(buildTokenCharts(groupOf('cursor', [
    row('2026-11-15', 'composer-2', { input: 10, output: 2, cacheRead: 30 }),
  ]), { today: TODAY }));
  const split = charts['cursor-token-shares-7d'];
  assert.deepEqual(split.series, [{ key: 'model:composer-2', label: 'composer-2' }]);
  assert.deepEqual(split.items, [{ key: 'last-7d', label: 'Last 7 days', values: { 'model:composer-2': 42 } }]);
  assert.equal(split.note, null);
  // Claude API copied days without any cost fall back to tokens, and the
  // split names the copied days; a window without them does not.
  const copied = byId(buildTokenCharts(groupOf('claude-api', [
    row('2026-10-20', 'sonnet', { input: 500, output: 10, backfill: true }),
    row('2026-11-15', 'sonnet', { input: 5, output: 1, cacheWrite: 4 }),
  ]), { today: TODAY }));
  assert.equal(copied['claude-api-token-shares-30d'].note, 'On the days copied from before the upgrade, input includes cache writes.');
  assert.equal(copied['claude-api-token-shares-7d'].note, null);
});

test('an own key: its own ids and label, none of the plan\'s figures', () => {
  const plan = groupOf('github', [row('2026-11-15', 'gpt-5.5', { input: 100, output: 10 })]);
  const key = groupOf('github', [row('2026-11-15', 'gpt-5.5', { input: 7, output: 1 })], { billing: 'byok-openai' });
  const charts = byId(buildTokenCharts(key, { today: TODAY }));
  assert.deepEqual(Object.keys(charts), [
    'github-daily-tokens-byok-openai-7d', 'github-token-shares-byok-openai-7d',
    'github-daily-tokens-byok-openai-30d', 'github-token-shares-byok-openai-30d',
    'github-daily-tokens-byok-openai-90d', 'github-token-shares-byok-openai-90d',
  ]);
  const daily = charts['github-daily-tokens-byok-openai-30d'];
  assert.equal(daily.label, 'Daily tokens, last 30 days — own OpenAI key');
  assert.equal(charts['github-token-shares-byok-openai-30d'].label, 'Where the tokens go, last 30 days — own OpenAI key');
  assert.match(daily.note, /^The own OpenAI key reports no cost per turn/);
  assert.equal(chartTotal(daily), 8);
  assert.equal(chartTotal(byId(buildTokenCharts(plan, { today: TODAY }))['github-daily-tokens-30d']), 110);
  // OpenAI images book under billing "image": not an own key, so no "own" label.
  const images = buildTokenCharts(groupOf('openai', [row('2026-11-15', 'gpt-image-2', { cost: 0.04 })], { billing: 'image' }), { today: TODAY });
  assert.deepEqual([images[0].id, images[0].label], ['openai-daily-spend-image-7d', 'Daily spend, last 7 days']);
});

test('"Counting since" only when the first day is inside that window', () => {
  const charts = byId(buildTokenCharts(groupOf('grok', [row('2026-11-12', 'm', { cost: 1 })], { since: '2026-10-29' }), { today: TODAY }));
  assert.doesNotMatch(charts['grok-daily-spend-7d'].note, /Counting since/);
  assert.match(charts['grok-daily-spend-30d'].note, /Counting since Oct 29\./);
  assert.match(charts['grok-daily-spend-90d'].note, /Counting since Oct 29\./);
  // The first day on the window's first day: the window is full.
  const full = byId(buildTokenCharts(groupOf('grok', [row('2026-11-12', 'm', { cost: 1 })], { since: '2026-11-09' }), { today: TODAY }));
  assert.doesNotMatch(full['grok-daily-spend-7d'].note, /Counting since/);
});
