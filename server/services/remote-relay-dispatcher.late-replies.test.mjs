import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { RemoteRelayError } from './remote-relay-client.mjs';
import { createRemoteRelayCallerContext } from './remote-relay-caller-context.mjs';
import { createRemoteRelayDispatcher } from './remote-relay-dispatcher.mjs';
import { createRelayEventService } from './relay-event-service.mjs';

// Late replies through the dispatcher: which waits close a prompt, the
// sweeper's read (readOwnReplies) on this relay and a paired one, the
// "also delivered" note, and the loop guard in a turn a late reply started.

const LANE = 'conv-fixture-lane';
const STARTER = 'conv-fixture-starter';
const LINUX = Object.freeze({ id: 'rr_linux', relayId: 'relay-linux-id', name: 'linux-test', url: 'https://relay-b.example.test', permission: 'full', lastStatus: 'online' });

/** A relay's conversation API, reduced to what sends, waits and the sweeper read. */
function createFakeRelay() {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 15, 1, 0, 0) + (tick++) * 1000).toISOString();
  const relay = {
    conversations: new Map(),
    reads: 0,
    failing: false,
    // Runs after a prompt is queued, so a test can answer it.
    onMessage: null,
    add(id, overrides = {}) {
      relay.conversations.set(id, { id, title: id, archived: false, inFlight: null, activeTurn: false, messages: [], ...overrides });
      return relay.conversations.get(id);
    },
    message(id, row) {
      relay.conversations.get(id).messages.push({ timestamp: stamp(), ...row });
    },
    async request(_target, method, path, { query = {}, body } = {}) {
      if (relay.failing) throw new RemoteRelayError(CODES.offline, 'offline');
      const match = /^\/api\/conversation\/([^/]+)$/.exec(path);
      if (method === 'GET' && match) {
        const conv = relay.conversations.get(decodeURIComponent(match[1]));
        if (!conv) throw new RemoteRelayError(CODES.notFound, 'not found', { status: 404 });
        if (query.afterMessageId) relay.reads += 1;
        const limit = Number(query.limit) || 20;
        let rows = conv.messages;
        if (query.afterMessageId) {
          const at = rows.findIndex((row) => row.id === query.afterMessageId);
          rows = at === -1 ? [] : rows.slice(at + 1);
        } else if (query.aroundMessageId) {
          rows = rows.filter((row) => row.id === query.aroundMessageId);
        } else {
          rows = rows.slice(-limit);
        }
        const page = rows.slice(0, limit);
        return { id: conv.id, title: conv.title, archived: conv.archived, inFlight: conv.inFlight, activeTurn: conv.activeTurn, messages: page, pageInfo: { hasMoreNewer: rows.length > limit } };
      }
      if (method === 'POST' && path === '/api/message') {
        relay.message(body.conversationId, { id: body.messageId, role: 'user', text: body.text });
        relay.onMessage?.(body);
        return { messageId: body.messageId };
      }
      if (method === 'GET' && path === '/api/status') return { pendingCount: 0, processingCount: 0, parkedCount: 0 };
      if (method === 'GET' && path === '/api/relay-questions') return { questions: [] };
      return {};
    },
  };
  return relay;
}

function setup({ agentPromptsBeforeAsking = 30, registry = [LINUX] } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const [id, title] of [[LANE, 'Lane'], [STARTER, 'Lead']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  }
  const repository = createRemoteRelayRepository(db);
  const events = createRelayEventService({
    db,
    stmts: { ...createSessionRepository(db), ...createMessageRepository(db) },
    relayName: () => 'win-test',
    setTimer: () => null,
    clearTimer: () => {},
    logger: { log() {}, warn() {} },
  });
  const callerContext = createRemoteRelayCallerContext({ db, repository, logger: { log() {}, warn() {} } });
  const remote = createFakeRelay();
  const local = createFakeRelay();
  const approvals = [];
  const clock = { now: Date.parse('2026-11-15T01:00:00.000Z') };
  let uuid = 0;
  const entries = [...registry];
  const dispatcher = createRemoteRelayDispatcher({
    registry: {
      list: () => entries,
      get: (id) => entries.find((entry) => entry.id === id) || null,
      resolve: (name) => {
        const relay = entries.find((entry) => entry.name === String(name).replace(/^@/, ''));
        return relay ? { relay } : { error: 'unknown', names: entries.map((entry) => entry.name) };
      },
      selfIdentity: () => ({ relayId: 'relay-self-id', name: 'win-test', publicUrl: 'https://relay-a.example.test' }),
      selfName: () => 'win-test',
    },
    client: { request: (...args) => remote.request(...args) },
    localClient: { request: (...args) => local.request(...args) },
    getAgentSessionsSettings: () => ({ enabled: true, maxWaitSeconds: 600, agentPromptsBeforeAsking }),
    repository: { ...repository, hasUnlock: () => true },
    getCallerContext: async (conversationId) => callerContext.getCallerContext(conversationId),
    requestApproval: async (request) => {
      approvals.push(request);
      return true;
    },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    logger: { log() {}, warn() {} },
    randomUUID: () => `m-sent-${++uuid}`,
    relayEvents: events,
  });
  const run = (action, args = {}, { conversationId = LANE, signal } = {}) => dispatcher.dispatch({ conversationId, action, args, signal });
  return { db, events, dispatcher, run, remote, local, approvals, clock, entries };
}

