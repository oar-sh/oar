import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createTokenUsageService, partlyReportedFields } from './token-usage-service.mjs';
import { normalizeTurnTokenUsageReport } from '../../shared/turn-token-usage.mjs';

const silent = { warn() {}, log() {} };

function setup({ at = '2026-11-02T10:00:00.000Z', timeZone = 'UTC' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const clock = { ms: Date.parse(at) };
  const service = createTokenUsageService({ db, now: () => clock.ms, timeZone, logger: silent });
  return { db, clock, service };
}

function report(body) {
  const parsed = normalizeTurnTokenUsageReport({ conversationId: 'conv-1', turnId: 'turn-1', runId: 'run-1', ...body });
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.report;
}

const day = (db, where = '') => db.prepare(`SELECT * FROM token_usage_days ${where} ORDER BY day, provider, billing, model, source`).all().map((row) => ({ ...row }));
const turnRows = (db) => db.prepare(`SELECT * FROM turn_token_usage ORDER BY turn_id, run_id, model`).all().map((row) => ({ ...row }));

test('a retried report books nothing twice', () => {
  const { db, service } = setup();
  const body = { models: [{ model: 'composer-2', inputTokens: 100, outputTokens: 20, cacheWriteTokens: 5, cacheReadTokens: 400 }] };
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report(body) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report(body) });
  const [row] = day(db);
  assert.equal(row.input_tokens, 100);
  assert.equal(row.cache_read_tokens, 400);
  assert.equal(row.turn_count, 1);
  assert.equal(turnRows(db).length, 1);
});

test('a re-post adds only its rise; a lower one changes nothing', () => {
  const { db, service } = setup();
  const post = (inputTokens, outputTokens) => service.recordTurn({
    conversationId: 'conv-1', provider: 'grok', report: report({ models: [{ model: 'grok-5', inputTokens, outputTokens }] }),
  });
  post(100, 10);
  post(150, 10);
  assert.equal(day(db)[0].input_tokens, 150);
  // Reordered: an older, smaller report arrives last. Only rises count, field by field.
  post(120, 40);
  const [row] = day(db);
  assert.equal(row.input_tokens, 150);
  assert.equal(row.output_tokens, 40);
  assert.equal(turnRows(db)[0].input_tokens, 150);
  assert.equal(turnRows(db)[0].output_tokens, 40);
  // The day row is the sum of the turn rows.
  assert.equal(row.turn_count, 1);
});

test('a field left out of a re-post keeps the earlier value', () => {
  const { db, service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'github', report: report({ models: [{ model: 'gpt-5.5', inputTokens: 10, cacheReadTokens: 30 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'github', report: report({ models: [{ model: 'gpt-5.5', inputTokens: 12 }] }) });
  const [row] = turnRows(db);
  assert.equal(row.cache_read_tokens, 30);
  assert.equal(day(db)[0].cache_read_tokens, 30);
  assert.equal(day(db)[0].input_tokens, 12);
});

test('sums are null-aware: NULL until reported, 0 when reported as zero', () => {
  const { db, service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't1', models: [{ model: 'composer-2', inputTokens: 10, outputTokens: 1 }] }) });
  let [row] = day(db);
  assert.equal(row.cache_write_tokens, null);
  assert.equal(row.reasoning_tokens, null);
  assert.equal(row.cost_usd, null);
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't2', models: [{ model: 'composer-2', inputTokens: 5, cacheWriteTokens: 0 }] }) });
  [row] = day(db);
  assert.equal(row.input_tokens, 15);
  assert.equal(row.cache_write_tokens, 0);
  assert.equal(row.turn_count, 2);
});

test('a report without any field is a turn of NULLs', () => {
  const { db, service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'grok', report: report({ models: [{ model: 'grok-5' }] }) });
  const [row] = day(db);
  assert.equal(row.turn_count, 1);
  assert.equal(row.input_tokens, null);
});

