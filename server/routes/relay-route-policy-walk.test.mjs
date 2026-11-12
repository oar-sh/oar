import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  COOKIE_ONLY_API_ROUTES,
  FILE_CAPABILITY_API_ROUTES,
  PERSON_ONLY_ROUTES,
  PUBLIC_API_ROUTES,
  RELAY_ROUTE_POLICY,
  SIGN_IN_API_ROUTES,
  ROUTE_ACCESS,
  isCookieOnlyRoute,
  isFileCapabilityRoute,
  relayRouteKey,
  routePolicyFor,
} from '../../shared/relay-route-policy.mjs';
import { registerMessagesRoutes } from './messages-routes.mjs';
import { registerAgentSdkRoutes } from './agent-sdk-routes.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';
import { registerConversationGroupRoutes } from './conversation-group-routes.mjs';
import { registerAskUserRoutes } from './ask-user-routes.mjs';
import { registerRelayBoardRoutes } from './relay-board-routes.mjs';
import { registerCacheRoutes } from './cache-routes.mjs';
import { registerGitRoutes } from './git-routes.mjs';
import { registerClaudeCloudRoutes } from './claude-cloud-routes.mjs';
import { registerPushRoutes } from './push-routes.mjs';
import { registerRemoteRelayRoutes } from './remote-relay-routes.mjs';
import { registerRelayEventRoutes } from './relay-event-routes.mjs';
import { registerRelayScheduleRoutes } from './relay-schedule-routes.mjs';
import { registerDeepSeekUsageImportRoutes } from './deepseek-usage-import-routes.mjs';
import { registerRelayAskRoutes } from './relay-ask-routes.mjs';
import { registerRelayRestartRoutes } from './relay-restart-routes.mjs';
import { registerAboutRoutes } from './about-routes.mjs';
import { registerPreviewRoutes } from './preview-routes.mjs';
import { registerAuthRoutes } from './auth-routes.mjs';

// The router walk (agent auth §10, test 5): every API route the relay
// registers behind `auth` is in the route policy, every listed route still
// exists, and nothing under /api is public by accident.

// The same order and set of modules the runtime registers (server-runtime.mjs).
const REGISTRARS = [
  registerMessagesRoutes,
  registerAgentSdkRoutes,
  registerSessionsRoutes,
  registerConversationGroupRoutes,
  registerAskUserRoutes,
  registerRelayBoardRoutes,
  registerCacheRoutes,
  registerGitRoutes,
  registerClaudeCloudRoutes,
  registerPushRoutes,
  registerRemoteRelayRoutes,
  registerRelayEventRoutes,
  registerRelayScheduleRoutes,
  registerDeepSeekUsageImportRoutes,
  registerRelayAskRoutes,
  registerRelayRestartRoutes,
  registerAboutRoutes,
  registerAuthRoutes,
  registerPreviewRoutes,
];

// Any dependency a module asks for at registration: a callable that answers
// itself for any property, so every optional route is registered (a module
// that registers a route only when a service is present sees one).
function stub() {
  return new Proxy(function stubbed() {}, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      return stub();
    },
    apply: () => stub(),
  });
}

function relayAuth(_req, _res, next) { next(); }

function buildApp() {
  const app = express();
  const base = {
    auth: relayAuth,
    MAX_UPLOAD_BYTES: 1024 * 1024,
    MAX_UPLOAD_ATTACHMENTS: 4,
    DEFAULT_RELAY_MODE: 'agent',
    DEFAULT_MODEL: 'gpt-5',
    featureFlags: {},
    config: { port: 3333 },
  };
  const deps = new Proxy(base, { get: (target, key) => (key in target ? target[key] : stub()) });
  for (const register of REGISTRARS) register(app, deps);
  return app;
}

