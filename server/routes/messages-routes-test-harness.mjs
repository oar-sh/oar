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
import crypto from 'node:crypto';
import path from 'node:path';

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

// Prepared-statement stand-ins that record every run: the named ones as
// given, any other answers `run` with one change, `get` with null and `all`
// with []. `calls` lists `{ stmt, args }` in order.
export function recordingStmts(explicit = {}) {
  const calls = [];
  const target = { ...explicit };
  const stmts = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      const recorder = {
        run: (...args) => { calls.push({ stmt: String(prop), args }); return { changes: 1 }; },
        get: () => null,
        all: () => [],
      };
      obj[prop] = recorder;
      return recorder;
    },
  });
  return { calls, stmts };
}

export const FAKE_OPENAI_BASE_URL = 'http://provider.invalid/v1';

/**
 * Global fetch for the image paths. Requests to FAKE_OPENAI_BASE_URL get
 * `openai`'s answers in turn (the last one again once they run out); each
 * is `{ status, json }`, `{ status, text }`, `{ error }` (thrown),
 * `{ hang: true }` (answers only the request's abort signal) or an event
 * stream `{ status, sse: [chunk, …], breakWith?, hangAfter? }` (the chunks,
 * then `breakWith` thrown from the body, or a wait for the abort signal;
 * openAIImageSse builds the chunks). Any other URL
 * is the relay calling itself: recorded as `{ route, body }` and answered
 * from `self` (route → [status, payload]), else 200 `{ ok: true }`.
 */
export function stubImageFetch(t, { openai = [], self = {} } = {}) {
  const calls = { openai: [], self: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith(FAKE_OPENAI_BASE_URL)) {
      const index = calls.openai.length;
      calls.openai.push({ path: href.slice(FAKE_OPENAI_BASE_URL.length), init });
      const answer = openai[Math.min(index, openai.length - 1)] || { status: 200, json: {} };
      if (answer.error) throw answer.error;
      if (answer.hang) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      if (answer.sse) {
        const status = answer.status ?? 200;
        async function* body() {
          for (const chunk of answer.sse) {
            // A turn of the event loop per chunk, as a socket gives them.
            await new Promise((resolve) => setImmediate(resolve));
            yield new TextEncoder().encode(chunk);
          }
          if (answer.breakWith) throw answer.breakWith;
          if (answer.hangAfter) {
            await new Promise((_resolve, reject) => {
              if (init.signal?.aborted) reject(init.signal.reason);
              init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            });
          }
        }
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
          body: body(),
          text: async () => answer.sse.join(''),
        };
      }
      const text = answer.text ?? JSON.stringify(answer.json ?? {});
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => text };
    }
    const route = new URL(href).pathname;
    calls.self.push({ route, body: init.body ? JSON.parse(init.body) : null });
    const [status, payload] = self[route] || [200, { ok: true }];
    return { ok: status < 400, status, json: async () => payload };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/**
 * The SSE text of an OpenAI image stream, cut into chunks at awkward places
 * (inside a data line, between CR and LF): `events` are `{ partial: index,
 * b64 }`, `{ completed: true, b64, usage? }` or `{ error: { … } }`; `family`
 * is 'image_generation' or 'image_edit'.
 */
export function openAIImageSse(events, { family = 'image_generation', outputFormat = 'png', chunkSize = 37 } = {}) {
  const text = events.map((entry) => {
    let payload;
    if (entry.error) payload = { type: 'error', error: entry.error };
    else if (entry.completed) {
      payload = { type: `${family}.completed`, b64_json: entry.b64, size: '1024x1024', quality: 'low', output_format: outputFormat, background: 'opaque', ...(entry.usage ? { usage: entry.usage } : {}) };
    } else {
      payload = { type: `${family}.partial_image`, b64_json: entry.b64, partial_image_index: entry.partial, size: '1024x1024', quality: 'low', output_format: outputFormat, background: 'opaque', created_at: 1 };
    }
    return `event: ${payload.type}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
  }).join('');
  const chunks = [];
  for (let at = 0; at < text.length; at += chunkSize) chunks.push(text.slice(at, at + chunkSize));
  return chunks;
}

/**
 * A socket.io stand-in recording every `emit` as `{ event, payload }`, but
 * the events named in `except`.
 */
export function recordingIo({ except = [] } = {}) {
  const events = [];
  return { events, io: { emit: (event, payload) => { if (!except.includes(event)) events.push({ event, payload }); } } };
}

/** A network error as undici's fetch throws it: "fetch failed" with the cause's code. */
export function fetchFailure(code) {
  const cause = Object.assign(new Error(`connect ${code}`), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/**
 * Deps for POST /api/image-operations/:id/execute around one operation
 * (`img_op_demo` of queue row `q-1`, an OpenAI image model at
 * FAKE_OPENAI_BASE_URL). `finished` and `inserted` record the attempt rows;
 * `latestAttempt` is the attempt the route finds first.
 */
export function makeImageOperationDeps({
  latestAttempt = null,
  parameters = { quality: 'low', size: '1024x1024', count: 1 },
  model = 'gpt-image-2',
  prompt = 'turn the sky purple',
  assets = [],
  uploadsDir = '',
  config = {},
} = {}) {
  const operation = {
    id: 'img_op_demo',
    queue_message_id: 'q-1',
    conversation_id: 'conv-1',
    provider: 'openai',
    execution_mode: 'direct_images',
    selected_image_model: model,
    prompt,
    parameters_json: JSON.stringify(parameters),
    idempotency_key: 'img_op_demo',
    parent_node_id: null,
  };
  const finished = [];
  const inserted = [];
  let attempt = latestAttempt;
  const deps = makeRouteDeps({
    ts: () => '00:00:00.000',
    featureFlags: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: true },
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    MAX_UPLOAD_ATTACHMENTS: 6,
    uuidv4: () => crypto.randomUUID(),
    config: { authToken: 'test-token', port: 4999, ...config },
    remotePath: '',
    uploadsDir,
    uploadReadDirs: [uploadsDir],
    uploadPathForSha: (sha) => path.join(uploadsDir, sha),
    getOpenAIProviderSettings: () => ({
      configured: true,
      enabled: true,
      apiKey: 'sk-test-key',
      baseUrl: FAKE_OPENAI_BASE_URL,
      model,
      models: [],
    }),
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    stmts: {
      getOperation: { get: (id) => (id === operation.id ? operation : null) },
      listNodesForOperation: { all: () => [] },
      findQById: { get: () => ({ id: 'q-1', image_operation_id: operation.id, processing_at: '2026-10-24T10:00:00.000Z' }) },
      getLatestAttempt: { get: () => attempt },
      insertAttempt: {
        run: (row) => {
          inserted.push(row);
          attempt = { id: row.id, attempt_number: row.attemptNumber, status: 'started', started_at: row.startedAt };
        },
      },
      finishAttempt: {
        run: (row) => {
          finished.push(row);
          attempt = { ...attempt, status: row.status, error_code: row.errorCode, error_message: row.errorMessage };
        },
      },
      listAssets: { all: () => assets },
    },
  });
  return { deps, finished, inserted };
}

export function executeImageOperation(deps) {
  return invokeRoute(captureRoutes(deps), 'POST', '/api/image-operations/:operationId/execute', { params: { operationId: 'img_op_demo' } });
}
