import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  createClaudeApiUsageService,
  normalizeClaudeApiUsageReport,
} from './claude-api-usage-service.mjs';

// The Claude API booking across both Claude billings: spend from a run's own
// rise, a resumed run's first result from the session's mark when the mark
// covers the last finished turn, never twice, never below zero.

const CONV = 'conv-1';
const NATIVE = 'native-1';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5';

function setup({ timeZone = 'UTC' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'Chat', 'a', 'a')`).run(CONV);
  const warnings = [];
  const service = createClaudeApiUsageService({
    db,
    now: () => Date.parse('2026-10-25T12:00:00.000Z'),
    timeZone,
    logger: { log() {}, warn: (line) => warnings.push(line) },
  });
  // A finished turn: the reply that answers queue row `turnId`.
  let replies = 0;
  const reply = (turnId, at) => {
    replies += 1;
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'assistant', 'ok', ?)`).run(`reply-${replies}`, CONV, at);
    db.prepare(`UPDATE messages SET source_message_id = ?, executed_provider = 'claude' WHERE id = ?`).run(turnId, `reply-${replies}`);
  };
  const post = (billing, body) => {
    const parsed = normalizeClaudeApiUsageReport({ claudeNativeSessionId: NATIVE, ...body });
    assert.equal(parsed.ok, true, parsed.error);
    return service.recordReport({ conversationId: CONV, billing, report: parsed.report });
  };
  const totals = () => db.prepare(`SELECT * FROM claude_api_usage_totals ORDER BY day, model`).all();
  const sum = (field, model = null) => totals()
    .filter((row) => !model || row.model === model)
    .reduce((acc, row) => acc + Number(row[field] || 0), 0);
  return { db, service, warnings, reply, post, totals, sum };
}

const entry = (model, miss, output, costUsd = 0, extra = {}) => ({ model, hitTokens: 0, missTokens: miss, outputTokens: output, costUsd, ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('a chat on the key: each result books what its run added; a retried or reordered report books nothing', () => {
  const app = setup();
  app.post('claude-api', {
    runId: 'run-a', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1000, 200, 0.05)], sessionTotals: [entry(SONNET, 1000, 200, 0.05)],
  });
  app.post('claude-api', {
    runId: 'run-a', turnId: 't2', at: '2026-10-25T10:05:00.000Z',
    runCounts: [entry(SONNET, 1500, 300, 0.08)], sessionTotals: [entry(SONNET, 1500, 300, 0.08)],
  });
  // The second report again, then the first one late.
  app.post('claude-api', {
    runId: 'run-a', turnId: 't2', at: '2026-10-25T10:05:00.000Z',
    runCounts: [entry(SONNET, 1500, 300, 0.08)], sessionTotals: [entry(SONNET, 1500, 300, 0.08)],
  });
  app.post('claude-api', {
    runId: 'run-a', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1000, 200, 0.05)], sessionTotals: [entry(SONNET, 1000, 200, 0.05)],
  });
  assert.equal(app.sum('miss_tokens'), 1500);
  assert.equal(app.sum('output_tokens'), 300);
  near(app.sum('cost_usd'), 0.08);
  assert.equal(app.sum('turn_count'), 2);
});

test('subscription turns book nothing; they keep the session\'s mark', () => {
  const app = setup();
  const answer = app.post('claude', {
    runId: 'run-s', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 2000, 400, 0.2)], sessionTotals: [entry(SONNET, 2000, 400, 0.2)],
  });
  assert.deepEqual(answer.booked, []);
  assert.deepEqual(app.totals(), []);
  const mark = app.db.prepare(`SELECT * FROM claude_api_usage_checkpoints`).get();
  assert.equal(mark.billing, 'claude');
  assert.equal(mark.last_turn_id, 't1');
  assert.equal(mark.session_miss_tokens, 2000);
});

