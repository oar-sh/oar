import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { RemoteRelayError } from './remote-relay-client.mjs';
import { admitRemoteRelayRequest, readRemoteRelayRequest } from './remote-relay-inbound.mjs';
import { createRemoteRelayLoopbackClient } from './remote-relay-loopback.mjs';

// The loopback hands requests to an Express app in-process: no port is bound
// and no connection is opened anywhere in this file.

const OWN_TOKEN = 't'.repeat(36);
const SELF = Object.freeze({ id: 'self', name: 'win-test', local: true });

/** An app shaped like the relay's: JSON body parser, bearer auth, JSON routes. */
function createApp({ inboundEnabled = true } = {}) {
  const app = express();
  const seen = [];
  const inbound = { inboundEnabled: () => inboundEnabled };
  app.use(express.json({ limit: '1mb' }));
  const auth = (req, res, next) => (req.headers.authorization === `Bearer ${OWN_TOKEN}`
    ? next()
    : res.status(401).json({ error: 'Unauthorized' }));
  app.get('/api/conversation/:id', auth, (req, res) => {
    seen.push({ method: 'GET', headers: { ...req.headers }, query: { ...req.query }, params: { ...req.params } });
    res.json({ id: req.params.id, limit: req.query.limit ?? null, request: readRemoteRelayRequest(req, inbound) });
  });
  app.post('/api/message', auth, (req, res) => {
    const request = admitRemoteRelayRequest(req, res, inbound);
    if (!request) return;
    seen.push({ method: 'POST', headers: { ...req.headers }, body: req.body });
    res.setHeader('Set-Cookie', 'session=abc; Path=/');
    res.json({ ok: true, body: req.body, request });
  });
  app.post('/api/refuse', auth, (_req, res) => res.status(400).json({ ok: false, error: 'Unsupported effort', code: 'REASONING_EFFORT_UNSUPPORTED', supportedReasoningEfforts: ['low'] }));
  app.post('/api/empty', auth, (_req, res) => res.status(204).end());
  app.get('/api/page', auth, (_req, res) => res.type('html').send('<p>not json</p>'));
  app.get('/api/large', auth, (_req, res) => res.json({ text: 'x'.repeat(4096) }));
  app.get('/api/never', auth, () => {});
  app.get('/api/throws', auth, () => { throw new Error('handler exploded'); });
  return { app, seen };
}

function createClient(app, options = {}) {
  return createRemoteRelayLoopbackClient({
    handle: app,
    getOwnRelayId: () => 'relay-self-id',
    getOwnToken: () => OWN_TOKEN,
    ...options,
  });
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to be rejected');
}

test('a request reaches the app\'s own route with the bearer token and the agent headers', async () => {
  const { app, seen } = createApp();
  const client = createClient(app);
  const answer = await client.request(SELF, 'get', '/api/conversation/conv%201', {
    query: { limit: 5, beforeMessageId: undefined, afterMessageId: null },
    hops: 0,
  });
  assert.equal(answer.id, 'conv 1');
  assert.equal(answer.limit, '5');
  assert.deepEqual(seen[0].query, { limit: '5' }, 'empty query values are left out');
  assert.equal(seen[0].headers.authorization, `Bearer ${OWN_TOKEN}`);
  assert.equal(seen[0].headers['x-oar-remote-origin'], 'relay-self-id');
  assert.equal(seen[0].headers['x-oar-remote-hops'], '0');
  // The routes treat it as an agent's request, and as this relay's own.
  assert.equal(answer.request.remote, true);
  assert.equal(answer.request.local, true);
});

