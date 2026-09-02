'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCopilotSettingsPayload,
  parseCopilotSettingsUpdateRequest,
  registerSessionsRoutes,
} from './sessions-routes.mjs';

test('parseCopilotSettingsUpdateRequest accepts both engines', () => {
  assert.deepEqual(parseCopilotSettingsUpdateRequest({ engine: 'extension' }), { ok: true, engine: 'extension' });
  assert.deepEqual(parseCopilotSettingsUpdateRequest({ engine: 'sdk' }), { ok: true, engine: 'sdk' });
});

test('parseCopilotSettingsUpdateRequest normalises case and whitespace', () => {
  assert.deepEqual(parseCopilotSettingsUpdateRequest({ engine: '  SDK ' }), { ok: true, engine: 'sdk' });
});

test('parseCopilotSettingsUpdateRequest rejects an empty body', () => {
  const parsed = parseCopilotSettingsUpdateRequest({});
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /No Copilot settings update/);
});

test('parseCopilotSettingsUpdateRequest rejects an unknown engine', () => {
  // A typo must 400 rather than persist a value that would read back as the
  // default forever, silently ignoring the user's choice.
  for (const engine of ['', 'Extention', 'cli', null, 42]) {
    const parsed = parseCopilotSettingsUpdateRequest({ engine });
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(engine)} to be rejected`);
  }
});

test('parseCopilotSettingsUpdateRequest tolerates a non-object body', () => {
  assert.equal(parseCopilotSettingsUpdateRequest(null).ok, false);
  assert.equal(parseCopilotSettingsUpdateRequest('sdk').ok, false);
});

test('buildCopilotSettingsPayload is one shape for the GET, the POST and the socket', () => {
  assert.deepEqual(buildCopilotSettingsPayload({ engine: 'sdk', engines: ['extension', 'sdk'] }), {
    engine: 'sdk',
    engines: ['extension', 'sdk'],
  });
  // A relay that cannot say which engine it is on must not claim to be on the
  // experimental one.
  for (const settings of [{}, null, { engine: 'quantum' }, { engine: '' }]) {
    assert.deepEqual(buildCopilotSettingsPayload(settings), {
      engine: 'extension',
      engines: ['extension', 'sdk'],
    });
  }
});

// ─── route contract ──────────────────────────────────────────────────────────

function createHarness({ setCopilotProviderSettings, engine = 'extension' } = {}) {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers);
  };
  const app = { routes, get: register('GET'), post: register('POST'), patch: register('PATCH'), delete: register('DELETE') };
  const emitted = [];
  let stored = engine;
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {},
    getCopilotProviderSettings: () => ({ engine: stored, engines: ['extension', 'sdk'] }),
    setCopilotProviderSettings: setCopilotProviderSettings || (({ engine: wanted }) => {
      stored = wanted;
      return { ok: true, engine: stored, engines: ['extension', 'sdk'] };
    }),
  });
  return { app, emitted };
}

async function callRoute(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `${key} should be registered`);
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

test('saving the engine persists it, answers with it, and broadcasts it', async () => {
  const { app, emitted } = createHarness();
  const saved = await callRoute(app, 'POST /api/settings/copilot', { body: { engine: 'sdk' } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body, { ok: true, engine: 'sdk', engines: ['extension', 'sdk'] });

  // Same shape on the wire as on the socket — one builder feeds both.
  assert.deepEqual(emitted, [{
    event: 'copilot_settings_updated',
    payload: { engine: 'sdk', engines: ['extension', 'sdk'] },
  }]);

  const read = await callRoute(app, 'GET /api/settings/copilot');
  assert.deepEqual(read.body, { engine: 'sdk', engines: ['extension', 'sdk'] });
});

test('an unavailable SDK engine is refused with 409 and the relay reason', async () => {
  // 409, not 400: the request is well-formed, the relay is not in a state to
  // honour it — and the reason string is what the settings panel renders.
  const reason = 'The Copilot SDK was not found when the relay started (COPILOT_SDK_PATH did not resolve).';
  const { app, emitted } = createHarness({
    setCopilotProviderSettings: () => ({ ok: false, status: 409, error: reason }),
  });
  const refused = await callRoute(app, 'POST /api/settings/copilot', { body: { engine: 'sdk' } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error, reason);
  // Nothing was broadcast: no other tab should render a switch that did not happen.
  assert.deepEqual(emitted, []);
});

test('a malformed engine is still a 400, not a 409', async () => {
  const { app } = createHarness();
  const bad = await callRoute(app, 'POST /api/settings/copilot', { body: { engine: 'quantum' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.error, /Invalid Copilot engine/);

  const empty = await callRoute(app, 'POST /api/settings/copilot', { body: {} });
  assert.equal(empty.statusCode, 400);
});

test('a setter failure without a status still answers 400', async () => {
  const { app } = createHarness({
    setCopilotProviderSettings: () => ({ ok: false, error: 'Copilot settings are unavailable' }),
  });
  const failed = await callRoute(app, 'POST /api/settings/copilot', { body: { engine: 'sdk' } });
  assert.equal(failed.statusCode, 400);
  assert.equal(failed.body.error, 'Copilot settings are unavailable');
});
