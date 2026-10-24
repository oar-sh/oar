import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { RemoteRelayError } from './remote-relay-client.mjs';
import { createRemoteRelayDispatcher } from './remote-relay-dispatcher.mjs';
import { createRelayEventLinkService } from './relay-event-link-service.mjs';
import { RelayEventError, createRelayEventService, servedWatcherKey } from './relay-event-service.mjs';

// remote_relay subscribe / unsubscribe / list_subscriptions /
// transfer_subscriptions on a paired relay, through the dispatcher of relay
// A ("win-test") and the event routes of relay B ("linux-test"), which the
// fake client answers with B's own event service. B has no registry entry
// for A: the pairing is one-way.

const LINUX = Object.freeze({
  id: 'rr_linux',
  relayId: 'relay-linux-id',
  name: 'linux-test',
  url: 'https://relay-b.example.test',
  tokenMode: 'own',
  permission: 'read',
  lastStatus: 'online',
  version: '0.9.9',
  protocol: 1,
});
const A_RELAY_ID = 'relay-win-id';
const WATCHER = 'conv-fixture-watcher';
const SECOND = 'conv-fixture-second';
const BUILDER = 'conv-fixture-builder';
const DOCS = 'conv-fixture-docs';
const at = new Date(Date.parse('2026-03-02T10:00:00.000Z')).toISOString();

function eventRelay(conversations) {
  const db = new Database(':memory:');
  applySchema(db);
  for (const [id, title] of conversations) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const service = createRelayEventService({ db, stmts, logger: { log() {}, warn() {} } });
  return { db, service };
}

function remoteError(code, message, status = null, remoteBody = null) {
  return new RemoteRelayError(code, message, { status, remoteBody, remoteError: remoteBody?.error || null });
}

/** B's two event routes, answered by B's service, as relay A's client reaches them. */
function createRelayB() {
  const b = eventRelay([[BUILDER, 'Orbit camera'], [DOCS, 'Docs pass']]);
  const state = { inbound: true, missingRoutes: false, offline: false, calls: [] };
  const STATUS = { invalid: 400, notFound: 404, limit: 409, unavailable: 503 };
  const CODE = { invalid: CODES.invalidInput, notFound: CODES.notFound, limit: CODES.subscriptionLimit, unavailable: CODES.unsupported };
  async function request(relay, method, path, { body = {} } = {}) {
    state.calls.push({ method, path, body });
    if (state.offline) throw remoteError(CODES.offline, `Relay "${relay.name}" is not reachable (ECONNREFUSED)`);
    // An older relay: Express's HTML 404, no JSON.
    if (state.missingRoutes && path.startsWith('/api/relay-events/')) throw remoteError(CODES.notFound, `Relay "${relay.name}": not found`, 404);
    if (path.startsWith('/api/relay-events/remote/') && !state.inbound) {
      throw remoteError(CODES.inboundDisabled, `Relay "${relay.name}" does not accept prompts from other relays' agents (its inbound switch is off)`, 403, { code: CODES.inboundDisabled });
    }
    try {
      if (method === 'POST' && path === '/api/relay-events/remote/subscribe') {
        const subscription = b.service.subscribeServed({
          subscriberRelayId: A_RELAY_ID,
          subscriberRelayName: body.subscriber?.name,
          watcherId: body.watcher?.conversationId,
          watcherTitle: body.watcher?.title,
          scope: body.scope,
          sessionIds: body.sessions,
          events: body.events || null,
          once: body.once === true,
          match: body.match || '',
          stalledMinutes: body.stalled_minutes ?? null,
          heartbeatMinutes: body.heartbeat_minutes ?? null,
          exclude: body.exclude ?? null,
          dryRun: body.dry_run === true,
        });
        return { ok: true, subscription };
      }
      if (method === 'POST' && path === '/api/relay-events/remote/pull') {
        return { ok: true, ...b.service.pullServed({ subscriberRelayId: A_RELAY_ID, ...body }) };
      }
    } catch (error) {
      if (error instanceof RelayEventError) throw remoteError(error.code === 'notFound' ? CODES.notFound : `${CODES.httpPrefix}${STATUS[error.code]}`, error.message, STATUS[error.code], { error: error.message, code: CODE[error.code] });
      throw error;
    }
    throw remoteError(CODES.notFound, `Relay "${relay.name}": not found`, 404);
  }
  return { ...b, state, request };
}

