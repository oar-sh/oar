// The unarchive wakes the queue, on a real database: a row left pending in
// an archived chat is neither claimed nor woken (QUEUE_ROW_NOT_ARCHIVED_SQL),
// and the unarchive writes no queue row, so the queue's own triggers stay
// quiet. The route wakes it itself. Wired as in
// services/queue-wake-integration.test.mjs: the triggers → the waker → the
// worker socket service's notify → the real claim; only the worker sockets
// and the supervisor's launch are stubbed. The poll is set far beyond any
// test here, so it never runs; the guard on a wait only stops a hang.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import fs from 'node:fs';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository, notHeldForUsageLimit } from '../repositories/message-repository.mjs';
import { dequeuePendingMessage } from './messages-worker-claim-routes.mjs';
import { installQueueWakeHook } from '../services/queue-wake-hook.mjs';
import { createPendingWorkerPrimer, createQueueWaker } from '../services/queue-waker.mjs';
import { createSessionWorkerWebSocketService } from '../services/session-worker-websocket-service.mjs';
import { asOwner } from '../services/relay-principal-test-harness.mjs';
import { registerConversationLifecycleRoutes } from './conversation-lifecycle-routes.mjs';

const POLL_OFF_MS = 3_600_000;
const HANG_GUARD_MS = 5_000;
const TEST_TIMEOUT_MS = 2 * HANG_GUARD_MS;
const CONV = 'conv-parser';

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

function startRelay(t, { failClaudeApiRowsWithoutLaunch = undefined, failCopilotRowsWithoutLaunch = undefined } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  db.prepare(`INSERT INTO conversations (id, title, status, archived, created_at, updated_at) VALUES (?, 'Parser work', 'active', 1, ?, ?)`)
    .run(CONV, iso(Date.now()), iso(Date.now()));
  const changes = new EventEmitter();
  const changed = () => changes.emit('change');
  const claims = [];
  const ensured = [];
  const cleared = [];
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
      const claimed = dequeuePendingMessage({ db, stmts, nowIso: iso(Date.now()), requesterSessionId: sessionId });
      claims.push({ reason, id: claimed?.id ?? null });
      changed();
      return claimed ? { message: claimed } : null;
    },
    nextDueAtMs: () => null,
    pollIntervalMs: POLL_OFF_MS,
    logger: { debug() {}, warn() {} },
  });
  // The supervisor's launch, as the route and the prime call it.
  const sessionWorkerSupervisor = {
    clearRestartSchedule: (sid, options) => { cleared.push({ sid, options }); },
    ensureWorker: async (sid) => {
      ensured.push(sid);
      changed();
      return { ok: true };
    },
  };
  waker = createQueueWaker({
    prime: createPendingWorkerPrimer({
      listPendingOwnerSessionIds: (limit) => stmts.listPendingWorkerOwnerSessionIds.all(limit),
      ensureWorker: (sid) => sessionWorkerSupervisor.ensureWorker(sid),
    }),
    notify: (reason) => { void service.notifyQueueChanged(reason); },
  });
  service.start();
  t.after(() => service.stop());

  const routes = new Map();
  const app = { post: (routePath, ...handlers) => { routes.set(`POST ${routePath}`, handlers.at(-1)); }, get() {}, delete() {} };
  const emitted = [];
  registerConversationLifecycleRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit: (event, payload) => { emitted.push([event, payload]); } },
    db,
    stmts,
    sessionWorkerSupervisor,
    failClaudeApiRowsWithoutLaunch,
    failCopilotRowsWithoutLaunch,
  }, {});
  async function unarchive() {
    const captured = { status: 200, body: null };
    const res = {
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await routes.get('POST /api/conversation/:id/unarchive')(asOwner({ params: { id: CONV }, body: {}, headers: {}, query: {}, socket: {} }), res);
    return captured;
  }

  function connect(sessionId) {
    httpServer.emit('upgrade', { url: `/api/session-worker/ws?sessionId=${sessionId}&pid=${process.pid}`, headers: { host: 'localhost', authorization: 'Bearer tok' } }, {}, Buffer.alloc(0));
    const socket = lastWss.sockets.at(-1);
    socket.on('sent', changed);
    socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'ws-open' }));
    return socket;
  }
  function insert(id, { owner = 'sdk-parser', next = null, usageLimitPause = null } = {}) {
    db.prepare(`
      INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, relay_mode, usage_limit_pause)
      VALUES (?, ?, 0, 'rename the parser', 'pending', ?, 0, ?, ?, 'agent', ?)
    `).run(id, CONV, iso(Date.now()), next, owner, usageLimitPause);
  }
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
  // A pending row of an archived chat is not queued work (countStatus): the
  // insert's wake asks the worker for nothing.
  async function insertWakeAsksNothing() {
    const pending = stmts.countStatus.all().find((row) => row.status === 'pending')?.cnt || 0;
    assert.equal(pending, 0, 'the archived chat\'s row is not counted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(claims.some((claim) => claim.reason === 'insert'), false, 'no claim on the insert wake');
  }
  return { db, stmts, hook, connect, insert, claims, ensured, cleared, emitted, unarchive, until, insertWakeAsksNothing };
}