test('after a switch: the resumed run\'s first result is booked from the mark, sub-agents included; its second only its own rise (B2a)', () => {
  const app = setup();
  // Two subscription turns.
  app.post('claude', {
    runId: 'run-s', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1200, 250, 0.12)], sessionTotals: [entry(SONNET, 1200, 250, 0.12)],
  });
  app.reply('t1', '2026-10-25T10:00:01.000Z');
  app.post('claude', {
    runId: 'run-s', turnId: 't2', at: '2026-10-25T10:10:00.000Z',
    runCounts: [entry(SONNET, 2000, 400, 0.2)], sessionTotals: [entry(SONNET, 2000, 400, 0.2)],
  });
  app.reply('t2', '2026-10-25T10:10:01.000Z');
  // Switched: the API worker resumes the session. Its first result's own
  // counts are the main loop only; the session totals carry everything.
  const first = app.post('claude-api', {
    runId: 'run-a', turnId: 't3', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 800, 150, 0)],
    sessionTotals: [entry(SONNET, 3000, 600, 0.3), entry(HAIKU, 100, 10, 0.001)],
  });
  assert.equal(first.basis, 'mark');
  app.reply('t3', '2026-10-25T10:20:01.000Z');
  assert.equal(app.sum('miss_tokens', SONNET), 1000);
  assert.equal(app.sum('output_tokens', SONNET), 200);
  near(app.sum('cost_usd', SONNET), 0.1);
  assert.equal(app.sum('miss_tokens', HAIKU), 100);
  near(app.sum('cost_usd', HAIKU), 0.001);
  // The run's second result: its own counts grew by the turn.
  const second = app.post('claude-api', {
    runId: 'run-a', turnId: 't4', at: '2026-10-25T10:30:00.000Z',
    runCounts: [entry(SONNET, 1300, 250, 0.05), entry(HAIKU, 0, 0, 0)],
    sessionTotals: [entry(SONNET, 3500, 700, 0.35), entry(HAIKU, 100, 10, 0.001)],
  });
  assert.equal(second.basis, null);
  // The two API turns, each exactly once.
  assert.equal(app.sum('miss_tokens', SONNET), 1500);
  assert.equal(app.sum('output_tokens', SONNET), 300);
  near(app.sum('cost_usd', SONNET), 0.15);
  assert.equal(app.sum('miss_tokens', HAIKU), 100);
  assert.equal(app.sum('turn_count', SONNET), 2);
  assert.equal(app.warnings.length, 0);
});

test('a mark older than the last finished turn is not used: the turn books its own counts, unpriced, and says so', () => {
  const app = setup();
  app.post('claude', {
    runId: 'run-s', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1200, 250, 0.12)], sessionTotals: [entry(SONNET, 1200, 250, 0.12)],
  });
  app.reply('t1', '2026-10-25T10:00:01.000Z');
  // t2's report was lost (or ran on a relay that did not report).
  app.reply('t2', '2026-10-25T10:10:01.000Z');
  const answer = app.post('claude-api', {
    runId: 'run-a', turnId: 't3', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 800, 150, 0)], sessionTotals: [entry(SONNET, 3000, 600, 0.3)],
  });
  assert.equal(answer.basis, 'stale-mark');
  assert.equal(app.sum('miss_tokens'), 800);
  assert.equal(app.sum('cost_usd'), 0);
  assert.equal(app.sum('unknown_cost_tokens'), 950);
  assert.equal(app.warnings.length, 1);
  assert.match(app.warnings[0], /mark stale/);
});

test('a resumed run with no mark at all books its own counts, unpriced', () => {
  const app = setup();
  const answer = app.post('claude-api', {
    runId: 'run-a', turnId: 't3', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 800, 150, 0)], sessionTotals: [entry(SONNET, 3000, 600, 0.3)],
  });
  assert.equal(answer.basis, 'no-mark');
  assert.equal(app.sum('miss_tokens'), 800);
  assert.match(app.warnings[0], /no mark/);
});