test('the day is the relay local date of the first report, also for a later re-post', () => {
  // 07:30Z is the 1st in Los Angeles' evening and the 2nd in Tokyo.
  const la = setup({ at: '2026-11-02T07:30:00.000Z', timeZone: 'America/Los_Angeles' });
  la.service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ models: [{ model: 'composer-2', inputTokens: 1 }] }) });
  assert.equal(day(la.db)[0].day, '2026-11-01');
  const tokyo = setup({ at: '2026-11-02T07:30:00.000Z', timeZone: 'Asia/Tokyo' });
  tokyo.service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ models: [{ model: 'composer-2', inputTokens: 1 }] }) });
  assert.equal(day(tokyo.db)[0].day, '2026-11-02');

  // A turn that ends at 23:59 and is re-posted at 00:05 stays on its day.
  const { db, clock, service } = setup({ at: '2026-11-02T23:59:00.000Z' });
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ models: [{ model: 'composer-2', inputTokens: 10 }] }) });
  clock.ms = Date.parse('2026-11-03T00:05:00.000Z');
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ models: [{ model: 'composer-2', inputTokens: 25 }] }) });
  assert.deepEqual(day(db).map((row) => [row.day, row.input_tokens]), [['2026-11-02', 25]]);
  assert.equal(turnRows(db)[0].day, '2026-11-02');
});

test('a re-run gets its own row, and the day sums both attempts', () => {
  const { db, service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude', report: report({ runId: 'run-a', models: [{ model: 'claude-opus-5-5', inputTokens: 40 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude', report: report({ runId: 'run-b', models: [{ model: 'claude-opus-5-5', inputTokens: 60 }] }) });
  assert.equal(turnRows(db).length, 2);
  assert.equal(day(db)[0].input_tokens, 100);
  assert.equal(day(db)[0].turn_count, 2);
});

test('one row per model, and a turn row keeps its first provider and billing', () => {
  const { db, service } = setup();
  service.recordTurn({
    conversationId: 'conv-1', provider: 'claude',
    report: report({ models: [{ model: 'claude-opus-5-5[1m]', inputTokens: 10 }, { model: 'claude-haiku-5-5', inputTokens: 3 }, { model: 'Claude-Opus-5-5', inputTokens: 5 }] }),
  });
  assert.deepEqual(turnRows(db).map((row) => [row.model, row.input_tokens]), [['claude-haiku-5-5', 3], ['claude-opus-5-5', 15]]);
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude-api', report: report({ models: [{ model: 'claude-opus-5-5', inputTokens: 20 }] }) });
  assert.deepEqual(day(db).map((row) => [row.provider, row.model, row.input_tokens]), [['claude', 'claude-haiku-5-5', 3], ['claude', 'claude-opus-5-5', 20]]);
});

test('cost: summed per day, and tokens without a price are counted apart', () => {
  const { db, service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude-api', report: report({ turnId: 't1', models: [{ model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, costUsd: 0.25, costSource: 'claude-code' }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude-api', report: report({ turnId: 't2', models: [{ model: 'claude-sonnet-5-5', inputTokens: 4, cacheReadTokens: 6, costUnknown: true }] }) });
  const [row] = day(db);
  assert.equal(row.cost_usd, 0.25);
  assert.equal(row.unknown_cost_tokens, 10);
  assert.equal(turnRows(db)[0].cost_source, 'claude-code');
});

