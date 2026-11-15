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
import { reportParkedQueueAtBoot } from '../services/relay-queue-gate-service.mjs';
import { applySchema } from '../db-schema.mjs';

// A requeue never parks the row: nothing releases parked rows, so it goes
// back to pending and its worker takes it again once the retry delay has
// passed. Rows parked by an earlier version stay parked; the boot report
// (reportParkedQueueAtBoot) only counts them.

const CONV = 'conv-park-7f3a';
const RUNTIME_SESSION_ID = 'rs-park-7f3a';
const PARK_TARGET = 'sess-park-target-51c2';
const MODEL = 'claude-sonnet-5';
const NOW = '2026-01-01T00:00:00.000Z';

function seed(db) {
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(CONV, 'Parked requeue', CONV, NOW, NOW);
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
  const emitted = [];
  const deps = baseRouteDeps({
    db,
    stmts,
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: () => {} },
    },
    uuidv4: () => crypto.randomUUID(),
    ts: () => new Date().toISOString(),
    MAX_UPLOAD_ATTACHMENTS: 4,
    MAX_REQUEUE_RETRIES: 5,
    ensureSessionId: () => 'client-park-1',
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
    queueCounts: () => {
      const map = Object.fromEntries(
        db.prepare(`SELECT status, COUNT(*) AS cnt FROM queue GROUP BY status`).all().map((row) => [row.status, row.cnt]),
      );
      return { pendingCount: map.pending || 0, processingCount: map.processing || 0, parkedCount: map.parked || 0 };
    },
    emitToClientsExceptSessionId: () => {},
    sanitizeActivityText: (value) => String(value || '').trim().slice(0, 4000),
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    runtimeState: {},
  });
  const routes = captureRoutes(deps);
  const headers = { 'x-relay-session-id': CONV };
  const post = (routePath, body) => invokeRoute(routes, 'POST', routePath, { body, headers });
  // The worker's owned dequeue: GET /api/pending with its session id.
  const pending = () => invokeRoute(routes, 'GET', '/api/pending', { headers });
  const rowOf = (id) => stmts.findQById.get(id);
  return { db, stmts, post, pending, rowOf, emitted };
}

async function enqueue(post) {
  const { status, body } = await post('/api/message', {
    clientId: 'client-park-1',
    conversationId: CONV,
    text: 'list the files',
    model: MODEL,
    relayMode: 'agent',
  });
  assert.equal(status, 200, `enqueue should succeed: ${JSON.stringify(body)}`);
  return body.messageId;
}

test('a requeued row goes back to pending, not parked, and is delivered again', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fx = boot();
  const msgId = await enqueue(fx.post);

  const claimed = await fx.pending();
  assert.equal(claimed.body?.message?.id, msgId, 'the worker claims the row');

  const requeue = await fx.post('/api/requeue', { messageId: msgId, attemptId: claimed.body.message.attemptId });
  assert.equal(requeue.status, 200);
  const requeued = fx.rowOf(msgId);
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.parked_at, null);
  assert.equal(requeued.parked_transaction_id, null);
  const status = fx.emitted.filter((entry) => entry.event === 'message_status' && entry.payload.messageId === msgId).at(-1);
  assert.equal(status?.payload?.status, 'pending');

  const next = await fx.pending();
  assert.equal(next.body?.message?.id, msgId, `the requeued row is delivered again (row status: ${fx.rowOf(msgId).status})`);
  const row = fx.rowOf(msgId);
  assert.equal(row.status, 'processing');
  assert.equal(row.retry_count, 1);
  assert.equal(row.parked_at, null);
});

test('a row parked by an earlier version stays parked at boot and is only reported', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fx = boot();
  const msgId = await enqueue(fx.post);
  await fx.pending();
  // The row as an earlier version's requeue during a restart window left it.
  fx.db.prepare(`
    UPDATE queue
    SET status = 'parked', processing_at = NULL, attempt_id = NULL, retry_count = 1, next_attempt_at = NULL,
        owner_lease_expires_at = NULL, parked_at = ?, parked_target_session_id = ?, parked_transaction_id = ?, parked_reason = ?
    WHERE id = ?
  `).run(NOW, PARK_TARGET, 'tx-park-0d4e', 'manual-request', msgId);

  const lines = [];
  const report = reportParkedQueueAtBoot({ stmts: fx.stmts, log: (line) => lines.push(line) });

  assert.deepEqual(report, { count: 1, oldestParkedAt: NOW });
  assert.equal(lines.length, 1);
  const row = fx.rowOf(msgId);
  assert.equal(row.status, 'parked');
  assert.equal(row.parked_at, NOW);
  assert.equal(row.parked_transaction_id, 'tx-park-0d4e');
  assert.equal((await fx.pending()).body?.message, null, 'a parked row is not delivered');
});