function walk(app) {
  const routes = [];
  for (const layer of app.router.stack) {
    const route = layer.route;
    if (!route) continue;
    const patterns = Array.isArray(route.path) ? route.path : [route.path];
    const methods = Object.keys(route.methods).filter((method) => route.methods[method] && method !== '_all');
    const handlers = route.stack.map((entry) => entry.handle);
    for (const pattern of patterns) {
      for (const method of methods) {
        routes.push({
          key: relayRouteKey(method, pattern),
          method: method.toUpperCase(),
          path: pattern,
          authed: handlers.includes(relayAuth),
          handler: handlers.at(-1),
        });
      }
    }
  }
  return routes;
}

const app = buildApp();
const routes = walk(app);

test('the walk sees the relay\'s API (sanity: a few hundred routes, behind auth)', () => {
  assert.ok(routes.length > 200, `only ${routes.length} routes registered`);
  assert.ok(routes.some((route) => route.key === 'POST /api/relay-question/:id/answer' && route.authed));
});

test('every route behind auth is classified in the route policy', () => {
  const unclassified = routes.filter((route) => route.authed && !RELAY_ROUTE_POLICY.has(route.key)).map((route) => route.key);
  assert.deepEqual([...new Set(unclassified)], [], 'add these to shared/relay-route-policy.mjs (agent and peer columns)');
});

test('nothing under /api is public unless it is meant to be (the sign-in exchange checks its own credential)', () => {
  const publicRoutes = routes.filter((route) => !route.authed && route.path.startsWith('/api/')).map((route) => route.key);
  assert.deepEqual([...new Set(publicRoutes)].sort(), [...PUBLIC_API_ROUTES, ...SIGN_IN_API_ROUTES].sort());
});

test('every route the policy lists still exists', () => {
  const registered = new Set(routes.map((route) => route.key));
  const stale = [...RELAY_ROUTE_POLICY.keys()].filter((key) => !registered.has(key));
  assert.deepEqual(stale, []);
});

test('deny by default: an unknown route is person-only, for agents and peers alike', () => {
  assert.deepEqual(
    { agent: routePolicyFor('POST', '/api/not-a-route').agent, peer: routePolicyFor('POST', '/api/not-a-route').peer },
    { agent: ROUTE_ACCESS.deny, peer: ROUTE_ACCESS.deny },
  );
  assert.equal(routePolicyFor('GET', ['/a', '/b']).agent, ROUTE_ACCESS.deny);
  // HEAD is looked up as GET (Express answers HEAD with the GET route).
  assert.equal(routePolicyFor('HEAD', '/api/status').agent, ROUTE_ACCESS.allow);
});

