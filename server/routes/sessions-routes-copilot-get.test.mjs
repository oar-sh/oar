import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

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

test('GET /api/settings/copilot is authenticated and answers the runtime\'s settings', async () => {
  const { app, auth } = createHarness({
    getCopilotProviderSettings: () => ({ engine: 'sdk', engines: ['sdk'] }),
  });
  const handlers = app.routes.get('GET /api/settings/copilot');
  assert.equal(handlers[0], auth);
  const response = await callRoute(handlers);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { engine: 'sdk', engines: ['sdk'] });
});

test('without a runtime getter the GET still answers the one engine', async () => {
  const { app } = createHarness();
  const response = await callRoute(app.routes.get('GET /api/settings/copilot'));
  assert.deepEqual(response.body, { engine: 'sdk', engines: ['sdk'] });
});

test('there is no Copilot settings save', () => {
  const { app } = createHarness();
  assert.equal(app.routes.has('POST /api/settings/copilot'), false);
});
