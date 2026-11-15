import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes } from './messages-routes.mjs';
import {
  RELAY_SHUTDOWN_QUEUED_REASON,
  isRelayShutdownQueued,
  queuedShutdownCanProceed,
} from '../services/relay-shutdown-gate.mjs';

// registerMessagesRoutes prepares every statement it owns: the db stub
// answers all of them with nothing.
function makeDb() {
  return {
    prepare: () => ({ all: () => [], get: () => null, run: () => ({ changes: 0 }) }),
    transaction: (fn) => fn,
  };
}

function makeStmts() {
  const generic = { run: () => ({ changes: 0 }), get: () => null, all: () => [] };
  return new Proxy({}, { get: () => generic });
}

function pendingHandler(deps) {
  let handler = null;
  const app = {
    get(registeredPath, ...handlers) {
      if (registeredPath === '/api/pending') handler = handlers[handlers.length - 1];
    },
    post() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, 'the pending route should be registered');
  return handler;
}

// The poller names its session, as every caller of the route does.
async function invokePending(handler, headers = { 'x-relay-session-id': 'sess-gate-4c1d' }) {
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await handler({ params: {}, body: {}, headers, query: {} }, res);
  return captured;
}

function makeDeps({ runtimeState, calls }) {
  return {
    auth: (_req, _res, next) => next(),
    db: makeDb(),
    stmts: makeStmts(),
    io: { emit: () => {} },
    touchCli: () => {},
    ts: () => '2026-01-01T00:00:00.000Z',
    uuidv4: () => 'generated-id',
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'agent',
    MAX_UPLOAD_BYTES: 1024 * 1024,
    runtimeState,
    // The first thing the route does past its gates: reaching it means a
    // dequeue was attempted.
    queueCounts: () => {
      calls.push('queueCounts');
      return { pendingCount: 1, processingCount: 1, parkedCount: 0 };
    },
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {},
  };
}

test('a queued restart stops the pending route from handing out rows', async () => {
  const calls = [];
  const runtimeState = {
    relayPaused: false,
    relayShutdownQueued: true,
    relayShutdown: { status: 'queued', action: 'restart', restart: true },
  };
  const { status, body } = await invokePending(pendingHandler(makeDeps({ runtimeState, calls })));

  assert.equal(status, 200);
  assert.equal(body.message, null);
  assert.equal(body.paused, true);
  assert.equal(body.reason, RELAY_SHUTDOWN_QUEUED_REASON);
  assert.equal(body.relayShutdown.action, 'restart');
  assert.deepEqual(calls, [], 'no dequeue is attempted while the restart is queued');
});

test('without a queued restart the pending route goes on to dequeue', async () => {
  const calls = [];
  const runtimeState = { relayPaused: false, relayShutdownQueued: false, relayShutdown: { status: 'idle' } };
  const { body } = await invokePending(pendingHandler(makeDeps({ runtimeState, calls })));

  assert.notEqual(body?.reason, RELAY_SHUTDOWN_QUEUED_REASON);
  assert.equal(calls[0], 'queueCounts', 'the route reaches the dequeue');
});

test('a poller that names no session is refused before any gate or dequeue', async () => {
  const calls = [];
  const runtimeState = { relayPaused: false, relayShutdownQueued: false, relayShutdown: { status: 'idle' } };
  const { status, body } = await invokePending(pendingHandler(makeDeps({ runtimeState, calls })), {});

  assert.equal(status, 400);
  assert.match(body.error, /x-relay-session-id/);
  assert.deepEqual(calls, [], 'no dequeue is attempted');
});

test('the queued shutdown waits for processing turns only', () => {
  // A new message enqueued after the restart was queued does not hold it.
  assert.equal(queuedShutdownCanProceed({ pendingCount: 3, processingCount: 1, parkedCount: 1 }), false);
  assert.equal(queuedShutdownCanProceed({ pendingCount: 3, processingCount: 0, parkedCount: 1 }), true);
  assert.equal(queuedShutdownCanProceed({ pendingCount: 0, processingCount: 0, parkedCount: 0 }), true);
  assert.equal(queuedShutdownCanProceed(null), true);
});

test('the gate reads the runtime flag or the shutdown state', () => {
  assert.equal(isRelayShutdownQueued({ relayShutdownQueued: true }), true);
  assert.equal(isRelayShutdownQueued({ relayShutdown: { status: 'queued' } }), true);
  assert.equal(isRelayShutdownQueued({ relayShutdown: { status: 'shutting_down' } }), false);
  assert.equal(isRelayShutdownQueued({ relayShutdown: { status: 'idle' } }), false);
  assert.equal(isRelayShutdownQueued(null), false);
  // With the flag the shutdown state (which counts the queue) is never read.
  const flagged = { relayShutdownQueued: false, get relayShutdown() { throw new Error('read the state'); } };
  assert.equal(isRelayShutdownQueued(flagged), false);
});