test('person-only routes, group moves and the queued restart have the classification they need', () => {
  for (const key of [
    'POST /api/relay-question/:id/answer',
    'POST /api/relay-question/:id/dismiss',
    'POST /api/relay-board/:id/action',
    'POST /api/inbox/relays/:relayId/asks/:id/answer',
    'POST /api/inbox/relays/:relayId/asks/:id/dismiss',
    'GET /api/inbox',
    'POST /api/relay-asks/remote/answer',
    'POST /api/relay-asks/remote/dismiss',
    'DELETE /api/conversation/:id',
    'POST /api/conversation-groups',
    'PATCH /api/conversation-groups/:id',
    'DELETE /api/conversation-groups/:id',
    'POST /api/settings/openai',
    'POST /api/remote-relays/pair',
    'POST /api/push/subscribe',
    'POST /api/conversation/:id/share',
    'POST /api/update/apply',
    'POST /api/session-worker/:sdkSessionId/kill',
    'POST /api/auth/owner-token/rotate',
    'POST /api/auth/signin-codes',
    'GET /api/auth/sessions',
    'PATCH /api/auth/sessions/:id',
    'DELETE /api/auth/sessions/:id',
    'DELETE /api/auth/sessions',
    'DELETE /api/auth/session',
    'GET /api/auth/notices',
    'POST /api/auth/notices/:id/dismiss',
    'POST /api/auth/notices/dismiss-signins',
  ]) {
    assert.equal(RELAY_ROUTE_POLICY.get(key)?.agent, ROUTE_ACCESS.deny, key);
  }
  assert.equal(RELAY_ROUTE_POLICY.get('POST /api/relay-question/:id/timeout').agent, ROUTE_ACCESS.row);
  assert.equal(RELAY_ROUTE_POLICY.get('PUT /api/conversation/:id/group').agent, ROUTE_ACCESS.row);
  assert.equal(RELAY_ROUTE_POLICY.get('DELETE /api/conversation/:id/group').agent, ROUTE_ACCESS.allow);
  assert.equal(RELAY_ROUTE_POLICY.get('POST /api/relay/shutdown').agent, ROUTE_ACCESS.row);
  assert.equal(RELAY_ROUTE_POLICY.get('POST /api/relay/shutdown/cancel').agent, ROUTE_ACCESS.allow);
  assert.equal(RELAY_ROUTE_POLICY.get('POST /api/remote-relays/tool').agent, ROUTE_ACCESS.allow);
  // `oar url --sign-in`: past `auth` for agent tokens, the route takes the
  // cli kind over loopback only; never a paired relay.
  assert.equal(RELAY_ROUTE_POLICY.get('POST /api/auth/signin-codes/terminal').agent, ROUTE_ACCESS.row);
  assert.equal(RELAY_ROUTE_POLICY.get('POST /api/auth/signin-codes/terminal').peer, ROUTE_ACCESS.deny);
  // Minting an inbound-only key is the person's: neither an agent token nor
  // a paired relay's key mints one.
  assert.deepEqual(
    { ...RELAY_ROUTE_POLICY.get('POST /api/remote-relays/peer-key/inbound') },
    { agent: ROUTE_ACCESS.deny, peer: ROUTE_ACCESS.deny, listed: true },
  );
  assert.ok(routes.some((route) => route.key === 'POST /api/remote-relays/peer-key/inbound' && route.authed));
});

test('the person-only list and the agent table do not overlap', () => {
  for (const key of PERSON_ONLY_ROUTES) assert.equal(RELAY_ROUTE_POLICY.get(key).agent, ROUTE_ACCESS.deny, key);
});