const ledger = (db, id) => db.prepare(`SELECT * FROM relay_event_own_prompts WHERE message_id = ?`).get(id);
const answer = (relay, conversationId, id, text, extra = {}) => relay.message(conversationId, { id: `${id}-reply`, role: 'assistant', text, sourceMessageId: id, ...extra });

// ─── Which waits close a prompt ──────────────────────────────────────────────

test('wait 0 leaves the prompt open; a wait that returns done marks it returned', async () => {
  const { db, run, remote } = setup();
  remote.add('conv-b');
  const queued = await run('send', { relay: 'linux-test', session: 'conv-b', text: 'go', wait_seconds: 0 });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(ledger(db, queued.body.message_id).late_state, null);
  remote.onMessage = (body) => answer(remote, 'conv-b', body.messageId, 'done here');
  const waited = await run('send', { relay: 'linux-test', session: 'conv-b', text: 'again', wait_seconds: 30 });
  assert.equal(waited.body.status, 'done');
  assert.equal(ledger(db, waited.body.message_id).late_state, 'returned');
  assert.ok(ledger(db, waited.body.message_id).received_at);
});

test('a wait that runs out leaves the prompt open; a stopped turn closes it without received_at', async () => {
  const { db, run, remote } = setup();
  remote.add('conv-b', { inFlight: { messageId: 'other' } });
  const running = await run('send', { relay: 'linux-test', session: 'conv-b', text: 'go', wait_seconds: 4 });
  assert.equal(running.body.status, 'running');
  assert.equal(ledger(db, running.body.message_id).late_state, null);
  remote.onMessage = (body) => answer(remote, 'conv-b', body.messageId, '', { kind: 'stopped' });
  const stopped = await run('send', { relay: 'linux-test', session: 'conv-b', text: 'stop it', wait_seconds: 30 });
  assert.equal(stopped.body.status, 'stopped');
  assert.deepEqual([ledger(db, stopped.body.message_id).late_state, ledger(db, stopped.body.message_id).received_at], ['returned', null]);
});

