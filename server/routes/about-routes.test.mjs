import test from 'node:test';
import assert from 'node:assert/strict';

import { registerAboutRoutes } from './about-routes.mjs';

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: register('GET'), post: register('POST') };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const request = { body: {}, query: {}, params: {}, headers: {}, ...req };
  for (const handler of handlers) {
    let next = false;
    await handler(request, response, () => { next = true; });
    if (!next) break;
  }
  return response;
}

// The relay's auth middleware, reduced to its answer: a request without the
// token gets 401 and goes no further.
const auth = (req, res, next) => (req.headers.authorization === 'Bearer fixture-token'
  ? next()
  : res.status(401).json({ error: 'Unauthorized' }));

test('GET /api/about answers only an authenticated request', async () => {
  let described = 0;
  const app = createMockApp();
  registerAboutRoutes(app, {
    auth,
    aboutService: { describe: async () => { described += 1; return { version: '1.2.3' }; } },
  });
  const handlers = app.routes.get('GET /api/about');
  assert.ok(handlers, 'the route is registered');
  assert.equal(handlers[0], auth, 'auth runs first');

  const refused = await callRoute(handlers);
  assert.equal(refused.statusCode, 401);
  assert.equal(described, 0, 'nothing is read for a refused request');

  const answered = await callRoute(handlers, { headers: { authorization: 'Bearer fixture-token' } });
  assert.equal(answered.statusCode, 200);
  assert.deepEqual(answered.body, { version: '1.2.3' });
  assert.equal(described, 1);
});

test('GET /api/about reports a failure instead of hanging', async () => {
  const app = createMockApp();
  registerAboutRoutes(app, { auth: (_req, _res, next) => next(), aboutService: { describe: async () => { throw new Error('disk gone'); } } });
  const failed = await callRoute(app.routes.get('GET /api/about'));
  assert.equal(failed.statusCode, 500);
  assert.match(failed.body.error, /disk gone/);

  const bare = createMockApp();
  registerAboutRoutes(bare, { auth: (_req, _res, next) => next() });
  assert.equal((await callRoute(bare.routes.get('GET /api/about'))).statusCode, 503);
});
