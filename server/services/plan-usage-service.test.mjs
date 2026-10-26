import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createPlanUsageService } from './plan-usage-service.mjs';
import { deepseekStartingBalanceState } from './plan-usage-deepseek.mjs';

function makeService({ nowIso = '2026-08-08T12:00:00.000Z' } = {}) {
  const db = new Database(':memory:');
  const clock = { value: new Date(nowIso) };
  const service = createPlanUsageService({ db, now: () => clock.value });
  return { db, service, clock };
}

const copilotSummary = {
  plan: 'copilot_pro',
  resetDate: '2026-09-01',
  chat: { unlimited: true },
  premiumInteractions: { remaining: 400, entitlement: 1500 },
  planQuota: { remaining: 90, entitlement: 100 },
};

test('the service creates its own schema and round-trips a snapshot', () => {
  const { service } = makeService();
  service.saveSnapshot('claude', { subscriptionType: 'max', windows: [] }, { source: 'worker' });
  const stored = service.readSnapshot('claude');
  assert.equal(stored.payload.subscriptionType, 'max');
  assert.equal(stored.source, 'worker');
  assert.equal(stored.capturedAt, '2026-08-08T12:00:00.000Z');
});

test('a corrupt snapshot blob degrades to null instead of throwing', () => {
  const { db, service } = makeService();
  db.prepare(`INSERT INTO provider_usage_snapshots (provider, payload_json, captured_at) VALUES (?, ?, ?)`)
    .run('claude', '{not json', '2026-08-08T00:00:00.000Z');
  assert.equal(service.readSnapshot('claude').payload, null);
});

test('only the latest snapshot is retained per provider', () => {
  const { db, service } = makeService();
  service.saveSnapshot('claude', { subscriptionType: 'pro' });
  service.saveSnapshot('claude', { subscriptionType: 'max' });
  const rows = db.prepare(`SELECT COUNT(*) AS count FROM provider_usage_snapshots`).get();
  assert.equal(rows.count, 1);
  assert.equal(service.readSnapshot('claude').payload.subscriptionType, 'max');
});

test('cursor reports accumulate into the cycle under the model’s pool', () => {
  const { service } = makeService();
  service.recordCursorUsageReport(
    { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 300, chargedCents: 0, totalTokens: 1000 },
    { resetDay: 1 },
  );
  service.recordCursorUsageReport(
    { agentId: 'a1', agentCreated: true, model: 'claude-opus-5', rawCostCents: 800, chargedCents: 100, totalTokens: 2500 },
    { resetDay: 1 },
  );
  const { totals, cycle } = service.readCursorCycleTotals({ resetDay: 1 });
  assert.equal(cycle.key, '2026-08-01');
  assert.equal(totals.cursor.rawCostCents, 300);
  assert.equal(totals.other.rawCostCents, 500);
  assert.equal(totals.other.chargedCents, 100);
});

test('a repeated identical report adds nothing', () => {
  const { service } = makeService();
  const report = { agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 300 };
  service.recordCursorUsageReport(report, { resetDay: 1 });
  const second = service.recordCursorUsageReport(report, { resetDay: 1 });
  assert.equal(second.changed, false);
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 300);
});

test('spend books into the cycle that is current when it is observed', () => {
  const { service, clock } = makeService();
  service.recordCursorUsageReport({ agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 100 }, { resetDay: 1 });
  clock.value = new Date('2026-09-05T00:00:00.000Z');
  service.recordCursorUsageReport({ agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 250 }, { resetDay: 1 });

  clock.value = new Date('2026-08-20T00:00:00.000Z');
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 100);
  clock.value = new Date('2026-09-20T00:00:00.000Z');
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 150);
});

test('separate agents accumulate independently', () => {
  const { service } = makeService();
  service.recordCursorUsageReport({ agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 100 }, { resetDay: 1 });
  service.recordCursorUsageReport({ agentId: 'a2', agentCreated: true, model: 'composer-2.5', rawCostCents: 400 }, { resetDay: 1 });
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 500);
});

test('resetting accounting clears the cycle and re-baselines future reports', () => {
  const { service } = makeService();
  service.recordCursorUsageReport({ agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 900 }, { resetDay: 1 });
  service.resetCursorAccounting({ resetDay: 1 });
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 0);

  // The agent's lifetime total is unchanged, so a fresh baseline must not
  // retroactively re-book the spend that was just cleared.
  service.recordCursorUsageReport({ agentId: 'a1', agentCreated: true, model: 'composer-2.5', rawCostCents: 950 }, { resetDay: 1 });
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 950);
});

test('buildReport returns one card per provider and never throws on partial data', () => {
  const { service } = makeService();
  const report = service.buildReport({ copilotSummary, claudeConfigured: true, cursorConfigured: true });
  assert.equal(report.version, 2);
  assert.deepEqual(report.providers.map((card) => card.provider), ['github', 'claude', 'cursor']);
  assert.equal(report.providers[0].status, 'ok');
  assert.equal(report.providers[1].status, 'unavailable');
});

test('buildReport marks a stored Claude reading as stale rather than live', () => {
  const { service } = makeService();
  service.saveSnapshot('claude', {
    subscriptionType: 'max',
    rateLimitsAvailable: true,
    windows: [{ id: 'five_hour', label: 'Current session (5 h)', emphasis: 'primary', utilization: 20, resetsAt: null }],
  });
  const claude = service.buildReport({ copilotSummary }).providers.find((card) => card.provider === 'claude');
  assert.equal(claude.stale, true);
  assert.equal(claude.source, 'cache');
  assert.equal(claude.meters.length, 1);
});

test('a Copilot failure still yields cards for the other providers', () => {
  const { service } = makeService();
  const report = service.buildReport({ copilotSummary: null, copilotError: 'no token' });
  assert.equal(report.providers[0].status, 'error');
  assert.equal(report.providers.length, 3);
});

test('disabled providers report as not configured', () => {
  const { service } = makeService();
  const report = service.buildReport({
    copilotSummary,
    claudeConfigured: false,
    cursorConfigured: false,
  });
  assert.equal(report.providers[1].status, 'not-configured');
  assert.equal(report.providers[2].status, 'not-configured');
});

// ─── Claude Cloud ────────────────────────────────────────────────────────────