const deliveryOf = (socket, id) => socket.sent.find((frame) => frame.type === 'queue.deliver' && frame.pending.message.id === id);

test('a row left in an archived chat goes to its ready worker right after the unarchive, not at the next poll', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  assert.equal(relay.hook.installed, true);
  const socket = relay.connect('sdk-parser');
  await relay.until(() => relay.claims.length > 0, 'claim on ready');
  relay.insert('msg-stranded');
  await relay.insertWakeAsksNothing();
  assert.equal(deliveryOf(socket, 'msg-stranded'), undefined, 'the archived chat\'s row is not claimed');

  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const frame = await relay.until(() => deliveryOf(socket, 'msg-stranded'), 'delivery after the unarchive');
  assert.equal(frame.reason, 'unarchive', 'the unarchive\'s wake delivered it');
  assert.deepEqual(relay.emitted.map(([event]) => event), ['conversation_archived']);
});

test('a row left in an archived chat whose worker was stopped gets its worker launched by the unarchive', async (t) => {
  const relay = startRelay(t);
  relay.insert('msg-stranded', { owner: 'sdk-stopped' });
  assert.deepEqual(relay.ensured, []);

  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(relay.ensured, ['sdk-stopped'], 'launched by the route itself, with no prime and no poll');
  assert.deepEqual(relay.cleared, [{ sid: 'sdk-stopped', options: { resetKilledMarker: true } }], 'the archive\'s kill marker is cleared first, as a send clears it');
});

// The runtime hands the route its failClaudeApiRowsWithoutLaunch: true when
// the session is a Claude API chat whose key, switch or cap cannot run a
// turn, its waiting rows then failed with the usual note.
test('a Claude API chat that cannot run a turn gets no worker at the unarchive; the other sessions do', async (t) => {
  const checked = [];
  const relay = startRelay(t, {
    failClaudeApiRowsWithoutLaunch: (sessionId) => {
      checked.push(sessionId);
      if (sessionId === 'sdk-broken-check') throw new Error('settings unreadable');
      if (sessionId !== 'sdk-api-capped') return false;
      relay.db.prepare(`UPDATE queue SET status = 'failed' WHERE owner_sdk_session_id = ?`).run(sessionId);
      return true;
    },
  });
  relay.insert('msg-capped', { owner: 'sdk-api-capped' });
  relay.insert('msg-broken', { owner: 'sdk-broken-check' });
  relay.insert('msg-subscription', { owner: 'sdk-subscription' });
  const warnings = [];
  const warn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let back;
  try {
    back = await relay.unarchive();
  } finally {
    console.warn = warn;
  }
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual([...checked].sort(), ['sdk-api-capped', 'sdk-broken-check', 'sdk-subscription']);
  assert.deepEqual(relay.ensured, ['sdk-subscription'], 'no launch for the capped chat, nor for the one whose check threw');
  assert.deepEqual(relay.cleared.map((entry) => entry.sid), ['sdk-subscription']);
  assert.equal(relay.db.prepare(`SELECT status FROM queue WHERE id = 'msg-capped'`).get().status, 'failed');
  assert.ok(warnings.some((line) => line.includes('the Claude API check failed: settings unreadable')), warnings.join('\n'));
});