// A cookie request that only reads is not checked for its site (§4.3), so a
// GET must not change anything: checked on the handler's own text, for the
// person-only GETs a browser makes. Writes through helpers are covered by
// those routes' own tests.
const WRITE_PATTERN = /\.run\(|\bupsert|\binsert[A-Z(]|\.delete\(|writeFile|rmSync|unlinkSync|renameSync|io\??\.emit\(|\bpersist[A-Z]|\bsave[A-Z]\w*\(|\.set[A-Z]\w*Settings?\(/;

test('no person-only GET changes state', () => {
  const offenders = routes
    .filter((route) => route.method === 'GET' && route.authed && routePolicyFor('GET', route.path).agent === ROUTE_ACCESS.deny)
    .filter((route) => WRITE_PATTERN.test(String(route.handler)))
    .map((route) => route.key);
  assert.deepEqual([...new Set(offenders)], []);
});

// ─── The session's proof key: every GET behind auth, the cookie-only list ────
//
// A request with the session cookie needs the session's proof key on every
// route except COOKIE_ONLY_API_ROUTES (relay-auth.mjs): a page on another
// port of the host gets the cookie, never the key. So a cookie-only GET is
// what such a page can still reach: it must be a GET of bytes the relay
// names by id or hash (never a file by path), open to agent tokens anyway,
// that writes nothing. The two routes that read a file by path take a file
// capability (`k`) in place of the key (FILE_CAPABILITY_API_ROUTES).

// An in-memory file-metadata cache that drops a stale entry is no write.
const CACHE_EVICTION = /\b\w*Cache\.delete\(/g;
const handlerText = (route) => String(route.handler).replace(CACHE_EVICTION, '');
// The content routes' answers: file bytes; JSON only for an error status.
const SERVES_FILE = /serveFileWithRangeSupport\(|\.sendFile\(|res\.end\(bytes\)/;
const JSON_ANSWER = /(?:\.status\((\d{3})\)\s*)?\.json\(/g;
const CONTENT_PATH = /^\/api\/(?:upload\/:sha256\/content|generated-image\/:conversationId\/:messageId\/(?::imageId\/content|partials\/:fileName)|media\/:id\/content)$/;

test('every GET behind auth that writes needs the proof key with a cookie (none is cookie-only); the worker GETs among them', () => {
  const authedGets = routes.filter((route) => route.method === 'GET' && route.authed);
  assert.ok(authedGets.length > 50, `only ${authedGets.length} GETs behind auth`);
  const writing = authedGets.filter((route) => WRITE_PATTERN.test(handlerText(route)));
  assert.deepEqual(writing.filter((route) => isCookieOnlyRoute('GET', route.path)).map((route) => route.key), []);
  // The worker plumbing GETs that change state: a cookie alone cannot reach
  // them any more (403 AUTH_SESSION_PROOF without the key).
  for (const key of ['GET /api/pending', 'GET /api/sdk-session-delete/pending', 'GET /api/control/active', 'GET /api/claude-cloud-session']) {
    const route = authedGets.find((candidate) => candidate.key === key);
    assert.ok(route, `${key} is registered behind auth`);
    assert.equal(isCookieOnlyRoute('GET', route.path), false, key);
    assert.equal(isCookieOnlyRoute('HEAD', route.path), false, key);
  }
  for (const key of ['GET /api/pending', 'GET /api/sdk-session-delete/pending', 'GET /api/control/active']) {
    assert.ok(writing.some((route) => route.key === key), `${key} is seen as a write`);
  }
  // Every other GET behind auth needs the key too: the list is the only way round it.
  const cookieOnly = authedGets.filter((route) => isCookieOnlyRoute('GET', route.path)).map((route) => route.key);
  assert.deepEqual([...new Set(cookieOnly)].sort(), [...COOKIE_ONLY_API_ROUTES].sort());
});

test('the cookie-only list: each route exists behind auth, is a GET of file bytes an agent may read too, and writes nothing', () => {
  assert.ok(COOKIE_ONLY_API_ROUTES.length > 0 && COOKIE_ONLY_API_ROUTES.length <= 8, 'a short list');
  for (const key of COOKIE_ONLY_API_ROUTES) {
    const route = routes.find((candidate) => candidate.key === key);
    assert.ok(route, `${key} exists`);
    assert.equal(route.method, 'GET', key);
    assert.equal(route.authed, true, `${key} is behind auth`);
    assert.match(route.path, CONTENT_PATH, `${key} is a content route`);
    // Nothing the person alone may see: an agent token reads it as well.
    assert.equal(routePolicyFor('GET', route.path).agent, ROUTE_ACCESS.allow, `${key} is open to agents`);
    assert.ok(!PERSON_ONLY_ROUTES.includes(key), key);
    const text = handlerText(route);
    assert.doesNotMatch(text, WRITE_PATTERN, `${key} writes nothing`);
    assert.match(text, SERVES_FILE, `${key} answers with file bytes`);
    for (const match of text.matchAll(JSON_ANSWER)) {
      const status = Number(match[1]);
      assert.ok(status >= 400, `${key}: JSON only for an error (found ${match[0]})`);
    }
    // No transcript, setting, card or secret store is read.
    assert.doesNotMatch(text, /getMessages|listMessages|transcript|readAppSetting|ownerSecret|relay-secrets|apiKey/i, key);
  }
  // A write, a JSON read of the person's, a sign-in route or a file by path is never on it.
  for (const key of ['GET /api/files/{*splat}', 'GET /api/drives/file', 'POST /api/upload', 'GET /api/conversation/:id', 'GET /api/auth/sessions', 'GET /api/files-preview/{*splat}', 'GET /api/drives/files-preview', 'GET /api/settings/openai', 'POST /api/relay-question/:id/answer']) {
    assert.ok(!COOKIE_ONLY_API_ROUTES.includes(key), key);
  }
});

// A row (`R`) is decided inside the route: its handler must look at who is
// calling. Checked on the handler's own text (a named handler, such as the
// send route's, is its whole function), so a row cannot be listed as one
// and then let every agent through unchecked.
// A module's own helper that does the check counts when its text does.
const ROW_LOGIC_PATTERN = /\b(isPerson|isAgent|notPerson|principalOf|agentConversationOf|isDirectAgentRequest|agentScope)\(/;
const ROW_HELPERS = [
  // preview-routes.mjs: an agent token's own conversation's previews.
  { name: 'agentScope', registrar: registerPreviewRoutes },
];

test('every row in the route policy has logic in its handler', () => {
  const rows = routes.filter((route) => route.authed && routePolicyFor(route.method, route.path).agent === ROUTE_ACCESS.row);
  assert.ok(rows.length >= 8, `only ${rows.length} rows`);
  const without = rows.filter((route) => !ROW_LOGIC_PATTERN.test(String(route.handler))).map((route) => route.key);
  assert.deepEqual([...new Set(without)], [], 'a row must decide per request who may call it');
  for (const { name, registrar } of ROW_HELPERS) {
    const helper = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[^}]*\\b(notPerson|isPerson|principalOf|agentConversationOf)\\(`);
    assert.match(String(registrar), helper, `${name} checks the caller`);
  }
});

// The file-by-path routes: not cookie-only, they take a file capability
// (`k`) instead of the key, check it and the always-refused files in their
// handler before reading; the route that makes capabilities is the person's.
test('the file capability routes: GETs of a file by path, not cookie-only, each checks its file before reading', () => {
  assert.deepEqual([...FILE_CAPABILITY_API_ROUTES].sort(), ['GET /api/drives/file', 'GET /api/files/{*splat}']);
  for (const key of FILE_CAPABILITY_API_ROUTES) {
    const route = routes.find((candidate) => candidate.key === key);
    assert.ok(route, `${key} exists`);
    assert.equal(route.authed, true, `${key} is behind auth`);
    assert.equal(isCookieOnlyRoute('GET', route.path), false, `${key} is not cookie-only`);
    assert.equal(isFileCapabilityRoute('GET', route.path), true, key);
    assert.equal(isFileCapabilityRoute('HEAD', route.path), true, `${key} (HEAD)`);
    const text = handlerText(route);
    assert.match(text, /fileAccessRefused\(req, res, filePath\)/, `${key} checks the capability and the refused files`);
    assert.doesNotMatch(text, WRITE_PATTERN, `${key} writes nothing`);
  }
  for (const key of ['GET /api/files-preview/{*splat}', 'GET /api/drives/files-preview']) {
    const route = routes.find((candidate) => candidate.key === key);
    assert.match(handlerText(route), /fileAccessRefused\(req, res, filePath\)/, `${key} refuses the relay's own files`);
    assert.equal(isFileCapabilityRoute('GET', route.path), false, `${key} takes no capability`);
  }
  // Every other GET behind auth takes none.
  const taking = routes.filter((route) => route.authed && isFileCapabilityRoute(route.method, route.path)).map((route) => route.key);
  assert.deepEqual([...new Set(taking)].sort(), [...FILE_CAPABILITY_API_ROUTES].sort());
  const mint = routes.find((candidate) => candidate.key === 'POST /api/files/capability');
  assert.ok(mint && mint.authed, 'POST /api/files/capability is behind auth');
  assert.ok(PERSON_ONLY_ROUTES.includes('POST /api/files/capability'), 'person-only: agents and peers are refused');
  assert.equal(routePolicyFor('POST', mint.path).agent, ROUTE_ACCESS.deny);
  assert.equal(routePolicyFor('POST', mint.path).peer, ROUTE_ACCESS.deny);
});