function setup({ unlocked = [`${WATCHER}:rr_linux`, `${SECOND}:rr_linux`], approve = true, relays = [LINUX] } = {}) {
  const a = eventRelay([[WATCHER, 'relay assistant'], [SECOND, 'second watcher']]);
  const b = createRelayB();
  const unlocks = new Set(unlocked);
  const approvals = [];
  const registry = {
    list: () => relays,
    get: (id) => relays.find((relay) => relay.id === id) || null,
    resolve(name) {
      const relay = relays.find((entry) => entry.name === String(name || '').replace(/^@/, ''));
      return relay ? { relay } : { error: 'unknown', names: relays.map((entry) => entry.name) };
    },
    selfIdentity: () => ({ relayId: A_RELAY_ID, name: 'win-test', version: '0.9.9' }),
    selfName: () => 'win-test',
  };
  const client = { request: (...args) => b.request(...args) };
  const link = createRelayEventLinkService({ relayEvents: a.service, registry, client, logger: { log() {}, warn() {} } });
  const dispatcher = createRemoteRelayDispatcher({
    registry,
    client,
    repository: {
      hasUnlock: (conversationId, key) => unlocks.has(`${conversationId}:${key}`),
      hasContactFrom: () => false,
      latestHumanMessageId: () => null,
      recordUnlock: (conversationId, key) => {
        unlocks.add(`${conversationId}:${key}`);
        return true;
      },
    },
    getCallerContext: async (conversationId) => ({
      conversationId,
      title: conversationId === WATCHER ? 'relay assistant' : 'second watcher',
      provider: 'claude',
      model: 'claude-sonnet-5',
      mode: 'agent',
      processingRowId: `q-${conversationId}`,
      hops: 0,
    }),
    requestApproval: async (request) => {
      approvals.push(request);
      return typeof approve === 'function' ? approve(request) : approve;
    },
    logger: { log() {}, warn() {} },
    relayEvents: a.service,
    relayEventLink: link,
  });
  const run = (action, args = {}, conversationId = WATCHER) => dispatcher.dispatch({ conversationId, action, args: { relay: 'linux-test', ...args } });
  return { a, b, link, run, approvals, unlocks };
}