const claudeAccount = {
  usage: {
    five_hour: { utilization: 9, resets_at: '2026-08-08T16:00:00Z', limit_dollars: null, used_dollars: null, remaining_dollars: null },
    seven_day: { utilization: 51, resets_at: '2026-08-12T09:00:00Z', limit_dollars: null, used_dollars: null, remaining_dollars: null },
    iguana_necktie: { utilization: 10, resets_at: '2026-09-10T08:00:00Z', limit_dollars: 60, used_dollars: 6, remaining_dollars: 54 },
    limits: [],
  },
  prepaid: null,
  offer: null,
  fetchedAt: '2026-08-08T11:59:40.000Z',
  error: null,
};

/** The two columns of the relay's runtime session table that the cloud spend reads. */
function addRuntimeSessions(db, rows) {
  db.exec(`
    CREATE TABLE runtime_sessions (
      conversation_id       TEXT NOT NULL UNIQUE,
      provider_type         TEXT NOT NULL DEFAULT 'github',
      claude_cloud_cost_usd REAL
    )
  `);
  const insert = db.prepare(`INSERT INTO runtime_sessions (conversation_id, provider_type, claude_cloud_cost_usd) VALUES (?, ?, ?)`);
  for (const row of rows) insert.run(...row);
}

test('the Claude Cloud card is absent while the provider is off, whatever was read', () => {
  const { service } = makeService();
  service.saveSnapshot('claude-cloud', { session: { totalCostUsd: 0.2, modelUsage: [] } });
  const report = service.buildReport({ copilotSummary, claudeAccount, claudeCloudConfigured: false });
  assert.deepEqual(report.providers.map((card) => card.provider), ['github', 'claude', 'cursor']);
});

test('the Claude Cloud card comes right after Claude and before the other providers', () => {
  const { service } = makeService();
  const report = service.buildReport({
    copilotSummary,
    claudeAccount,
    claudeCloudConfigured: true,
    grokConfigured: true,
  });
  assert.deepEqual(report.providers.map((card) => card.provider), ['github', 'claude', 'claude-cloud', 'cursor', 'grok']);
  const cloud = report.providers[2];
  assert.equal(cloud.label, 'Claude Cloud');
  assert.equal(cloud.status, 'ok');
  assert.deepEqual(cloud.meters.map((meter) => [meter.id, meter.used, meter.allowance, meter.resetKind]), [
    ['claude-cloud-credit-iguana_necktie', 6, 60, 'expiry'],
  ]);
});

test('live account usage makes the Claude card live instead of a stale snapshot', () => {
  const { service } = makeService();
  service.saveSnapshot('claude', {
    subscriptionType: 'max',
    rateLimitsAvailable: true,
    windows: [{ id: 'five_hour', label: 'Current session (5 h)', emphasis: 'primary', utilization: 80, resetsAt: null }],
    session: { totalCostUsd: 0.4, modelUsage: [] },
  });
  const claude = service.buildReport({ copilotSummary, claudeAccount }).providers.find((card) => card.provider === 'claude');
  assert.equal(claude.stale, false);
  assert.equal(claude.source, 'live');
  assert.equal(claude.capturedAt, '2026-08-08T11:59:40.000Z');
  assert.deepEqual(claude.meters.map((meter) => [meter.id, meter.utilization]), [['claude-five_hour', 9], ['claude-seven_day', 51]]);
  assert.ok(claude.details.some((section) => section.id === 'claude-session'));
});

test('the cloud spend sums the cost of the cloud conversations and counts them', () => {
  const { db, service } = makeService();
  addRuntimeSessions(db, [
    ['conv-cloud-1', 'claude-cloud', 0.18],
    ['conv-cloud-2', 'claude-cloud', 0.07],
    ['conv-cloud-3', 'Claude-Cloud', null],
    ['conv-local-1', 'claude', 9.5],
    ['conv-local-2', 'github', null],
  ]);
  const everywhere = service.readClaudeCloudSpend();
  assert.equal(everywhere.conversationCount, 3);
  assert.ok(Math.abs(everywhere.totalUsd - 0.25) < 1e-9);
  assert.equal(everywhere.conversation, null);

  assert.deepEqual(service.readClaudeCloudSpend({ conversationId: 'conv-cloud-1' }).conversation, { costUsd: 0.18 });
  assert.deepEqual(service.readClaudeCloudSpend({ conversationId: 'conv-cloud-3' }).conversation, { costUsd: null });
  // Another provider's conversation, or one that does not exist, has no cloud cost.
  assert.equal(service.readClaudeCloudSpend({ conversationId: 'conv-local-1' }).conversation, null);
  assert.equal(service.readClaudeCloudSpend({ conversationId: 'conv-missing' }).conversation, null);
});

test('the report carries the spend and the cost of the conversation the modal was opened from', () => {
  const { db, service } = makeService();
  addRuntimeSessions(db, [
    ['conv-cloud-1', 'claude-cloud', 0.18],
    ['conv-cloud-2', 'claude-cloud', 0.07],
  ]);
  service.saveSnapshot('claude-cloud', { session: { totalCostUsd: 0.07, modelUsage: [] } });
  const cloud = service.buildReport({
    copilotSummary,
    claudeAccount,
    claudeCloudConfigured: true,
    conversationId: 'conv-cloud-1',
  }).providers.find((card) => card.provider === 'claude-cloud');
  assert.deepEqual(cloud.meters.map((meter) => meter.id), ['claude-cloud-credit-iguana_necktie', 'claude-cloud-spend']);
  assert.equal(cloud.meters[1].used, 0.25);
  assert.deepEqual(cloud.details.map((section) => section.id), ['claude-cloud-spend', 'claude-cloud-session']);
  assert.deepEqual(cloud.details[0].rows, [
    { label: 'All cloud conversations', value: '$0.25', hint: '2 cloud conversations' },
    { label: 'This conversation', value: '$0.18', hint: null },
  ]);
});

test('a database without the cloud columns has no spend and still builds the card', () => {
  const { db, service } = makeService();
  assert.equal(service.readClaudeCloudSpend({ conversationId: 'conv-cloud-1' }), null);
  db.exec(`CREATE TABLE runtime_sessions (conversation_id TEXT, provider_type TEXT)`);
  assert.equal(service.readClaudeCloudSpend(), null);
  const cloud = service.buildReport({ copilotSummary, claudeAccount: null, claudeCloudConfigured: true })
    .providers.find((card) => card.provider === 'claude-cloud');
  assert.equal(cloud.status, 'unavailable');
  assert.equal(cloud.meters.length, 0);
});

