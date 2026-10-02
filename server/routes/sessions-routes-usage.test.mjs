import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createPlanUsageService } from '../services/plan-usage-service.mjs';

// GET /api/usage with the Claude account's live usage: read best-effort beside
// the other providers' fetches, never a reason for the modal to fail or wait.

const NOW = '2026-10-02T10:01:00.000Z';

const COPILOT_SUMMARY = {
  plan: 'copilot_pro',
  resetDate: '2026-11-01',
  chat: { unlimited: true },
  premiumInteractions: { remaining: 400, entitlement: 1500 },
};

const ACCOUNT = {
  usage: {
    five_hour: { utilization: 9, resets_at: '2026-10-02T15:00:00Z', limit_dollars: null, used_dollars: null, remaining_dollars: null },
    iguana_necktie: { utilization: 10, resets_at: '2026-11-20T08:00:00Z', limit_dollars: 60, used_dollars: 6, remaining_dollars: 54 },
  },
  prepaid: null,
  offer: null,
  fetchedAt: '2026-10-02T10:00:30.000Z',
  error: null,
};

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

async function getUsage(app, query = {}) {
  const handler = app.routes.get('GET /api/usage');
  assert.ok(handler, 'GET /api/usage should be registered');
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ body: {}, params: {}, query, headers: {} }, res);
  return res;
}

function setup({ cloudEnabled = true, claudeAccountUsageService, cloudRows = [], fetchUsageSummary, fetchCopilotBillingUsage, grokEnabled = false, fetchGrokBillingUsage } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  // Only the runtime session rows matter here, so they go in without their conversations.
  db.pragma('foreign_keys = OFF');
  const insert = db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, runtime_key, provider_type, claude_cloud_cost_usd, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [conversationId, providerType, costUsd] of cloudRows) {
    insert.run(`rs-${conversationId}`, conversationId, `rs-${conversationId}`, providerType, costUsd, NOW, NOW);
  }
  const planUsageService = createPlanUsageService({ db, now: () => new Date(NOW) });
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts: { ...createSessionRepository(db), ...createMessageRepository(db) },
    runtimeState: {},
    config: {},
    fetchUsageSummary: fetchUsageSummary || ((callback) => callback(null, COPILOT_SUMMARY)),
    ...(fetchCopilotBillingUsage ? { fetchCopilotBillingUsage } : {}),
    ...(fetchGrokBillingUsage ? { fetchGrokBillingUsage } : {}),
    getGrokProviderSettings: () => ({ enabled: grokEnabled }),
    planUsageService,
    getClaudeProviderSettings: () => ({ enabled: true }),
    claudeCloudSettingsService: { getSettings: () => ({ enabled: cloudEnabled }) },
    ...(claudeAccountUsageService === undefined ? {} : { claudeAccountUsageService }),
  });
  return { app };
}

test('the report carries the live Claude card and the Claude Cloud card after it', async () => {
  const asked = [];
  const { app } = setup({
    cloudRows: [['conv-cloud-1', 'claude-cloud', 0.18], ['conv-cloud-2', 'claude-cloud', 0.07]],
    claudeAccountUsageService: {
      getAccountUsage: async (options) => {
        asked.push(options);
        return ACCOUNT;
      },
    },
  });
  const res = await getUsage(app, { conversationId: 'conv-cloud-1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(asked, [{ timeoutMs: 3000 }]);
  assert.deepEqual(res.body.providers.map((card) => card.provider), ['github', 'claude', 'claude-cloud', 'cursor']);
  // The legacy top-level fields stay beside the cards.
  assert.equal(res.body.plan, 'copilot_pro');

  const claude = res.body.providers[1];
  assert.equal(claude.source, 'live');
  assert.equal(claude.meters[0].utilization, 9);

  const cloud = res.body.providers[2];
  assert.deepEqual(cloud.meters.map((meter) => meter.id), ['claude-cloud-credit-iguana_necktie', 'claude-cloud-spend']);
  assert.deepEqual(cloud.details[0].rows.map((row) => [row.label, row.value]), [
    ['All cloud conversations', '$0.25'],
    ['This conversation', '$0.18'],
  ]);
});

test('with Claude Cloud off there is no cloud card and the Claude card is the snapshot one', async () => {
  const { app } = setup({
    cloudEnabled: false,
    // What the real service answers while the provider is off.
    claudeAccountUsageService: { getAccountUsage: async () => null },
  });
  const res = await getUsage(app);
  assert.deepEqual(res.body.providers.map((card) => card.provider), ['github', 'claude', 'cursor']);
  assert.equal(res.body.providers[1].status, 'unavailable');
});

test('a failing account read does not fail the modal', async () => {
  for (const getAccountUsage of [
    async () => { throw new Error('boom'); },
    () => { throw new Error('boom, synchronously'); },
  ]) {
    const { app } = setup({ claudeAccountUsageService: { getAccountUsage } });
    const res = await getUsage(app);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.providers.map((card) => card.provider), ['github', 'claude', 'claude-cloud', 'cursor']);
    assert.equal(res.body.providers[1].status, 'unavailable');
    assert.equal(res.body.providers[2].status, 'unavailable');
  }
});

test('without the account service the report is built as before', async () => {
  const { app } = setup({ cloudEnabled: false });
  const res = await getUsage(app);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.providers.map((card) => card.provider), ['github', 'claude', 'cursor']);
});