test('totals below the mark (a count from zero after a resume): the run\'s own counts, no negative, no stale log (B2b)', () => {
  const app = setup();
  app.post('claude', {
    runId: 'run-s', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 5000, 900, 0.5)], sessionTotals: [entry(SONNET, 5000, 900, 0.5)],
  });
  app.reply('t1', '2026-10-25T10:00:01.000Z');
  const answer = app.post('claude-api', {
    runId: 'run-a', turnId: 't2', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 700, 120, 0)], sessionTotals: [entry(SONNET, 900, 160, 0.09)],
  });
  assert.equal(answer.basis, 'run');
  for (const row of app.totals()) {
    for (const field of ['hit_tokens', 'miss_tokens', 'output_tokens', 'cost_usd', 'unknown_cost_tokens']) {
      assert.ok(Number(row[field]) >= 0, field);
    }
  }
  assert.equal(app.sum('miss_tokens'), 700);
  assert.equal(app.sum('output_tokens'), 120);
  assert.equal(app.warnings.length, 0);
  // The run's next result books only its own rise.
  app.post('claude-api', {
    runId: 'run-a', turnId: 't3', at: '2026-10-25T10:30:00.000Z',
    runCounts: [entry(SONNET, 1000, 200, 0.03)], sessionTotals: [entry(SONNET, 1200, 240, 0.12)],
  });
  assert.equal(app.sum('miss_tokens'), 1000);
});

test('a late report of an API run, after the subscription reported higher totals, still books its own rise', () => {
  const app = setup();
  app.post('claude-api', {
    runId: 'run-a', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1000, 100, 0.04)], sessionTotals: [entry(SONNET, 1000, 100, 0.04)],
  });
  app.reply('t1', '2026-10-25T10:00:01.000Z');
  // Switched back; the subscription worker resumes and reports.
  app.post('claude', {
    runId: 'run-s', turnId: 't3', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 500, 50, 0)], sessionTotals: [entry(SONNET, 2500, 250, 0.1)],
  });
  // The API run's report for t2 arrives only now.
  app.post('claude-api', {
    runId: 'run-a', turnId: 't2', at: '2026-10-25T10:10:00.000Z',
    runCounts: [entry(SONNET, 2000, 200, 0.06)], sessionTotals: [entry(SONNET, 2000, 200, 0.06)],
  });
  assert.equal(app.sum('miss_tokens'), 2000);
  near(app.sum('cost_usd'), 0.06);
});

test('a model without a price is booked as tokens; a [1m] id under its base', () => {
  const app = setup();
  app.post('claude-api', {
    runId: 'run-a', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry('claude-new-model', 400, 40, 0, { costUnknown: true }), entry(`${SONNET}[1m]`, 100, 10, 0.01)],
    sessionTotals: [entry('claude-new-model', 400, 40, 0, { costUnknown: true }), entry(`${SONNET}[1m]`, 100, 10, 0.01)],
  });
  const rows = Object.fromEntries(app.totals().map((row) => [row.model, row]));
  assert.equal(rows['claude-new-model'].cost_usd, 0);
  assert.equal(rows['claude-new-model'].unknown_cost_tokens, 440);
  assert.equal(rows[SONNET].miss_tokens, 100);
  near(rows[SONNET].cost_usd, 0.01);
});

test('the day is the relay\'s local date: a turn just after local midnight on the 1st is the new month\'s', () => {
  const app = setup({ timeZone: 'Europe/Berlin' });
  app.post('claude-api', {
    runId: 'run-a', turnId: 't1', at: '2026-10-31T22:59:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 100, 10, 0.01)], sessionTotals: [entry(SONNET, 100, 10, 0.01)],
  });
  app.post('claude-api', {
    runId: 'run-a', turnId: 't2', at: '2026-10-31T23:01:00.000Z',
    runCounts: [entry(SONNET, 300, 30, 0.03)], sessionTotals: [entry(SONNET, 300, 30, 0.03)],
  });
  assert.deepEqual(app.totals().map((row) => [row.day, row.miss_tokens]), [['2026-10-31', 100], ['2026-11-01', 200]]);
  assert.equal(app.service.localDay('2026-10-31T23:01:00.000Z'), '2026-11-01');
  assert.deepEqual(app.service.readDaysBetween('2026-11-01', '2026-11-30').map((row) => row.day), ['2026-11-01']);
});

