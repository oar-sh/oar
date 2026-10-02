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

function setup({ cloudEnabled = true, claudeAccountUsageService, cloudRows = [] } = {}) {
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
    fetchUsageSummary: (callback) => callback(null, COPILOT_SUMMARY),
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
