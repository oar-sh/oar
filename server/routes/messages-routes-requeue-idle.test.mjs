import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import {
  makeRouteDeps as baseRouteDeps,
  captureRoutes,
  invokeRoute,
} from './messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { applySchema } from '../db-schema.mjs';

// A requeue that ends the worker's turn without a response (a dropped
// continuation, a row of the other billing handed back) tells the registry
// the worker is idle. A delivery left the entry 'processing', and since a
// reuse no longer writes 'ready' over it, the relay would otherwise show the
// session busy until its next delivery. A steering-held hand-back is not
// such an end: the worker's live turn goes on.

const CONV = 'conv-idle-4b19';
const RUNTIME_SESSION_ID = 'rs-idle-4b19';
const MODEL = 'claude-sonnet-5';
const NOW = '2026-01-01T00:00:00.000Z';

function seed(db) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(CONV, 'Idle after requeue', CONV, NOW, NOW);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
    VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)
  `).run(RUNTIME_SESSION_ID, CONV, CONV, `runtime-key-${RUNTIME_SESSION_ID}`, MODEL, MODEL, NOW, NOW);
}

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  seed(db);
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
  };
  const registry = createSessionWorkerRegistry();
  const idleMarks = [];
  const queueCounts = () => {
    const map = Object.fromEntries(
      db.prepare(`SELECT status, COUNT(*) AS cnt FROM queue GROUP BY status`).all().map((row) => [row.status, row.cnt]),
    );
    return { pendingCount: map.pending || 0, processingCount: map.processing || 0, parkedCount: map.parked || 0 };
  };
  const deps = baseRouteDeps({
    db,
    stmts,
    io: {
      emit: () => {},
      volatile: { emit: () => {} },
    },
    uuidv4: () => crypto.randomUUID(),
    ts: () => new Date().toISOString(),
    MAX_UPLOAD_ATTACHMENTS: 4,
    MAX_REQUEUE_RETRIES: 5,
    ensureSessionId: () => 'client-idle-1',
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: 0 }),
    attachmentSummary: () => '',
    parseAttachments: (raw) => {
      try {
        return JSON.parse(raw || '[]') || [];
      } catch {
        return [];
      }
    },
    hydrateAttachment: (value) => value,
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    getClaudeProviderSettings: () => ({ enabled: true, model: MODEL, models: [MODEL] }),
    workspaceRootPayload: () => ({}),
    queueCounts,
    emitToClientsExceptSessionId: () => {},
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 4000),
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    runtimeState: {},
    sessionWorkerRegistry: registry,
    sessionWorkerSupervisor: {
      markIdle: (sessionId, depth) => { idleMarks.push({ sessionId, depth }); },
    },
  });
  const routes = captureRoutes(deps);
  const headers = { 'x-relay-session-id': CONV };
  const post = (routePath, body) => invokeRoute(routes, 'POST', routePath, { body, headers });
  const pending = () => invokeRoute(routes, 'GET', '/api/pending', { headers });
  return { db, stmts, registry, idleMarks, post, pending };
}

// Sends a message and has the session's worker claim it: the registry entry
// is 'processing' afterwards, as a delivery leaves it.
async function claimTurn(fx) {
  const { status, body } = await fx.post('/api/message', {
    clientId: 'client-idle-1',
    conversationId: CONV,
    text: 'summarise the log',
    model: MODEL,
    relayMode: 'agent',
  });
  assert.equal(status, 200, `enqueue should succeed: ${JSON.stringify(body)}`);
  const claimed = await fx.pending();
  assert.equal(claimed.body?.message?.id, body.messageId, 'the worker claims the row');
  assert.equal(fx.registry.getWorker(CONV)?.status, 'processing');
  fx.idleMarks.length = 0;
  return { messageId: body.messageId, attemptId: claimed.body.message.attemptId };
}

test('a dropped continuation marks its worker idle', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fx = boot();
  const { messageId, attemptId } = await claimTurn(fx);
  fx.db.prepare(`UPDATE queue SET kind = 'continuation' WHERE id = ?`).run(messageId);

  const res = await fx.post('/api/requeue', { messageId, attemptId });

  assert.deepEqual(res.body, { ok: true, dropped: 'continuation' });
  assert.equal(fx.stmts.findQById.get(messageId).status, 'failed');
  assert.equal(fx.registry.getWorker(CONV)?.status, 'ready');
  assert.deepEqual(fx.idleMarks.map((mark) => mark.sessionId), [CONV]);
});

test('a row of the other billing handed back marks its worker idle', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fx = boot();
  const { messageId, attemptId } = await claimTurn(fx);

  const res = await fx.post('/api/requeue', { messageId, attemptId, class: 'kind-mismatch' });

  assert.deepEqual(res.body, { ok: true, held: true });
  assert.equal(fx.stmts.findQById.get(messageId).status, 'pending');
  assert.equal(fx.registry.getWorker(CONV)?.status, 'ready');
  assert.deepEqual(fx.idleMarks, [{ sessionId: CONV, depth: 1 }], 'the row waits again and counts in the depth');
});

test('a steering-held hand-back leaves its worker processing: its live turn goes on', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fx = boot();
  const { messageId, attemptId } = await claimTurn(fx);

  const res = await fx.post('/api/requeue', { messageId, attemptId, class: 'steering-held' });

  assert.deepEqual(res.body, { ok: true, held: true });
  assert.equal(fx.stmts.findQById.get(messageId).status, 'pending');
  assert.equal(fx.registry.getWorker(CONV)?.status, 'processing');
  assert.deepEqual(fx.idleMarks, []);
});

test('the provider-mismatch code takes no branch of its own: the row is requeued with a retry', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fx = boot();
  const { messageId, attemptId } = await claimTurn(fx);

  const res = await fx.post('/api/requeue', { messageId, attemptId, code: 'relay.provider-mismatch' });

  assert.deepEqual(res.body, { ok: true });
  const row = fx.stmts.findQById.get(messageId);
  assert.equal(row.status, 'pending');
  assert.equal(row.retry_count, 1);
});
