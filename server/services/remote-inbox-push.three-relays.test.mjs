import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { registerRelayAskRoutes } from '../routes/relay-ask-routes.mjs';
import { createPushDispatchService } from './push-dispatch-service.mjs';
import { createRemoteInboxWatchService } from './remote-inbox-watch-service.mjs';
import { createRemoteRelayCallerContext } from './remote-relay-caller-context.mjs';

// Three-relay check, in process: relays A, B and C, each with its
// own database, push service (web-push stubbed: what each one sends is
// recorded) and routes; A and C are paired with B and watch it. A card on B
// that a turn waits on pushes once in total:
//
// - push on A only: A pushes it, and the tap opens B's session;
// - push on B and A: B pushes, A does not;
// - push on A and C, not B: exactly one of A and C pushes.
//
// Every name and text here is made up.

const NOW = '2026-03-02T10:00:00.000Z';

function formatQuestionRow(row) {
  if (!row) return null;
  const envelope = JSON.parse(row.request || '{}') || {};
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    prompt: row.prompt,
    choices: JSON.parse(row.choices || '[]'),
    context: envelope.context || null,
    allowFreeform: envelope.allowFreeform ?? true,
    requestSchema: null,
    status: row.status,
    answer: row.answer || null,
    createdAt: row.created_at,
    answeredAt: row.answered_at || null,
  };
}

/** One relay: its database, push service, routes and (for a watcher) its watch of B. */
function makeRelay(name, { pushOn = false } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const sent = [];
  const push = createPushDispatchService({
    db,
    webpush: { sendNotification: async (subscription, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; } },
    // No device is looking at any relay.
    hasActiveDevice: () => false,
    uuid: () => `${name}-sub`,
    logger: { warn() {} },
  });
  if (pushOn) {
    push.upsertSubscription({
      deviceId: `${name}-phone`, label: 'phone', endpoint: `https://push.example.test/${name}`, keys: { p256dh: 'p', auth: 'a' },
      preferences: { content: { preview: 'full' } },
    });
  }
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1));
  }
  registerRelayAskRoutes(app, {
    auth: (_req, _res, next) => next(),
    db,
    stmts: createQuestionRepository(db),
    formatQuestionRow,
    remoteRelayInbound: { listRelays: () => [], selfNames: () => [name], inboundEnabled: () => true },
    questionNotice: (id) => push.questionNotice(id),
  });
  /** A paired relay's GET, handled here in process, as it would be over HTTP. */
  async function handle(fromRelayId, method, fullPath) {
    const [path, search = ''] = fullPath.split('?');
    const handler = routes.get(`${method} ${path}`);
    let status = 200;
    let body = null;
    const res = { setHeader() {}, status(code) { status = code; return res; }, json(payload) { body = payload; return res; } };
    await handler({ headers: { 'x-oar-remote-origin': fromRelayId, 'x-oar-remote-hops': '1' }, params: {}, body: {}, query: Object.fromEntries(new URLSearchParams(search)) }, res);
    if (status !== 200) throw Object.assign(new Error(`HTTP ${status}`), { status });
    return body;
  }
  return { name, db, push, sent, handle };
}

/** `watcher` watches `cardRelay` (registered there under the id `${watcher.name}-id`). */
function watch(watcher, cardRelay) {
  return createRemoteInboxWatchService({
    registry: { list: () => [{ id: `pair-${cardRelay.name}`, name: cardRelay.name, url: `https://${cardRelay.name}.example.test`, lastStatus: 'online' }] },
    client: { request: (_relay, method, path) => cardRelay.handle(`${watcher.name}-id`, method, path) },
    push: watcher.push,
    hasSockets: () => false,
    logger: { warn() {} },
  });
}

