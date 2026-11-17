import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerSessionsRoutes, withoutCopilotModels } from './sessions-routes.mjs';
import { buildProviderRefreshTable } from '../services/provider-model-refresh.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';

// The Copilot switch and the model catalogue: while Copilot is off its
// models leave the catalogue, its CLI is not asked on a refresh, and an
// install does not start a discovery.

const COPILOT_CATALOG = Object.freeze({
  models: ['auto', 'gpt-5.4-mini', 'claude-opus-5.5'],
  currentModel: 'gpt-5.4-mini',
  defaultModel: 'gpt-5.4-mini',
  reasoningByModel: { auto: ['none'], 'gpt-5.4-mini': ['none', 'low'], 'claude-opus-5.5': ['none'] },
  contextLimitsByModel: { 'gpt-5.4-mini': 128000 },
  modelMetadataByModel: { 'gpt-5.4-mini': { provider: 'github-copilot' } },
  providersByModel: { 'gpt-5.4-mini': ['github-copilot'], 'claude-opus-5.5': ['github-copilot'] },
  reasoningByProvider: {},
});
const CLAUDE_ON = Object.freeze({ configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'], availableModels: ['claude-sonnet-5'] });

function settingsStmts(copilotEnabled) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  if (copilotEnabled !== null) stmts.upsertAppSetting.run('copilot_enabled', copilotEnabled, '2026-11-16T21:00:00.000Z');
  return stmts;
}

function createHarness({ copilotEnabled = 'false', ...deps } = {}) {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  const app = { get: register('GET'), post: register('POST'), patch: register('PATCH'), put: register('PUT'), delete: register('DELETE') };
  const calls = { cli: 0, discovery: [] };
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: { prepare: () => ({ run() {}, get: () => null, all: () => [] }), transaction: (fn) => (...args) => fn(...args) },
    stmts: settingsStmts(copilotEnabled),
    ensureSessionId: () => 'session-1',
    getModelCatalogState: () => COPILOT_CATALOG,
    getClaudeProviderSettings: () => CLAUDE_ON,
    refreshModelVariantCatalogFromCli: async () => { calls.cli += 1; return COPILOT_CATALOG; },
    copilotModelDiscoveryService: { refresh: async (reason) => { calls.discovery.push(reason); return { ok: true, models: [] }; } },
    ...deps,
  });
  const call = async (key, req = {}) => {
    const captured = { status: 200, body: null };
    const res = { setHeader() {}, status(code) { captured.status = code; return res; }, json(payload) { captured.body = payload; return res; } };
    await routes.get(key)({ headers: {}, query: {}, params: {}, body: {}, ...req }, res);
    return captured;
  };
  return { call, calls };
}

test('withoutCopilotModels keeps the catalogue fields and drops every Copilot model', () => {
  const stripped = withoutCopilotModels(COPILOT_CATALOG);
  assert.deepEqual(stripped.models, []);
  assert.equal(stripped.currentModel, '');
  assert.equal(stripped.defaultModel, '');
  assert.deepEqual(stripped.reasoningByModel, {});
  assert.deepEqual(stripped.contextLimitsByModel, {});
  assert.deepEqual(stripped.providersByModel, {});
  assert.deepEqual(stripped.modelMetadataByModel, {});
  assert.deepEqual(stripped.reasoningByProvider, {});
});

test('Copilot off and only Claude on: GET /api/models lists Claude\'s models only', async () => {
  const { call } = createHarness({ copilotEnabled: 'false' });
  const { status, body } = await call('GET /api/models');
  assert.equal(status, 200);
  assert.deepEqual(body.models, ['claude-sonnet-5']);
  assert.ok(!body.models.includes('auto'));
  assert.ok(!body.models.includes('gpt-5.4-mini'));
});

test('Copilot on or unset: GET /api/models keeps Copilot\'s models beside Claude\'s', async () => {
  for (const copilotEnabled of ['true', null]) {
    const { call } = createHarness({ copilotEnabled });
    const { body } = await call('GET /api/models');
    assert.ok(body.models.includes('gpt-5.4-mini'), String(copilotEnabled));
    assert.ok(body.models.includes('claude-sonnet-5'), String(copilotEnabled));
  }
});

test('the Refresh button asks neither the Copilot CLI nor its discovery while Copilot is off', async () => {
  const off = createHarness({ copilotEnabled: 'false' });
  const refreshed = await off.call('POST /api/model-variants/refresh');
  assert.equal(refreshed.status, 200);
  assert.equal(off.calls.cli, 0);
  assert.deepEqual(off.calls.discovery, []);
  const on = createHarness({ copilotEnabled: 'true' });
  await on.call('POST /api/model-variants/refresh');
  assert.equal(on.calls.cli, 1);
  assert.deepEqual(on.calls.discovery, ['manual-refresh']);
});

test('provider refresh table: github is neither enabled nor set up while Copilot is off', () => {
  const discovery = { refresh: async () => ({ ok: true }), isCliResolvable: () => true };
  const off = buildProviderRefreshTable({ copilotModelDiscoveryService: discovery, isCopilotEnabled: () => false });
  assert.equal(off.github.isEnabled(), false);
  assert.equal(off.github.isSetUp(), false);
  const on = buildProviderRefreshTable({ copilotModelDiscoveryService: discovery, isCopilotEnabled: () => true });
  assert.equal(on.github.isEnabled(), true);
  assert.equal(on.github.isSetUp(), true);
  const legacy = buildProviderRefreshTable({ copilotModelDiscoveryService: discovery });
  assert.equal(legacy.github.isEnabled(), true, 'absent switch: on');
});

test('a Copilot CLI install starts a discovery only while Copilot is on', async () => {
  for (const [copilotEnabled, expected] of [['false', []], ['true', ['cli-install']]]) {
    let onSuccess = null;
    const cliInstallService = {
      subscribe() {},
      onInstallSuccess(listener) { onSuccess = listener; },
      getCachedStatusSnapshot: () => ({}),
      getStatusSnapshot: async () => ({}),
    };
    const { calls } = createHarness({ copilotEnabled, cliInstallService });
    await onSuccess({ providerId: 'copilot' });
    assert.deepEqual(calls.discovery, expected, copilotEnabled);
  }
});

test('Select Models gets no Copilot rows while Copilot is off', async () => {
  const row = { variantId: 'gpt-5.4-mini-none', baseModelId: 'gpt-5.4-mini', reasoningEffort: 'none', enabled: true, provider: 'github-copilot' };
  for (const [copilotEnabled, expected] of [['false', 0], ['true', 1]]) {
    const { call } = createHarness({ copilotEnabled, listModelVariantRows: () => [row] });
    const { body } = await call('GET /api/model-variants');
    assert.equal(body.variants.length, expected, copilotEnabled);
  }
});