test('the cloud snapshot never reaches the Claude card', () => {
  const { service } = makeService();
  service.saveSnapshot('claude-cloud', { session: { totalCostUsd: 0.2, modelUsage: [] } });
  const report = service.buildReport({ copilotSummary, claudeCloudConfigured: true });
  assert.equal(report.providers.find((card) => card.provider === 'claude').status, 'unavailable');
  const cloud = report.providers.find((card) => card.provider === 'claude-cloud');
  assert.deepEqual(cloud.details.map((section) => section.id), ['claude-cloud-session']);
  assert.equal(cloud.status, 'partial');
  assert.equal(cloud.capturedAt, '2026-08-08T12:00:00.000Z');
});

// ─── DeepSeek ────────────────────────────────────────────────────────────────

// A Saturday: off-peak all day.
const DS_AT = '2026-10-24T12:00:00.000Z';

function dsReport(nativeSessionId, totals, { conversationId = 'conv-ds', at = DS_AT, runId = '', requests } = {}) {
  return { conversationId, nativeSessionId, at, totals, ...(runId ? { runId } : {}), ...(requests ? { requests } : {}) };
}

function flash(hitTokens, missTokens, outputTokens) {
  return { model: 'deepseek-flash', hitTokens, missTokens, outputTokens };
}

const dsTokens = (service) => service.readDeepSeekUsageTotals().models
  .map((entry) => [entry.model, entry.hitTokens, entry.missTokens, entry.outputTokens, entry.turnCount])
  .sort();

test('a CLI resumed on its session starts from the earlier totals, and nothing is booked twice', () => {
  const { service } = makeService();
  // Per turn: T1 and T2 in process A; the effort change resumes the session
  // in process B, which reports the restored totals plus T3, then T4 on pro.
  const t1 = flash(37_248, 18_973, 341);
  const a = flash(37_248 + 18_944, 18_973 + 137, 341 + 13);
  const aT3 = flash(a.hitTokens, a.missTokens + 19_122, a.outputTokens + 3);
  const t4 = { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 19_365, outputTokens: 19 };

  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [t1])).models.map((entry) => entry.missTokens), [18_973]);
  service.recordDeepSeekUsageReport(dsReport('native-1', [a]));
  const third = service.recordDeepSeekUsageReport(dsReport('native-1', [aT3]));
  assert.deepEqual(third.models.map(({ model, hitTokens, missTokens, outputTokens }) => ({ model, hitTokens, missTokens, outputTokens })), [
    { model: 'deepseek-flash', hitTokens: 0, missTokens: 19_122, outputTokens: 3 },
  ]);
  service.recordDeepSeekUsageReport(dsReport('native-1', [aT3, t4]));

  assert.deepEqual(dsTokens(service), [
    ['deepseek-flash', 56_192, 38_232, 357, 3],
    ['deepseek-v4-pro', 0, 19_365, 19, 1],
  ]);
  const byModel = Object.fromEntries(service.readDeepSeekUsageTotals().models.map((entry) => [entry.model, entry]));
  // Off-peak: flash $0.003/$0.15/$0.60 and ¥0.02/¥1/¥4, pro $0.022/$0.66/$1.98 and ¥0.15/¥4.5/¥13.5 per 1M.
  assert.equal(byModel['deepseek-flash'].costUsd, 0.006117576);
  assert.equal(byModel['deepseek-flash'].costCny, 0.04078384);
  assert.equal(byModel['deepseek-v4-pro'].costUsd, 0.01281852);
  assert.equal(byModel['deepseek-v4-pro'].costCny, 0.087399);
});

test('a restarted worker repeating the same totals books nothing', () => {
  const { service } = makeService();
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)]));
  const again = service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)]));
  assert.deepEqual(again.models, []);
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 1000, 2000, 300, 1]]);
});

test('a new session id, or another conversation, books from zero', () => {
  const { service } = makeService();
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)]));
  service.recordDeepSeekUsageReport(dsReport('native-2', [flash(10, 20, 3)]));
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(5, 5, 5)], { conversationId: 'conv-other' }));
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 1015, 2025, 308, 3]]);
});

test('a total below its checkpoint is a CLI that started over: the report is booked in full', () => {
  const { service } = makeService();
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(5000, 1000, 500)]));
  // A fresh process on the same session id, counting from zero again: its
  // totals are new spend, not a correction of the earlier ones.
  const fresh = service.recordDeepSeekUsageReport(dsReport('native-1', [flash(7000, 400, 100)]));
  assert.deepEqual(fresh.models.map(({ hitTokens, missTokens, outputTokens }) => [hitTokens, missTokens, outputTokens]), [[7000, 400, 100]]);
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 12_000, 1400, 600, 2]]);
  // From there the checkpoint is the fresh run's totals: a normal rise books
  // the increase, the same totals again book nothing.
  const rise = service.recordDeepSeekUsageReport(dsReport('native-1', [flash(7000, 1200, 550)]));
  assert.deepEqual(rise.models.map(({ hitTokens, missTokens, outputTokens }) => [hitTokens, missTokens, outputTokens]), [[0, 800, 450]]);
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(7000, 1200, 550)])).models, []);
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 12_000, 2200, 1050, 3]]);
  // One model starting over does not touch another's checkpoint.
  const pro = { model: 'deepseek-v4-pro', hitTokens: 10, missTokens: 20, outputTokens: 30 };
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(7000, 1200, 550), pro]));
  const both = service.recordDeepSeekUsageReport(dsReport('native-1', [flash(100, 100, 100), { ...pro, outputTokens: 31 }]));
  assert.deepEqual(both.models.map(({ model, hitTokens, missTokens, outputTokens }) => [model, hitTokens, missTokens, outputTokens]), [
    ['deepseek-flash', 100, 100, 100],
    ['deepseek-v4-pro', 0, 0, 1],
  ]);
});

