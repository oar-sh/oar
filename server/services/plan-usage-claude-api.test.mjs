import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  createClaudeApiUsageService,
  normalizeClaudeApiUsageReport,
} from './claude-api-usage-service.mjs';
import {
  CLAUDE_API_CONSOLE_BILLING_URL,
  buildClaudeApiPlanCard,
  claudeApiCapStateFrom,
  claudeApiLocalDayStart,
  claudeApiMonthBounds,
  createClaudeApiCapWatch,
  createClaudeApiPlanUsage,
  createClaudeApiStopNoteLedger,
} from './plan-usage-claude-api.mjs';

// The Claude API card and its monthly cap, read from what the REAL booking
// service writes into the REAL schema: today and this month are the relay's
// local days (never UTC dates), a switch books only the turns on the key, an
// unpriced turn is "estimate incomplete" and never $0, and the cap compares
// the priced estimate in cents.

const CONV = 'conv-1';
const NATIVE = 'native-1';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';

function setup({ timeZone = 'UTC', now = '2026-10-25T12:00:00.000Z', settings = {} } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Chat', 'a', 'a')`).run(CONV);
  const clock = { now: Date.parse(now) };
  const warnings = [];
  const usageService = createClaudeApiUsageService({
    db,
    now: () => clock.now,
    timeZone,
    logger: { log() {}, warn: (line) => warnings.push(line) },
  });
  const state = { settings: { configured: true, enabled: true, monthlyCapUsd: null, modelDetails: {}, ...settings } };
  const planUsage = createClaudeApiPlanUsage({
    usageService,
    getSettings: () => state.settings,
    now: () => clock.now,
  });
  let replies = 0;
  const reply = (turnId, at) => {
    replies += 1;
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'assistant', 'ok', ?)`).run(`reply-${replies}`, CONV, at);
    db.prepare(`UPDATE messages SET source_message_id = ? WHERE id = ?`).run(turnId, `reply-${replies}`);
  };
  const post = (billing, body) => {
    const parsed = normalizeClaudeApiUsageReport({ claudeNativeSessionId: NATIVE, ...body });
    assert.equal(parsed.ok, true, parsed.error);
    return usageService.recordReport({ conversationId: CONV, billing, report: parsed.report });
  };
  // One finished API turn of its own run, priced or not.
  let runs = 0;
  const apiTurn = (at, model, miss, output, costUsd, extra = {}) => {
    runs += 1;
    const counts = [{ model, hitTokens: 0, missTokens: miss, outputTokens: output, costUsd, ...extra }];
    return post('claude-api', { runId: `run-${runs}`, turnId: `t-${runs}`, at, firstResultOfRun: true, runCounts: counts, sessionTotals: counts });
  };
  return { db, clock, state, usageService, planUsage, warnings, reply, post, apiTurn };
}

const entry = (model, miss, output, costUsd = 0, extra = {}) => ({ model, hitTokens: 0, missTokens: miss, outputTokens: output, costUsd, ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const noteOf = (card, id) => card.notes.find((note) => note.id === id);
const meterOf = (card, id) => card.meters.find((meter) => meter.id === id);

test('month bounds are text days of the local month; day 31 holds every month\'s end', () => {
  assert.deepEqual(claudeApiMonthBounds('2026-02-14'), {
    today: '2026-02-14', month: '2026-02', monthStart: '2026-02-01', monthEnd: '2026-02-31', nextMonthStart: '2026-03-01',
  });
  assert.equal(claudeApiMonthBounds('2026-12-31').nextMonthStart, '2027-01-01');
  assert.equal(claudeApiMonthBounds('2026-1-1'), null);
});

test('the month boundary in relay time: just after local midnight on the 1st, October is over', () => {
  // 2026-10-31T23:30Z is 00:30 on Nov 1 in Berlin (CET): a UTC date would still say October.
  const app = setup({ timeZone: 'Europe/Berlin', now: '2026-10-31T23:30:00.000Z', settings: { monthlyCapUsd: 1 } });
  app.apiTurn('2026-10-31T22:59:00.000Z', SONNET, 1000, 100, 5); // Oct 31, 23:59 local
  app.apiTurn('2026-10-31T23:01:00.000Z', SONNET, 300, 30, 0.25); // Nov 1, 00:01 local
  const spend = app.planUsage.readSpend();
  assert.equal(spend.bounds.today, '2026-11-01');
  assert.equal(spend.bounds.monthStart, '2026-11-01');
  near(spend.month.costUsd, 0.25);
  near(spend.today.costUsd, 0.25);
  // October's $5 does not count against November's $1 cap.
  assert.equal(app.planUsage.getCapState().reached, false);
  // One minute before local midnight it was still October, and over the cap.
  app.clock.now = Date.parse('2026-10-31T22:59:30.000Z');
  const october = app.planUsage.getCapState();
  assert.equal(october.reached, true);
  assert.equal(october.spentUsd, 5);
  assert.match(october.error, /\$5\.00, has reached the monthly cap of \$1\.00/);
});

test('a month that starts by UTC but not locally: turns before local midnight on the 1st are last month\'s', () => {
  // America/New_York: 2026-11-01T03:30Z is still Oct 31 there.
  const app = setup({ timeZone: 'America/New_York', now: '2026-11-01T03:45:00.000Z' });
  app.apiTurn('2026-11-01T03:30:00.000Z', SONNET, 100, 10, 0.4);
  const spend = app.planUsage.readSpend();
  assert.equal(spend.bounds.today, '2026-10-31');
  near(spend.month.costUsd, 0.4);
  app.clock.now = Date.parse('2026-11-01T04:30:00.000Z'); // 00:30 on Nov 1, EDT
  assert.equal(app.planUsage.readSpend().month.costUsd, 0);
});

test('the DST day is one local day of 25 hours, the repeated hour included', () => {
  // Europe/Berlin leaves summer time on 2026-10-25 at 03:00 CEST (01:00Z).
  const app = setup({ timeZone: 'Europe/Berlin', now: '2026-10-25T22:30:00.000Z' }); // 23:30 CET
  app.apiTurn('2026-10-24T21:59:00.000Z', SONNET, 1, 1, 0.01); // Oct 24, 23:59 CEST
  app.apiTurn('2026-10-24T22:00:00.000Z', SONNET, 1, 1, 0.02); // Oct 25, 00:00 CEST
  app.apiTurn('2026-10-25T00:30:00.000Z', SONNET, 1, 1, 0.04); // 02:30 CEST
  app.apiTurn('2026-10-25T01:30:00.000Z', SONNET, 1, 1, 0.08); // 02:30 CET, the hour again
  app.apiTurn('2026-10-25T22:59:00.000Z', SONNET, 1, 1, 0.16); // Oct 25, 23:59 CET
  app.apiTurn('2026-10-25T23:00:00.000Z', SONNET, 1, 1, 0.32); // Oct 26, 00:00 CET
  const days = app.db.prepare(`SELECT day, cost_usd FROM claude_api_usage_totals ORDER BY day`).all();
  assert.deepEqual(days.map((row) => row.day), ['2026-10-24', '2026-10-25', '2026-10-26']);
  const spend = app.planUsage.readSpend();
  assert.equal(spend.bounds.today, '2026-10-25');
  near(spend.today.costUsd, 0.02 + 0.04 + 0.08 + 0.16);
  // The month holds every October day booked, the 26th too (a worker clock
  // a little ahead must not drop out of its month).
  near(spend.month.costUsd, 0.01 + 0.02 + 0.04 + 0.08 + 0.16 + 0.32);
});

test('when the local month starts over: the zone\'s own midnight, DST included', () => {
  const dayIn = (timeZone) => createClaudeApiUsageService({ db: (() => { const db = new Database(':memory:'); applySchema(db); return db; })(), timeZone, logger: { log() {}, warn() {} } }).localDay;
  assert.equal(claudeApiLocalDayStart(dayIn('Europe/Berlin'), '2026-11-01'), '2026-10-31T23:00:00.000Z'); // CET
  assert.equal(claudeApiLocalDayStart(dayIn('Europe/Berlin'), '2027-04-01'), '2027-03-31T22:00:00.000Z'); // CEST
  assert.equal(claudeApiLocalDayStart(dayIn('America/New_York'), '2026-11-01'), '2026-11-01T04:00:00.000Z'); // still EDT
  assert.equal(claudeApiLocalDayStart(dayIn('Asia/Kolkata'), '2026-11-01'), '2026-10-31T18:30:00.000Z');
  assert.equal(claudeApiLocalDayStart(dayIn('Pacific/Kiritimati'), '2026-11-01'), '2026-10-31T10:00:00.000Z'); // UTC+14
  assert.equal(claudeApiLocalDayStart(dayIn('UTC'), '2026-11-01'), '2026-11-01T00:00:00.000Z');
  assert.equal(claudeApiLocalDayStart(dayIn('UTC'), 'soon'), null);
});

test('booking across a switch: only the turns on the key are spend, the subscription\'s are not', () => {
  const app = setup({ settings: { monthlyCapUsd: 10 } });
  // A turn on the key, then the chat moves to the subscription for two turns.
  app.post('claude-api', {
    runId: 'run-a', turnId: 't1', at: '2026-10-25T09:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1000, 100, 0.1)], sessionTotals: [entry(SONNET, 1000, 100, 0.1)],
  });
  app.reply('t1', '2026-10-25T09:00:01.000Z');
  app.post('claude', {
    runId: 'run-s', turnId: 't2', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 400, 40, 0)], sessionTotals: [entry(SONNET, 1400, 140, 0.14)],
  });
  app.reply('t2', '2026-10-25T10:00:01.000Z');
  app.post('claude', {
    runId: 'run-s', turnId: 't3', at: '2026-10-25T10:10:00.000Z',
    runCounts: [entry(SONNET, 1000, 100, 0.1)], sessionTotals: [entry(SONNET, 2000, 200, 0.2)],
  });
  app.reply('t3', '2026-10-25T10:10:01.000Z');
  // Back on the key: the resumed run's first result from the mark.
  const back = app.post('claude-api', {
    runId: 'run-b', turnId: 't4', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 300, 30, 0)], sessionTotals: [entry(SONNET, 2500, 250, 0.25), entry(HAIKU, 50, 5, 0.002)],
  });
  assert.equal(back.basis, 'mark');
  const spend = app.planUsage.readSpend();
  // t1 ($0.10) and t4 ($0.05 on Sonnet, $0.002 on a Haiku helper): the
  // subscription's $0.10 is nowhere.
  near(spend.month.costUsd, 0.152);
  assert.equal(spend.month.unknownCostTokens, 0);
  const card = app.planUsage.buildCard();
  assert.equal(noteOf(card, 'claude-api-spend-month').value, '$0.15');
  assert.equal(meterOf(card, 'claude-api-monthly-cap').used, 0.15);
  assert.equal(meterOf(card, 'claude-api-monthly-cap').allowance, 10);
  const byModel = card.details.find((section) => section.id === 'claude-api-spend-by-model');
  assert.deepEqual(byModel.rows.map((row) => [row.label, row.value]), [['Claude Sonnet 5.5', '$0.15'], ['Claude Haiku 4.5', '$0.0020']]);
  assert.equal(app.warnings.length, 0);
});

test('a drop after resume (totals below the mark) books the run\'s tokens unpriced: "estimate incomplete", not $0', () => {
  const app = setup({ settings: { monthlyCapUsd: 5 } });
  app.post('claude', {
    runId: 'run-s', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 5000, 900, 0.5)], sessionTotals: [entry(SONNET, 5000, 900, 0.5)],
  });
  app.reply('t1', '2026-10-25T10:00:01.000Z');
  const resumed = app.post('claude-api', {
    runId: 'run-a', turnId: 't2', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 700, 120, 0)], sessionTotals: [entry(SONNET, 900, 160, 0.09)],
  });
  assert.equal(resumed.basis, 'run');
  const card = app.planUsage.buildCard();
  assert.equal(noteOf(card, 'claude-api-spend-month').value, 'no price known');
  assert.match(noteOf(card, 'claude-api-spend-month').text, /820 tokens had no known price/);
  assert.match(meterOf(card, 'claude-api-monthly-cap').note, /Estimate incomplete/);
  const cap = app.planUsage.getCapState();
  assert.equal(cap.reached, false);
  assert.equal(cap.incomplete, true);
  // The run's next result is priced again: a figure with the gap named.
  app.post('claude-api', {
    runId: 'run-a', turnId: 't3', at: '2026-10-25T10:30:00.000Z',
    runCounts: [entry(SONNET, 1000, 200, 0.03)], sessionTotals: [entry(SONNET, 1200, 240, 0.12)],
  });
  assert.equal(noteOf(app.planUsage.buildCard(), 'claude-api-spend-month').value, '$0.03 (estimate incomplete)');
});

test('costBasis unknown: tokens without a price, the model row says so, the priced ones still add up', () => {
  const app = setup();
  app.apiTurn('2026-10-25T10:00:00.000Z', 'claude-new-model', 400, 40, 0, { costUnknown: true });
  app.apiTurn('2026-10-25T10:05:00.000Z', SONNET, 100, 10, 0.02);
  const card = app.planUsage.buildCard();
  const byModel = card.details.find((section) => section.id === 'claude-api-spend-by-model');
  const rows = Object.fromEntries(byModel.rows.map((row) => [row.label, row]));
  assert.equal(rows['claude-new-model'].value, 'no price known');
  assert.match(rows['claude-new-model'].hint, /440 tokens had no known price/);
  assert.equal(rows['Claude Sonnet 5.5'].value, '$0.02');
  assert.equal(noteOf(card, 'claude-api-spend-today').value, '$0.02 (estimate incomplete)');
  // Nothing on the card counts turns (turn_count is per model row).
  assert.doesNotMatch(JSON.stringify(card), /\bturns? (today|this month|since)|\d+ turns?\b/);
});

test('the cap: reached at the cap in cents, refusing with its figures; none set is never reached', () => {
  assert.deepEqual(claudeApiCapStateFrom({ capUsd: null, spend: { month: { costUsd: 99, unknownCostTokens: 0 } } }), {
    reached: false, capUsd: null, spentUsd: 99, incomplete: false,
  });
  assert.equal(claudeApiCapStateFrom({ capUsd: 5, spend: { month: { costUsd: 4.994, unknownCostTokens: 0 } } }).reached, false);
  const atCap = claudeApiCapStateFrom({ capUsd: 5, spend: { month: { costUsd: 4.996, unknownCostTokens: 0 } } });
  assert.equal(atCap.reached, true);
  assert.equal(atCap.error, 'This month\'s estimated Claude API spend, $5.00, has reached the monthly cap of $5.00 set in Settings → Providers → Claude API.');
  assert.equal(atCap.reason, 'This month\'s estimated Claude API spend, $5.00, has reached the monthly cap of $5.00.');
  const app = setup({ settings: { monthlyCapUsd: 0.5 } });
  app.apiTurn('2026-10-25T10:00:00.000Z', SONNET, 100, 10, 0.3);
  assert.equal(app.planUsage.getCapState().reached, false);
  app.apiTurn('2026-10-25T10:10:00.000Z', SONNET, 100, 10, 0.2);
  assert.equal(app.planUsage.getCapState().reached, true);
  // One episode at the cap: this local month and this cap.
  assert.equal(app.planUsage.getCapState().episode, '2026-10:0.5');
  const card = app.planUsage.buildCard();
  assert.match(card.message, /reached the cap: new Claude API turns, agents' new Claude API sessions and switches to the API key are refused until Nov 1/);
  assert.equal(meterOf(card, 'claude-api-monthly-cap').utilization, 100);
  assert.equal(meterOf(card, 'claude-api-monthly-cap').resetAt, '2026-11-01T00:00:00.000Z');
  app.state.settings = { ...app.state.settings, monthlyCapUsd: null };
  assert.deepEqual(app.planUsage.getCapState(), { reached: false, capUsd: null });
  assert.equal(meterOf(app.planUsage.buildCard(), 'claude-api-monthly-cap'), undefined);
});

test('a cap whose totals cannot be read throws, so the seam fails closed', () => {
  const app = setup({ settings: { monthlyCapUsd: 5 } });
  app.db.exec('DROP TABLE claude_api_usage_totals');
  assert.throws(() => app.planUsage.getCapState());
  // The card says it could not read the spend instead of showing $0.
  const card = app.planUsage.buildCard();
  assert.equal(card.status, 'unavailable');
  assert.match(card.message, /could not be read/);
  // With a cap set, it says what that means for the key.
  assert.match(card.message, /While a monthly cap is set, new turns on the key are refused until it can be read\./);
  app.state.settings = { ...app.state.settings, monthlyCapUsd: null };
  assert.doesNotMatch(app.planUsage.buildCard().message, /refused/);
});

test('the card: no card without a key and off; switched off keeps the month\'s figures; links to the Console', () => {
  assert.equal(buildClaudeApiPlanCard({ settings: { configured: false, enabled: false } }), null);
  const app = setup({ settings: { enabled: false, modelDetails: { [SONNET]: { displayName: 'Claude Sonnet 5.5 (Console)' } } } });
  app.apiTurn('2026-10-25T10:00:00.000Z', SONNET, 1_500_000, 20_000, 1.25);
  const card = app.planUsage.buildCard();
  assert.equal(card.provider, 'claude-api');
  assert.equal(card.label, 'Claude API');
  assert.match(card.message, /switched off/);
  assert.equal(noteOf(card, 'claude-api-spend-today').value, '$1.25');
  assert.ok(card.links.some((link) => link.url === CLAUDE_API_CONSOLE_BILLING_URL));
  assert.match(noteOf(card, 'claude-api-estimate').text, /subscriber API credit/);
  // Console billing once, in the card's links: the estimate note has none.
  assert.equal(noteOf(card, 'claude-api-estimate').link ?? null, null);
  assert.equal(card.links.filter((link) => link.label === 'Console billing').length, 1);
  const tokens = card.details.find((section) => section.id === 'claude-api-tokens-by-model');
  assert.equal(tokens.rows[0].label, 'Claude Sonnet 5.5 (Console)');
  assert.equal(tokens.rows[0].value, 'cache read 0 · other input 1.5M · output 20.0k');
  const empty = setup().planUsage.buildCard();
  assert.match(empty.message, /No turns on the Claude API key this month yet/);
  assert.equal(noteOf(empty, 'claude-api-spend-month').value, '$0.00');
});

test('the zone the card names is the one the booking keeps its days in', () => {
  const app = setup({ timeZone: 'Europe/Berlin' });
  assert.equal(app.usageService.timeZone, 'Europe/Berlin');
  const card = app.planUsage.buildCard();
  assert.match(card.notes.find((note) => note.id === 'claude-api-estimate').text, /\(Europe\/Berlin\)/);
  app.state.settings = { ...app.state.settings, monthlyCapUsd: 5 };
  const meter = app.planUsage.buildCard().meters.find((entry) => entry.id === 'claude-api-monthly-cap');
  assert.match(meter.note, /since Oct 1 \(Europe\/Berlin\)/);
  // A turn's cost is booked when it ends: running turns can pass the cap.
  assert.match(meter.note, /turns already running finish and can take the month past the cap/);
});

test('the cap watch: the first check sets where it stands, then each flip either way is announced once', () => {
  const state = { reached: false, throws: false };
  const flips = [];
  const watch = createClaudeApiCapWatch({
    getCapState: () => { if (state.throws) throw new Error('unreadable'); return { reached: state.reached }; },
    onChange: (event) => flips.push(event),
    logger: { warn() {} },
  });
  assert.deepEqual(watch.check('boot'), { reached: false, changed: false });
  assert.deepEqual(watch.check('usage'), { reached: false, changed: false });
  state.reached = true;
  assert.deepEqual(watch.check('usage'), { reached: true, changed: true });
  assert.deepEqual(watch.check('settings'), { reached: true, changed: false });
  state.reached = false;
  assert.deepEqual(watch.check('clock'), { reached: false, changed: true });
  // Unreadable counts as reached.
  state.throws = true;
  assert.deepEqual(watch.check('clock'), { reached: true, changed: true });
  assert.deepEqual(flips, [{ reached: true, reason: 'usage' }, { reached: false, reason: 'clock' }, { reached: true, reason: 'clock' }]);
  // A failing announcement does not break the check.
  const quiet = createClaudeApiCapWatch({ getCapState: () => ({ reached: state.reached }), onChange: () => { throw new Error('emit'); }, logger: { warn() {} } });
  state.throws = false;
  quiet.check('boot');
  state.reached = true;
  assert.deepEqual(quiet.check('usage'), { reached: true, changed: true });
});

test('the cap watch over the real cap: booking past it flips it, raising the cap flips it back', () => {
  const app = setup({ settings: { monthlyCapUsd: 0.5 } });
  const flips = [];
  const watch = createClaudeApiCapWatch({ getCapState: () => app.planUsage.getCapState(), onChange: (event) => flips.push(event.reached) });
  watch.check('boot');
  app.apiTurn('2026-10-25T10:00:00.000Z', SONNET, 100, 10, 0.6);
  watch.check('usage');
  app.state.settings = { ...app.state.settings, monthlyCapUsd: 1 };
  watch.check('settings');
  assert.deepEqual(flips, [true, false]);
});

test('the stop-note ledger: one note per chat per episode, ended per chat or for all', () => {
  const ledger = createClaudeApiStopNoteLedger();
  assert.equal(ledger.has('a', 'cap:2026-10:5'), false);
  ledger.note('a', 'cap:2026-10:5');
  ledger.note('b', 'CLAUDE_API_NOT_CONFIGURED');
  assert.equal(ledger.has('a', 'cap:2026-10:5'), true);
  assert.equal(ledger.has('a', 'cap:2026-11:5'), false);
  ledger.clear('a');
  assert.equal(ledger.has('a', 'cap:2026-10:5'), false);
  assert.equal(ledger.has('b', 'CLAUDE_API_NOT_CONFIGURED'), true);
  ledger.clearAll();
  assert.equal(ledger.has('b', 'CLAUDE_API_NOT_CONFIGURED'), false);
});
