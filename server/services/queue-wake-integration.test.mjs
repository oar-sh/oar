// The queue wake end to end, on a real database: the queue's own triggers
// (queue-wake-hook.mjs) → the waker and the primer (queue-waker.mjs) → the
// worker socket service's notify and due timer → the real claim
// (dequeuePendingMessage). Only the worker sockets and the supervisor's
// launch are stubbed. The poll is set to 10 s, so whatever happens within a
// second here was not the poll.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { dequeuePendingMessage } from '../routes/messages-routes.mjs';
import { installQueueWakeHook } from './queue-wake-hook.mjs';
import { createPendingWorkerPrimer, createQueueWaker } from './queue-waker.mjs';
import { createSessionWorkerWebSocketService } from './session-worker-websocket-service.mjs';

let lastWss = null;
class FakeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.sockets = [];
    lastWss = this;
  }

  handleUpgrade(_req, _socket, _head, done) {
    const ws = new FakeSocket();
    this.sockets.push(ws);
    done(ws);
  }

  close() {}
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) { this.sent.push(JSON.parse(String(payload))); }

  close() { this.readyState = 3; }
}

const iso = (ms) => new Date(ms).toISOString();

function startRelay(t) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createMessageRepository(db);
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'Demo', 'active', ?, ?)`).run(iso(Date.now()), iso(Date.now()));
  const ensured = [];
  const httpServer = new EventEmitter();
  let waker = null;
  const hook = installQueueWakeHook(db, { onWake: (reason) => { waker?.wake(reason, { prime: false }); } });
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'tok',
    queueCounts: () => {
      const map = Object.fromEntries(stmts.countStatus.all().map((row) => [row.status, row.cnt]));
      return { pendingCount: map.pending || 0, processingCount: map.processing || 0, parkedCount: map.parked || 0 };
    },
    requestWork: async ({ sessionId }) => {
      const claimed = dequeuePendingMessage({ db, stmts, nowIso: iso(Date.now()), routingEnabled: true, requesterSessionId: sessionId });
      return claimed ? { message: claimed } : null;
    },
    nextDueAtMs: () => {
      const due = stmts.nextPendingAttemptAt.get(iso(Date.now()))?.due;
      return due ? Date.parse(due) : null;
    },
    onDue: (reason) => { waker.wake(reason); },
    pollIntervalMs: 10_000,
    logger: { debug() {}, warn() {} },
  });
  const prime = createPendingWorkerPrimer({
    listPendingOwnerSessionIds: (limit) => stmts.listPendingWorkerOwnerSessionIds.all(limit),
    ensureWorker: async (sid) => { ensured.push({ sid, at: Date.now() }); return { ok: true }; },
  });
  waker = createQueueWaker({
    prime,
    notify: (reason) => { void service.notifyQueueChanged(reason); },
  });
  service.start();
  t.after(() => service.stop());

  function connect(sessionId) {
    httpServer.emit('upgrade', { url: `/api/session-worker/ws?sessionId=${sessionId}&pid=${process.pid}`, headers: { host: 'localhost', authorization: 'Bearer tok' } }, {}, Buffer.alloc(0));
    const socket = lastWss.sockets.at(-1);
    socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'ws-open' }));
    return socket;
  }
  function insert(id, { owner = 'sdk-1', status = 'pending', mode = 'agent', ts = Date.now(), next = null, usageLimitPause = null } = {}) {
    db.prepare(`
      INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, relay_mode, usage_limit_pause)
      VALUES (?, 'conv-1', 0, 'hello', ?, ?, 0, ?, ?, ?, ?)
    `).run(id, status, iso(ts), next, owner, mode, usageLimitPause);
  }
  return { db, stmts, hook, connect, insert, ensured };
}

const delivered = (socket) => socket.sent.filter((frame) => frame.type === 'queue.deliver').map((frame) => frame.pending.message.id);

async function waitFor(check, label, timeoutMs) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`not within ${timeoutMs} ms: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Date.now() - started;
}

test('a prompt queued for an idle worker reaches it within a second', async (t) => {
  const relay = startRelay(t);
  assert.equal(relay.hook.installed, true);
  const socket = relay.connect('sdk-1');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(delivered(socket), []);
  relay.insert('q-1');
  await waitFor(() => delivered(socket).includes('q-1'), 'q-1 delivered', 1_000);
});

test('a cancelled row frees the plan-boundary hold and the next row goes within a second', async (t) => {
  const relay = startRelay(t);
  const now = Date.now();
  // A plan turn runs; an agent-mode follow-up waits behind the plan boundary,
  // and a plan-mode row behind that one.
  relay.insert('q-live', { status: 'processing', mode: 'plan', ts: now - 3_000 });
  relay.insert('q-held', { mode: 'agent', ts: now - 2_000 });
  relay.insert('q-next', { mode: 'plan', ts: now - 1_000 });
  const socket = relay.connect('sdk-1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(delivered(socket), [], 'the hold keeps both back');
  relay.db.prepare(`DELETE FROM queue WHERE id = 'q-held'`).run();
  await waitFor(() => delivered(socket).includes('q-next'), 'q-next after the cancel', 1_000);
});

test('a usage-limit hold that ends with no worker running gets its worker primed', async (t) => {
  const relay = startRelay(t);
  const heldUntil = Date.now() + 300;
  relay.insert('q-held', { owner: 'sdk-sleeping', next: iso(heldUntil), usageLimitPause: '{"resetsAt":1}' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(relay.ensured, [], 'held: not work waiting for a worker yet');
  await waitFor(() => relay.ensured.some((entry) => entry.sid === 'sdk-sleeping'), 'worker primed at the end of the hold', 1_500);
  const primedAt = relay.ensured.find((entry) => entry.sid === 'sdk-sleeping').at;
  assert.ok(primedAt >= heldUntil, 'not before the hold ended');
  assert.ok(primedAt - heldUntil < 1_000, `on time (${primedAt - heldUntil} ms after)`);
});

test('a retry in backoff goes to its ready worker when the backoff ends, not at the next poll', async (t) => {
  const relay = startRelay(t);
  const socket = relay.connect('sdk-1');
  const retryAt = Date.now() + 300;
  relay.insert('q-retry', { status: 'processing' });
  relay.db.prepare(`UPDATE queue SET status = 'pending', next_attempt_at = ? WHERE id = 'q-retry'`).run(iso(retryAt));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(delivered(socket), [], 'still in backoff');
  await waitFor(() => delivered(socket).includes('q-retry'), 'retry delivered', 1_500);
  assert.ok(Date.now() >= retryAt);
});