/** An approval card on B the way the relay_tool puts one there, with B's own push. */
async function approvalCardOn(relay) {
  relay.db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES ('conv-lead', 'Lead', 'ask', ?, ?)`).run(NOW, NOW);
  relay.db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('turn-1', 'conv-lead', 'user', 'go', ?)`).run(NOW);
  relay.db.prepare(`
    INSERT INTO queue (id, conversation_id, relay_mode, text, status, timestamp, processing_at, attempt_id)
    VALUES ('turn-1', 'conv-lead', 'ask', 'go', 'processing', ?, ?, 'attempt-1')
  `).run(NOW, NOW);
  let asked = null;
  const pushed = [];
  const callerContext = createRemoteRelayCallerContext({
    db: relay.db,
    questions: createQuestionRepository(relay.db),
    uuid: () => 'card-1',
    now: () => new Date(NOW),
    // As server-runtime.mjs wires it: the card's relay pushes it itself.
    notifyQuestion: (question) => { asked = question; pushed.push(relay.push.notifyQuestion(question)); },
    // The card stays open: the check ends before anyone answers it.
    sleep: () => new Promise(() => {}),
    logger: { log() {}, warn() {} },
  });
  void callerContext.requestApproval({
    conversationId: 'conv-lead',
    callerContext: callerContext.getCallerContext('conv-lead'),
    relay: { name: 'relay-c' },
    action: 'create_session',
    args: { text: 'A PROMPT THAT STAYS ON B', title: 'Docs pass', model: 'claude-sonnet-5' },
  });
  await Promise.all(pushed);
  assert.equal(asked?.id, 'card-1');
}

test('push on A only: A pushes the card on B once, and the tap opens B\'s session', async () => {
  const a = makeRelay('relay-a', { pushOn: true });
  const b = makeRelay('relay-b');
  await approvalCardOn(b);
  const watchA = watch(a, b);
  for (let sweep = 0; sweep < 3; sweep += 1) await watchA.sweep();
  assert.equal(b.sent.length, 0);
  assert.equal(a.sent.length, 1);
  const [payload] = a.sent;
  assert.equal(payload.title, 'Approval waiting on relay "relay-b"');
  assert.equal(payload.body, 'New session requested by \'Lead\': Docs pass, claude-sonnet-5');
  assert.deepEqual(payload.data, { url: 'https://relay-b.example.test/?conv=conv-lead', remoteRelayId: 'pair-relay-b', tag: 'remote-pair-relay-b-card-1', type: 'question' });
  assert.ok(!JSON.stringify(payload).includes('A PROMPT THAT STAYS ON B'));
});

test('push on both: only B pushes', async () => {
  const a = makeRelay('relay-a', { pushOn: true });
  const b = makeRelay('relay-b', { pushOn: true });
  await approvalCardOn(b);
  const watchA = watch(a, b);
  for (let sweep = 0; sweep < 3; sweep += 1) await watchA.sweep();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].data.questionId, 'card-1', 'B\'s own push is the one with the answer buttons');
  assert.equal(a.sent.length, 0);
});

test('push on A and C, not B: exactly one of A and C pushes, whichever sweeps first', async () => {
  for (const order of [['a', 'c'], ['c', 'a']]) {
    const relays = { a: makeRelay('relay-a', { pushOn: true }), c: makeRelay('relay-c', { pushOn: true }) };
    const b = makeRelay('relay-b');
    await approvalCardOn(b);
    const watches = { a: watch(relays.a, b), c: watch(relays.c, b) };
    for (let round = 0; round < 3; round += 1) {
      for (const key of order) await watches[key].sweep();
    }
    // Both at once as well: the claim is taken in one synchronous step on B.
    await Promise.all([watches.a.sweep(), watches.c.sweep()]);
    assert.equal(relays[order[0]].sent.length, 1, `${order[0]} swept first and pushed`);
    assert.equal(relays[order[1]].sent.length, 0);
    assert.equal(b.sent.length, 0);
  }
});

test('A restarts after it pushed: no second push; a card nobody claimed yet is pushed at any age', async () => {
  const a = makeRelay('relay-a', { pushOn: true });
  const b = makeRelay('relay-b');
  await approvalCardOn(b);
  await watch(a, b).sweep();
  assert.equal(a.sent.length, 1);
  // A's memory is gone; B still holds A's claim.
  const restarted = watch(a, b);
  await restarted.sweep();
  await restarted.sweep();
  assert.equal(a.sent.length, 1);
  // A card from long ago that nobody claimed (B restarted, its own push forgotten).
  b.db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, status, created_at, expires_at)
    VALUES ('card-old', 'turn-1', 'conv-lead', 'turn-1', 'ask', 'Which theme?', '["Light","Dark"]', ?, 'pending', '2026-03-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
  `).run(JSON.stringify({ request: null, context: null, allowFreeform: true }));
  await restarted.sweep();
  assert.equal(a.sent.length, 2);
  assert.equal(a.sent[1].title, 'A question waits on relay "relay-b"');
  assert.equal(a.sent[1].body, 'Which theme?');
});