// The same for a Copilot chat while Copilot is switched off
// (failCopilotRowsWithoutLaunch): its rows fail with the switch's note and no
// Copilot worker starts; an OpenAI chat (Copilot's worker, its own switch)
// gets its worker.
test('a Copilot chat while Copilot is off gets no worker at the unarchive; an OpenAI chat does', async (t) => {
  const checked = [];
  const relay = startRelay(t, {
    failClaudeApiRowsWithoutLaunch: () => false,
    failCopilotRowsWithoutLaunch: (sessionId) => {
      checked.push(sessionId);
      if (sessionId !== 'sdk-copilot') return false;
      relay.db.prepare(`UPDATE queue SET status = 'failed' WHERE owner_sdk_session_id = ?`).run(sessionId);
      return true;
    },
  });
  relay.insert('msg-copilot', { owner: 'sdk-copilot' });
  relay.insert('msg-openai', { owner: 'sdk-openai' });
  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual([...checked].sort(), ['sdk-copilot', 'sdk-openai']);
  assert.deepEqual(relay.ensured, ['sdk-openai'], 'no Copilot worker while Copilot is off');
  assert.deepEqual(relay.cleared.map((entry) => entry.sid), ['sdk-openai']);
  assert.equal(relay.db.prepare(`SELECT status FROM queue WHERE id = 'msg-copilot'`).get().status, 'failed');
});

test('an unarchive with nothing queued launches no worker and wakes nothing',{ timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  relay.connect('sdk-parser');
  await relay.until(() => relay.claims.length > 0, 'claim on ready');
  const claimsBefore = relay.claims.length;
  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relay.ensured, []);
  assert.equal(relay.claims.length, claimsBefore, 'no claim attempt');
});

test('a follow-up whose usage-limit hold has ended gets its worker and the wake at the unarchive', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const relay = startRelay(t);
  const socket = relay.connect('sdk-held');
  await relay.until(() => relay.claims.length > 0, 'claim on ready');
  relay.insert('msg-released', { owner: 'sdk-held', next: iso(Date.now() - 60_000), usageLimitPause: '{"resetsAt":1}' });
  await relay.insertWakeAsksNothing();
  assert.equal(deliveryOf(socket, 'msg-released'), undefined, 'the archived chat\'s row is not claimed');

  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(relay.ensured, ['sdk-held'], 'the hold is over: its worker is launched');
  const frame = await relay.until(() => deliveryOf(socket, 'msg-released'), 'delivery after the unarchive');
  assert.equal(frame.reason, 'unarchive');
});

test('a follow-up held at the usage limit stays held: the unarchive launches no worker for it', async (t) => {
  const relay = startRelay(t);
  relay.insert('msg-held', { owner: 'sdk-held', next: iso(Date.now() + 3_600_000), usageLimitPause: '{"resetsAt":1}' });
  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(relay.ensured, []);
});

test('the unarchive and the waker read one usage-limit hold: an expired hold goes, a live one waits, no hold goes', async (t) => {
  const relay = startRelay(t);
  relay.insert('msg-expired', { owner: 'sdk-expired', next: iso(Date.now() - 60_000), usageLimitPause: '{"resetsAt":1}' });
  relay.insert('msg-live', { owner: 'sdk-live', next: iso(Date.now() + 3_600_000), usageLimitPause: '{"resetsAt":1}' });
  relay.insert('msg-none', { owner: 'sdk-none' });

  const back = await relay.unarchive();
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const woken = relay.stmts.listPendingWorkerOwnerSessionIds.all(10).map((row) => row.sdk_session_id);
  const notHeld = relay.db.prepare(`SELECT id FROM queue q WHERE q.status = 'pending' ${notHeldForUsageLimit('q.')}`).all().map((row) => row.id);
  assert.deepEqual([...relay.ensured].sort(), ['sdk-expired', 'sdk-none'], 'the unarchive launches the expired hold and the row with none');
  assert.deepEqual([...woken].sort(), [...relay.ensured].sort(), 'the waker lists the same sessions');
  assert.deepEqual(notHeld.sort(), ['msg-expired', 'msg-none'], 'the shared clause keeps the same rows');
  const counts = Object.fromEntries(relay.stmts.countStatus.all().map((row) => [row.status, row.cnt]));
  assert.equal(counts.pending, 2, 'the queue counts leave out the live hold only');
});

test('the unarchive route keeps no copy of the usage-limit hold clause', () => {
  const source = fs.readFileSync(new URL('./conversation-lifecycle-routes.mjs', import.meta.url), 'utf8');
  assert.match(source, /notHeldForUsageLimit\('q\.'\)/);
  assert.doesNotMatch(source, /usage_limit_pause IS NOT NULL/);
  assert.equal(notHeldForUsageLimit('q.', false), '', 'no clause without the column');
});