test('under one run id a total below the checkpoint is a stale report: nothing booked, the high-water mark kept', () => {
  const { service } = makeService();
  const run = { runId: 'run-a' };
  const booked = (result) => result.models.map(({ hitTokens, missTokens, outputTokens }) => [hitTokens, missTokens, outputTokens]);
  // Reports after turns 1, 2 and 3 of one process; the second reaches the
  // relay last (a retried post).
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)], run));
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 5000, 700)], run))), [[0, 3000, 400]]);
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 3500, 500)], run)).models, []);
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 1000, 5000, 700, 2]]);
  // A duplicate of the latest report books nothing either.
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 5000, 700)], run)).models, []);
  // The checkpoint stayed at the high-water mark: the next turn books only
  // what it adds to the third report.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 5100, 710)], run))), [[0, 100, 10]]);
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 1000, 5100, 710, 3]]);
});

test('a new run id on the session is a process counting from zero: its totals are booked in full, above or below the checkpoint', () => {
  const { service } = makeService();
  const booked = (result) => result.models.map(({ hitTokens, missTokens, outputTokens }) => [hitTokens, missTokens, outputTokens]);
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)], { runId: 'run-a' }));
  // An effort change respawns the CLI with --resume. The worker reports the
  // new process's own totals, from zero: a first turn above the checkpoint in
  // every field (a respawn whose first turn was big) is no increase of the
  // earlier process's totals but all new spend.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1200, 2600, 350)], { runId: 'run-b' }))), [[1200, 2600, 350]]);
  // The next turn of that process adds its increase.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1200, 2700, 360)], { runId: 'run-b' }))), [[0, 100, 10]]);
  // A process after a hard kill (the CLI restored an older snapshot) reports
  // from zero as well: its first turn, below the checkpoint, is booked in
  // full, and nothing of the restored history with it.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 40, 4)], { runId: 'run-c' }))), [[0, 40, 4]]);
  assert.deepEqual(dsTokens(service), [['deepseek-flash', 2200, 4740, 664, 4]]);
  // A late report of an earlier process after a later one started is booked
  // in full too: the relay cannot tell it from a process counting from zero.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2100, 310)], { runId: 'run-a' }))), [[1000, 2100, 310]]);
  // A report without a run id (an older worker) below the checkpoint is a
  // CLI counting from zero, booked in full, as before.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(10, 10, 10)]))), [[10, 10, 10]]);
  // And the run id of the checkpoint is then none: the next report under a
  // run id is a new process, booked in full as well.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(5, 5, 5)], { runId: 'run-d' }))), [[5, 5, 5]]);
});

test('a requests-only entry under a new run id leaves the token checkpoint and its run id alone', () => {
  const { service } = makeService();
  const booked = (result) => result.models.map(({ hitTokens, missTokens, outputTokens, searchRequests }) => [hitTokens, missTokens, outputTokens, searchRequests]);
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)], { runId: 'run-a', requests: [{ model: 'deepseek-flash', searchRequests: 1, fetchRequests: 0 }] }));
  // A new process posts counts for flash with no token entry of its own (a
  // sub-agent's model that searched before flash spent a token).
  const countsOnly = service.recordDeepSeekUsageReport(dsReport('native-1', [], { runId: 'run-b', requests: [{ model: 'deepseek-flash', searchRequests: 2, fetchRequests: 0 }] }));
  assert.deepEqual(booked(countsOnly), [[0, 0, 0, 2]]);
  // Process A's late token report, below nothing and under its own run id,
  // is a stale one of the same run: nothing booked, the checkpoint kept.
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 1900, 290)], { runId: 'run-a' })).models, []);
  // Process A's next turn under its run id adds its increase, and process
  // B's counts run on under theirs.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2100, 310)], { runId: 'run-a' }))), [[0, 100, 10, 0]]);
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [], { runId: 'run-b', requests: [{ model: 'deepseek-flash', searchRequests: 3, fetchRequests: 0 }] }))), [[0, 0, 0, 1]]);
  // A token report of process B then starts the token checkpoint over, in
  // full, and leaves B's counts where they are.
  assert.deepEqual(booked(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 50, 5)], { runId: 'run-b', requests: [{ model: 'deepseek-flash', searchRequests: 3, fetchRequests: 0 }] }))), [[0, 50, 5, 0]]);
  const [row] = service.readDeepSeekUsageTotals().models;
  assert.deepEqual([row.hitTokens, row.missTokens, row.outputTokens, row.searchRequests, row.turnCount], [1000, 2150, 315, 4, 5]);
});

test('with a run id the searches and fetches are the process\'s running counts: a repeated post adds nothing', () => {
  const { service } = makeService();
  const counts = (service) => service.readDeepSeekUsageTotals().models.map((entry) => [entry.model, entry.searchRequests, entry.fetchRequests, entry.turnCount]).sort();
  const run = { runId: 'run-a' };
  const search = (searchRequests, fetchRequests) => [{ model: 'deepseek-flash', searchRequests, fetchRequests }];
  // Turn 1 searched twice and fetched once; the post is retried with the
  // same body.
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(100, 100, 10)], { ...run, requests: search(2, 1) }));
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(100, 100, 10)], { ...run, requests: search(2, 1) })).models, []);
  assert.deepEqual(counts(service), [['deepseek-flash', 2, 1, 1]]);
  // Turn 2 searched once more: the running counts rise to 3 and 1, and the
  // report books one search.
  const second = service.recordDeepSeekUsageReport(dsReport('native-1', [flash(100, 200, 20)], { ...run, requests: search(3, 1) }));
  assert.deepEqual(second.models.map(({ searchRequests, fetchRequests }) => [searchRequests, fetchRequests]), [[1, 0]]);
  // A stale report (turn 1's again) books nothing, not even its tokens.
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(100, 100, 10)], { ...run, requests: search(2, 1) })).models, []);
  // Turn 3 on another model, requests only: a model's counts start from
  // zero within the run.
  const pro = service.recordDeepSeekUsageReport(dsReport('native-1', [], { ...run, requests: [{ model: 'deepseek-v4-pro', searchRequests: 1, fetchRequests: 0 }] }));
  assert.deepEqual(pro.models.map(({ model, searchRequests }) => [model, searchRequests]), [['deepseek-v4-pro', 1]]);
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [], { ...run, requests: [{ model: 'deepseek-v4-pro', searchRequests: 1, fetchRequests: 0 }] })).models, []);
  assert.deepEqual(counts(service), [['deepseek-flash', 3, 1, 2], ['deepseek-v4-pro', 1, 0, 1]]);
  // A new process counts from zero: its first report's counts are booked in
  // full, and so are its own token totals.
  const respawned = service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 50, 5)], { runId: 'run-b', requests: search(1, 1) }));
  assert.deepEqual(respawned.models.map(({ missTokens, searchRequests, fetchRequests }) => [missTokens, searchRequests, fetchRequests]), [[50, 1, 1]]);
  assert.deepEqual(counts(service), [['deepseek-flash', 4, 2, 3], ['deepseek-v4-pro', 1, 0, 1]]);
  // An older worker's report has no run id: its counts are the turn's, booked
  // as they come, twice when posted twice.
  service.recordDeepSeekUsageReport(dsReport('native-2', [], { requests: search(1, 0) }));
  service.recordDeepSeekUsageReport(dsReport('native-2', [], { requests: search(1, 0) }));
  assert.deepEqual(counts(service), [['deepseek-flash', 6, 2, 5], ['deepseek-v4-pro', 1, 0, 1]]);
});