test('Claude cloud: the turn is the growth of the session totals over its other turns', () => {
  const { db, service } = setup();
  const post = (turnId, inputTokens, nativeSessionId = 'cloud-1') => service.recordCloudSessionTotals({
    conversationId: 'conv-1',
    report: report({ turnId, runId: '', nativeSessionId, sessionTotals: [{ model: 'claude-opus-5-5', inputTokens, cacheWriteTokens: inputTokens * 2, costUsd: inputTokens / 100 }] }),
  });
  post('t1', 100);
  post('t2', 160);
  // A retry of t2 with the same totals stays 60.
  post('t2', 160);
  assert.deepEqual(turnRows(db).map((row) => [row.turn_id, row.input_tokens, row.cache_write_tokens]), [['t1', 100, 200], ['t2', 60, 120]]);
  // Totals below what is booked (a session counted from zero) floor at 0.
  post('t3', 50);
  assert.equal(turnRows(db).find((row) => row.turn_id === 't3').input_tokens, 0);
  // A new cloud session has its own baseline.
  post('t4', 30, 'cloud-2');
  assert.equal(turnRows(db).find((row) => row.turn_id === 't4').input_tokens, 30);
  assert.equal(day(db)[0].input_tokens, 190);
  assert.ok(Math.abs(day(db)[0].cost_usd - 1.9) < 1e-9);
});

test('periods: today, this month and all time across a month boundary in a non-UTC zone', () => {
  // Berlin, 2026-11-01 00:30 local = 2026-10-31 23:30Z.
  const { db, clock, service } = setup({ at: '2026-10-31T21:00:00.000Z', timeZone: 'Europe/Berlin' });
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't-oct', models: [{ model: 'composer-2', inputTokens: 7 }] }) });
  clock.ms = Date.parse('2026-10-31T23:30:00.000Z');
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't-nov', models: [{ model: 'composer-2', inputTokens: 3, cacheWriteTokens: 1 }] }) });
  assert.deepEqual(day(db).map((row) => row.day), ['2026-10-31', '2026-11-01']);
  const periods = service.readPeriods({ provider: 'cursor' });
  assert.equal(periods.today, '2026-11-01');
  const [group] = periods.groups;
  assert.equal(group.periods.today.inputTokens, 3);
  assert.equal(group.periods.month.inputTokens, 3);
  assert.equal(group.periods.allTime.inputTokens, 10);
  assert.equal(group.since, '2026-10-31');
  assert.deepEqual(partlyReportedFields(group.periods.allTime), ['cacheWriteTokens']);
  assert.deepEqual(partlyReportedFields(group.periods.today), []);
  assert.equal(group.periods.allTime.cacheWriteTokens, 1);
  assert.equal(group.periods.allTime.cacheReadTokens, null);
  assert.equal(group.models[0].model, 'composer-2');
  assert.equal(group.models[0].allTime.inputTokens, 10);
});

test('periods: backfilled days are flagged, and the upgrade day sums both sources', () => {
  const { db, service } = setup({ at: '2026-11-02T12:00:00.000Z' });
  db.prepare(`
    INSERT INTO token_usage_days (day, provider, billing, model, source, input_tokens, output_tokens, cache_read_tokens, cost_usd, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES (?, 'claude-api', '', 'claude-sonnet-5-5', 'backfill', ?, 1, 1, 0.1, 1, ?, ?, ?)
  `).run('2026-10-15', 500, '2026-10-15T08:00:00.000Z', '2026-10-15T08:00:00.000Z', 'x');
  db.prepare(`
    INSERT INTO token_usage_days (day, provider, billing, model, source, input_tokens, output_tokens, cache_read_tokens, cost_usd, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES (?, 'claude-api', '', 'claude-sonnet-5-5', 'backfill', ?, 1, 1, 0.1, 1, ?, ?, ?)
  `).run('2026-11-02', 40, '2026-11-02T08:00:00.000Z', '2026-11-02T08:00:00.000Z', 'x');
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude-api', report: report({ models: [{ model: 'claude-sonnet-5-5', inputTokens: 2, outputTokens: 1, cacheWriteTokens: 9, cacheReadTokens: 0 }] }) });
  const [group] = service.readPeriods({ provider: 'claude-api' }).groups;
  assert.equal(group.periods.today.inputTokens, 42);
  assert.equal(group.periods.allTime.inputTokens, 542);
  assert.deepEqual(group.backfilled, { today: true, month: true, allTime: true });
  assert.equal(group.backfillThrough, '2026-11-02');
  assert.equal(group.since, '2026-10-15');
  // The backfill keeps cache writes unknown; the new turn reported them.
  assert.deepEqual(partlyReportedFields(group.periods.today), ['cacheWriteTokens']);
});