test('a report is checked before it is booked', () => {
  assert.equal(normalizeClaudeApiUsageReport({}).ok, false);
  assert.match(normalizeClaudeApiUsageReport({ claudeNativeSessionId: 'n' }).error, /runId/);
  assert.match(normalizeClaudeApiUsageReport({ claudeNativeSessionId: 'n', runId: 'r', at: 'later' }).error, /at/);
  assert.match(normalizeClaudeApiUsageReport({ claudeNativeSessionId: 'n', runId: 'r', at: '2026-10-25T10:00:00Z' }).error, /runCounts/);
  const app = setup();
  assert.equal(app.service.recordReport({ conversationId: CONV, billing: 'deepseek', report: {} }), null);
});

test('old run checkpoints are pruned, each session\'s mark is kept', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const old = '2026-07-01T00:00:00.000Z';
  const insert = db.prepare(`
    INSERT INTO claude_api_usage_checkpoints (conversation_id, native_session_id, run_id, model, billing, last_turn_at, updated_at)
    VALUES (?, ?, ?, ?, 'claude', ?, ?)
  `);
  insert.run(CONV, NATIVE, 'run-old', SONNET, '2026-07-01T00:00:00.000Z', old);
  insert.run(CONV, NATIVE, 'run-mark', SONNET, '2026-07-02T00:00:00.000Z', old);
  const service = createClaudeApiUsageService({ db, now: () => Date.parse('2026-10-25T12:00:00.000Z'), timeZone: 'UTC', logger: { log() {}, warn() {} } });
  service.recordReport({
    conversationId: CONV,
    billing: 'claude-api',
    report: normalizeClaudeApiUsageReport({
      claudeNativeSessionId: 'native-other', runId: 'run-x', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
      runCounts: [entry(SONNET, 1, 1, 0)], sessionTotals: [entry(SONNET, 1, 1, 0)],
    }).report,
  });
  const runs = db.prepare(`SELECT run_id FROM claude_api_usage_checkpoints WHERE native_session_id = ? ORDER BY run_id`).all(NATIVE).map((row) => row.run_id);
  assert.deepEqual(runs, ['run-mark']);
});

test('a turn that left no reply still covers the mark: the next resume books from it', () => {
  const app = setup();
  app.post('claude', {
    runId: 'run-s', turnId: 't1', at: '2026-10-25T10:00:00.000Z', firstResultOfRun: true,
    runCounts: [entry(SONNET, 1200, 250, 0.12)], sessionTotals: [entry(SONNET, 1200, 250, 0.12)],
  });
  app.reply('t1', '2026-10-25T10:00:01.000Z');
  // t2 was stopped: its report came, its reply never did.
  app.post('claude', {
    runId: 'run-s', turnId: 't2', at: '2026-10-25T10:10:00.000Z',
    runCounts: [entry(SONNET, 2000, 400, 0.2)], sessionTotals: [entry(SONNET, 2000, 400, 0.2)],
  });
  const answer = app.post('claude-api', {
    runId: 'run-a', turnId: 't3', at: '2026-10-25T10:20:00.000Z', firstResultOfRun: true, resumedSessionId: NATIVE,
    runCounts: [entry(SONNET, 800, 150, 0)], sessionTotals: [entry(SONNET, 3000, 600, 0.3)],
  });
  assert.equal(answer.basis, 'mark');
  assert.equal(app.sum('miss_tokens'), 1000);
  near(app.sum('cost_usd'), 0.1);
  assert.equal(app.warnings.length, 0);
});
