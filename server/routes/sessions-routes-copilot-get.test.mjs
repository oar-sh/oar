import test from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';

function createHarness(deps = {}) {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers);
  };
  const app = { routes, get: register('GET'), post: register('POST'), patch: register('PATCH'), put: register('PUT'), delete: register('DELETE') };
  const auth = (_req, _res, next) => next();
  registerSessionsRoutes(app, {
    auth,
    io: { emit() {} },
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {},
    ...deps,
  });
  return { app, auth };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, response, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return response;
}

/** The settings statements of a real database (applySchema), the rest stubbed. */
function settingsStmts(initial = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  for (const [key, value] of Object.entries(initial)) stmts.upsertAppSetting.run(key, value, '2026-11-16T21:00:00.000Z');
  return stmts;
}

const CATALOG = () => ({ models: ['gpt-5.4-mini'], reasoningByModel: {}, reasoningByProvider: {}, modelMetadataByModel: {}, providersByModel: {} });

function recordingIo() {
  const events = [];
  return { events, io: { emit: (event, payload) => events.push({ event, payload }) } };
}

test('GET /api/settings/copilot is authenticated and answers the engine, the switch and the CLI', async () => {
  const { app, auth } = createHarness({
    getCopilotProviderSettings: () => ({ engine: 'sdk', engines: ['sdk'] }),
  });
  const handlers = app.routes.get('GET /api/settings/copilot');
  assert.equal(handlers[0], auth);
  const response = await callRoute(handlers);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: false });
});

test('without a runtime getter or a stored switch the GET answers the one engine, on', async () => {
  const { app } = createHarness();
  const response = await callRoute(app.routes.get('GET /api/settings/copilot'));
  assert.deepEqual(response.body, { engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: false });
});

test('GET reads the stored switch; cliFound from the detector, else the runtime settings', async () => {
  const off = createHarness({ stmts: settingsStmts({ copilot_enabled: 'false' }), getCopilotProviderSettings: () => ({ engine: 'sdk', cliFound: true }) });
  assert.deepEqual((await callRoute(off.app.routes.get('GET /api/settings/copilot'))).body, { engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: true });
  const detected = createHarness({ stmts: settingsStmts({ copilot_enabled: 'true' }), detectCopilotCli: () => true });
  assert.equal((await callRoute(detected.app.routes.get('GET /api/settings/copilot'))).body.cliFound, true);
});

test('on a new database the first GET with a detector decides the switch once and writes it', async () => {
  const stmts = settingsStmts();
  let calls = 0;
  const { app } = createHarness({ stmts, detectCopilotCli: () => { calls += 1; return false; } });
  assert.equal((await callRoute(app.routes.get('GET /api/settings/copilot'))).body.enabled, false);
  assert.equal(stmts.getAppSetting.get('copilot_enabled').value, 'false');
  assert.equal((await callRoute(app.routes.get('GET /api/settings/copilot'))).body.enabled, false);
  assert.equal(calls, 3, 'one detection for the switch, then cliFound asks on each GET');
});

test('POST /api/settings/copilot switches Copilot off: stored, announced, no discovery', async () => {
  const stmts = settingsStmts({ copilot_enabled: 'true' });
  const { events, io } = recordingIo();
  const refreshes = [];
  const { app, auth } = createHarness({ stmts, io, getModelCatalogState: CATALOG, copilotModelDiscoveryService: { refresh: async (reason) => { refreshes.push(reason); return { ok: true }; } } });
  const handlers = app.routes.get('POST /api/settings/copilot');
  assert.equal(handlers[0], auth);
  const response = await callRoute(handlers, { body: { enabled: false } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: false, warning: null });
  assert.equal(stmts.getAppSetting.get('copilot_enabled').value, 'false');
  assert.deepEqual(refreshes, []);
  assert.deepEqual(events.map((entry) => entry.event), ['models_updated', 'copilot_settings_updated']);
  assert.equal(events[1].payload.enabled, false);
});

test('POST switching Copilot on runs one discovery; on again runs none', async () => {
  const stmts = settingsStmts({ copilot_enabled: 'false' });
  const { events, io } = recordingIo();
  const refreshes = [];
  const { app } = createHarness({ stmts, io, getModelCatalogState: CATALOG, copilotModelDiscoveryService: { refresh: async (reason) => { refreshes.push(reason); return { ok: false, error: 'Copilot CLI runtime is not installed' }; } } });
  const post = app.routes.get('POST /api/settings/copilot');
  const response = await callRoute(post, { body: { enabled: true } });
  assert.equal(response.body.enabled, true);
  assert.equal(response.body.warning, 'Copilot CLI runtime is not installed');
  assert.deepEqual(refreshes, ['copilot-enabled']);
  assert.equal(stmts.getAppSetting.get('copilot_enabled').value, 'true');
  assert.ok(events.some((entry) => entry.event === 'copilot_settings_updated' && entry.payload.enabled === true));
  await callRoute(post, { body: { enabled: true } });
  assert.deepEqual(refreshes, ['copilot-enabled']);
});

test('POST refuses a body without a boolean enabled, and answers 500 where nothing can be stored', async () => {
  const { app } = createHarness({ stmts: settingsStmts() });
  const bad = await callRoute(app.routes.get('POST /api/settings/copilot'), { body: { enabled: 'off' } });
  assert.equal(bad.statusCode, 400);
  const bare = createHarness();
  const unavailable = await callRoute(bare.app.routes.get('POST /api/settings/copilot'), { body: { enabled: false } });
  assert.equal(unavailable.statusCode, 500);
});