test('periods: an own key is its own group, after the plan', () => {
  const { service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'github', billing: 'byok-openai', report: report({ turnId: 't1', models: [{ model: 'gpt-5.5', inputTokens: 9 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'github', report: report({ turnId: 't2', models: [{ model: 'gpt-5.5', inputTokens: 4 }] }) });
  const { groups } = service.readPeriods({ provider: 'github' });
  assert.deepEqual(groups.map((group) => [group.billing, group.periods.allTime.inputTokens]), [['', 4], ['byok-openai', 9]]);
});

test('readTurn and readConversation sum over runs, models and sessions', () => {
  const { service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude', report: report({ turnId: 't1', runId: 'a', nativeSessionId: 's1', models: [{ model: 'claude-opus-5-5', inputTokens: 10, costUsd: 0.5 }, { model: 'claude-haiku-5-5', inputTokens: 2 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude', report: report({ turnId: 't1', runId: 'b', nativeSessionId: 's1', models: [{ model: 'claude-opus-5-5', inputTokens: 1 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'claude', report: report({ turnId: 't2', runId: 'b', nativeSessionId: 's2', models: [{ model: 'claude-opus-5-5', outputTokens: 7 }] }) });
  const turn = service.readTurn('t1');
  assert.equal(turn.rows.length, 3);
  assert.equal(turn.totals.inputTokens, 13);
  assert.equal(turn.totals.outputTokens, null);
  assert.equal(turn.totals.costUsd, 0.5);
  assert.equal(service.readTurn('nope'), null);
  const conversation = service.readConversation('conv-1');
  assert.equal(conversation.totals.inputTokens, 13);
  assert.equal(conversation.totals.outputTokens, 7);
  assert.deepEqual(conversation.sessions.map((session) => [session.nativeSessionId, session.totals.inputTokens]), [['s1', 13], ['s2', null]]);
});

test('forgetConversation drops the turn rows and keeps the day rows', () => {
  const { db, service } = setup();
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ models: [{ model: 'composer-2', inputTokens: 5 }] }) });
  service.recordTurn({ conversationId: 'conv-2', provider: 'cursor', report: report({ conversationId: 'conv-2', turnId: 'other', models: [{ model: 'composer-2', inputTokens: 1 }] }) });
  assert.equal(service.forgetConversation('conv-1'), 1);
  assert.deepEqual(turnRows(db).map((row) => row.conversation_id), ['conv-2']);
  assert.equal(day(db)[0].input_tokens, 6);
  assert.equal(service.readPeriods({ provider: 'cursor' }).groups[0].periods.allTime.inputTokens, 6);
});

test('without the tables every call is a no-op, and they are made once they can be', () => {
  const db = new Database(':memory:');
  const warnings = [];
  const service = createTokenUsageService({ db, logger: { warn: (line) => warnings.push(line) } });
  assert.equal(service.recordTurn({ conversationId: 'c', provider: 'grok', report: report({ models: [{ model: 'grok-5', inputTokens: 1 }] }) }), null);
  assert.equal(service.readPeriods({ provider: 'grok' }), null);
  assert.equal(service.forgetConversation('c'), 0);
  // Three calls, one failure: logged once.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[token-usage\] migration 0036 failed; retrying later: cannot backfill yet/);
  applySchema(db);
  assert.ok(service.recordTurn({ conversationId: 'c', provider: 'grok', report: report({ models: [{ model: 'grok-5', inputTokens: 1 }] }) }));
});

test('the worker\'s at sets the day unless it is more than a day off the relay clock', () => {
  const { db, service } = setup({ at: '2026-11-02T10:00:00.000Z' });
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't1', at: '2026-11-01T23:00:00.000Z', models: [{ model: 'composer-2', inputTokens: 1 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't2', at: '2026-10-20T10:00:00.000Z', models: [{ model: 'composer-2', inputTokens: 2 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'cursor', report: report({ turnId: 't3', at: '2027-01-01T00:00:00.000Z', models: [{ model: 'composer-2', inputTokens: 4 }] }) });
  assert.deepEqual(turnRows(db).map((row) => [row.turn_id, row.day, row.at]), [
    ['t1', '2026-11-01', '2026-11-01T23:00:00.000Z'],
    ['t2', '2026-11-02', '2026-11-02T10:00:00.000Z'],
    ['t3', '2026-11-02', '2026-11-02T10:00:00.000Z'],
  ]);
});

test('Berlin\'s DST days: local midnight on the 23-hour and the 25-hour day', () => {
  // 2026-03-29: clocks go 02:00 → 03:00 (UTC+1 → UTC+2). 2026-10-25: 03:00 → 02:00 (UTC+2 → UTC+1).
  const cases = [
    ['2026-03-28T22:59:00.000Z', '2026-03-28'],
    ['2026-03-28T23:00:00.000Z', '2026-03-29'],
    ['2026-03-29T21:59:00.000Z', '2026-03-29'],
    ['2026-03-29T22:00:00.000Z', '2026-03-30'],
    ['2026-10-24T21:59:00.000Z', '2026-10-24'],
    ['2026-10-24T22:00:00.000Z', '2026-10-25'],
    ['2026-10-25T22:59:00.000Z', '2026-10-25'],
    ['2026-10-25T23:00:00.000Z', '2026-10-26'],
  ];
  for (const [at, expected] of cases) {
    const { db, service } = setup({ at, timeZone: 'Europe/Berlin' });
    service.recordTurn({ conversationId: 'conv-1', provider: 'grok', report: report({ models: [{ model: 'grok-5', inputTokens: 1 }] }) });
    assert.equal(day(db)[0].day, expected, at);
    assert.equal(service.readPeriods({ provider: 'grok' }).today, expected, at);
  }
});

test('year end: the month turns over to January, and all time keeps December', () => {
  // Tokyo (UTC+9): 2026-12-31 23:30 local, then 2027-01-01 00:30 local.
  const { clock, service } = setup({ at: '2026-12-31T14:30:00.000Z', timeZone: 'Asia/Tokyo' });
  service.recordTurn({ conversationId: 'conv-1', provider: 'grok', report: report({ turnId: 't-dec', models: [{ model: 'grok-5', inputTokens: 10 }] }) });
  let [group] = service.readPeriods({ provider: 'grok' }).groups;
  assert.equal(group.periods.month.inputTokens, 10);
  clock.ms = Date.parse('2026-12-31T15:30:00.000Z');
  service.recordTurn({ conversationId: 'conv-1', provider: 'grok', report: report({ turnId: 't-jan', models: [{ model: 'grok-5', inputTokens: 3 }] }) });
  const periods = service.readPeriods({ provider: 'grok' });
  assert.equal(periods.month, '2027-01');
  [group] = periods.groups;
  assert.equal(group.periods.today.inputTokens, 3);
  assert.equal(group.periods.month.inputTokens, 3);
  assert.equal(group.periods.allTime.inputTokens, 13);
});

test('a worker without an attempt id names one per process: a requeued turn after a restart is a second row', () => {
  const { db, service } = setup();
  // The same turn, run by two processes (each with its own randomUUID run id).
  service.recordTurn({ conversationId: 'conv-1', provider: 'github', report: report({ runId: 'proc-1', models: [{ model: 'gpt-5.5', inputTokens: 30 }] }) });
  service.recordTurn({ conversationId: 'conv-1', provider: 'github', report: report({ runId: 'proc-2', models: [{ model: 'gpt-5.5', inputTokens: 20 }] }) });
  assert.equal(turnRows(db).length, 2);
  assert.equal(day(db)[0].input_tokens, 50);
});
