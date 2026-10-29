import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createTokenUsageService } from './token-usage-service.mjs';
import {
  appendTokenSections,
  buildTokenSections,
  formatTokenCount,
  formatTokenSplit,
  tokenSectionNote,
} from './plan-usage-tokens.mjs';
import { normalizeTurnTokenUsageReport } from '../../shared/turn-token-usage.mjs';

// Counts are made up.

function setup({ at = '2026-11-02T10:00:00.000Z' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const clock = { ms: Date.parse(at) };
  const service = createTokenUsageService({ db, now: () => clock.ms, timeZone: 'UTC', logger: { warn() {} } });
  let turn = 0;
  const book = (provider, models, { billing = '' } = {}) => {
    turn += 1;
    const { report } = normalizeTurnTokenUsageReport({ conversationId: 'conv-1', turnId: `t-${turn}`, models });
    service.recordTurn({ conversationId: 'conv-1', provider, billing, report });
  };
  const backfill = (provider, day, model, input) => db.prepare(`
    INSERT INTO token_usage_days (day, provider, billing, model, source, input_tokens, output_tokens, cache_read_tokens, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, '', ?, 'backfill', ?, 10, 100, 1, ?, ?, 'x')
  `).run(day, provider, model, input, `${day}T00:00:00.000Z`, `${day}T00:00:00.000Z`);
  return { db, clock, service, book, backfill };
}

const groupOf = (service, provider, billing = '') => service.readPeriods({ provider }).groups.find((group) => group.billing === billing);

test('token counts: "—" for unknown, then k, M and B; 0 stays 0', () => {
  assert.equal(formatTokenCount(null), '—');
  assert.equal(formatTokenCount(undefined), '—');
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1k');
  assert.equal(formatTokenCount(340_000), '340k');
  assert.equal(formatTokenCount(1_234_567), '1.2M');
  assert.equal(formatTokenCount(999_949), '999.9k');
  assert.equal(formatTokenCount(999_950), '1M');
  assert.equal(formatTokenCount(45_300_000), '45.3M');
  assert.equal(formatTokenCount(2_500_000_000), '2.5B');
  assert.equal(formatTokenCount(999_900_000_000), '999.9B');
});

test('the split value, worst case included, stays within the agent card\'s 120 characters', () => {
  assert.equal(formatTokenSplit({ inputTokens: 1_200_000, outputTokens: 340_000, cacheWriteTokens: null, cacheReadTokens: 45_300_000 }), 'in 1.2M · out 340k · cache w — · cache r 45.3M');
  const worst = formatTokenSplit({ inputTokens: 999_900_000_000, outputTokens: 999_900_000_000, cacheWriteTokens: 999_900_000_000, cacheReadTokens: 999_900_000_000 });
  assert.equal(worst, 'in 999.9B · out 999.9B · cache w 999.9B · cache r 999.9B');
  assert.ok(worst.length < 120);
});

test('two sections per group: the periods, then the models this month', () => {
  const { service, book, clock } = setup({ at: '2026-10-20T10:00:00.000Z' });
  book('cursor', [{ model: 'composer-2', inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 300 }]);
  clock.ms = Date.parse('2026-11-02T10:00:00.000Z');
  book('cursor', [{ model: 'composer-2', inputTokens: 1_000, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 3_000 }, { model: 'gpt-5.5', inputTokens: 5, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0 }]);
  const [periods, byModel] = buildTokenSections(groupOf(service, 'cursor'));
  assert.equal(periods.id, 'cursor-token-usage');
  assert.equal(periods.label, 'Tokens');
  assert.deepEqual(periods.rows.map((row) => [row.label, row.value, row.hint]), [
    ['Today', 'in 1k · out 55 · cache w 0 · cache r 3k', '75% of input from the cache'],
    ['This month', 'in 1k · out 55 · cache w 0 · cache r 3k', '75% of input from the cache'],
    ['All time', 'in 1.1k · out 65 · cache w 0 · cache r 3.3k', '75% of input from the cache'],
  ]);
  assert.equal(periods.note, 'Counting since Oct 20, 2026.');
  assert.equal(byModel.id, 'cursor-token-usage-by-model');
  assert.equal(byModel.label, 'Tokens by model, this month');
  assert.deepEqual(byModel.rows.map((row) => [row.label, row.value, row.hint]), [
    ['composer-2', 'in 1k · out 50 · cache w 0 · cache r 3k', 'today 4k · all time 4.5k'],
    ['gpt-5.5', 'in 5 · out 5 · cache w 0 · cache r 0', 'today 10 · all time 10'],
  ]);
});

test('an empty period says so; a model idle this month has no row', () => {
  const { service, book, clock } = setup({ at: '2026-10-20T10:00:00.000Z' });
  book('grok', [{ model: 'grok-5', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
  clock.ms = Date.parse('2026-11-02T10:00:00.000Z');
  const sections = buildTokenSections(groupOf(service, 'grok'));
  assert.deepEqual(sections[0].rows.map((row) => row.value).slice(0, 2), ['no turns', 'no turns']);
  // Nothing this month: the by-model section has no rows and is left out.
  assert.equal(sections.length, 1);
});

test('a field nobody reported is "—", and the note names who does not report it', () => {
  const { service, book } = setup();
  book('github', [{ model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }], { billing: 'byok-openai' });
  const group = groupOf(service, 'github', 'byok-openai');
  const [periods, byModel] = buildTokenSections(group);
  assert.equal(periods.id, 'github-token-usage-byok-openai');
  assert.equal(periods.label, 'Tokens — own OpenAI key');
  assert.equal(byModel.label, 'Tokens by model, this month — own OpenAI key');
  assert.equal(periods.rows[0].value, 'in 100 · out 10 · cache w — · cache r 50');
  assert.equal(periods.note, 'OpenAI does not report cache writes. Counting since Nov 2, 2026.');
});

test('a field some turns left out is summed where reported, and the note says so', () => {
  const { service, book } = setup();
  book('grok', [{ model: 'grok-5', inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 }]);
  book('grok', [{ model: 'grok-5', inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 }]);
  // One day row, so the day sum hides the gap; a second model shows it.
  book('grok', [{ model: 'grok-5-mini', inputTokens: 3, outputTokens: 1, cacheReadTokens: 0 }]);
  const note = tokenSectionNote(groupOf(service, 'grok'));
  assert.equal(note, 'Cache writes not reported for some turns. Counting since Nov 2, 2026.');
});

test('Claude API and DeepSeek: the backfill note dates from the first counted turn; since is the first copied day', () => {
  const { service, book, backfill } = setup();
  backfill('claude-api', '2026-09-14', 'claude-sonnet-5-5', 500);
  book('claude-api', [{ model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 1, cacheWriteTokens: 4, cacheReadTokens: 20 }]);
  const group = groupOf(service, 'claude-api');
  assert.equal(tokenSectionNote(group), 'Before Nov 2, 2026, input includes cache writes. Counting since Sep 14, 2026.');
  // Copied days alone: no turn yet.
  const only = setup();
  only.backfill('deepseek', '2026-10-30', 'deepseek-flash', 40);
  const [periods] = buildTokenSections(groupOf(only.service, 'deepseek'));
  assert.equal(periods.rows[2].value, 'in 40 · out 10 · cache w — · cache r 100');
  assert.equal(periods.note, 'On the days copied from before the upgrade, input includes cache writes. Counting since Oct 30, 2026.');
});

test('the backfill note never shows on another tab', () => {
  const { service, book } = setup();
  book('claude', [{ model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 1, cacheReadTokens: 1 }]);
  // A copied-day flag on another provider (not possible from 0036) still adds no note.
  const group = { ...groupOf(service, 'claude'), backfilled: { today: true, month: true, allTime: true }, firstTurnsDay: '2026-11-02' };
  assert.doesNotMatch(tokenSectionNote(group), /cache writes/);
});

test('appendTokenSections adds the groups to their cards, the plan before the own keys, and leaves the rest alone', () => {
  const { service, book } = setup();
  book('github', [{ model: 'gpt-5.5', inputTokens: 9, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }], { billing: 'byok-openai' });
  book('github', [{ model: 'gpt-5.5', inputTokens: 4, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }]);
  const cards = [
    { provider: 'github', details: [{ id: 'existing', label: 'Existing', rows: [] }] },
    { provider: 'cursor', details: [] },
  ];
  appendTokenSections(cards, (options) => service.readPeriods(options));
  assert.deepEqual(cards[0].details.map((section) => section.id), [
    'existing', 'github-token-usage', 'github-token-usage-by-model', 'github-token-usage-byok-openai', 'github-token-usage-by-model-byok-openai',
  ]);
  assert.deepEqual(cards[1].details, []);
  // A failing read changes nothing.
  const kept = [{ provider: 'grok', details: [] }];
  appendTokenSections(kept, () => { throw new Error('locked'); });
  assert.deepEqual(kept[0].details, []);
});

test('a tab may name its models: the label where it has one, the raw id where it has none', () => {
  const { service, book } = setup();
  book('claude-api', [
    { model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
    { model: 'claude-new-model', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
  ]);
  const cards = [{ provider: 'claude-api', details: [] }, { provider: 'cursor', details: [] }];
  const asked = [];
  appendTokenSections(cards, (options) => service.readPeriods(options), {
    modelLabelFor: (provider) => {
      asked.push(provider);
      return provider === 'claude-api' ? (model) => (model === 'claude-sonnet-5-5' ? 'Claude Sonnet 5.5 (Console)' : null) : null;
    },
  });
  const byModel = cards[0].details.find((section) => section.id === 'claude-api-token-usage-by-model');
  // Sorted by the name shown.
  assert.deepEqual(byModel.rows.map((row) => row.label), ['Claude Sonnet 5.5 (Console)', 'claude-new-model']);
  assert.deepEqual(asked, ['claude-api']);
});

test('both sections of every group open expanded', () => {
  const { service, book } = setup();
  book('github', [{ model: 'gpt-5.5', inputTokens: 4, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 }]);
  book('github', [{ model: 'gpt-5.5', inputTokens: 9, outputTokens: 1, cacheReadTokens: 0 }], { billing: 'byok-openai' });
  const sections = service.readPeriods({ provider: 'github' }).groups.flatMap((group) => buildTokenSections(group));
  assert.equal(sections.length, 4);
  for (const section of sections) assert.equal(section.open, true, section.id);
});

test('ids with one name are one row: tokens added up, the ids in its title, sorted by name', () => {
  const { service, book, clock } = setup({ at: '2026-10-20T10:00:00.000Z' });
  // Last month: only the dated id, and only all time sees it.
  book('claude', [{ model: 'claude-opus-5-5-20260601', inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 }]);
  clock.ms = Date.parse('2026-11-02T10:00:00.000Z');
  book('claude', [
    { model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 300 },
    { model: 'claude-opus-5-5-20260601', inputTokens: 50, outputTokens: 5, cacheWriteTokens: 5, cacheReadTokens: 100 },
    { model: 'claude-haiku-4-5', inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 },
  ]);
  const label = (model) => (model.startsWith('claude-opus-5-5') ? 'Claude Opus 5.5' : model === 'claude-haiku-4-5' ? 'Claude Haiku 4.5' : null);
  const [, byModel] = buildTokenSections(groupOf(service, 'claude'), { modelLabel: label });
  assert.deepEqual(byModel.rows, [
    { label: 'Claude Haiku 4.5', value: 'in 1 · out 1 · cache w 0 · cache r 0', hint: 'today 2 · all time 2' },
    {
      label: 'Claude Opus 5.5',
      value: 'in 150 · out 15 · cache w 25 · cache r 400',
      hint: 'today 590 · all time 1.7k',
      title: 'Model ids: claude-opus-5-5, claude-opus-5-5-20260601',
    },
  ]);
});

test('a merged row keeps "—" where neither id reported a field, and the figure where one did', () => {
  const { service, book } = setup();
  book('github', [
    { model: 'gpt-5.5', inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 },
    { model: 'gpt-5.5-2026-08-01', inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 },
    { model: 'gpt-5.5-mini', inputTokens: 3, outputTokens: 1, cacheWriteTokens: 4, cacheReadTokens: 0 },
  ]);
  const label = (model) => (model.startsWith('gpt-5.5') ? 'GPT-5.5' : null);
  const [, byModel] = buildTokenSections(groupOf(service, 'github'), { modelLabel: label });
  assert.equal(byModel.rows.length, 1);
  assert.equal(byModel.rows[0].value, 'in 33 · out 4 · cache w 4 · cache r 10');
  const noWrites = buildTokenSections(groupOf(service, 'github'), { modelLabel: (model) => (model === 'gpt-5.5-mini' ? 'Mini' : 'GPT-5.5') })[1];
  assert.deepEqual(noWrites.rows.map((row) => [row.label, row.value]), [
    ['GPT-5.5', 'in 30 · out 3 · cache w — · cache r 10'],
    ['Mini', 'in 3 · out 1 · cache w 4 · cache r 0'],
  ]);
});
