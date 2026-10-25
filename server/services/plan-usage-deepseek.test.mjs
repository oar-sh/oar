import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_HOLIDAY_NOTE,
  DEEPSEEK_SEARCH_NOTE,
  shownBalances,
  DEEPSEEK_TOP_UP_URL,
  DEEPSEEK_USAGE_URL,
  buildDeepSeekPlanCard,
  deepseekStartingBalanceNote,
  deepseekStartingBalanceCurrency,
  deepseekStartingBalanceState,
  formatDeepSeekMoney,
  normalizeDeepSeekUsageReport,
  overlayDeepSeekActuals,
} from './plan-usage-deepseek.mjs';
import { createDeepSeekBalanceService } from './deepseek-balance-service.mjs';
import { renderPlanUsageHtml, utilizationColor } from '../public/app/plan-usage-view.mjs';

const TEST_KEY = 'sk-test-0000000000000000';
const FETCHED_AT = '2026-10-21T12:00:00.000Z';

const TOTALS = {
  models: [
    { model: 'deepseek-flash', hitTokens: 2_000_000, missTokens: 150_000, outputTokens: 40_000, turnCount: 12, costUsd: 0.0525, costCny: 0.35, firstSeenAt: '2026-10-20T08:00:00.000Z', lastSeenAt: '2026-10-21T11:00:00.000Z' },
    { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 1000, outputTokens: 500, turnCount: 1, costUsd: 0.0006, costCny: 0.0042, firstSeenAt: '2026-10-21T09:00:00.000Z', lastSeenAt: '2026-10-21T09:00:00.000Z' },
  ],
};

const noteText = (card, id) => card.notes.find((note) => note.id === id)?.text || null;
const rows = (card, id) => card.details.find((section) => section.id === id)?.rows || [];

test('a CNY balance: the balance with its parts, and the spend in yuan', () => {
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT, cached: false },
    totals: TOTALS,
  });
  assert.equal(card.provider, 'deepseek');
  assert.equal(card.label, 'DeepSeek');
  assert.equal(card.status, 'ok');
  assert.equal(card.source, 'live');
  assert.equal(card.message, null);
  assert.equal(card.capturedAt, FETCHED_AT);
  assert.deepEqual(card.meters, []);
  assert.equal(noteText(card, 'deepseek-balance-cny'), 'Balance (CNY): ¥110.00 (topped up ¥100.00, granted ¥10.00)');
  assert.equal(noteText(card, 'deepseek-spend'), 'Estimated spend on this relay: ¥0.35 since 2026-10-20');
  assert.deepEqual(rows(card, 'deepseek-spend-by-model').map((row) => [row.label, row.value, row.hint]), [
    ['DeepSeek Flash', '¥0.35', '12 turns since 2026-10-20'],
    ['DeepSeek V4 Pro', '¥0.0042', '1 turn since 2026-10-21'],
  ]);
  assert.deepEqual(rows(card, 'deepseek-tokens-by-model').map((row) => [row.value, row.hint]), [
    ['cache hit 2.0M · cache miss 150.0k · output 40.0k', '93% of input from the cache'],
    ['cache hit 0 · cache miss 1.0k · output 500', '0% of input from the cache'],
  ]);
  const estimate = card.notes.find((note) => note.id === 'deepseek-estimate');
  assert.match(estimate.text, /DeepSeek's published prices \(2026-10-19\)/);
  assert.match(estimate.text, /peak or off-peak by the time of each turn/);
  // The weekdays are said by UTC, since the browser shifts only the hours.
  assert.match(estimate.text, /Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays \(Monday to Friday by UTC\)\./);
  assert.equal(estimate.text.includes(DEEPSEEK_HOLIDAY_NOTE), true);
  assert.equal(
    DEEPSEEK_HOLIDAY_NOTE,
    'On Chinese public holidays DeepSeek charges off-peak prices all day; the estimate doesn\'t know those dates, so turns at peak hours on a holiday are counted at double the real price.',
  );
  assert.equal(estimate.text.endsWith(DEEPSEEK_SEARCH_NOTE), true);
  assert.equal(
    DEEPSEEK_SEARCH_NOTE,
    'Web searches run on DeepSeek\'s servers and are counted at $0.75 / ¥5 per 1,000 from 2026-10-31 16:00 UTC; WebFetch reads the page on the relay host and costs only tokens. DeepSeek does not bill count_tokens requests (Claude Code sends some at each session start).',
  );
  // The peak hours travel as data too, for the browser's own time zone.
  assert.deepEqual(estimate.hours, { utcRanges: [[1, 4], [6, 10]], utcText: '01:00–04:00 and 06:00–10:00 UTC' });
  assert.equal(estimate.link.url, 'https://api-docs.deepseek.com/quick_start/pricing');
  assert.deepEqual(card.links.map((link) => link.url), [DEEPSEEK_USAGE_URL, DEEPSEEK_TOP_UP_URL]);
});

test('a USD balance shows the spend in dollars; with both, the one with money on it leads', () => {
  const usd = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'USD', total: 4.5, granted: 0, toppedUp: 4.5 }], fetchedAt: FETCHED_AT, cached: true },
    totals: TOTALS,
  });
  assert.equal(usd.source, 'cache');
  assert.equal(noteText(usd, 'deepseek-balance-usd'), 'Balance (USD): $4.50 (topped up $4.50, granted $0.00)');
  assert.equal(noteText(usd, 'deepseek-spend'), 'Estimated spend on this relay: $0.05 since 2026-10-20');

  const both = buildDeepSeekPlanCard({
    balance: {
      ok: true,
      isAvailable: true,
      balances: [{ currency: 'CNY', total: 0, granted: 0, toppedUp: 0 }, { currency: 'USD', total: 2, granted: 0, toppedUp: 2 }],
      fetchedAt: FETCHED_AT,
    },
    totals: TOTALS,
  });
  // The empty currency gets no line next to the one with money on it.
  assert.equal(noteText(both, 'deepseek-balance-cny'), null);
  assert.equal(noteText(both, 'deepseek-balance-usd'), 'Balance (USD): $2.00 (topped up $2.00, granted $0.00)');
  assert.match(noteText(both, 'deepseek-spend'), /\$0\.05/);
  // Both empty: both are shown, so an empty account reads as one.
  assert.deepEqual(
    shownBalances([{ currency: 'CNY', total: 0 }, { currency: 'USD', total: 0 }]).map((entry) => entry.currency),
    ['CNY', 'USD'],
  );
  assert.deepEqual(shownBalances([{ currency: 'CNY', total: 0 }, { currency: 'USD', total: 2 }]).map((entry) => entry.currency), ['USD']);
});

test('is_available false is a warning with the top-up link', () => {
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: false, balances: [{ currency: 'CNY', total: 0, granted: 0, toppedUp: 0 }], fetchedAt: FETCHED_AT },
    totals: null,
  });
  assert.match(card.message, /not enough for API calls/);
  assert.equal(card.notes.find((note) => note.id === 'deepseek-top-up').link.url, DEEPSEEK_TOP_UP_URL);
  assert.equal(noteText(card, 'deepseek-balance-cny'), 'Balance (CNY): ¥0.00 (topped up ¥0.00, granted ¥0.00)');
  // No spend yet: no spend lines.
  assert.equal(noteText(card, 'deepseek-spend'), null);
  assert.deepEqual(card.details, []);
});