test('a report naming a Claude model books it under the DeepSeek model that served it, with its price', () => {
  const { service } = makeService();
  // An older worker reports a sub-agent asked for as "opus" under the Claude
  // id DeepSeek served with V4 Pro, and one asked for as "sonnet" under the
  // id it served with Flash, next to the session's own flash totals.
  const first = service.recordDeepSeekUsageReport(dsReport('native-1', [
    flash(1000, 2000, 300),
    { model: 'claude-sonnet-5-5', hitTokens: 0, missTokens: 500, outputTokens: 50 },
    { model: 'claude-opus-5-5', hitTokens: 0, missTokens: 1_000_000, outputTokens: 100_000 },
  ]));
  assert.deepEqual(first.models.map(({ model, hitTokens, missTokens, outputTokens, costUsd, costCny }) => [model, hitTokens, missTokens, outputTokens, costUsd, costCny]), [
    ['deepseek-flash', 1000, 2500, 350, 0.000588, 0.00392],
    // Off-peak pro: 1M misses at $0.66 / ¥4.5 and 100K output at $1.98 / ¥13.5.
    ['deepseek-v4-pro', 0, 1_000_000, 100_000, 0.858, 5.85],
  ]);
  assert.deepEqual(dsTokens(service), [
    ['deepseek-flash', 1000, 2500, 350, 1],
    ['deepseek-v4-pro', 0, 1_000_000, 100_000, 1],
  ]);
  // The checkpoint is kept under the served model: the next report of the
  // session, under either name, books only the increase.
  const next = service.recordDeepSeekUsageReport(dsReport('native-1', [
    flash(1000, 2000, 300),
    { model: 'claude-sonnet-5-5', hitTokens: 0, missTokens: 500, outputTokens: 50 },
    { model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 1_000_000, outputTokens: 100_010 },
  ]));
  assert.deepEqual(next.models.map(({ model, hitTokens, missTokens, outputTokens }) => [model, hitTokens, missTokens, outputTokens]), [
    ['deepseek-v4-pro', 0, 0, 10],
  ]);
  const requests = service.recordDeepSeekUsageReport({
    ...dsReport('native-1', []),
    requests: [{ model: 'claude-opus-5-5', searchRequests: 2, fetchRequests: 1 }, { model: 'deepseek-v4-pro', searchRequests: 1, fetchRequests: 0 }],
  });
  assert.deepEqual(requests.models.map(({ model, searchRequests, fetchRequests }) => [model, searchRequests, fetchRequests]), [['deepseek-v4-pro', 3, 1]]);
  assert.deepEqual(service.readDeepSeekUsageTotals().models.map((entry) => entry.model).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
});

test('rows booked under a Claude name before the mapping are folded into the served model when the service opens the database', () => {
  const db = new Database(':memory:');
  const early = createPlanUsageService({ db, now: () => new Date('2026-10-24T23:30:00.000Z') });
  early.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)], { at: '2026-10-24T23:23:00.000Z' }));
  // What an older relay left behind: a V4 Pro sub-agent under its Claude name.
  db.prepare(`
    INSERT INTO deepseek_usage_totals (model, hit_tokens, miss_tokens, output_tokens, turn_count, first_seen_at, last_seen_at, updated_at)
    VALUES ('claude-opus-5-5', 0, 1000000, 0, 1, '2026-10-24T23:23:00.000Z', '2026-10-24T23:23:00.000Z', '2026-10-24T23:23:00.000Z')
  `).run();
  const service = createPlanUsageService({ db, now: () => new Date('2026-10-25T00:00:00.000Z') });
  const byModel = Object.fromEntries(service.readDeepSeekUsageTotals().models.map((entry) => [entry.model, entry]));
  assert.deepEqual(Object.keys(byModel).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual([byModel['deepseek-v4-pro'].missTokens, byModel['deepseek-v4-pro'].costUsd, byModel['deepseek-v4-pro'].costCny], [1_000_000, 0.66, 4.5]);
});

test('an unknown model is counted without a price; the report is checked', () => {
  const { service } = makeService();
  // Wednesday 03:59 UTC is peak, 04:00 is not.
  service.recordDeepSeekUsageReport(dsReport('native-1', [{ model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 1_000_000, outputTokens: 0 }], { at: '2026-08-05T03:59:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-1', [{ model: 'deepseek-v4-pro', hitTokens: 0, missTokens: 2_000_000, outputTokens: 0 }], { at: '2026-08-05T04:00:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-1', [{ model: 'deepseek-v5', hitTokens: 10, missTokens: 10, outputTokens: 10 }], { at: '2026-08-05T05:00:00.000Z' }));
  const totals = service.readDeepSeekUsageTotals().models;
  assert.deepEqual(totals.map((entry) => [entry.model, entry.turnCount, entry.costUsd, entry.costCny]), [
    ['deepseek-v5', 1, null, null],
    ['deepseek-v4-pro', 2, 1.98, 13.5],
  ]);
  assert.equal(totals[1].firstSeenAt, '2026-08-05T03:59:00.000Z');
  assert.equal(totals[1].lastSeenAt, '2026-08-05T04:00:00.000Z');
  assert.equal(service.recordDeepSeekUsageReport(dsReport('native-1', [])), null);
  assert.equal(service.recordDeepSeekUsageReport(dsReport('', [flash(1, 1, 1)])), null);
  assert.equal(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1, 1, 1)], { conversationId: '' })), null);
});

