import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { markRemoteRelayLoopbackRequest } from '../services/remote-relay-inbound.mjs';
import { createRelayEventService, servedWatcherKey } from '../services/relay-event-service.mjs';
import { registerRelayEventRoutes } from './relay-event-routes.mjs';

// The routes a paired relay uses to watch this relay's sessions: who may
// call them, the inbound switch, and what they store.

const A_ID = 'relay-fixture-a';
const BUILDER = 'conv-fixture-builder';
const LOCAL_WATCHER = 'conv-fixture-local-watcher';

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: register('GET'), post: register('POST'), delete: register('DELETE') };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  // The same object, not a copy: the loopback's mark is kept by identity.
  const request = Object.assign(req, { body: req.body || {}, query: req.query || {}, params: req.params || {}, headers: req.headers || {} });
  for (const handler of handlers) {
    let next = false;
    await handler(request, response, () => { next = true; });
    if (!next) break;
  }
  return response;
}

function setup({ inbound = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const at = '2026-03-02T10:00:00.000Z';
  for (const [id, title] of [[BUILDER, 'Orbit camera'], [LOCAL_WATCHER, 'local watcher']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const service = createRelayEventService({ db, stmts, logger: { log() {}, warn() {} } });
  const settings = { inbound };
  const app = createMockApp();
  registerRelayEventRoutes(app, {
    auth: (_req, _res, next) => next(),
    relayEventService: service,
    remoteRelayInbound: { listRelays: () => [], inboundEnabled: () => settings.inbound },
  });
  const route = (key) => app.routes.get(key);
  const fromRelay = (body, headers = {}) => ({ body, headers: { 'x-oar-remote-origin': A_ID, 'x-oar-remote-hops': '1', ...headers } });
  return { db, service, settings, route, fromRelay };
}

test('a paired relay subscribes, dry run first; what it names as watcher stays its own', async () => {
  const { db, service, route, fromRelay } = setup();
  const body = { watcher: { conversationId: LOCAL_WATCHER, title: 'relay assistant' }, subscriber: { name: 'win-test' }, sessions: [BUILDER], events: ['turn_end', 'error'] };
  const dry = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay({ ...body, dry_run: true }));
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual(dry.body.subscription.sessions, [{ id: BUILDER, title: 'Orbit camera' }]);
  assert.equal(service.listActive().length, 0, 'a dry run stores nothing');
  const made = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay(body));
  assert.equal(made.statusCode, 200);
  assert.equal(made.body.subscription.watcher, servedWatcherKey(A_ID));
  assert.equal(made.body.subscription.subscriber.watcherId, LOCAL_WATCHER);
  // Its events never become a message in the conversation it named.
  service.noteError({ conversationId: BUILDER, message: 'boom' });
  service.flush(LOCAL_WATCHER);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE kind = ?`).get(RELAY_EVENT_MESSAGE_KIND).n, 0);
  const pulled = await callRoute(route('POST /api/relay-events/remote/pull'), fromRelay({ after: 0, subscriptions: [{ id: made.body.subscription.id }] }));
  assert.equal(pulled.statusCode, 200);
  assert.equal(pulled.body.events.length, 1);
  assert.equal(pulled.body.events[0].type, 'error');
  assert.deepEqual(pulled.body.subscriptions.map((sub) => sub.active), [true]);
  // The browser list shows who watches.
  const listed = await callRoute(route('GET /api/relay-events/subscriptions'));
  assert.equal(listed.body.subscriptions[0].subscriber.name, 'win-test');
});

test('only another relay\'s request is taken, and only while the inbound switch is on', async () => {
  const { service, settings, route, fromRelay } = setup();
  const body = { watcher: { conversationId: 'conv-x' }, sessions: [BUILDER] };
  const browser = await callRoute(route('POST /api/relay-events/remote/subscribe'), { body });
  assert.equal(browser.statusCode, 403);
  assert.equal(browser.body.code, CODES.forbidden);
  const own = await callRoute(route('POST /api/relay-events/remote/pull'), markRemoteRelayLoopbackRequest(fromRelay({})));
  assert.equal(own.statusCode, 403, 'this relay\'s own agents use the tool');
  const nameless = await callRoute(route('POST /api/relay-events/remote/subscribe'), { body: { ...body, origin: { relayName: 'win-test' } } });
  assert.equal(nameless.statusCode, 400);
  settings.inbound = false;
  const closed = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay(body));
  assert.equal(closed.statusCode, 403);
  assert.equal(closed.body.code, CODES.inboundDisabled);
  const closedPull = await callRoute(route('POST /api/relay-events/remote/pull'), fromRelay({}));
  assert.equal(closedPull.body.code, CODES.inboundDisabled);
  assert.equal(service.listActive().length, 0);
});

test('a paired relay\'s "all" subscription takes exclude; digest and quiet hours are not this relay\'s', async () => {
  const { service, route, fromRelay } = setup();
  const body = { watcher: { conversationId: LOCAL_WATCHER }, scope: 'all', exclude: [LOCAL_WATCHER], digest_minutes: 10, quiet_hours: { from: '22:00', to: '06:00', tz: 'UTC' } };
  const made = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay(body));
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  assert.deepEqual(made.body.subscription.exclude, [LOCAL_WATCHER]);
  assert.equal(made.body.subscription.digestMinutes, undefined);
  assert.equal(made.body.subscription.quietHours, undefined);
  service.noteTurnEnd({ conversationId: LOCAL_WATCHER, replyText: 'left out' });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'watched' });
  const pulled = await callRoute(route('POST /api/relay-events/remote/pull'), fromRelay({ after: 0, subscriptions: [{ id: made.body.subscription.id }] }));
  assert.deepEqual(pulled.body.events.map((event) => event.payload.session.id), [BUILDER]);
  const listed = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay({ sessions: [BUILDER], exclude: [LOCAL_WATCHER] }));
  assert.equal(listed.statusCode, 400);
  assert.match(listed.body.error, /exclude goes with sessions \["all"\] only/);
});

test('refusals carry a code: an unknown session is not a missing route', async () => {
  const { route, fromRelay } = setup();
  const missing = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay({ sessions: ['conv-fixture-missing'] }));
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.code, CODES.notFound);
  const empty = await callRoute(route('POST /api/relay-events/remote/subscribe'), fromRelay({ sessions: [] }));
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.body.code, CODES.invalidInput);
});
