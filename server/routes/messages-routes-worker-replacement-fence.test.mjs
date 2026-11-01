import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createWorkerReplacementFence } from '../services/worker-replacement.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from '../services/session-worker-supervisor-service.mjs';
import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';

// GET /api/pending and the replacement fence (services/worker-replacement.mjs):
// while the worker recycle replaces a session's worker process, that process
// is handed no work, so no turn starts on the pid being stopped; another pid
// of the session (the new worker) takes what waited. Against the REAL schema
// and claim statements, through the shared route harness.

const CONV = 'conv-replace-1';
const SID = 'sid-replace-1';
const NOW = '2026-10-30T12:00:00.000Z';
const OLD_PID = 4100;
const NEW_PID = 4200;

function boot({ wrapStmts = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, 'Replace', ?, ?, ?)`).run(CONV, SID, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES ('rs-1', ?, ?, 'rs-1', 'gpt-5.4-mini', 'github', 'gpt-5.4-mini', ?, ?)
  `).run(CONV, SID, NOW, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const fence = createWorkerReplacementFence();
  // A test may wrap a statement (one that fails once, say), with the fence at hand.
  if (typeof wrapStmts === 'function') wrapStmts(stmts, fence);
  const enqueue = (id) => db.prepare(`
    INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp, owner_sdk_session_id)
    VALUES (?, ?, 'rs-1', 'hello', 'pending', ?, ?)
  `).run(id, CONV, NOW, SID);
  const row = (id) => db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({ registry, spawnWorker: async () => ({ workerId: 'w', pid: null }), isPidAlive: () => true });
  const deps = makeRouteDeps({
    db,
    stmts,
    io: { emit() {}, volatile: { emit() {} } },
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    configuredConversationSessionMode: 'isolated',
    DEFAULT_RELAY_MODE: 'agent',
    // The pid rides the request as the workers send it.
    relayBridgeOwnerService: {
      normalizeIdentity: ({ sessionId, pid } = {}) => {
        const sid = String(sessionId || '').trim();
        const n = Number(pid);
        return sid ? { sessionId: sid, pid: Number.isInteger(n) && n > 0 ? n : null } : null;
      },
      observe: () => ({ accepted: true }),
    },
    sessionWorkerRegistry: registry,
    sessionWorkerSupervisor: supervisor,
    workerReplacementFence: fence,
    runtimeState: { featureFlags: {}, relayPaused: false },
    ts: () => NOW,
    uuidv4: () => 'uuid-1',
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || 'agent',
    getCursorProviderSettings: () => ({ enabledModels: [] }),
    getClaudeCloudProviderSettings: () => null,
    emitSessionWorkerTelemetry: () => {},
  });
  const routes = captureRoutes(deps);
  const pendingAs = (pid) => invokeRoute(routes, 'GET', '/api/pending', {
    headers: { 'x-relay-session-id': SID, ...(pid ? { 'x-relay-process-pid': String(pid) } : {}) },
  });
  return { db, enqueue, row, fence, supervisor, pendingAs };
}

test('GET /api/pending hands no work to the pid being replaced; the row waits', async () => {
  const app = boot();
  app.enqueue('q-1');
  app.fence.hold(SID, OLD_PID);
  const { status, body } = await app.pendingAs(OLD_PID);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.message ?? null, null);
  assert.equal(body.routing?.blockedReason, 'worker-replacement');
  assert.equal(app.row('q-1').status, 'pending');
  assert.equal(app.row('q-1').attempt_id, null);
  // A poll that names no pid cannot be told from the old process.
  assert.equal((await app.pendingAs(null)).body.message ?? null, null);
  assert.equal(app.row('q-1').status, 'pending');
});

test('GET /api/pending: another pid of the session (the new worker) takes the waiting row', async () => {
  const app = boot();
  app.enqueue('q-1');
  app.fence.hold(SID, OLD_PID);
  const { body } = await app.pendingAs(NEW_PID);
  assert.equal(body.message?.id, 'q-1', JSON.stringify(body));
  assert.equal(app.row('q-1').status, 'processing');
});

test('GET /api/pending: once the fence is released the old pid is served again', async () => {
  const app = boot();
  app.enqueue('q-1');
  app.fence.hold(SID, OLD_PID);
  assert.equal((await app.pendingAs(OLD_PID)).body.message ?? null, null);
  app.fence.release(SID, OLD_PID);
  const { body } = await app.pendingAs(OLD_PID);
  assert.equal(body.message?.id, 'q-1', JSON.stringify(body));
});

test('GET /api/pending: lifting the killed marker leaves the fence refusing the old pid', async () => {
  // A relaunch elsewhere calls clearRestartSchedule with resetKilledMarker,
  // after which the killed check no longer refuses; the fence still does.
  const app = boot();
  app.enqueue('q-1');
  app.supervisor.markKilled(SID);
  app.fence.hold(SID, OLD_PID);
  assert.equal((await app.pendingAs(OLD_PID)).body.routing?.blockedReason, 'session-killed');
  app.supervisor.clearRestartSchedule(SID, { resetKilledMarker: true });
  const { body } = await app.pendingAs(OLD_PID);
  assert.equal(body.message ?? null, null);
  assert.equal(body.routing?.blockedReason, 'worker-replacement');
  assert.equal(app.row('q-1').status, 'pending');
});

test('GET /api/pending: a fence raised during a transient error\'s backoff stops the retry from claiming the row', async () => {
  let failures = 0;
  const app = boot({
    wrapStmts: (stmts, fence) => {
      const claim = stmts.findPendingForWorker;
      stmts.findPendingForWorker = {
        get: (...args) => {
          if (failures === 0) {
            failures += 1;
            // The recycle passes its holds for the old pid while the loop
            // waits out the backoff (25 ms; this fires first).
            setTimeout(() => fence.hold(SID, OLD_PID), 0);
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          }
          return claim.get(...args);
        },
      };
    },
  });
  app.enqueue('q-1');
  const { status, body } = await app.pendingAs(OLD_PID);
  assert.equal(failures, 1, 'the first attempt hit the transient error');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.message ?? null, null);
  assert.equal(body.routing?.blockedReason, 'worker-replacement');
  assert.equal(app.row('q-1').status, 'pending');
  assert.equal(app.row('q-1').attempt_id, null);
  // The new worker takes it.
  assert.equal((await app.pendingAs(NEW_PID)).body.message?.id, 'q-1');
});
