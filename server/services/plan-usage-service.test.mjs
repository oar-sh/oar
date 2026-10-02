import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createPlanUsageService } from './plan-usage-service.mjs';

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