test('buildReport adds the DeepSeek card only while DeepSeek is on, after the others', () => {
  const { service } = makeService();
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 1_000_000, 0)], { at: '2026-08-08T12:00:00.000Z' }));
  const off = service.buildReport({ copilotSummary });
  assert.equal(off.providers.some((card) => card.provider === 'deepseek'), false);
  const on = service.buildReport({
    copilotSummary,
    grokConfigured: true,
    deepseekConfigured: true,
    deepseekBalance: { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 5, granted: 0, toppedUp: 5 }], fetchedAt: '2026-08-08T11:59:00.000Z' },
  });
  assert.deepEqual(on.providers.map((card) => card.provider), ['github', 'claude', 'cursor', 'grok', 'deepseek']);
  const deepseek = on.providers.at(-1);
  assert.equal(deepseek.status, 'ok');
  assert.match(deepseek.notes.find((note) => note.id === 'deepseek-spend').text, /¥1\.00 since 2026-08-08/);
});

test('web searches and fetches are counted per turn, priced from 2026-10-31 16:00 UTC, and booked by day with the tokens', () => {
  const { service } = makeService();
  const requests = (searchRequests, fetchRequests) => [{ model: 'deepseek-flash', searchRequests, fetchRequests }];
  // Before the cutoff: counted, free. The counts are per turn, so the same
  // counts again are a second turn's, and book again.
  service.recordDeepSeekUsageReport({ ...dsReport('native-1', [flash(1000, 2000, 300)]), requests: requests(2, 1) });
  service.recordDeepSeekUsageReport({ ...dsReport('native-1', [flash(1000, 2000, 300)]), requests: requests(2, 1) });
  let [total] = service.readDeepSeekUsageTotals().models;
  assert.deepEqual(
    [total.searchRequests, total.fetchRequests, total.toolsCostUsd, total.toolsCostCny, total.turnCount, total.costUsd],
    [4, 2, 0, 0, 2, 0.000483],
  );
  // From the cutoff: $0.75 / ¥5 per 1,000 of either, peak or not (Monday 2026-11-02 02:00 UTC is peak).
  const later = '2026-11-02T02:00:00.000Z';
  const booked = service.recordDeepSeekUsageReport({ ...dsReport('native-1', [flash(1000, 2000, 300)], { at: later }), requests: requests(10, 30) });
  assert.deepEqual(booked.models.map((entry) => [entry.model, entry.searchRequests, entry.fetchRequests, entry.toolsCostUsd, entry.toolsCostCny, entry.costUsd]), [
    ['deepseek-flash', 10, 30, 0.03, 0.2, null],
  ]);
  // A request-only report on a model without token totals books the requests alone.
  service.recordDeepSeekUsageReport({ ...dsReport('native-1', [], { at: later }), requests: [{ model: 'deepseek-v4-pro', searchRequests: 1000, fetchRequests: 0 }] });
  const byModel = Object.fromEntries(service.readDeepSeekUsageTotals().models.map((entry) => [entry.model, entry]));
  assert.deepEqual(
    [byModel['deepseek-flash'].searchRequests, byModel['deepseek-flash'].fetchRequests, byModel['deepseek-flash'].toolsCostUsd, byModel['deepseek-flash'].toolsCostCny, byModel['deepseek-flash'].turnCount],
    [14, 32, 0.03, 0.2, 3],
  );
  assert.deepEqual(
    [byModel['deepseek-v4-pro'].searchRequests, byModel['deepseek-v4-pro'].toolsCostUsd, byModel['deepseek-v4-pro'].toolsCostCny, byModel['deepseek-v4-pro'].turnCount, byModel['deepseek-v4-pro'].costUsd],
    [1000, 0.75, 5, 1, null],
  );
  // Nothing new at all (same totals, no requests) is nothing booked, and no turn.
  assert.deepEqual(service.recordDeepSeekUsageReport(dsReport('native-1', [flash(1000, 2000, 300)], { at: later })).models, []);
  assert.equal(service.recordDeepSeekUsageReport({ ...dsReport('native-1', [], { at: later }), requests: [] }), null);

  // The days carry the same sums, one row per UTC day and model.
  const days = service.readDeepSeekUsageDays().days.map((entry) => [entry.day, entry.model, entry.hitTokens, entry.searchRequests, entry.fetchRequests, entry.turnCount, entry.costUsd, entry.toolsCostUsd]);
  assert.deepEqual(days, [
    ['2026-10-24', 'deepseek-flash', 1000, 4, 2, 2, 0.000483, 0],
    ['2026-11-02', 'deepseek-flash', 0, 10, 30, 1, null, 0.03],
    ['2026-11-02', 'deepseek-v4-pro', 0, 1000, 0, 1, null, 0.75],
  ]);
  assert.deepEqual(service.readDeepSeekUsageDays({ since: '2026-11-01' }).days.map((entry) => entry.day), ['2026-11-02', '2026-11-02']);
  assert.deepEqual(service.readDeepSeekUsageDays({ since: 'nonsense' }).days.length, 3);
});

test('the daily rows follow the checkpoint: a resumed CLI books only the increase, a restarted one in full', () => {
  const { service } = makeService();
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(5000, 1000, 500)]));
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(5000, 1200, 600)], { at: '2026-10-25T12:00:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(5000, 1200, 600)], { at: '2026-10-25T13:00:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(100, 100, 100)], { at: '2026-10-25T14:00:00.000Z' }));
  assert.deepEqual(service.readDeepSeekUsageDays().days.map((entry) => [entry.day, entry.hitTokens, entry.missTokens, entry.outputTokens, entry.turnCount]), [
    ['2026-10-24', 5000, 1000, 500, 1],
    ['2026-10-25', 100, 300, 200, 2],
  ]);
  const [total] = service.readDeepSeekUsageTotals().models;
  assert.deepEqual([total.hitTokens, total.missTokens, total.outputTokens, total.turnCount], [5100, 1300, 700, 3]);
});

