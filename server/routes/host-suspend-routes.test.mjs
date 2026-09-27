import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { registerMessagesRoutes } from './messages-routes.mjs';
import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';

// Sessions routes prepare many statements at registration; the harness db stub
// absorbs them. Only the deps the suspend routes touch are real here.
function sessionsDeps(overrides = {}) {
  return makeRouteDeps({
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
      exec() {},
    },
    io: { emit() {} },
    hostSuspendPlatform: 'win32',
    runtimeState: { hostSuspend: { status: 'idle', pending: false }, relayShutdown: { status: 'idle' } },
    config: {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    backgroundTaskStore: { get: () => [], sets: new Map() },
    sessionWorkerRegistry: { getWorker: () => null, getWorkerByConversationId: () => null, listWorkers: () => [] },
    ...overrides,
  });
}

function fakeHostSuspendService(initial = { status: 'idle', pending: false, blockers: [] }) {
  let state = { ...initial };
  const calls = [];
  return {
    calls,
    refresh() { calls.push('refresh'); return state; },
    getState() { return state; },
    request(args) {
      calls.push(['request', args]);
      state = { status: 'queued', pending: true, blockers: [{ kind: 'turn', title: 'report builder', detail: 'turn running' }], requestedBy: args.requestedBy };
      return { accepted: true, state };
    },
    cancel(args) {
      calls.push(['cancel', args]);
      const wasPending = state.pending;
      state = { status: 'idle', pending: false, blockers: [] };
      return { cancelled: wasPending, state };
    },
  };
}

test('GET /api/host/suspend peeks at activity when nothing is queued', async () => {
  const service = fakeHostSuspendService();
  const routes = captureRoutes(sessionsDeps({
    hostSuspendService: service,
    collectHostActivity: ({ request }) => {
      assert.equal(request, null);
      return { blockers: [{ kind: 'background', title: 'sidebar polish', count: 2, detail: '2 background agents' }] };
    },
  }), registerSessionsRoutes);
  const { status, body } = await invokeRoute(routes, 'GET', '/api/host/suspend');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.state.pending, false);
  assert.equal(body.blockers[0].title, 'sidebar polish');
  assert.deepEqual(service.calls, ['refresh']);
});

test('GET /api/host/suspend returns the service blockers once queued, without re-collecting', async () => {
  const service = fakeHostSuspendService({ status: 'queued', pending: true, blockers: [{ kind: 'turn', title: 'report builder', detail: 'turn running' }] });
  const routes = captureRoutes(sessionsDeps({
    hostSuspendService: service,
    collectHostActivity: () => { throw new Error('must not collect while pending'); },
  }), registerSessionsRoutes);
  const { body } = await invokeRoute(routes, 'GET', '/api/host/suspend');
  assert.equal(body.state.status, 'queued');
  assert.equal(body.blockers[0].title, 'report builder');
  assert.equal(body.activity, null);
});

test('POST /api/host/suspend queues through the service and answers 202 with the state', async () => {
  const service = fakeHostSuspendService();
  const routes = captureRoutes(sessionsDeps({ hostSuspendService: service }), registerSessionsRoutes);
  const { status, body } = await invokeRoute(routes, 'POST', '/api/host/suspend', { body: { requestedBy: 'phone', reason: 'bedtime' } });
  assert.equal(status, 202);
  assert.equal(body.queued, true);
  assert.equal(body.accepted, true);
  assert.equal(body.state.status, 'queued');
  assert.deepEqual(service.calls[0], ['request', { reason: 'bedtime', requestedBy: 'phone' }]);
});

test('POST /api/host/suspend/cancel withdraws the queued suspend', async () => {
  const service = fakeHostSuspendService({ status: 'queued', pending: true, blockers: [] });
  const routes = captureRoutes(sessionsDeps({ hostSuspendService: service }), registerSessionsRoutes);
  const { status, body } = await invokeRoute(routes, 'POST', '/api/host/suspend/cancel', { body: { requestedBy: 'phone' } });
  assert.equal(status, 200);
  assert.equal(body.cancelled, true);
  assert.equal(body.state.status, 'idle');
});

test('POST /api/host/suspend refuses on a non-Windows relay host without touching the service', async () => {
  const service = fakeHostSuspendService();
  const routes = captureRoutes(sessionsDeps({ hostSuspendService: service, hostSuspendPlatform: 'linux' }), registerSessionsRoutes);
  const post = await invokeRoute(routes, 'POST', '/api/host/suspend');
  assert.equal(post.status, 501);
  assert.deepEqual(service.calls, []);
  const get = await invokeRoute(routes, 'GET', '/api/host/suspend');
  assert.equal(get.body.supported, false);
});

test('host suspend routes answer 501 when the service is not wired', async () => {
  const routes = captureRoutes(sessionsDeps({ hostSuspendService: null }), registerSessionsRoutes);
  const get = await invokeRoute(routes, 'GET', '/api/host/suspend');
  assert.equal(get.status, 501);
  const post = await invokeRoute(routes, 'POST', '/api/host/suspend');
  assert.equal(post.status, 501);
});

test('POST /api/relay/shutdown/cancel is localhost-only and forwards to cancelRelayShutdown', async () => {
  const calls = [];
  const routes = captureRoutes(makeRouteDeps({
    cancelRelayShutdown: (args) => { calls.push(args); return { cancelled: true, status: 'idle' }; },
    requestRelayShutdown: () => ({ accepted: true }),
  }), registerMessagesRoutes);
  const remote = await invokeRoute(routes, 'POST', '/api/relay/shutdown/cancel', { socket: { remoteAddress: '10.0.0.5' } });
  assert.equal(remote.status, 403);
  const local = await invokeRoute(routes, 'POST', '/api/relay/shutdown/cancel', { socket: { remoteAddress: '127.0.0.1' }, body: { requestedBy: 'phone' } });
  assert.equal(local.status, 200);
  assert.equal(local.body.cancelled, true);
  assert.deepEqual(calls, [{ requestedBy: 'phone' }]);
});
