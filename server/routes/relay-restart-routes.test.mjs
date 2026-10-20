import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRelayRestartRoutes } from './relay-restart-routes.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PICTURE = {
  waitingFor: [{ conversationId: 'c1', title: 'sidebar polish', turns: 1 }],
  held: { count: 1, conversations: [] },
  backgroundTasks: [{ conversationId: 'c2', title: 'nightly export', count: 1, detail: '1 background agent: export', survives: true }],
  survival: { action: 'restart', workersSurvive: true, summary: 'workers keep running' },
};

function routesWith(overrides = {}) {
  const calls = [];
  let stored = 30;
  const routes = captureRoutes({
    auth: (_req, _res, next) => next?.(),
    getState: () => ({ status: 'idle', action: null, queue: { processingCount: 1 } }),
    collectRestartPicture: ({ action }) => { calls.push(['picture', action]); return { ...PICTURE, survival: { ...PICTURE.survival, action } }; },
    keepWaiting: (args) => { calls.push(['keep', args]); return { extended: true, status: 'queued', question: null }; },
    getMaxWaitMinutes: () => stored,
    setMaxWaitMinutes: (minutes) => { stored = minutes; calls.push(['set', minutes]); return { ok: true, maxWaitMinutes: minutes }; },
    ...overrides,
  }, registerRelayRestartRoutes);
  return { routes, calls };
}

test('GET /api/relay/shutdown only reads: it neither fires nor asks', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'server-runtime.mjs'), 'utf8');
  assert.match(runtime, /registerRelayRestartRoutes\(app, \{[\s\S]*?getState: \(\) => relayRestartQueue\.getState\(\),/);
});

test('GET /api/relay/shutdown: the state plus what a restart asked now would wait for and leave running', async () => {
  const { routes, calls } = routesWith();
  const { status, body } = await invokeRoute(routes, 'GET', '/api/relay/shutdown');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'idle');
  assert.equal(body.preview.action, 'restart');
  assert.deepEqual(body.preview.waitingFor, PICTURE.waitingFor);
  assert.equal(body.preview.backgroundTasks[0].survives, true);
  const shutdown = await invokeRoute(routes, 'GET', '/api/relay/shutdown', { query: { action: 'shutdown' } });
  assert.equal(shutdown.body.preview.action, 'shutdown');
  assert.deepEqual(calls.map(([kind, action]) => `${kind}:${action}`), ['picture:restart', 'picture:shutdown']);
});

test('POST /api/relay/shutdown/keep-waiting passes who asked', async () => {
  const { routes, calls } = routesWith();
  const { status, body } = await invokeRoute(routes, 'POST', '/api/relay/shutdown/keep-waiting', { body: { requestedBy: 'phone' } });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.extended, true);
  assert.deepEqual(calls, [['keep', { requestedBy: 'phone' }]]);
});

test('the max-wait setting: read, store a choice, refuse anything else', async () => {
  const { routes, calls } = routesWith();
  const read = await invokeRoute(routes, 'GET', '/api/settings/relay-restart-max-wait');
  assert.equal(read.body.maxWaitMinutes, 30);
  assert.deepEqual(read.body.choices, [5, 10, 15, 30, 60, 120, 240, 0]);
  assert.equal(read.body.overrideMs, null);
  const saved = await invokeRoute(routes, 'POST', '/api/settings/relay-restart-max-wait', { body: { maxWaitMinutes: 0 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.maxWaitMinutes, 0);
  for (const bad of [3, 'soon', null, 300]) {
    const refused = await invokeRoute(routes, 'POST', '/api/settings/relay-restart-max-wait', { body: { maxWaitMinutes: bad } });
    assert.equal(refused.status, 400, String(bad));
  }
  assert.deepEqual(calls, [['set', 0]]);
});

test('without the queue the routes answer 501', async () => {
  const { routes } = routesWith({ getState: null, keepWaiting: null });
  assert.equal((await invokeRoute(routes, 'GET', '/api/relay/shutdown')).status, 501);
  assert.equal((await invokeRoute(routes, 'POST', '/api/relay/shutdown/keep-waiting')).status, 501);
});

test('POST /api/relay/shutdown passes `immediate` through, and only a true-ish one', async () => {
  const calls = [];
  const routes = captureRoutes(makeRouteDeps({
    io: { emit() {} },
    requestRelayShutdown: (args) => { calls.push(args); return { accepted: true, status: args.immediate ? 'shutting_down' : 'queued', waitingFor: PICTURE.waitingFor }; },
  }));
  const now = await invokeRoute(routes, 'POST', '/api/relay/shutdown', { body: { restart: true, immediate: true, requestedBy: 'phone' } });
  assert.equal(now.body.status, 'shutting_down');
  assert.deepEqual(now.body.waitingFor, PICTURE.waitingFor);
  await invokeRoute(routes, 'POST', '/api/relay/shutdown', { body: { restart: true, immediate: 'no' } });
  await invokeRoute(routes, 'POST', '/api/relay/shutdown', { body: { restart: true } });
  assert.deepEqual(calls.map((args) => args.immediate), [true, false, false]);
  assert.equal(calls[0].restart, true);
  assert.equal(calls[0].expectRequestedAt, null);
  await invokeRoute(routes, 'POST', '/api/relay/shutdown', { body: { restart: false, immediate: true, expectRequestedAt: '2026-10-19T08:00:00.000Z' } });
  assert.equal(calls[3].expectRequestedAt, '2026-10-19T08:00:00.000Z');
  assert.equal(calls[3].restart, false);
});