test('the balance reference is the balance after its last rise, before that the highest seen; failed or repeated reads change nothing', () => {
  const { service } = makeService();
  const read = (total, fetchedAt, extra = {}) => ({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total, granted: 0, toppedUp: total }], fetchedAt, ...extra });
  assert.deepEqual(service.readDeepSeekBalanceReferences(), []);
  // The first read is the reference: the meter starts full.
  assert.deepEqual(service.recordDeepSeekBalance(read(110, '2026-08-01T10:00:00.000Z')), [
    { currency: 'CNY', referenceTotal: 110, lastTotal: 110, referenceAt: '2026-08-01T10:00:00.000Z', roseAt: null, roseFromAt: null },
  ]);
  // Spending lowers the balance, not the reference.
  assert.deepEqual(service.recordDeepSeekBalance(read(104.5, '2026-08-02T10:00:00.000Z')), [
    { currency: 'CNY', referenceTotal: 110, lastTotal: 104.5, referenceAt: '2026-08-01T10:00:00.000Z', roseAt: null, roseFromAt: null },
  ]);
  // The same reading again (the service's one-minute cache) changes nothing.
  assert.deepEqual(service.recordDeepSeekBalance(read(104.5, '2026-08-02T10:00:00.000Z', { cached: true })), [
    { currency: 'CNY', referenceTotal: 110, lastTotal: 104.5, referenceAt: '2026-08-01T10:00:00.000Z', roseAt: null, roseFromAt: null },
  ]);
  // A failed read keeps what is known.
  assert.deepEqual(service.recordDeepSeekBalance({ ok: false, code: 'error', error: 'DeepSeek balance check failed (401)', fetchedAt: '2026-08-03T10:00:00.000Z' }), [
    { currency: 'CNY', referenceTotal: 110, lastTotal: 104.5, referenceAt: '2026-08-01T10:00:00.000Z', roseAt: null, roseFromAt: null },
  ]);
  assert.deepEqual(service.recordDeepSeekBalance(null).length, 1);
  // A rise (a top-up) makes the new balance the reference, even below the old one.
  assert.deepEqual(service.recordDeepSeekBalance(read(105, '2026-08-04T10:00:00.000Z')), [
    { currency: 'CNY', referenceTotal: 105, lastTotal: 105, referenceAt: '2026-08-04T10:00:00.000Z', roseAt: '2026-08-04T10:00:00.000Z', roseFromAt: '2026-08-02T10:00:00.000Z' },
  ]);
  assert.deepEqual(service.recordDeepSeekBalance(read(100, '2026-08-05T10:00:00.000Z'))[0].referenceTotal, 105);
  assert.deepEqual(service.recordDeepSeekBalance(read(300, '2026-08-06T10:00:00.000Z'))[0], { currency: 'CNY', referenceTotal: 300, lastTotal: 300, referenceAt: '2026-08-06T10:00:00.000Z', roseAt: '2026-08-06T10:00:00.000Z', roseFromAt: '2026-08-05T10:00:00.000Z' });
  // Each currency has its own; a zero balance is noted too, and an unusable entry is skipped.
  const both = service.recordDeepSeekBalance({ ok: true, isAvailable: true, fetchedAt: '2026-08-07T10:00:00.000Z', balances: [
    { currency: 'CNY', total: 299 }, { currency: 'USD', total: 0 }, { currency: '', total: 5 }, { currency: 'EUR', total: 'none' },
  ] });
  assert.deepEqual(both.map((entry) => [entry.currency, entry.referenceTotal, entry.lastTotal]), [['CNY', 300, 299], ['USD', 0, 0]]);
});

test('a top-up before the starting balance was set, seen by the next read after it, does not replace it; the next top-up does', () => {
  const { service } = makeService();
  const read = (total, fetchedAt) => ({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total }], fetchedAt });
  const starting = { amount: 60, setAt: '2026-10-25T10:00:00.000Z' };
  service.recordDeepSeekBalance(read(10, '2026-10-25T09:00:00.000Z'));
  // Topped up to ¥60 and entered at 10:00; the relay reads ¥60 at 10:05.
  const [seen] = service.recordDeepSeekBalance(read(60, '2026-10-25T10:05:00.000Z'));
  assert.deepEqual([seen.roseAt, seen.roseFromAt], ['2026-10-25T10:05:00.000Z', '2026-10-25T09:00:00.000Z']);
  assert.equal(deepseekStartingBalanceState(starting, seen).applies, true);
  const [spent] = service.recordDeepSeekBalance(read(55, '2026-10-26T10:00:00.000Z'));
  assert.equal(deepseekStartingBalanceState(starting, spent).applies, true);
  // The next top-up: the balance before it was read after the setting.
  const [toppedUp] = service.recordDeepSeekBalance(read(105, '2026-10-27T10:00:00.000Z'));
  assert.deepEqual([toppedUp.roseAt, toppedUp.roseFromAt], ['2026-10-27T10:00:00.000Z', '2026-10-26T10:00:00.000Z']);
  assert.deepEqual(deepseekStartingBalanceState(starting, toppedUp), { applies: false, replacedAt: '2026-10-27T10:00:00.000Z' });
});

