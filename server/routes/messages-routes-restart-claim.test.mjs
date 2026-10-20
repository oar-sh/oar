import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes } from './messages-routes.mjs';

// A worker's heartbeat that lists a turn claims it: a turn that was running
// when the relay started and that its worker still has was not cut off by
// the restart (services/restart-resume-service.mjs, outcome `claimed`).

function heartbeatHandler(deps) {
  let handler = null;
  const app = {
    get() {},
    post(registeredPath, ...handlers) {
      if (registeredPath === '/api/heartbeat') handler = handlers[handlers.length - 1];
    },
    patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, 'the heartbeat route should be registered');
  return handler;
}

function makeDeps(outcomes) {
  const generic = { run: () => ({ changes: 0 }), get: () => null, all: () => [] };
  return {
    auth: (_req, _res, next) => next(),
    db: { prepare: () => generic, transaction: (fn) => fn },
    stmts: new Proxy({}, { get: () => generic }),
    io: { emit: () => {} },
    touchCli: () => {},
    uuidv4: () => 'generated-id',
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'agent',
    MAX_UPLOAD_BYTES: 1024 * 1024,
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    runtimeState: {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 1, parkedCount: 0 }),
    sessionWorkerRegistry: { getWorker: () => null, upsertWorker: () => {} },
    sessionWorkerSupervisor: {},
    relayBridgeOwnerService: { normalizeIdentity: (identity) => ({ ...identity, pid: Number(identity.pid) || null }) },
    noteRestartTurnOutcome: (row, outcome) => outcomes.push([row?.id, outcome]),
  };
}

async function beat(handler, body) {
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  const headers = { 'x-relay-session-id': 'sess-fixture', 'x-relay-conversation-id': 'conv-fixture', 'x-relay-process-pid': '4242' };
  await handler({ params: {}, body, headers, query: {}, get: (name) => headers[String(name).toLowerCase()] }, res);
  return captured;
}

test('a heartbeat that lists its turns claims each of them', async () => {
  const outcomes = [];
  const handler = heartbeatHandler(makeDeps(outcomes));
  const { status } = await beat(handler, { activeQueueMessageId: 'q-turn', activeQueueMessageIds: ['q-turn', 'q-continuation'] });
  assert.equal(status, 200);
  assert.deepEqual(outcomes, [['q-turn', 'claimed'], ['q-continuation', 'claimed']]);
});

test('an idle heartbeat claims nothing', async () => {
  const outcomes = [];
  const handler = heartbeatHandler(makeDeps(outcomes));
  await beat(handler, { activeQueueMessageId: '' });
  assert.deepEqual(outcomes.filter(([, outcome]) => outcome === 'claimed'), []);
});