test('a wait whose call was abandoned before it returned done leaves the prompt open', async () => {
  const { db, run, remote } = setup();
  remote.add('conv-b');
  const controller = new AbortController();
  remote.onMessage = (body) => {
    answer(remote, 'conv-b', body.messageId, 'nobody hears this');
    controller.abort();
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-b', text: 'go', wait_seconds: 30 }, { signal: controller.signal });
  assert.equal(result.body.status, 'done', 'the read found it');
  const own = ledger(db, result.body.message_id);
  assert.deepEqual([own.late_state, own.received_at], [null, null], 'neither returned nor received: the late reply brings it');
});

// ─── readOwnReplies ──────────────────────────────────────────────────────────

test('readOwnReplies returns what a wait returns, per prompt, from one read; steered prompts included', async () => {
  const remote = createFakeRelay();
  const local = createFakeRelay();
  // The dispatcher hands its read to the event service at construction.
  const captured = [];
  createRemoteRelayDispatcher({
    registry: { list: () => [LINUX], get: (id) => (id === LINUX.id ? LINUX : null), selfName: () => 'win-test' },
    client: remote,
    localClient: local,
    getAgentSessionsSettings: () => ({ enabled: true }),
    relayEvents: { setLateReplyReader: (fn) => captured.push(fn) },
  });
  const [reader] = captured;
  assert.equal(typeof reader, 'function');

  for (const target of [remote, local]) {
    target.add('conv-b', { title: 'Lane B' });
    target.message('conv-b', { id: 'p-1', role: 'user', text: 'first' });
    answer(target, 'conv-b', 'p-1', 'answer one');
    target.message('conv-b', { id: 'p-2', role: 'user', text: 'steered' });
    target.message('conv-b', { id: 'p-2-folded', role: 'assistant', kind: 'folded', sourceMessageId: 'p-2', text: '' });
    target.message('conv-b', { id: 'p-2-answer', role: 'assistant', text: 'answer for both', sourceMessageId: 'p-x' });
    target.message('conv-b', { id: 'p-3', role: 'user', text: 'third' });
    target.reads = 0;
    const seen = () => ({ inFlight: null });
    const result = await reader({ watcherConversationId: LANE, relayId: target === remote ? LINUX.id : 'self', sessionId: 'conv-b', rows: [{ messageId: 'p-1', seen: seen() }, { messageId: 'p-2', seen: seen() }, { messageId: 'p-3', seen: seen() }] });
    assert.equal(target.reads, 1, 'one read for three prompts');
    assert.equal(result.title, 'Lane B');
    assert.deepEqual([result.outcomes['p-1'].status, result.outcomes['p-1'].reply.text], ['done', 'answer one']);
    assert.deepEqual([result.outcomes['p-2'].status, result.outcomes['p-2'].reply.text, result.outcomes['p-2'].reply.folded], ['done', 'answer for both', true]);
    assert.match(result.outcomes['p-2'].note, /steered into the turn/);
    assert.equal(result.outcomes['p-3'].status, 'queued', 'idle once: confirmed at the next pass');
  }
});

test('readOwnReplies: a removed registry entry is gone, a deleted session is gone, a failing relay throws', async () => {
  const captured = [];
  const remote = createFakeRelay();
  createRemoteRelayDispatcher({ registry: { list: () => [LINUX], get: (id) => (id === LINUX.id ? LINUX : null) }, client: remote, relayEvents: { setLateReplyReader: (fn) => captured.push(fn) } });
  const [reader] = captured;
  const rows = [{ messageId: 'p-1', seen: { inFlight: null } }];
  assert.deepEqual(await reader({ watcherConversationId: LANE, relayId: 'rr_removed', sessionId: 'conv-b', rows }), { gone: 'relay' });
  assert.deepEqual(await reader({ watcherConversationId: LANE, relayId: LINUX.id, sessionId: 'conv-deleted', rows }), { gone: 'session' });
  remote.add('conv-b');
  remote.failing = true;
  await assert.rejects(reader({ watcherConversationId: LANE, relayId: LINUX.id, sessionId: 'conv-b', rows }), /offline/);
  // This relay's own sessions need the owner's agent sessions setting.
  await assert.rejects(reader({ watcherConversationId: LANE, relayId: 'self', sessionId: 'conv-b', rows }), /agent sessions are off/);
});

test('a wait after the late reply went still answers, with the "also delivered" note', async () => {
  const { db, run, remote, events } = setup();
  remote.add('conv-b');
  const queued = await run('send', { relay: 'linux-test', session: 'conv-b', text: 'go', wait_seconds: 0 });
  const id = queued.body.message_id;
  answer(remote, 'conv-b', id, 'the answer');
  await events.passLateReplies();
  assert.equal(ledger(db, id).late_state, 'delivered');
  events.flush(LANE);
  const waited = await run('wait', { relay: 'linux-test', session: 'conv-b', message_id: id, wait_seconds: 10 });
  assert.equal(waited.body.status, 'done');
  assert.equal(waited.body.reply.text, 'the answer');
  assert.match(waited.body.note, new RegExp(`Also delivered to your conversation as a late reply at ${ledger(db, id).late_at.slice(11, 16)}Z\\.`));
  assert.equal(ledger(db, id).late_state, 'delivered');
});

// ─── The loop guard ──────────────────────────────────────────────────────────

test('a send in a turn a late reply started counts, also to the starter; the delivery itself counts nothing', async () => {
  const { db, run, local, approvals, events, clock } = setup({ agentPromptsBeforeAsking: 10 });
  const starterOrigin = { kind: 'agent', relayId: 'relay-self-id', relayName: 'win-test', conversationId: STARTER, hops: 0, local: true };
  db.prepare(`UPDATE conversations SET origin_json = ? WHERE id = ?`).run(JSON.stringify(starterOrigin), LANE);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-human', ?, 'user', 'carry on', ?)`).run(LANE, new Date(Date.now() - 50_000).toISOString());
  local.add(STARTER, { title: 'Lead' });
  // The lane sent to the starter earlier and stopped waiting; the reply came as a late reply.
  events.noteOwnPrompt({ watcherConversationId: LANE, sessionId: STARTER, messageId: 'm-earlier' });
  assert.equal(events.recordLateReply({ watcher: LANE, sessionId: STARTER, messageId: 'm-earlier', outcome: { status: 'done', reply: { text: 'Four more points to fix.' } } }), 'delivered');
  const delivery = events.flush(LANE);
  assert.ok(delivery?.messageId);
  assert.equal(db.prepare(`SELECT kind FROM messages WHERE id = ?`).get(delivery.messageId).kind, RELAY_EVENT_MESSAGE_KIND);
  // That event row is the lane's turn now.
  db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`).run(new Date().toISOString(), delivery.messageId);
  for (let index = 0; index < 10; index += 1) {
    clock.now += 61_000;
    const sent = await run('send', { relay: 'this', session: STARTER, text: `report ${index}`, wait_seconds: 0 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  }
  assert.equal(approvals.length, 0, 'the delivery counted nothing: ten sends fit the limit of 10');
  clock.now += 61_000;
  const eleventh = await run('send', { relay: 'this', session: STARTER, text: 'report 10', wait_seconds: 0 });
  assert.equal(eleventh.status, 200);
  assert.equal(approvals.length, 1, 'counted, although it goes to the starter');
  assert.equal(approvals[0].agentPrompts, 10);
});
