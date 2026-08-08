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
    { agentId: 'a1', model: 'composer-2.5', rawCostCents: 300, chargedCents: 0, totalTokens: 1000 },
    { resetDay: 1 },
  );
  service.recordCursorUsageReport(
    { agentId: 'a1', model: 'claude-opus-5', rawCostCents: 800, chargedCents: 100, totalTokens: 2500 },
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
  const report = { agentId: 'a1', model: 'composer-2.5', rawCostCents: 300 };
  service.recordCursorUsageReport(report, { resetDay: 1 });
  const second = service.recordCursorUsageReport(report, { resetDay: 1 });
  assert.equal(second.changed, false);
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 300);
});

test('spend books into the cycle that is current when it is observed', () => {
  const { service, clock } = makeService();
  service.recordCursorUsageReport({ agentId: 'a1', model: 'composer-2.5', rawCostCents: 100 }, { resetDay: 1 });
  clock.value = new Date('2026-09-05T00:00:00.000Z');
  service.recordCursorUsageReport({ agentId: 'a1', model: 'composer-2.5', rawCostCents: 250 }, { resetDay: 1 });

  clock.value = new Date('2026-08-20T00:00:00.000Z');
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 100);
  clock.value = new Date('2026-09-20T00:00:00.000Z');
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 150);
});

test('separate agents accumulate independently', () => {
  const { service } = makeService();
  service.recordCursorUsageReport({ agentId: 'a1', model: 'composer-2.5', rawCostCents: 100 }, { resetDay: 1 });
  service.recordCursorUsageReport({ agentId: 'a2', model: 'composer-2.5', rawCostCents: 400 }, { resetDay: 1 });
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 500);
});

test('resetting accounting clears the cycle and re-baselines future reports', () => {
  const { service } = makeService();
  service.recordCursorUsageReport({ agentId: 'a1', model: 'composer-2.5', rawCostCents: 900 }, { resetDay: 1 });
  service.resetCursorAccounting({ resetDay: 1 });
  assert.equal(service.readCursorCycleTotals({ resetDay: 1 }).totals.cursor.rawCostCents, 0);

  // The agent's lifetime total is unchanged, so a fresh baseline must not
  // retroactively re-book the spend that was just cleared.
  service.recordCursorUsageReport({ agentId: 'a1', model: 'composer-2.5', rawCostCents: 950 }, { resetDay: 1 });
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