test('a failed balance read keeps the spend, says why, and never carries the key', async () => {
  const service = createDeepSeekBalanceService({
    getSettings: () => ({ enabled: true, apiKey: TEST_KEY, baseUrl: 'https://api.deepseek.com' }),
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED (Bearer ${TEST_KEY})`); },
  });
  const balance = await service.getBalance();
  assert.equal(balance.ok, false);
  const card = buildDeepSeekPlanCard({ balance, totals: TOTALS });
  assert.equal(card.status, 'partial');
  assert.equal(card.source, 'worker');
  assert.match(card.message, /^The balance could not be read: DeepSeek balance check failed: connect ECONNREFUSED/);
  assert.equal(JSON.stringify(card).includes(TEST_KEY), false);
  assert.match(noteText(card, 'deepseek-spend'), /\$0\.05/, 'USD without a balance to go by');

  // Nothing at all to show: an unavailable card with the reason.
  const empty = buildDeepSeekPlanCard({ balance, totals: { models: [] } });
  assert.equal(empty.status, 'partial');
  assert.match(empty.message, /could not be read/);
});

test('a failed read after a good one shows the earlier balance with its time', () => {
  const card = buildDeepSeekPlanCard({
    balance: {
      ok: false,
      code: 'transient',
      error: 'DeepSeek balance check failed (503)',
      fetchedAt: '2026-10-21T12:05:00.000Z',
      previous: { ok: true, isAvailable: true, balances: [{ currency: 'USD', total: 3, granted: 1, toppedUp: 2 }], fetchedAt: FETCHED_AT },
    },
    totals: TOTALS,
  });
  assert.equal(card.status, 'partial');
  assert.equal(card.stale, true);
  assert.equal(card.source, 'cache');
  assert.equal(card.capturedAt, FETCHED_AT);
  assert.equal(noteText(card, 'deepseek-balance-usd'), 'Balance (USD): $3.00 (topped up $2.00, granted $1.00), as read 2026-10-21 12:00 UTC');
});

test('no key configured is said as that', () => {
  const card = buildDeepSeekPlanCard({
    balance: { ok: false, code: 'not_configured', error: 'DeepSeek API key is not configured', fetchedAt: FETCHED_AT },
    totals: null,
  });
  assert.equal(card.status, 'not-configured');
  assert.match(card.message, /Settings → Providers → DeepSeek/);
});

test('no balance read and no turns yet; DeepSeek off has no card', () => {
  const card = buildDeepSeekPlanCard({ balance: null, totals: null });
  assert.equal(card.status, 'unavailable');
  assert.match(card.message, /No DeepSeek balance or usage yet/);
  assert.equal(buildDeepSeekPlanCard({ configured: false }), null);
});

test('a model without a known price is listed, not priced, and named in the total', () => {
  const card = buildDeepSeekPlanCard({
    balance: null,
    totals: { models: [...TOTALS.models, { model: 'deepseek-v5', hitTokens: 0, missTokens: 10, outputTokens: 10, turnCount: 2, costUsd: null, costCny: null, firstSeenAt: FETCHED_AT, lastSeenAt: FETCHED_AT }] },
  });
  assert.deepEqual(rows(card, 'deepseek-spend-by-model').at(-1), { label: 'deepseek-v5', value: 'no price known', hint: '2 turns since 2026-10-21' });
  assert.match(noteText(card, 'deepseek-spend'), /\(1 model without a known price not included\)$/);
});

test('web searches get one Search row of their own, with a fetch count only if one was booked, and their cost is in the total', () => {
  const withRequests = (model, overrides) => ({ ...TOTALS.models.find((entry) => entry.model === model), ...overrides });
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT, cached: false },
    totals: {
      models: [
        withRequests('deepseek-flash', { searchRequests: 40, fetchRequests: 1, toolsCostUsd: 0.015, toolsCostCny: 0.1 }),
        withRequests('deepseek-v4-pro', { searchRequests: 0, fetchRequests: 4, toolsCostUsd: 0.003, toolsCostCny: 0.02 }),
      ],
    },
  });
  assert.deepEqual(rows(card, 'deepseek-spend-by-model').map((row) => [row.label, row.value, row.hint]), [
    ['DeepSeek Flash', '¥0.35', '12 turns since 2026-10-20'],
    ['DeepSeek V4 Pro', '¥0.0042', '1 turn since 2026-10-21'],
    ['Search', '¥0.12', '40 searches · 5 fetches'],
  ]);
  assert.equal(noteText(card, 'deepseek-spend'), 'Estimated spend on this relay: ¥0.47 since 2026-10-20');
  // Counted before DeepSeek charged for them: the row says so by its price.
  const free = buildDeepSeekPlanCard({
    balance: null,
    totals: { models: [withRequests('deepseek-flash', { searchRequests: 1, fetchRequests: 1 })] },
  });
  assert.deepEqual(rows(free, 'deepseek-spend-by-model').at(-1), { label: 'Search', value: '$0.00', hint: '1 search · 1 fetch' });
  // Searches alone (DeepSeek has no server-side fetch): the hint names them only.
  const searchesOnly = buildDeepSeekPlanCard({ balance: null, totals: { models: [withRequests('deepseek-flash', { searchRequests: 3, fetchRequests: 0 })] } });
  assert.deepEqual(rows(searchesOnly, 'deepseek-spend-by-model').at(-1), { label: 'Search', value: '$0.00', hint: '3 searches' });
  // No searches or fetches at all: no row.
  const none = buildDeepSeekPlanCard({ balance: null, totals: TOTALS });
  assert.equal(rows(none, 'deepseek-spend-by-model').some((row) => row.label === 'Search'), false);
  // Only an unpriced model, with searches: the total is the searches' cost.
  const unpriced = buildDeepSeekPlanCard({
    balance: null,
    totals: { models: [{ model: 'deepseek-v5', hitTokens: 0, missTokens: 10, outputTokens: 10, searchRequests: 1000, fetchRequests: 0, turnCount: 2, costUsd: null, costCny: null, toolsCostUsd: 0.75, toolsCostCny: 5, firstSeenAt: FETCHED_AT, lastSeenAt: FETCHED_AT }] },
  });
  assert.equal(noteText(unpriced, 'deepseek-spend'), 'Estimated spend on this relay: $0.75 since 2026-10-21 (1 model without a known price not included)');
});

test('money formats: two decimals, four for an estimate under a cent', () => {
  assert.equal(formatDeepSeekMoney(1.5, 'USD'), '$1.50');
  assert.equal(formatDeepSeekMoney(0.0042, 'CNY', { estimate: true }), '¥0.0042');
  assert.equal(formatDeepSeekMoney(0, 'CNY', { estimate: true }), '¥0.00');
  assert.equal(formatDeepSeekMoney(null, 'USD'), null);
});

test('a worker report: totals summed by model id, counts checked, the session id required, the time kept or the relay\'s', () => {
  const now = () => new Date('2026-10-21T12:00:00.000Z');
  const parsed = normalizeDeepSeekUsageReport({
    claudeNativeSessionId: 'native-1',
    at: '2026-10-21T02:00:00.000Z',
    totals: [
      { model: 'deepseek-flash[1m]', hitTokens: 100, missTokens: 20, outputTokens: 5 },
      { model: 'DeepSeek-Flash', hitTokens: 1, missTokens: -9, outputTokens: 'x' },
      { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 0, outputTokens: 0 },
    ],
  }, { now });
  assert.deepEqual(parsed, {
    ok: true,
    report: {
      nativeSessionId: 'native-1',
      runId: '',
      at: '2026-10-21T02:00:00.000Z',
      totals: [{ model: 'deepseek-flash', hitTokens: 101, missTokens: 20, outputTokens: 5 }],
      requests: [],
    },
  });
  const base = { claudeNativeSessionId: 'native-1', totals: [{ model: 'deepseek-flash', missTokens: 1 }] };
  // The worker's id of its CLI process, when it sends one.
  assert.equal(normalizeDeepSeekUsageReport({ ...base, runId: ' 7f3c2a9e-1b4d-4e6f-9a8b-0c1d2e3f4a5b ' }, { now }).report.runId, '7f3c2a9e-1b4d-4e6f-9a8b-0c1d2e3f4a5b');
  assert.equal(normalizeDeepSeekUsageReport({ ...base, runId: null }, { now }).report.runId, '');
  // The turn's web searches and fetches, summed by model id like the totals;
  // they stand on their own when the totals have nothing new.
  const requests = [
    { model: 'deepseek-flash[1m]', searchRequests: 2, fetchRequests: 1 },
    { model: 'DeepSeek-Flash', searchRequests: 1, fetchRequests: -1 },
    { model: 'deepseek-v4-pro', searchRequests: 0, fetchRequests: 0 },
  ];
  assert.deepEqual(normalizeDeepSeekUsageReport({ ...base, requests }, { now }).report.requests, [{ model: 'deepseek-flash', searchRequests: 3, fetchRequests: 1 }]);
  assert.deepEqual(normalizeDeepSeekUsageReport({ ...base, totals: [], requests }, { now }).report.totals, []);
  assert.deepEqual(normalizeDeepSeekUsageReport({ ...base, requests: null }, { now }).report.requests, []);
  assert.equal(normalizeDeepSeekUsageReport(base, { now }).report.at, '2026-10-21T12:00:00.000Z');
  // A worker clock far ahead does not book a turn in the future.
  assert.equal(normalizeDeepSeekUsageReport({ ...base, at: '2026-10-22T12:00:00.000Z' }, { now }).report.at, '2026-10-21T12:00:00.000Z');

  for (const [body, error] of [
    [{ ...base, at: 'yesterday' }, /at must be an ISO time/],
    [{ ...base, claudeNativeSessionId: '' }, /claudeNativeSessionId/],
    [{ ...base, claudeNativeSessionId: 'a b' }, /claudeNativeSessionId/],
    [{ ...base, runId: 'run <script>' }, /runId must be a short id/],
    [{ ...base, runId: { id: 1 } }, /runId must be a short id/],
    [{ claudeNativeSessionId: 'native-1' }, /totals must be a list/],
    [{ ...base, totals: [null] }, /must be an object/],
    [{ ...base, totals: [{ model: 'bad id <script>', missTokens: 1 }] }, /valid model id/],
    [{ ...base, totals: [{ model: 'deepseek-flash', missTokens: 0 }] }, /Missing usable usage metrics/],
    [{ ...base, totals: [], requests: [{ model: 'deepseek-flash', searchRequests: 0 }] }, /Missing usable usage metrics/],
    [{ ...base, requests: {} }, /requests must be a list/],
    [{ ...base, requests: [1] }, /Every requests entry must be an object/],
    [{ ...base, requests: [{ model: 'bad id <script>', searchRequests: 1 }] }, /Every requests entry needs a valid model id/],
  ]) {
    const result = normalizeDeepSeekUsageReport(body, { now });
    assert.equal(result.ok, false);
    assert.match(result.error, error);
  }
});

test('the generic renderer draws the card under a DeepSeek tab, the balance on the card itself', () => {
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: false, balances: [{ currency: 'CNY', total: 0.5, granted: 0, toppedUp: 0.5 }], fetchedAt: FETCHED_AT },
    totals: TOTALS,
  });
  const html = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek' });
  assert.match(html, /data-usage-tab="deepseek">DeepSeek<\/button>/);
  assert.match(html, /class="plan-usage-message">DeepSeek reports this balance as not enough/);
  // The balance and the spend are figures: label and value in one list
  // under the bars, the whole sentence as the row's title.
  assert.match(html, /<dl class="plan-usage-facts"><div class="plan-usage-fact" data-note-id="deepseek-balance-cny" title="Balance \(CNY\): ¥0\.50 \(topped up ¥0\.50, granted ¥0\.00\)"><dt>Balance \(CNY\)<span class="plan-usage-fact-hint">topped up ¥0\.50 · granted ¥0\.00<\/span><\/dt><dd>¥0\.50<\/dd><\/div>/);
  assert.match(html, /data-note-id="deepseek-spend" title="Estimated spend on this relay: ¥0\.35 since 2026-10-20"><dt>Estimated spend on this relay<span class="plan-usage-fact-hint">since 2026-10-20<\/span><\/dt><dd>¥0\.35<\/dd>/);
  // Every figure is on show: the tables start open.
  assert.match(html, /data-section-id="deepseek-spend-by-model" open>/);
  assert.match(html, /data-section-id="deepseek-tokens-by-model" open>/);
  assert.match(html, /href="https:\/\/platform\.deepseek\.com\/usage"/);
});

test('the renderer shows the peak hours in the reader\'s time zone and keeps the UTC wording as the title', () => {
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 50, granted: 0, toppedUp: 50 }], fetchedAt: FETCHED_AT },
    totals: TOTALS,
  });
  const berlin = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek', now: new Date('2026-10-21T12:00:00.000Z'), timeZone: 'Europe/Berlin' });
  assert.match(berlin, /Peak is 03:00–06:00 and 08:00–12:00 in your time zone on weekdays \(Monday to Friday by UTC\)\./);
  assert.match(berlin, /title="Estimated from DeepSeek(?:'|&#39;|&apos;)s published prices \(2026-10-19\);[^"]*01:00–04:00 and 06:00–10:00 UTC/);
  assert.doesNotMatch(berlin, />Estimated from[^<]*01:00–04:00 and 06:00–10:00 UTC/);
  const beijing = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek', now: new Date('2026-10-21T12:00:00.000Z'), timeZone: 'Asia/Shanghai' });
  assert.match(beijing, /Peak is 09:00–12:00 and 14:00–18:00 in your time zone on weekdays \(Monday to Friday by UTC\)\./);
  // West of UTC the Monday peak starts on Sunday evening: the wording stays true.
  const newYork = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek', now: new Date('2026-10-21T12:00:00.000Z'), timeZone: 'America/New_York' });
  assert.match(newYork, /Peak is 21:00–00:00 and 02:00–06:00 in your time zone on weekdays \(Monday to Friday by UTC\)\./);
});

const DAYS = {
  firstDay: '2026-09-30',
  days: [
    { day: '2026-09-30', model: 'deepseek-flash', costUsd: 14, costCny: 100, toolsCostUsd: 0, toolsCostCny: 0 },
    { day: '2026-10-20', model: 'deepseek-flash', costUsd: 0.8, costCny: 6, toolsCostUsd: 0, toolsCostCny: 0 },
    { day: '2026-10-21', model: 'deepseek-v4-pro', costUsd: 0.35, costCny: 2.5, toolsCostUsd: 0.07, toolsCostCny: 0.5 },
  ],
};
const NOW = '2026-10-21T12:00:00.000Z';

test('the balance bar: what is left since the balance last rose, in the currency with money, with the reference the relay keeps', () => {
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }, { currency: 'USD', total: 0, granted: 0, toppedUp: 0 }], fetchedAt: FETCHED_AT },
    balanceReferences: [
      { currency: 'CNY', referenceTotal: 150, lastTotal: 110, referenceAt: '2026-10-15T09:00:00.000Z' },
      { currency: 'USD', referenceTotal: 0, lastTotal: 0, referenceAt: '2026-10-15T09:00:00.000Z' },
    ],
    totals: TOTALS,
    now: NOW,
  });
  assert.deepEqual(card.meters.map((meter) => [meter.id, meter.label, meter.unit, meter.used, meter.allowance, meter.remaining, Math.round(meter.utilization), meter.emphasis]), [
    ['deepseek-balance-cny', 'Balance (CNY)', 'cny', 40, 150, 110, 27, 'primary'],
  ]);
  assert.equal(card.meters[0].note, 'Measured from ¥150.00, the balance after its last rise (2026-10-15).');
  // The balance line with its parts stays under the bar.
  assert.equal(noteText(card, 'deepseek-balance-cny'), 'Balance (CNY): ¥110.00 (topped up ¥100.00, granted ¥10.00)');

  // The first read: the balance is the reference, the bar is full.
  const fresh = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'USD', total: 20, granted: 0, toppedUp: 20 }], fetchedAt: FETCHED_AT },
    balanceReferences: [{ currency: 'USD', referenceTotal: 20, lastTotal: 20, referenceAt: FETCHED_AT }],
    totals: TOTALS,
    now: NOW,
  });
  assert.deepEqual([fresh.meters[0].id, fresh.meters[0].used, fresh.meters[0].remaining, fresh.meters[0].utilization], ['deepseek-balance-usd', 0, 20, 0]);
  assert.equal(fresh.meters[0].note, 'Measured from $20.00, the highest balance seen (2026-10-21).');

  // A failed read after a good one keeps the bar with the earlier balance; no reference, no bar.
  const failed = buildDeepSeekPlanCard({
    balance: { ok: false, code: 'error', error: 'DeepSeek balance check failed (401)', fetchedAt: '2026-10-21T13:00:00.000Z', previous: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110 }], fetchedAt: FETCHED_AT } },
    balanceReferences: [{ currency: 'CNY', referenceTotal: 150, lastTotal: 110, referenceAt: '2026-10-15T09:00:00.000Z' }],
    totals: TOTALS,
    now: NOW,
  });
  assert.deepEqual([failed.meters[0].id, failed.meters[0].used], ['deepseek-balance-cny', 40]);
  assert.deepEqual(buildDeepSeekPlanCard({ balance: failed.balance, totals: TOTALS, now: NOW }).meters, []);
});

test('a starting balance from the DeepSeek tab is what the bar measures from, until the balance rises after it was set', () => {
  const balance = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 45.91, granted: 0, toppedUp: 45.91 }], fetchedAt: FETCHED_AT };
  const seen = { currency: 'CNY', referenceTotal: 45.91, lastTotal: 45.91, referenceAt: FETCHED_AT, roseAt: null };
  const starting = { amount: 50, setAt: '2026-10-21T13:00:00.000Z' };
  // The first top-up was ¥50; the relay first saw ¥45.91.
  const card = buildDeepSeekPlanCard({ balance, balanceReferences: [seen], startingBalance: starting, totals: TOTALS, now: NOW });
  assert.deepEqual(card.meters.map((meter) => [meter.id, meter.used, meter.allowance, meter.remaining]), [['deepseek-balance-cny', 4.09, 50, 45.91]]);
  assert.equal(card.meters[0].note, 'Measured from ¥50.00, the starting balance set on the DeepSeek tab.');
  assert.deepEqual(deepseekStartingBalanceState(starting, seen), { applies: true, replacedAt: null });
  assert.equal(deepseekStartingBalanceNote(starting, [seen]), null);
  // A rise before it was set does not replace it.
  const earlier = { ...seen, roseAt: '2026-10-20T09:00:00.000Z' };
  assert.equal(deepseekStartingBalanceState(starting, earlier).applies, true);
  // A top-up after it was set does: the balance after it is the reference again.
  const toppedUp = { currency: 'CNY', referenceTotal: 140, lastTotal: 140, referenceAt: '2026-10-23T09:00:00.000Z', roseAt: '2026-10-23T09:00:00.000Z', roseFromAt: '2026-10-22T09:00:00.000Z' };
  const after = buildDeepSeekPlanCard({
    balance: { ...balance, balances: [{ currency: 'CNY', total: 130, granted: 0, toppedUp: 130 }] },
    balanceReferences: [toppedUp],
    startingBalance: starting,
    totals: TOTALS,
    now: NOW,
  });
  assert.deepEqual(after.meters.map((meter) => [meter.used, meter.allowance, meter.remaining]), [[10, 140, 130]]);
  assert.equal(after.meters[0].note, 'Measured from ¥140.00, the balance after its last rise (2026-10-23).');
  assert.deepEqual(deepseekStartingBalanceState(starting, toppedUp), { applies: false, replacedAt: '2026-10-23T09:00:00.000Z' });
  assert.equal(
    deepseekStartingBalanceNote(starting, [toppedUp]),
    'No longer used: the balance rose on 2026-10-23 (a top-up), so the bar measures from the balance after it. Enter an amount again to measure from it.',
  );
  // None set, or none on the tab: as before.
  assert.equal(deepseekStartingBalanceNote(null, [toppedUp]), null);
  assert.equal(buildDeepSeekPlanCard({ balance, balanceReferences: [seen], totals: TOTALS, now: NOW }).meters[0].allowance, 45.91);
  // A balance above the starting amount (no rise seen) leaves the bar full.
  const above = buildDeepSeekPlanCard({ balance: { ...balance, balances: [{ currency: 'CNY', total: 52 }] }, balanceReferences: [seen], startingBalance: starting, totals: TOTALS, now: NOW });
  assert.deepEqual([above.meters[0].used, above.meters[0].allowance, above.meters[0].remaining], [0, 50, 52]);
});

test('a rise first seen after the starting balance was set replaces it only when the balance before it was read after it too; with that read unknown, when the balance is above it', () => {
  // The owner tops up to ¥60 and enters ¥60 before the relay reads the balance
  // again: the read that sees the rise comes after the setting, the read
  // before it came before. The top-up is the starting balance, not after it.
  const starting = { amount: 60, setAt: '2026-10-25T10:00:00.000Z' };
  const fresh = { currency: 'CNY', referenceTotal: 60, lastTotal: 60, referenceAt: '2026-10-25T10:05:00.000Z', roseAt: '2026-10-25T10:05:00.000Z', roseFromAt: '2026-10-25T09:00:00.000Z' };
  assert.deepEqual(deepseekStartingBalanceState(starting, fresh), { applies: true, replacedAt: null });
  assert.equal(deepseekStartingBalanceNote(starting, [fresh]), null);
  const card = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 57 }], fetchedAt: FETCHED_AT },
    balanceReferences: [{ ...fresh, lastTotal: 57 }],
    startingBalance: starting,
    totals: TOTALS,
    now: NOW,
  });
  assert.deepEqual(card.meters.map((meter) => [meter.used, meter.allowance, meter.remaining]), [[3, 60, 57]]);
  // The balance before the rise read after the setting: a top-up after it.
  const later = { ...fresh, roseAt: '2026-10-26T10:05:00.000Z', roseFromAt: '2026-10-25T10:05:00.000Z' };
  assert.deepEqual(deepseekStartingBalanceState(starting, later), { applies: false, replacedAt: '2026-10-26T10:05:00.000Z' });
  // Not known when the balance before the rise was read (a reference from
  // before that was noted): it stays, unless the balance after the rise is
  // above the starting balance, which then no longer describes the account.
  assert.equal(deepseekStartingBalanceState(starting, { ...fresh, roseFromAt: null }).applies, true);
  assert.deepEqual(deepseekStartingBalanceState(starting, { ...fresh, roseFromAt: null, referenceTotal: 160 }), { applies: false, replacedAt: '2026-10-25T10:05:00.000Z' });
  // Known to come from a read before the setting, a balance above the
  // starting balance does not replace it: ¥5 left, topped up ¥50, ¥50
  // entered before the relay's next read sees ¥55.
  assert.deepEqual(deepseekStartingBalanceState({ amount: 50, setAt: starting.setAt }, { ...fresh, referenceTotal: 55, lastTotal: 55 }), { applies: true, replacedAt: null });
  // A rise seen before the setting never replaces it.
  assert.equal(deepseekStartingBalanceState(starting, { ...later, roseAt: '2026-10-25T09:59:00.000Z', referenceTotal: 160 }).applies, true);
});

test('the tab\'s note and the bar judge the starting balance on the same currency, the balance\'s main one', () => {
  const setAt = '2026-10-21T13:00:00.000Z';
  const starting = { amount: 50, setAt };
  // CNY is the main balance (the first with money); USD rose after the
  // starting balance was set, CNY did not.
  const balances = [{ currency: 'CNY', total: 45.91 }, { currency: 'USD', total: 20 }];
  const cny = { currency: 'CNY', referenceTotal: 45.91, lastTotal: 45.91, referenceAt: FETCHED_AT, roseAt: null, roseFromAt: null };
  const usdRose = { currency: 'USD', referenceTotal: 20, lastTotal: 20, referenceAt: '2026-10-22T09:00:00.000Z', roseAt: '2026-10-22T09:00:00.000Z', roseFromAt: '2026-10-21T14:00:00.000Z' };
  const card = buildDeepSeekPlanCard({ balance: { ok: true, isAvailable: true, balances, fetchedAt: FETCHED_AT }, balanceReferences: [cny, usdRose], startingBalance: starting, totals: TOTALS, now: NOW });
  assert.deepEqual(card.meters.filter((meter) => meter.id.startsWith('deepseek-balance-')).map((meter) => [meter.id, meter.allowance]), [
    ['deepseek-balance-cny', 50],
    ['deepseek-balance-usd', 20],
  ]);
  assert.equal(deepseekStartingBalanceCurrency(balances), 'CNY');
  assert.equal(deepseekStartingBalanceNote(starting, [cny, usdRose], { balances }), null);
  // Without a balance read, the references' last balances stand in.
  assert.equal(deepseekStartingBalanceNote(starting, [cny, usdRose]), null);
  // CNY rose after it: the bar leaves it, and the note says so.
  const cnyRose = { ...usdRose, currency: 'CNY', referenceTotal: 140, lastTotal: 140 };
  const after = buildDeepSeekPlanCard({
    balance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 140 }, { currency: 'USD', total: 20 }], fetchedAt: FETCHED_AT },
    balanceReferences: [cnyRose, { ...cny, currency: 'USD', referenceTotal: 20, lastTotal: 20 }],
    startingBalance: starting,
    totals: TOTALS,
    now: NOW,
  });
  assert.equal(after.meters.find((meter) => meter.id === 'deepseek-balance-cny').allowance, 140);
  assert.match(deepseekStartingBalanceNote(starting, [cnyRose, usdRose], { balances }), /^No longer used: the balance rose on 2026-10-22/);
  // USD is the main balance when CNY has nothing on it.
  const usdMain = [{ currency: 'CNY', total: 0 }, { currency: 'USD', total: 20 }];
  assert.equal(deepseekStartingBalanceCurrency(usdMain), 'USD');
  assert.match(deepseekStartingBalanceNote(starting, [cny, usdRose], { balances: usdMain }), /^No longer used/);
});

test('the budget bar: this calendar month\'s spend (UTC) against the budget from the DeepSeek tab, amber near it and red over it', () => {
  const balance = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT };
  const card = buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 10, now: NOW });
  const budget = card.meters.find((meter) => meter.id === 'deepseek-monthly-budget');
  // October so far: ¥6 + ¥2.5 + ¥0.5 of searches; September is not in it.
  assert.deepEqual([budget.label, budget.unit, budget.used, budget.allowance, budget.remaining, budget.utilization, budget.resetAt, budget.estimated], [
    'Monthly budget (CNY)', 'cny', 9, 10, 1, 90, '2026-11-01T00:00:00.000Z', true,
  ]);
  assert.equal(budget.note, 'This relay\'s estimated spend since Oct 1 (UTC); starts over on the 1st.');
  // 90% is red, 75% amber, less is green: the renderer's ramp.
  assert.equal(utilizationColor(budget.utilization), '#f85149');
  assert.equal(utilizationColor(buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 12, now: NOW }).meters.at(-1).utilization), '#e3b341');
  assert.equal(utilizationColor(buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 100, now: NOW }).meters.at(-1).utilization), '#3fb950');
  // Over the budget: the remaining goes negative, the bar clamps.
  const over = buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 5, now: NOW }).meters.at(-1);
  assert.deepEqual([over.used, over.remaining, over.utilization], [9, -4, 100]);
  assert.match(renderPlanUsageHtml({ providers: [buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 5, now: NOW })] }, { activeProvider: 'deepseek', now: new Date(NOW) }), /¥9\.00 of ¥5\.00 used · ¥4\.00 over · resets in 10 d 12 h/);
  // No budget, or a budget of nothing: no bar. Without a balance the budget is in dollars like the spend.
  assert.equal(buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, now: NOW }).meters.some((meter) => meter.id === 'deepseek-monthly-budget'), false);
  assert.equal(buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 0, now: NOW }).meters.some((meter) => meter.id === 'deepseek-monthly-budget'), false);
  const usd = buildDeepSeekPlanCard({ balance: null, totals: TOTALS, days: DAYS, monthlyBudget: 2, now: NOW }).meters.at(-1);
  assert.deepEqual([usd.label, usd.unit, usd.used, usd.allowance], ['Monthly budget (USD)', 'usd', 1.22, 2]);
});

test('the budget bar is in the budget\'s own currency, whatever the balance is in; a budget saved without one follows the balance', () => {
  const balance = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT };
  // A $2 budget on a CNY account: October's spend in dollars ($0.80 + $0.35 + $0.07), not ¥9 against $2.
  const usd = buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 2, monthlyBudgetCurrency: 'USD', now: NOW }).meters.at(-1);
  assert.deepEqual([usd.id, usd.label, usd.unit, usd.used, usd.allowance, usd.remaining, usd.utilization], ['deepseek-monthly-budget', 'Monthly budget (USD)', 'usd', 1.22, 2, 0.78, 61]);
  assert.match(renderPlanUsageHtml({ providers: [buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 2, monthlyBudgetCurrency: 'USD', now: NOW })] }, { activeProvider: 'deepseek', now: new Date(NOW) }), /Monthly budget \(USD\)[\s\S]*\$1\.22 of \$2\.00 used/);
  // The balance bar stays in the balance's currency beside it.
  const card = buildDeepSeekPlanCard({
    balance,
    balanceReferences: [{ currency: 'CNY', referenceTotal: 150, lastTotal: 110, referenceAt: '2026-10-15T09:00:00.000Z' }],
    totals: TOTALS,
    days: DAYS,
    monthlyBudget: 2,
    monthlyBudgetCurrency: 'usd',
    now: NOW,
  });
  assert.deepEqual(card.meters.map((meter) => [meter.id, meter.unit]), [['deepseek-balance-cny', 'cny'], ['deepseek-monthly-budget', 'usd']]);
  // A CNY budget without a balance read: still yuan.
  const cny = buildDeepSeekPlanCard({ balance: null, totals: TOTALS, days: DAYS, monthlyBudget: 10, monthlyBudgetCurrency: 'CNY', now: NOW }).meters.at(-1);
  assert.deepEqual([cny.label, cny.unit, cny.used, cny.allowance], ['Monthly budget (CNY)', 'cny', 9, 10]);
  // No currency stored (a budget from before), or one the prices don't know: the balance's currency.
  for (const legacy of [null, undefined, '', 'EUR']) {
    const meter = buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, monthlyBudget: 10, monthlyBudgetCurrency: legacy, now: NOW }).meters.at(-1);
    assert.deepEqual([meter.label, meter.unit, meter.used], ['Monthly budget (CNY)', 'cny', 9], String(legacy));
  }
});

test('the daily chart: the last 30 UTC days stacked by model, empty days included, with a word on where the history starts', () => {
  const balance = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT };
  const card = buildDeepSeekPlanCard({ balance, totals: TOTALS, days: DAYS, now: NOW });
  const daily = card.charts.find((chart) => chart.id === 'deepseek-daily-spend');
  assert.deepEqual([daily.label, daily.kind, daily.unit, daily.items.length], ['Daily spend, last 30 days', 'columns', 'cny', 30]);
  assert.deepEqual(daily.series, [{ key: 'deepseek-flash', label: 'DeepSeek Flash' }, { key: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }]);
  assert.deepEqual([daily.items[0].key, daily.items[0].label, daily.items.at(-1).key, daily.items.at(-1).label], ['2026-09-22', 'Sep 22', '2026-10-21', 'Oct 21']);
  assert.deepEqual(daily.items.filter((item) => Object.values(item.values).some(Boolean)).map((item) => [item.key, item.values]), [
    ['2026-09-30', { 'deepseek-flash': 100, 'deepseek-v4-pro': 0 }],
    ['2026-10-20', { 'deepseek-flash': 6, 'deepseek-v4-pro': 0 }],
    ['2026-10-21', { 'deepseek-flash': 0, 'deepseek-v4-pro': 3 }],
  ]);
  assert.equal(daily.note, 'Daily history on this relay starts Sep 30; earlier turns are only in the totals.');
  // A history reaching back the whole 30 days needs no such word.
  const long = buildDeepSeekPlanCard({ balance, totals: TOTALS, days: { ...DAYS, firstDay: '2026-09-22' }, now: NOW }).charts[0];
  assert.equal(long.note, 'Estimated, by UTC day, from the turns of this relay.');
  // Nothing spent in the 30 days: no chart. Without a balance the chart is in dollars.
  assert.equal(buildDeepSeekPlanCard({ balance, totals: TOTALS, days: { days: DAYS.days.slice(0, 1), firstDay: '2026-09-30' }, now: '2026-11-15T12:00:00.000Z' }).charts.some((chart) => chart.id === 'deepseek-daily-spend'), false);
  assert.deepEqual(buildDeepSeekPlanCard({ balance: null, totals: TOTALS, days: DAYS, now: NOW }).charts[0].items.at(-1).values, { 'deepseek-flash': 0, 'deepseek-v4-pro': 0.42 });
  // More models than colours: the known ones keep theirs, the rest are "Other models".
  const many = buildDeepSeekPlanCard({
    balance,
    totals: TOTALS,
    now: NOW,
    days: { firstDay: '2026-10-01', days: ['deepseek-zeta', 'deepseek-alpha', 'deepseek-v4-pro', 'deepseek-flash', 'deepseek-beta'].map((model, index) => ({ day: '2026-10-21', model, costCny: index + 1, costUsd: index + 1 })) },
  }).charts[0];
  assert.deepEqual(many.series.map((entry) => entry.key), ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-alpha', 'other']);
  assert.deepEqual(many.items.at(-1).values, { 'deepseek-flash': 4, 'deepseek-v4-pro': 3, 'deepseek-alpha': 2, other: 6 });
});

test('where the money goes: each model\'s cost split into cache hit, miss and output from its tokens, and what the cache saved', () => {
  const balance = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT };
  const card = buildDeepSeekPlanCard({ balance, totals: TOTALS, now: NOW });
  const shares = card.charts.find((chart) => chart.id === 'deepseek-spend-shares');
  const round = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value * 1e6) / 1e6]));
  assert.deepEqual([shares.label, shares.kind, shares.unit], ['Where the money goes', 'bars', 'cny']);
  assert.deepEqual(shares.series.map((entry) => entry.key), ['hit', 'miss', 'output']);
  // Flash, ¥0.35 at off-peak weights 2M×0.02 : 150k×1 : 40k×4 = 40k : 150k : 160k.
  assert.deepEqual(shares.items.map((item) => [item.key, item.label, round(item.values)]), [
    ['deepseek-flash', 'DeepSeek Flash', { hit: 0.04, miss: 0.15, output: 0.16 }],
    ['deepseek-v4-pro', 'DeepSeek V4 Pro', { hit: 0, miss: 0.00168, output: 0.00252 }],
  ]);
  // 2M hits at the miss price would be ¥2.00; they cost ¥0.04.
  assert.equal(shares.summary, 'Cache saved about ¥1.96');
  assert.equal(shares.note, 'Cache saved: the cache hits at the cache-miss price, less what they cost.');
  // With searches and fetches a fourth piece appears.
  const withTools = buildDeepSeekPlanCard({
    balance,
    totals: { models: [{ ...TOTALS.models[0], searchRequests: 40, fetchRequests: 5, toolsCostUsd: 0.03375, toolsCostCny: 0.225 }] },
    now: NOW,
  }).charts.find((chart) => chart.id === 'deepseek-spend-shares');
  assert.deepEqual(withTools.series.map((entry) => entry.key), ['hit', 'miss', 'output', 'tools']);
  assert.equal(withTools.series.at(-1).label, 'Search');
  assert.equal(round(withTools.items[0].values).tools, 0.225);
  // A model without a price is left out; nothing priced, no chart.
  const unknown = buildDeepSeekPlanCard({ balance, totals: { models: [{ model: 'deepseek-mystery', hitTokens: 1, missTokens: 1, outputTokens: 1, turnCount: 1, costUsd: null, costCny: null }] }, now: NOW });
  assert.equal(unknown.charts.some((chart) => chart.id === 'deepseek-spend-shares'), false);
  // The renderer draws it with a legend, text equivalents and a table.
  const html = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek', now: new Date(NOW) });
  assert.match(html, /data-chart-id="deepseek-spend-shares" role="group" aria-label="Where the money goes"/);
  assert.match(html, /class="plan-usage-chart-row" tabindex="0" aria-label="DeepSeek Flash: ¥0\.35 \(Cache hit ¥0\.04 \(11%\), Cache miss ¥0\.15 \(43%\), Output ¥0\.16 \(46%\)\)"/);
  assert.match(html, /class="plan-usage-chart-summary">Cache saved about ¥1\.96</);
});

// The imported export over the estimate (deepseek-usage-import.mjs).
const CNY_BALANCE = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }], fetchedAt: FETCHED_AT };
const OVERLAY_NOW = '2026-10-22T12:00:00.000Z';
const OVERLAY_TOTALS = {
  models: [
    { model: 'deepseek-flash', hitTokens: 3000, missTokens: 300, outputTokens: 30, searchRequests: 4, turnCount: 12, costUsd: 0.05, costCny: 0.35, toolsCostCny: 0.02, toolsCostUsd: 0.003, firstSeenAt: '2026-10-20T08:00:00.000Z', lastSeenAt: '2026-10-21T11:00:00.000Z' },
    { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 100, outputTokens: 10, turnCount: 1, costUsd: 0.0006, costCny: 0.0042, firstSeenAt: '2026-10-21T09:00:00.000Z', lastSeenAt: '2026-10-21T09:00:00.000Z' },
  ],
};
const OVERLAY_DAYS = {
  firstDay: '2026-09-01',
  days: [
    { day: '2026-10-20', model: 'deepseek-flash', hitTokens: 1000, missTokens: 100, outputTokens: 10, costCny: 0.1, costUsd: 0.014 },
    { day: '2026-10-21', model: 'deepseek-flash', hitTokens: 2000, missTokens: 200, outputTokens: 20, searchRequests: 4, costCny: 0.25, toolsCostCny: 0.02, costUsd: 0.036, toolsCostUsd: 0.003 },
    { day: '2026-10-21', model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 100, outputTokens: 10, costCny: 0.0042, costUsd: 0.0006 },
  ],
};
const actualRow = (day, model, cost, requestCount, extra = {}) => ({ day, model, hitTokens: 5000, missTokens: 500, outputTokens: 50, requestCount, cost, currency: 'CNY', ...extra });

test('the export replaces the estimate per day and model on the days it covers, with its requests in the hints', () => {
  const actuals = { through: '2026-10-22T00:00:00+01:00', rows: [actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)] };
  const card = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, now: OVERLAY_NOW, actuals });
  // Flash: 0.35 estimated less the 21st's 0.25, plus the export's 0.50. Its
  // search estimate of the 21st goes: the export's cost is everything. V4 Pro
  // is not in the export on the 21st, so nothing was spent on it then.
  assert.equal(noteText(card, 'deepseek-spend'), 'Spend, actual and estimated: ¥0.60 since 2026-10-20');
  assert.deepEqual(rows(card, 'deepseek-spend-by-model').map((row) => [row.label, row.value, row.hint]), [
    ['DeepSeek Flash', '¥0.60', '12 turns since 2026-10-20 · 40 requests in the export'],
    ['DeepSeek V4 Pro', '¥0.00', '1 turn since 2026-10-21'],
  ]);
  assert.equal(card.details[0].label, 'Spend by model, actual and estimated');
  assert.deepEqual(rows(card, 'deepseek-tokens-by-model')[0].value, 'cache hit 6.0k · cache miss 600 · output 60');
  assert.equal(
    noteText(card, 'deepseek-actual'),
    'Actual figures from the DeepSeek export on the days it covers (the last through 2026-10-22 00:00 UTC+01:00), estimated on the others. On export days the export\'s cost includes the web searches. Export days follow the export\'s time zone, the estimate\'s UTC.',
  );
  const daily = card.charts.find((chart) => chart.id === 'deepseek-daily-spend');
  assert.deepEqual(daily.items.filter((item) => Object.values(item.values).some(Boolean)).map((item) => [item.key, item.values]), [
    ['2026-10-20', { 'deepseek-flash': 0.1, 'deepseek-v4-pro': 0 }],
    ['2026-10-21', { 'deepseek-flash': 0.5, 'deepseek-v4-pro': 0 }],
  ]);
  assert.match(daily.note, /^Actual from the DeepSeek export on the days it covers, by its days; estimated on the others/);
});

test('days after the export keep the estimate; a model only in the export gets a row of its own', () => {
  const actuals = {
    through: '2026-10-21T00:00:00+01:00',
    rows: [actualRow('2026-10-20', 'deepseek-flash', 0.3, 20), actualRow('2026-10-20', 'deepseek-v4-flash-new', 0.07, 3)],
  };
  const card = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, now: OVERLAY_NOW, actuals, monthlyBudget: 10, monthlyBudgetCurrency: 'CNY' });
  // Flash: 0.35 − 0.10 + 0.30, and the 21st's estimate with its searches stays.
  assert.deepEqual(rows(card, 'deepseek-spend-by-model').map((row) => [row.label, row.value, row.hint]), [
    ['DeepSeek Flash', '¥0.55', '12 turns since 2026-10-20 · 20 requests in the export'],
    ['DeepSeek V4 Pro', '¥0.0042', '1 turn since 2026-10-21'],
    ['deepseek-v4-flash-new', '¥0.07', '3 requests in the export'],
    ['Search', '¥0.02', '4 searches'],
  ]);
  // The month's budget bar counts the export's days too.
  const budget = card.meters.find((meter) => meter.id === 'deepseek-monthly-budget');
  assert.equal(budget.used, Math.round((0.3 + 0.07 + 0.25 + 0.02 + 0.0042) * 100) / 100);
  assert.match(budget.note, /actual on the days of the DeepSeek export, estimated on the others/);
  // Partly DeepSeek's own figures: no "estimated" flag on the bar.
  assert.equal(budget.estimated, false);
  const html = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek', now: new Date(OVERLAY_NOW) });
  const budgetHtml = html.slice(html.indexOf('data-meter-id="deepseek-monthly-budget"'));
  assert.doesNotMatch(budgetHtml.slice(0, budgetHtml.indexOf('</div>', budgetHtml.indexOf('plan-usage-meter-head'))), /plan-usage-flag">estimated/);
  // Export days of another month leave the bar estimated.
  const lastMonth = { through: '2026-10-01T00:00:00+01:00', rows: [actualRow('2026-09-30', 'deepseek-flash', 0.3, 20)] };
  const september = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, now: OVERLAY_NOW, actuals: lastMonth, monthlyBudget: 10, monthlyBudgetCurrency: 'CNY' })
    .meters.find((meter) => meter.id === 'deepseek-monthly-budget');
  assert.equal(september.estimated, true);
  assert.match(september.note, /estimated spend/);
});

test('a gap between two imports keeps its estimate', () => {
  // Imports of the 18th and of the 21st; the 20th lies between them.
  const actuals = {
    through: '2026-10-22T00:00:00+01:00',
    rows: [actualRow('2026-10-18', 'deepseek-flash', 0.2, 10), actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)],
    coveredDays: [{ day: '2026-10-18', currency: 'CNY' }, { day: '2026-10-21', currency: 'CNY' }],
  };
  const { days, totals, actual } = overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, actuals, currency: 'CNY' });
  assert.deepEqual(actual.days, ['2026-10-18', '2026-10-21']);
  const flash20 = days.days.find((row) => row.day === '2026-10-20' && row.model === 'deepseek-flash');
  assert.deepEqual([flash20.costCny, flash20.hitTokens], [0.1, 1000]);
  // 0.35 − 0.25 (the 21st) + 0.20 + 0.50; the 20th's 0.10 stays in.
  assert.equal(totals.models.find((entry) => entry.model === 'deepseek-flash').costCny, 0.8);
});

test('a day another key of the export covers replaces the estimate too; one in another currency does not', () => {
  const actuals = {
    through: '2026-10-22T00:00:00+01:00',
    rows: [actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)],
    coveredDays: [{ day: '2026-10-20', currency: 'CNY' }, { day: '2026-10-21', currency: 'CNY' }, { day: '2026-10-19', currency: 'USD' }],
  };
  const { days, actual } = overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, actuals, currency: 'CNY' });
  assert.deepEqual(actual.days, ['2026-10-20', '2026-10-21']);
  const flash20 = days.days.find((row) => row.day === '2026-10-20' && row.model === 'deepseek-flash');
  assert.deepEqual([flash20.costCny, flash20.hitTokens], [0, 0]);
});

test('export days before the daily history are left out and named on the card', () => {
  // The daily history starts on the 20th; the totals hold turns before it.
  const days = { ...OVERLAY_DAYS, firstDay: '2026-10-20' };
  const actuals = {
    through: '2026-10-22T00:00:00+01:00',
    rows: [actualRow('2026-10-15', 'deepseek-flash', 9, 400), actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)],
  };
  const overlay = overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days, actuals, currency: 'CNY' });
  assert.deepEqual(overlay.actual.days, ['2026-10-21']);
  assert.equal(overlay.actual.leftOutBefore, '2026-10-20');
  // Not 0.35 − 0.25 + 9 + 0.5: the 15th's turns are in the estimate already.
  assert.equal(overlay.totals.models.find((entry) => entry.model === 'deepseek-flash').costCny, 0.6);
  const card = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days, now: OVERLAY_NOW, actuals });
  assert.equal(noteText(card, 'deepseek-spend'), 'Spend, actual and estimated: ¥0.60 since 2026-10-20');
  assert.match(noteText(card, 'deepseek-actual'), /Export days through Oct 20, the day this relay's daily history starts, are left out/);

  // Only days before the history: nothing is used, the card says why.
  const early = { through: '2026-10-16T00:00:00+01:00', rows: [actualRow('2026-10-15', 'deepseek-flash', 9, 400)] };
  const estimateOnly = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days, now: OVERLAY_NOW, actuals: early });
  assert.equal(noteText(estimateOnly, 'deepseek-spend'), 'Estimated spend on this relay: ¥0.37 since 2026-10-20');
  assert.match(noteText(estimateOnly, 'deepseek-actual'), /^Export days through Oct 20/);

  // No daily history but turns in the totals: the export is left out whole.
  const none = overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days: { days: [], firstDay: null }, actuals, currency: 'CNY' });
  assert.equal(none.actual, null);
  assert.deepEqual(none.leftOut, { leftOutAll: true });
  // No history and no turns: nothing to count twice, the export is used.
  assert.deepEqual(overlayDeepSeekActuals({ totals: { models: [] }, days: { days: [], firstDay: null }, actuals, currency: 'CNY' }).actual.days, ['2026-10-15', '2026-10-21']);
});

test('the first day of the daily history is left out: its earlier turns are only in the totals', () => {
  // Upgraded on the 21st at 14:00 UTC: a turn at 09:00 that day is in the
  // totals only, with no backfill into the daily row. The export's 21st
  // would count it a second time.
  const days = { ...OVERLAY_DAYS, firstDay: '2026-10-21' };
  const onlyFirst = { through: '2026-10-22T00:00:00+01:00', rows: [actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)] };
  const overlay = overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days, actuals: onlyFirst, currency: 'CNY' });
  assert.equal(overlay.actual, null);
  assert.deepEqual(overlay.leftOut, { leftOutBefore: '2026-10-21' });
  assert.equal(overlay.totals, OVERLAY_TOTALS);
  assert.equal(overlay.days, days);
  const card = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days, now: OVERLAY_NOW, actuals: onlyFirst });
  assert.match(noteText(card, 'deepseek-spend'), /^Estimated spend on this relay:/);
  assert.match(noteText(card, 'deepseek-actual'), /^Export days through Oct 21, the day this relay's daily history starts, are left out/);
  // The day after is used.
  const withNext = { ...onlyFirst, through: '2026-10-23T00:00:00+01:00', rows: [...onlyFirst.rows, actualRow('2026-10-22', 'deepseek-flash', 0.2, 10)] };
  const next = overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days, actuals: withNext, currency: 'CNY' });
  assert.deepEqual(next.actual.days, ['2026-10-22']);
  assert.equal(next.actual.leftOutBefore, '2026-10-21');
});

test('an export in another currency than the card\'s leaves the estimate as it is', () => {
  const usdBalance = { ok: true, isAvailable: true, balances: [{ currency: 'USD', total: 4.5, granted: 0, toppedUp: 4.5 }], fetchedAt: FETCHED_AT };
  const actuals = { through: '2026-10-22T00:00:00+01:00', rows: [actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)] };
  const base = { balance: usdBalance, totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, now: OVERLAY_NOW };
  assert.deepEqual(buildDeepSeekPlanCard({ ...base, actuals }), buildDeepSeekPlanCard(base));
  assert.deepEqual(buildDeepSeekPlanCard({ ...base, actuals: null }), buildDeepSeekPlanCard(base));
  assert.deepEqual(overlayDeepSeekActuals({ totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, actuals, currency: 'USD' }), { totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, actual: null });
});

test('the overlay keeps the other currency\'s estimate and never goes below zero', () => {
  // Totals that hold less than the covered days (0.10 against the 21st's
  // 0.25): the export's 0.05 makes no negative spend.
  const actuals = { through: '2026-10-22T00:00:00+01:00', rows: [actualRow('2026-10-21', 'deepseek-flash', 0.05, 40)] };
  const shrunk = { models: [{ ...OVERLAY_TOTALS.models[0], costCny: 0.1 }] };
  const { totals, days } = overlayDeepSeekActuals({ totals: shrunk, days: OVERLAY_DAYS, actuals, currency: 'CNY' });
  assert.equal(totals.models[0].costCny, 0);
  assert.equal(totals.models[0].costUsd, 0.05);
  assert.equal(totals.models[0].toolsCostCny, 0);
  assert.equal(totals.models[0].searchRequests, 0);
  const flash21 = days.days.find((row) => row.day === '2026-10-21' && row.model === 'deepseek-flash');
  assert.deepEqual([flash21.costCny, flash21.toolsCostCny, flash21.costUsd, flash21.requestCount], [0.05, 0, 0.036, 40]);
});

test('the renderer shows the export\'s note', () => {
  const actuals = { through: '2026-10-22T00:00:00+01:00', rows: [actualRow('2026-10-21', 'deepseek-flash', 0.5, 40)] };
  const card = buildDeepSeekPlanCard({ balance: CNY_BALANCE, totals: OVERLAY_TOTALS, days: OVERLAY_DAYS, now: OVERLAY_NOW, actuals });
  const html = renderPlanUsageHtml({ providers: [card] }, { activeProvider: 'deepseek' });
  assert.match(html, /Actual figures from the DeepSeek export on the days it covers \(the last through 2026-10-22 00:00 UTC\+01:00\), estimated on the others/);
  assert.match(html, /12 turns since 2026-10-20 · 40 requests in the export/);
});
