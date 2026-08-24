// Shared scaffolding for the messages-routes test suites and the claude-worker
// routes-integration test: the route-capturing fake express app, the res stub,
// and the baseline deps stand-ins.
//
// server-runtime.mjs boots a live server on import, so the deps it injects are
// reproduced here rather than imported. makeRouteDeps carries only the minimal
// working defaults every suite shares; each suite supplies its own db/stmts —
// the stub suites keep their hand-rolled fakes and prepared-statement mirrors,
// the integration test passes a real better-sqlite3 database and the real
// repositories. The harness owns the shape, the suite owns the fakes.
import assert from 'node:assert/strict';

import { registerMessagesRoutes } from './messages-routes.mjs';

// Baseline deps: enough for registerMessagesRoutes to register every route
// without touching a real server. Registration eagerly prepares statements for
// many routes the suites never exercise, against tables they do not create —
// the db stub absorbs those; suites that need real statement/transaction
// semantics override db/stmts.
export function makeRouteDeps(overrides = {}) {
  return {
    auth: (_req, _res, next) => next(),
    db: { prepare: () => ({ run() {}, get: () => null, all: () => [] }) },
    stmts: {},
    MAX_UPLOAD_BYTES: 1024 * 1024,
    touchCli: () => {},
    ensureSessionId: () => 'session-1',
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'default',
    DEFAULT_MODEL: 'gpt-5',
    normalizeAttachments: () => [],
    collectReferenceAttachmentsFromText: () => ({ attachments: [] }),
    mergeMessageAttachments: (left, right) => [...(left || []), ...(right || [])],
    resolveRequestedModel: (model) => ({
      ok: false,
      error: `Model "${String(model || '')}" is not supported`,
      available: [],
    }),
    getOpenAIProviderSettings: () => ({ configured: false, enabled: false, model: '', models: [] }),
    getCursorProviderSettings: () => ({ enabled: false, model: '', models: [] }),
    featureFlags: {},
    ...overrides,
  };
}

// Registers the routes on a fake express app and returns the captured handlers
// as a Map keyed 'METHOD /path' (last handler wins, matching how the suites
// always grabbed the terminal handler after the auth middleware).
export function captureRoutes(deps, registerFn = registerMessagesRoutes) {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  const app = {
    post: register('POST'),
    get: register('GET'),
    patch: register('PATCH'),
    put: register('PUT'),
    delete: register('DELETE'),
    use() {},
  };
  registerFn(app, deps);
  return routes;
}

// Express res stub capturing status/body.
export function makeRes() {
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  return { res, captured };
}

// Dispatches into a captured handler and returns { status, body }.
export async function invokeRoute(routes, method, routePath, { body = {}, headers = {}, query = {}, params = {}, socket = {} } = {}) {
  const handler = routes.get(`${String(method).toUpperCase()} ${routePath}`);
  assert.ok(handler, `${routePath} should be registered`);
  const { res, captured } = makeRes();
  await handler({ body, headers, query, params, socket }, res);
  return captured;
}

// Registers once and returns an invoker for one POST route — for suites that
// drive the same handler repeatedly against one database.
export function postHandler(routePath, deps) {
  const routes = captureRoutes(deps);
  assert.ok(routes.has(`POST ${routePath}`), `${routePath} should be registered`);
  return (body) => invokeRoute(routes, 'POST', routePath, { body });
}

// One-shot register + POST, the common form in the stub suites.
export function invokePost(routePath, deps, body) {
  return postHandler(routePath, deps)(body);
}

// The worker runner's `api(method, path, body)` against the captured handlers:
// dispatch with a fixed header set (e.g. the bridge identity header the live
// worker sends) and surface non-2xx as a rejection like the worker's HTTP
// client does.
export function makeApi(routes, { headers = {} } = {}) {
  return async (method, routePath, body) => {
    const { status, body: responseBody } = await invokeRoute(routes, method, routePath, { body: body || {}, headers });
    if (status >= 400) {
      throw new Error(`${method} ${routePath} -> ${status}: ${JSON.stringify(responseBody)}`);
    }
    return responseBody;
  };
}