test('a body arrives as the wire would deliver it, and a local origin keeps its flag', async () => {
  const { app, seen } = createApp();
  const client = createClient(app);
  const origin = { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-1', conversationTitle: 'report builder', hops: 0, local: true };
  const answer = await client.request(SELF, 'POST', '/api/message', {
    body: { conversationId: 'c-2', text: 'collect the numbers', origin, skipped: undefined },
    hops: 0,
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(seen[0].body, { conversationId: 'c-2', text: 'collect the numbers', origin });
  assert.equal(answer.request.origin.local, true);
  assert.equal(answer.request.origin.conversationId, 'c-1');
  assert.equal(seen[0].headers['content-type'], 'application/json');
});

test('the inbound switch does not apply to this relay\'s own agents', async () => {
  const { app } = createApp({ inboundEnabled: false });
  const answer = await createClient(app).request(SELF, 'POST', '/api/message', { body: { text: 'x' } });
  assert.equal(answer.ok, true);
});

test('a refusal comes back as the error a paired relay\'s refusal would be', async () => {
  const { app } = createApp();
  const client = createClient(app);
  const refused = await rejected(client.request(SELF, 'POST', '/api/refuse', { body: {} }));
  assert.ok(refused instanceof RemoteRelayError);
  assert.equal(refused.code, `${CODES.httpPrefix}400`);
  assert.equal(refused.status, 400);
  assert.equal(refused.message, 'Relay "win-test" answered HTTP 400: Unsupported effort');
  assert.deepEqual(refused.remoteBody.supportedReasoningEfforts, ['low']);
  assert.equal(refused.remoteBody.code, 'REASONING_EFFORT_UNSUPPORTED');

  const missing = await rejected(client.request(SELF, 'GET', '/api/no-such-route'));
  assert.equal(missing.code, CODES.notFound);
  assert.equal(missing.status, 404);
});

test('a wrong or missing token is refused before or by the app\'s auth', async () => {
  const { app } = createApp();
  const wrong = await rejected(createClient(app, { getOwnToken: () => 'another-token' }).request(SELF, 'GET', '/api/conversation/c-1'));
  assert.equal(wrong.code, CODES.unauthorized);
  assert.equal(wrong.status, 401);
  const none = await rejected(createClient(app, { getOwnToken: () => '' }).request(SELF, 'GET', '/api/conversation/c-1'));
  assert.equal(none.code, CODES.unauthorized);
  assert.match(none.message, /no token configured/);
});

test('an empty answer is null; one that is not JSON, or too large, is refused', async () => {
  const { app } = createApp();
  const client = createClient(app);
  assert.equal(await client.request(SELF, 'POST', '/api/empty', { body: {} }), null);
  const page = await rejected(client.request(SELF, 'GET', '/api/page'));
  assert.equal(page.code, CODES.unsupported);
  assert.match(page.message, /did not answer its own request with JSON/);
  const large = await rejected(createClient(app, { maxBytes: 1024 }).request(SELF, 'GET', '/api/large'));
  assert.equal(large.code, CODES.unsupported);
  assert.match(large.message, /larger than 1024 bytes/);
  assert.equal((await client.request(SELF, 'GET', '/api/large')).text.length, 4096);
});

test('a route that never answers ends on the timeout, with injected time', async () => {
  const { app } = createApp();
  const timers = [];
  const cleared = [];
  const client = createClient(app, {
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => cleared.push(timer),
  });
  const pending = rejected(client.request(SELF, 'GET', '/api/never', { timeoutMs: 4000 }));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 4000);
  timers[0].fn();
  const error = await pending;
  assert.equal(error.code, CODES.offline);
  assert.match(error.message, /did not answer its own request within 4 s/);

  // An answered request clears its timer; the default budget is the client's.
  await client.request(SELF, 'GET', '/api/conversation/c-1');
  assert.equal(timers[1].ms, 15_000);
  assert.deepEqual(cleared.at(-1), timers[1]);
});

test('a path that is not one of the app\'s is refused, and a missing handler is an answer', async () => {
  const { app } = createApp();
  const client = createClient(app);
  for (const path of ['api/conversation/c-1', '//evil.example.test/api', '']) {
    const error = await rejected(client.request(SELF, 'GET', path));
    assert.equal(error.code, CODES.invalidInput, path);
  }
  const none = await rejected(createRemoteRelayLoopbackClient({ getOwnToken: () => OWN_TOKEN }).request(SELF, 'GET', '/api/conversation/c-1'));
  assert.equal(none.code, CODES.unsupported);
});

test('a handler that throws answers 500 through the app, not a hung call', async () => {
  const { app } = createApp();
  // Express prints the stack of an unhandled route error; keep the test log clean.
  app.set('env', 'test');
  const error = await rejected(createClient(app).request(SELF, 'GET', '/api/throws'));
  assert.ok(error instanceof RemoteRelayError);
  assert.equal(error.status, 500);
  assert.equal(error.code, `${CODES.httpPrefix}500`);
});