function eventMessages(db, conversationId = WATCHER) {
  return db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND kind = ? ORDER BY timestamp ASC`).all(conversationId, RELAY_EVENT_MESSAGE_KIND);
}

test('subscribe on a paired relay: checked there, then the card names the relay, then stored on both sides', async () => {
  const { a, b, link, run, approvals, unlocks } = setup();
  const result = await run('subscribe', { sessions: [BUILDER], events: ['turn_end', 'question_asked'], heartbeat_minutes: 30 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { subscription } = result.body;
  assert.equal(subscription.relay, 'rr_linux');
  assert.equal(subscription.relayName, 'linux-test');
  assert.deepEqual(subscription.sessions, [{ id: BUILDER, title: 'Orbit camera' }]);
  assert.match(result.body.note, /fetches them from relay "linux-test"/);
  // The dry run came before the card, the subscribe after it.
  const posts = b.state.calls.filter((call) => call.path === '/api/relay-events/remote/subscribe');
  assert.deepEqual(posts.map((call) => call.body.dry_run === true), [true, false]);
  assert.equal(posts[1].body.watcher.conversationId, WATCHER);
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].watch, {
    kind: 'subscribe',
    all: false,
    sessions: [{ id: BUILDER, title: 'Orbit camera' }],
    events: ['turn_end', 'question_asked'],
    once: false,
    heartbeatMinutes: 30,
    relayName: 'linux-test',
  });
  assert.ok(unlocks.has(`${WATCHER}:rr_linux:watch`));
  // B holds it for A; nothing of it names a conversation of B's.
  const [served] = b.service.listActive();
  assert.equal(served.watcher, servedWatcherKey(A_RELAY_ID));
  assert.equal(served.subscriber.watcherTitle, 'relay assistant');
  assert.equal(served.heartbeatMinutes, 30);
  // Asked once per relay; all is asked again and named.
  assert.equal((await run('subscribe', { sessions: [DOCS] })).status, 200);
  assert.equal(approvals.length, 1);
  assert.equal((await run('subscribe', { sessions: ['all'] })).status, 200);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].watch.all, true);
  assert.equal(approvals[1].watch.relayName, 'linux-test');
  // The link brings B's events to the watcher.
  b.service.noteQuestion({ id: 'q-fixture-1', conversationId: BUILDER, prompt: 'Merge now?', choices: ['Yes', 'No'] });
  await link.fetchNow('rr_linux');
  await new Promise((resolve) => setImmediate(resolve));
  const [message] = eventMessages(a.db);
  assert.match(message.text, /\[relay event\] linux-test · session "Orbit camera" \(conv-fixture-builder\): question_asked "Merge now\?"/);
  link.stop();
});

test('on a paired relay, exclude goes to that relay too; digest and quiet hours stay on the watching side', async () => {
  const { b, run, link } = setup();
  const quiet = { from: '22:00', to: '07:00', tz: 'Europe/Berlin' };
  const result = await run('subscribe', { sessions: ['all'], digest_minutes: 20, quiet_hours: quiet, exclude: [DOCS] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const posts = b.state.calls.filter((call) => call.path === '/api/relay-events/remote/subscribe');
  for (const post of posts) {
    assert.deepEqual(post.body.exclude, [DOCS]);
    assert.equal('digest_minutes' in post.body || 'quiet_hours' in post.body, false, 'the watched relay is not told');
  }
  const { subscription } = result.body;
  assert.deepEqual([subscription.digestMinutes, subscription.quietHours, subscription.exclude], [20, quiet, [DOCS]]);
  const [served] = b.service.listActive();
  assert.deepEqual(served.exclude, [DOCS]);
  assert.equal(served.digestMinutes, undefined);
  const listed = await run('list_subscriptions');
  assert.equal(listed.body.subscriptions[0].heldCount, 0);
  assert.equal(listed.body.subscriptions[0].nextDeliveryAt, null);
  link.stop();
});

test('a locked relay, a denied card and an unknown session subscribe nothing there', async () => {
  const locked = setup({ unlocked: [] });
  const refused = await locked.run('subscribe', { sessions: [BUILDER] });
  assert.equal(refused.body.code, CODES.locked);
  assert.equal(locked.b.state.calls.length, 0);

  const denied = setup({ approve: { approved: false } });
  const no = await denied.run('subscribe', { sessions: [BUILDER] });
  assert.equal(no.status, 403);
  assert.equal(no.body.code, CODES.approvalDenied);
  assert.equal(denied.b.service.listActive().length, 0);
  assert.equal(denied.a.service.listActive().length, 0);

  const unknown = await denied.run('subscribe', { sessions: ['conv-fixture-missing'] });
  assert.equal(unknown.status, 404);
  assert.equal(denied.approvals.length, 1, 'refused by the dry run, before any card');
});

test('a relay whose inbound switch is off, or that predates these routes, refuses before the card', async () => {
  const { b, run, approvals } = setup();
  b.state.inbound = false;
  const off = await run('subscribe', { sessions: [BUILDER] });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, CODES.inboundDisabled);
  b.state.inbound = true;
  b.state.missingRoutes = true;
  const old = await run('subscribe', { sessions: [BUILDER] });
  assert.equal(old.status, 400);
  assert.equal(old.body.code, CODES.unsupported);
  assert.match(old.body.error, /Relay "linux-test" runs an OAR version without event subscriptions across relays/);
  assert.equal(approvals.length, 0);
});

test('unsubscribe reaches the paired relay, and later when it was offline', async () => {
  const { a, b, link, run } = setup();
  const first = (await run('subscribe', { sessions: [BUILDER] })).body.subscription;
  const second = (await run('subscribe', { sessions: [DOCS] })).body.subscription;
  const ended = await run('unsubscribe', { subscription_id: first.id });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.note, undefined, 'it reached B at once');
  assert.deepEqual(b.service.listActive().map((sub) => sub.id), [second.remoteId]);
  // B offline: ended here at once, there once it answers.
  b.state.offline = true;
  const later = await run('unsubscribe', { subscription_id: 'all' });
  assert.equal(later.body.ended.length, 1);
  assert.match(later.body.note, /Relay "linux-test" did not answer .*learns of the end once it answers again/);
  assert.equal(b.service.listActive().length, 1);
  assert.deepEqual(a.service.remoteRelaysToPoll(), ['rr_linux']);
  b.state.offline = false;
  await link.fetchNow('rr_linux');
  assert.equal(b.service.listActive().length, 0);
  assert.deepEqual(a.service.remoteRelaysToPoll(), []);
  link.stop();
});

test('list_subscriptions on a paired relay shows its subscriptions with the link, freshly fetched', async () => {
  const { b, run } = setup();
  await run('subscribe', { sessions: [BUILDER] });
  b.service.noteConversationGone(BUILDER);
  const listed = await run('list_subscriptions');
  assert.equal(listed.status, 200);
  const [sub] = listed.body.subscriptions;
  assert.equal(sub.endReason, 'archived', 'the archive on B was fetched before answering');
  await run('subscribe', { sessions: [DOCS] });
  b.state.offline = true;
  const again = await run('list_subscriptions');
  const live = again.body.subscriptions.find((entry) => !entry.endedAt);
  assert.equal(live.link.state, 'failing');
  assert.match(live.link.error, /not reachable/);
});

test('transfer_subscriptions on a paired relay moves that relay\'s subscriptions after a card naming it', async () => {
  const { a, b, link, run, approvals } = setup();
  await run('subscribe', { sessions: [BUILDER] });
  const moved = await run('transfer_subscriptions', { from: WATCHER }, SECOND);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.moved.length, 1);
  const card = approvals.at(-1);
  assert.equal(card.watch.kind, 'transfer');
  assert.deepEqual(card.watch.relays, ['linux-test']);
  assert.equal(a.service.listActive()[0].watcher, SECOND);
  await link.fetchNow('rr_linux');
  assert.equal(b.service.listActive()[0].subscriber.watcherId, SECOND);
  link.stop();
});

test('list_sessions and read_session on a paired relay carry state, tasks and lastActivityAt', async () => {
  const { b, run } = setup();
  const tasks = [{ kind: 'shell', description: 'npm test', startedAt: at, lastActivityAt: at, status: 'running', id: 'toolu_fixture_shell' }];
  const original = b.request;
  b.request = undefined;
  const conversation = { id: BUILDER, title: 'Orbit camera', updatedAt: at, sessionState: 'background_only', sessionTasks: tasks, lastActivityAt: at, messages: [] };
  const client = async (relay, method, path, options) => {
    if (method === 'GET' && path === '/api/conversations') return { conversations: [conversation], pageInfo: { hasMore: false } };
    if (method === 'GET' && path === `/api/conversation/${BUILDER}`) return conversation;
    if (method === 'GET' && path === '/api/relay-questions') return { questions: [] };
    return original(relay, method, path, options);
  };
  b.state.calls.length = 0;
  b.request = client;
  const listed = await run('list_sessions');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.sessions[0].state, 'background_only');
  assert.equal(listed.body.sessions[0].lastActivityAt, at);
  assert.equal(listed.body.sessions[0].tasks[0].description, 'npm test');
  const read = await run('read_session', { session: BUILDER });
  assert.equal(read.body.session.state, 'background_only');
  assert.equal(read.body.session.lastActivityAt, at);
});