test('buildReport gives the DeepSeek card its balance bar, the daily and shares charts, and the budget bar from this month\'s days', () => {
  const { service, clock } = makeService();
  // Saturday 2026-08-08 12:00 UTC is off-peak: 1M misses on flash = ¥1.00. The
  // CLI's running totals: 2M on the 7th, 3M on the 8th (1M more that day).
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 2_000_000, 0)], { at: '2026-08-07T12:00:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 3_000_000, 0)], { at: '2026-08-08T12:00:00.000Z' }));
  // Last month: in the totals, not in this month's budget, and off the 30-day chart.
  service.recordDeepSeekUsageReport(dsReport('native-2', [flash(0, 1_000_000, 0)], { at: '2026-07-01T12:00:00.000Z' }));
  const balance = (total) => ({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total, granted: 0, toppedUp: total }], fetchedAt: '2026-08-08T11:59:00.000Z' });
  const first = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: balance(50), deepseekMonthlyBudget: 4 }).providers.at(-1);
  // The first read is the reference: nothing spent against it yet.
  assert.deepEqual(first.meters.map((meter) => [meter.id, meter.unit, meter.used, meter.allowance, meter.remaining, Math.round(meter.utilization)]), [
    ['deepseek-balance-cny', 'cny', 0, 50, 50, 0],
    ['deepseek-monthly-budget', 'cny', 3, 4, 1, 75],
  ]);
  assert.equal(first.meters[1].resetAt, '2026-09-01T00:00:00.000Z');
  assert.equal(first.meters[1].estimated, true);
  assert.deepEqual(first.charts.map((chart) => [chart.id, chart.kind, chart.unit, chart.items.length]), [
    ['deepseek-daily-spend', 'columns', 'cny', 30],
    ['deepseek-spend-shares', 'bars', 'cny', 1],
  ]);
  const daily = first.charts[0];
  assert.deepEqual([daily.items[0].key, daily.items.at(-1).key], ['2026-07-10', '2026-08-08']);
  assert.deepEqual(daily.items.filter((item) => item.values['deepseek-flash'] > 0).map((item) => [item.key, item.label, item.values]), [
    ['2026-08-07', 'Aug 7', { 'deepseek-flash': 2 }],
    ['2026-08-08', 'Aug 8', { 'deepseek-flash': 1 }],
  ]);
  assert.deepEqual(daily.series, [{ key: 'deepseek-flash', label: 'DeepSeek Flash' }]);
  // The daily table reaches back to July 1 here, so the 30 days are complete.
  assert.equal(daily.note, 'Estimated, by UTC day, from the turns of this relay.');
  // Misses only (4M over both sessions): the whole cost is cache misses, so the cache saved nothing.
  assert.deepEqual(first.charts[1].items, [{ key: 'deepseek-flash', label: 'DeepSeek Flash', values: { hit: 0, miss: 4, output: 0 } }]);
  assert.equal(first.charts[1].summary, null);

  // The balance read again, lower: spent against the reference.
  const second = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: balance(47.5), deepseekMonthlyBudget: 4 }).providers.at(-1);
  assert.deepEqual([second.meters[0].used, second.meters[0].allowance, second.meters[0].remaining], [2.5, 50, 47.5]);
  assert.match(second.meters[0].note, /^Measured from ¥50\.00, the balance after its last rise \(2026-08-08\)\.$/);
  // Without a budget there is no budget bar; without a balance read there is no balance bar.
  const bare = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: null }).providers.at(-1);
  assert.deepEqual(bare.meters, []);
  assert.equal(bare.charts.length, 2);
  // The budget's stored currency reaches the card: a dollar budget on a CNY account is measured in dollars.
  const dollars = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: balance(47.5), deepseekMonthlyBudget: 4, deepseekMonthlyBudgetCurrency: 'USD' }).providers.at(-1);
  assert.deepEqual([dollars.meters[1].label, dollars.meters[1].unit, dollars.meters[1].allowance], ['Monthly budget (USD)', 'usd', 4]);
  assert.ok(dollars.meters[1].used > 0 && dollars.meters[1].used < 1, String(dollars.meters[1].used));
  // The month turns over: the budget starts from zero, the reference stays.
  clock.value = new Date('2026-09-01T00:30:00.000Z');
  const next = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: balance(47.5), deepseekMonthlyBudget: 4 }).providers.at(-1);
  assert.deepEqual([next.meters[1].used, next.meters[1].allowance, next.meters[1].resetAt], [0, 4, '2026-10-01T00:00:00.000Z']);
  assert.deepEqual([next.meters[0].used, next.meters[0].allowance], [2.5, 50]);
});

test('buildReport lays the imported export over the DeepSeek estimate, reading the days back to the export\'s first', () => {
  const { service } = makeService();
  // ¥1.00 each, off-peak: June 1 and 2 (before the 30 days and the month), Aug 8.
  // June 1 starts the daily history, so an export of it would be left out.
  service.recordDeepSeekUsageReport(dsReport('native-1', [flash(0, 1_000_000, 0)], { at: '2026-06-01T12:00:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-3', [flash(0, 1_000_000, 0)], { at: '2026-06-02T12:00:00.000Z' }));
  service.recordDeepSeekUsageReport(dsReport('native-2', [flash(0, 1_000_000, 0)], { at: '2026-08-08T12:00:00.000Z' }));
  const balance = { ok: true, isAvailable: true, balances: [{ currency: 'CNY', total: 50, granted: 0, toppedUp: 50 }], fetchedAt: '2026-08-08T11:59:00.000Z' };
  const deepseekActuals = {
    through: '2026-06-03T00:00:00+01:00',
    rows: [{ day: '2026-06-02', model: 'deepseek-flash', hitTokens: 0, missTokens: 800_000, outputTokens: 0, requestCount: 9, cost: 0.8, currency: 'CNY' }],
  };
  const card = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: balance, deepseekActuals }).providers.at(-1);
  // ¥3.00 estimated, less June 2's ¥1.00, plus the export's ¥0.80.
  const spend = card.notes.find((note) => note.id === 'deepseek-spend');
  assert.equal(spend.text, 'Spend, actual and estimated: ¥2.80 since 2026-06-01');
  assert.match(card.notes.find((note) => note.id === 'deepseek-actual').text, /through 2026-06-03 00:00 UTC\+01:00/);
  const without = service.buildReport({ copilotSummary, deepseekConfigured: true, deepseekBalance: balance }).providers.at(-1);
  assert.equal(without.notes.find((note) => note.id === 'deepseek-spend').text, 'Estimated spend on this relay: ¥3.00 since 2026-06-01');
  assert.equal(without.notes.some((note) => note.id === 'deepseek-actual'), false);
});

test('the Claude API card sits after the Claude cards and before Cursor; without one there is no card', () => {
  const { service } = makeService();
  const claudeApiCard = { provider: 'claude-api', label: 'Claude API', status: 'ok', meters: [], details: [], notes: [], links: [] };
  const ids = service.buildReport({ copilotSummary, claudeCloudConfigured: true, claudeApiCard }).providers.map((card) => card.provider);
  assert.deepEqual(ids.slice(0, 5), ['github', 'claude', 'claude-cloud', 'claude-api', 'cursor']);
  assert.equal(service.buildReport({ copilotSummary }).providers.some((card) => card.provider === 'claude-api'), false);
});
