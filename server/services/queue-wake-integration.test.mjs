// The queue wake end to end, on a real database: the queue's own triggers
// (queue-wake-hook.mjs) → the waker and the primer (queue-waker.mjs) → the
// worker socket service's notify and due timer → the real claim
// (dequeuePendingMessage). Only the worker sockets and the supervisor's
// launch are stubbed. The poll is set far beyond any test here, so it never
// runs: every delivery and every prime comes from one of the event-driven
// wakes, and each test names which one (a frame's reason, a prime's reason).
// The tests wait for the frame or the prime itself; the guard on a wait only
// stops a hang and says nothing about time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { dequeuePendingMessage } from '../routes/messages-worker-claim-routes.mjs';
import { installQueueWakeHook } from './queue-wake-hook.mjs';
import { createPendingWorkerPrimer, createQueueWaker } from './queue-waker.mjs';
import { createSessionWorkerWebSocketService } from './session-worker-websocket-service.mjs';

const POLL_OFF_MS = 3_600_000;
const HANG_GUARD_MS = 30_000;
// Above the guard, so a hang reports the guard's message.
const TEST_TIMEOUT_MS = 2 * HANG_GUARD_MS;

// The wake reasons a delivery or a prime carries: the queue-wake hook's
// trigger reasons and the socket service's due timer.
const WAKE_INSERT = 'insert';
const WAKE_DELETE = 'delete';
const WAKE_DUE = 'retry-due';

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

  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
    this.emit('sent');
  }

  close() { this.readyState = 3; }
}

const iso = (ms) => new Date(ms).toISOString();