test('the legacy answer never asks for the account usage', async () => {
  let asked = 0;
  const { app } = setup({ claudeAccountUsageService: { getAccountUsage: async () => { asked += 1; return ACCOUNT; } } });
  const res = await getUsage(app, { legacy: '1' });
  assert.deepEqual(res.body, COPILOT_SUMMARY);
  assert.equal(asked, 0);
});

// ---------------------------------------------------------------------------
// One provider live, the rest from the last live answer

test('every provider is live when nothing is asked for, and the answer says so', async () => {
  const { app } = setup({ claudeAccountUsageService: { getAccountUsage: async () => ACCOUNT } });
  const res = await getUsage(app);
  assert.deepEqual(res.body.live, ['github', 'claude', 'claude-cloud', 'cursor', 'grok']);
  assert.equal(typeof res.body.fetchedAt.github, 'string');
  assert.equal(res.body.fetchedAt.claude, ACCOUNT.fetchedAt);
  assert.equal(res.body.providers[0].capturedAt, res.body.fetchedAt.github);
});

test('asked for one provider, the others come from the last live answer without a read', async () => {
  let quotaReads = 0;
  let billingReads = 0;
  let grokReads = 0;
  const accountCalls = [];
  const { app } = setup({
    grokEnabled: true,
    fetchUsageSummary: (callback) => {
      quotaReads += 1;
      callback(null, { ...COPILOT_SUMMARY, premiumInteractions: { remaining: 400 - quotaReads, entitlement: 1500 } });
    },
    fetchCopilotBillingUsage: async () => {
      billingReads += 1;
      return { items: [], timePeriod: null, scope: 'dev-example', error: null };
    },
    fetchGrokBillingUsage: async () => {
      grokReads += 1;
      return null;
    },
    claudeAccountUsageService: {
      getAccountUsage: async (options) => { accountCalls.push(['live', options]); return ACCOUNT; },
      peekAccountUsage: () => { accountCalls.push(['peek']); return { ...ACCOUNT, fetchedAt: '2026-10-02T09:00:00.000Z' }; },
    },
  });

  // First open: Copilot live, Claude from the service's own cache.
  const first = await getUsage(app, { providers: 'github' });
  assert.deepEqual(first.body.live, ['github']);
  // Grok has no earlier answer yet, so it is read once even though not asked for.
  assert.deepEqual([quotaReads, billingReads, grokReads], [1, 1, 1]);
  assert.deepEqual(accountCalls, [['peek']]);
  assert.equal(first.body.providers[0].meters[0].used ?? first.body.providers[0].meters[0].remaining, first.body.providers[0].meters[0].used ?? 399);
  assert.equal(first.body.fetchedAt.claude, '2026-10-02T09:00:00.000Z');
  const copilotAt = first.body.fetchedAt.github;

  // The Claude tab: only the account is read; Copilot is the earlier answer.
  const second = await getUsage(app, { providers: 'claude,claude-cloud' });
  assert.deepEqual(second.body.live, ['claude', 'claude-cloud']);
  assert.deepEqual([quotaReads, billingReads, grokReads], [1, 1, 1]);
  assert.deepEqual(accountCalls.at(-1), ['live', { timeoutMs: 3000 }]);
  assert.equal(second.body.fetchedAt.github, copilotAt);
  assert.equal(second.body.providers[0].capturedAt, copilotAt);
  assert.equal(second.body.fetchedAt.claude, ACCOUNT.fetchedAt);

  // Asked for Grok: read again; Copilot still not.
  const third = await getUsage(app, { providers: 'grok' });
  assert.deepEqual(third.body.live, ['grok']);
  assert.deepEqual([quotaReads, billingReads, grokReads], [1, 1, 2]);

  // Unknown ids are ignored; `all` means everything live.
  const fourth = await getUsage(app, { providers: 'all' });
  assert.equal(fourth.body.live.length, 5);
  assert.deepEqual([quotaReads, billingReads, grokReads], [2, 2, 3]);
});

test('a provider never read live is read on its first request even when not asked for', async () => {
  let quotaReads = 0;
  const { app } = setup({
    fetchUsageSummary: (callback) => { quotaReads += 1; callback(null, COPILOT_SUMMARY); },
    claudeAccountUsageService: { getAccountUsage: async () => ACCOUNT, peekAccountUsage: () => null },
  });
  const res = await getUsage(app, { providers: 'claude' });
  // Nothing cached for Copilot yet: it is read so the card is not empty.
  assert.equal(quotaReads, 1);
  assert.equal(res.body.providers[0].status !== 'unavailable', true);
  await getUsage(app, { providers: 'claude' });
  assert.equal(quotaReads, 1, 'and kept from then on');
});

test('a failed live read does not replace the last good answer', async () => {
  let fail = false;
  const { app } = setup({
    fetchUsageSummary: (callback) => (fail ? callback(new Error('GitHub down')) : callback(null, COPILOT_SUMMARY)),
    claudeAccountUsageService: { getAccountUsage: async () => ACCOUNT, peekAccountUsage: () => ACCOUNT },
  });
  await getUsage(app, { providers: 'github' });
  fail = true;
  const failed = await getUsage(app, { providers: 'github' });
  assert.equal(failed.body.providers[0].status, 'error');
  const cached = await getUsage(app, { providers: 'claude' });
  assert.equal(cached.body.providers[0].status, 'ok', 'the good answer is what the cache serves');
});