function startRelay(t) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createMessageRepository(db);
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'Demo', 'active', ?, ?)`).run(iso(Date.now()), iso(Date.now()));
  // Every frame, claim and prime: a wait re-reads its condition.
  const changes = new EventEmitter();
  const changed = () => changes.emit('change');
  // The clock of the claim, the due time and the service: the wall clock,
  // unless a test holds it at one instant (every claim made meanwhile sees
  // that instant, however slow the machine).
  let heldAt = null;
  const clock = {
    now: () => heldAt ?? Date.now(),
    hold: () => { heldAt = Date.now(); return heldAt; },
    holdAt: (ms) => { heldAt = ms; },
    release: () => { heldAt = null; },
  };
  const claims = [];
  // Called with each claim as it is made, before the wake that made it goes on.
  let onClaim = null;
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
    requestWork: async ({ sessionId, reason }) => {
      const claimed = dequeuePendingMessage({ db, stmts, nowIso: iso(clock.now()), requesterSessionId: sessionId });
      claims.push({ reason, id: claimed?.id ?? null });
      onClaim?.(claims.at(-1));
      changed();
      return claimed ? { message: claimed } : null;
    },
    nextDueAtMs: () => {
      const due = stmts.nextPendingAttemptAt.get(iso(clock.now()))?.due;
      return due ? Date.parse(due) : null;
    },
    onDue: (reason) => { waker.wake(reason); },
    pollIntervalMs: POLL_OFF_MS,
    nowMs: clock.now,
    nowIso: () => iso(clock.now()),
    logger: { debug() {}, warn() {} },
  });
  // Primes never overlap (the waker runs one at a time), so the reason of
  // the pass that launches a worker is the one running.
  let primeReason = null;
  const primeOnce = createPendingWorkerPrimer({
    listPendingOwnerSessionIds: (limit) => stmts.listPendingWorkerOwnerSessionIds.all(limit),
    ensureWorker: async (sid) => {
      ensured.push({ sid, at: Date.now(), reason: primeReason });
      changed();
      return { ok: true };
    },
  });
  const prime = async (reason) => {
    primeReason = reason;
    try { return await primeOnce(reason); } finally { primeReason = null; }
  };
  waker = createQueueWaker({
    prime,
    notify: (reason) => { void service.notifyQueueChanged(reason); },
  });
  service.start();
  t.after(() => service.stop());

  function connect(sessionId) {
    httpServer.emit('upgrade', { url: `/api/session-worker/ws?sessionId=${sessionId}&pid=${process.pid}`, headers: { host: 'localhost', authorization: 'Bearer tok' } }, {}, Buffer.alloc(0));
    const socket = lastWss.sockets.at(-1);
    socket.on('sent', changed);
    socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'ws-open' }));
    return socket;
  }
  function insert(id, { owner = 'sdk-1', status = 'pending', mode = 'agent', ts = Date.now(), next = null, usageLimitPause = null } = {}) {
    db.prepare(`
      INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, relay_mode, usage_limit_pause)
      VALUES (?, 'conv-1', 0, 'hello', ?, ?, 0, ?, ?, ?, ?)
    `).run(id, status, iso(ts), next, owner, mode, usageLimitPause);
  }
  // Resolves with the first truthy value of `check`, re-read on every change,
  // after the step that produced it has settled (the next turn of the loop).
  function until(check, label) {
    return new Promise((resolve, reject) => {
      const finish = (then) => { clearTimeout(guard); changes.off('change', probe); then(); };
      const guard = setTimeout(() => finish(() => reject(new Error(`hung: no ${label} in ${HANG_GUARD_MS} ms`))), HANG_GUARD_MS);
      function probe() {
        const value = check();
        if (value) finish(() => setImmediate(resolve, value));
      }
      changes.on('change', probe);
      probe();
    });
  }
  const watchClaims = (fn) => { onClaim = fn; };
  return { db, stmts, hook, clock, connect, insert, claims, watchClaims, ensured, until };
}

const delivered = (socket) => socket.sent.filter((frame) => frame.type === 'queue.deliver').map((frame) => frame.pending.message.id);
const deliveryOf = (socket, id) => socket.sent.find((frame) => frame.type === 'queue.deliver' && frame.pending.message.id === id);

test('a prompt queued for an idle worker reaches it on the queue write, not at the next poll', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  assert.equal(relay.hook.installed, true);
  const socket = relay.connect('sdk-1');
  await relay.until(() => relay.claims.length > 0, 'claim on ready');
  assert.deepEqual(delivered(socket), []);
  relay.insert('q-1');
  const frame = await relay.until(() => deliveryOf(socket, 'q-1'), 'delivery of q-1');
  assert.equal(frame.reason, WAKE_INSERT, 'the insert wake delivered it');
});

test('a cancelled row frees the plan-boundary hold and the next row goes on the cancel, not at the next poll', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  const now = Date.now();
  // A plan turn runs; an agent-mode follow-up waits behind the plan boundary,
  // and a plan-mode row behind that one.
  relay.insert('q-live', { status: 'processing', mode: 'plan', ts: now - 3_000 });
  relay.insert('q-held', { mode: 'agent', ts: now - 2_000 });
  relay.insert('q-next', { mode: 'plan', ts: now - 1_000 });
  const socket = relay.connect('sdk-1');
  await relay.until(() => relay.claims.some((claim) => claim.reason === WAKE_INSERT), 'claim on the insert wake');
  assert.deepEqual(delivered(socket), [], 'the hold keeps both back');
  relay.db.prepare(`DELETE FROM queue WHERE id = 'q-held'`).run();
  const frame = await relay.until(() => deliveryOf(socket, 'q-next'), 'delivery of q-next after the cancel');
  assert.equal(frame.reason, WAKE_DELETE, 'the delete wake delivered it');
});

test('a usage-limit hold that ends with no worker running gets its worker primed by the due timer', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  const heldUntil = Date.now() + 300;
  relay.insert('q-held', { owner: 'sdk-sleeping', next: iso(heldUntil), usageLimitPause: '{"resetsAt":1}' });
  const primed = await relay.until(() => relay.ensured.find((entry) => entry.sid === 'sdk-sleeping'), 'prime of sdk-sleeping');
  assert.equal(primed.reason, WAKE_DUE, 'the due timer primed it');
  assert.ok(primed.at >= heldUntil, `not before the hold ended (${heldUntil - primed.at} ms early)`);
});

test('a retry in backoff goes to its ready worker when the backoff ends, not at the next poll', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  const socket = relay.connect('sdk-1');
  // Held: the claim on the requeue's own wake sees an instant inside the
  // backoff, so only the due timer can hand the row out.
  const retryAt = relay.clock.hold() + 300;
  relay.insert('q-retry', { status: 'processing' });
  const claimsBefore = relay.claims.length;
  relay.db.prepare(`UPDATE queue SET status = 'pending', next_attempt_at = ? WHERE id = 'q-retry'`).run(iso(retryAt));
  await relay.until(() => relay.claims.length > claimsBefore, 'claim on the requeue wake');
  assert.deepEqual(delivered(socket), [], 'still in backoff');
  relay.clock.release();
  const frame = await relay.until(() => deliveryOf(socket, 'q-retry'), 'delivery of the retry');
  assert.equal(frame.reason, WAKE_DUE, 'the due timer delivered it');
  assert.ok(frame.pending.message.processing_at >= iso(retryAt), 'not before the backoff ended');
});

test('a due timer that fires a millisecond early still hands out the retry when the clock passes its time before the re-arm', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  const socket = relay.connect('sdk-1');
  const retryAt = relay.clock.hold() + 300;
  relay.insert('q-retry', { status: 'processing' });
  const claimsBefore = relay.claims.length;
  relay.db.prepare(`UPDATE queue SET status = 'pending', next_attempt_at = ? WHERE id = 'q-retry'`).run(iso(retryAt));
  await relay.until(() => relay.claims.length > claimsBefore, 'claim on the requeue wake');
  // The due timer is armed for retryAt. By the relay's clock it fires 1 ms
  // early, so its claim is refused; the clock reaches retryAt before the
  // timer re-arms, when the due query no longer sees the row as future.
  relay.clock.holdAt(retryAt - 1);
  relay.watchClaims((claim) => {
    if (claim.reason === WAKE_DUE && claim.id === null) relay.clock.holdAt(retryAt);
  });
  const frame = await relay.until(() => deliveryOf(socket, 'q-retry'), 'delivery of the retry');
  assert.equal(frame.reason, WAKE_DUE, 'the due timer delivered it');
  assert.deepEqual(relay.claims.filter((claim) => claim.reason === WAKE_DUE).map((claim) => claim.id), [null, 'q-retry'],
    'refused at retryAt − 1, handed out from the owed re-arm');
  assert.equal(frame.pending.message.processing_at, iso(retryAt));
});
