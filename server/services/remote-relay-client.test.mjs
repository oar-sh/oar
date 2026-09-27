import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteRelayClient, RemoteRelayError } from './remote-relay-client.mjs';
import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';

// Token-shaped values are assembled at runtime so no literal looks like a secret.
const OWN_TOKEN = 'o'.repeat(36);
const CUSTOM_TOKEN = 'c'.repeat(64);
const OWN_RELAY_ID = 'relay-self-0001';

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function createClient(fetchImpl, overrides = {}) {
  return createRemoteRelayClient({
    fetchImpl,
    getOwnRelayId: () => OWN_RELAY_ID,
    getOwnToken: () => OWN_TOKEN,
    ...overrides,
  });
}

function recordingFetch(respond = () => jsonResponse({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return respond(url, options);
  };
  return { calls, fetchImpl };
}

const relayA = { name: 'linux-test', url: 'https://relay-a.example.test/oar', tokenMode: 'own' };
const relayB = { name: 'win-test', url: 'https://relay-b.example.test', tokenMode: 'custom', token: CUSTOM_TOKEN };

test('tokenFor uses the own token unless the remote has a custom one', () => {
  const client = createClient(async () => jsonResponse({}));
  assert.equal(client.tokenFor(relayA), OWN_TOKEN);
  assert.equal(client.tokenFor(relayB), CUSTOM_TOKEN);
  assert.equal(client.tokenFor({ url: relayA.url, tokenMode: 'custom' }), '', 'custom without a token has none');
});

test('a request sends only the documented headers and keeps the path prefix', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ conversations: [] }));
  const client = createClient(fetchImpl);
  const result = await client.request(relayA, 'get', '/api/conversations', { query: { limit: 20, cursor: undefined, q: 'report builder' }, hops: 2 });
  assert.deepEqual(result, { conversations: [] });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://relay-a.example.test/oar/api/conversations?limit=20&q=report+builder');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.body, undefined);
  assert.deepEqual(options.headers, {
    Authorization: `Bearer ${OWN_TOKEN}`,
    Accept: 'application/json',
    'x-oar-remote-origin': OWN_RELAY_ID,
    'x-oar-remote-hops': '2',
  });
  assert.equal(Object.keys(options.headers).some((name) => /^x-relay-/i.test(name)), false, 'never a worker identity header');
});

test('a body adds Content-Type, is JSON-encoded and uses the custom token', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ ok: true, messageId: 'm-1' }));
  const client = createClient(fetchImpl);
  await client.request(relayB, 'POST', '/api/message', { body: { text: 'hello', conversationId: 'c-1' } });
  const { url, options } = calls[0];
  assert.equal(url, 'https://relay-b.example.test/api/message');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers.Authorization, `Bearer ${CUSTOM_TOKEN}`);
  assert.equal(options.headers['x-oar-remote-hops'], '1', 'hops default to 1');
  assert.deepEqual(JSON.parse(options.body), { text: 'hello', conversationId: 'c-1' });
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Authorization', 'Content-Type', 'x-oar-remote-hops', 'x-oar-remote-origin']);
});

test('redirects are refused, so the token never follows one', async () => {
  const client = createClient(async () => new Response(null, { status: 302, headers: { location: 'https://login.example.test/' } }));
  await assert.rejects(client.request(relayA, 'GET', '/api/status'), (error) => {
    assert.ok(error instanceof RemoteRelayError);
    assert.equal(error.code, 'REMOTE_RELAY_HTTP_302');
    assert.equal(error.status, 302);
    assert.match(error.message, /redirect/);
    return true;
  });

  const opaque = createClient(async () => ({ type: 'opaqueredirect', status: 0, headers: new Headers() }));
  await assert.rejects(opaque.request(relayA, 'GET', '/api/status'), { code: 'REMOTE_RELAY_HTTP_3xx' });
});

test('the address policy is re-checked before anything is sent', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = createClient(fetchImpl);
  await assert.rejects(
    client.request({ url: 'http://relay-a.example.test', tokenMode: 'own' }, 'GET', '/api/status'),
    { code: REMOTE_RELAY_ERROR_CODES.unsupported },
  );
  await assert.rejects(
    client.request({ url: 'ftp://relay-a.example.test', tokenMode: 'own' }, 'GET', '/api/status'),
    { code: REMOTE_RELAY_ERROR_CODES.unsupported },
  );
  assert.equal(calls.length, 0);

  await client.request({ url: 'http://127.0.0.1:13352', tokenMode: 'own' }, 'GET', '/api/status');
  await client.request({ url: 'http://192.168.10.20:3333', tokenMode: 'own' }, 'GET', '/api/status');
  assert.equal(calls.length, 2, 'loopback and private http is allowed');
});

test('paths must stay under the relay base', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = createClient(fetchImpl);
  await assert.rejects(client.request(relayA, 'GET', '/../../elsewhere'), { code: REMOTE_RELAY_ERROR_CODES.invalidInput });
  await assert.rejects(client.request(relayA, 'GET', '//relay-b.example.test/api'), { code: REMOTE_RELAY_ERROR_CODES.invalidInput });
  await assert.rejects(client.request(relayA, 'GET', 'api/status'), { code: REMOTE_RELAY_ERROR_CODES.invalidInput });
  assert.equal(calls.length, 0);
});

test('without a token nothing is sent', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = createClient(fetchImpl, { getOwnToken: () => '' });
  await assert.rejects(client.request(relayA, 'GET', '/api/status'), { code: REMOTE_RELAY_ERROR_CODES.unauthorized });
  assert.equal(calls.length, 0);
});

test('a timeout maps to offline', async () => {
  const client = createClient((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(client.request(relayA, 'GET', '/api/status', { timeoutMs: 20 }), (error) => {
    assert.equal(error.code, REMOTE_RELAY_ERROR_CODES.offline);
    assert.match(error.detail, /timed out/);
    assert.match(error.message, /linux-test/);
    return true;
  });
});

test('network and DNS failures map to offline with the socket error code', async () => {
  const refused = createClient(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  });
  await assert.rejects(refused.request(relayA, 'GET', '/api/status'), (error) => {
    assert.equal(error.code, REMOTE_RELAY_ERROR_CODES.offline);
    assert.equal(error.detail, 'ECONNREFUSED');
    return true;
  });
  const dns = createClient(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  });
  await assert.rejects(dns.request(relayA, 'GET', '/api/status'), { code: REMOTE_RELAY_ERROR_CODES.offline, detail: 'ENOTFOUND' });
});

test('HTTP errors map to the contract codes and keep the remote error text', async () => {
  const cases = [
    [401, { error: 'Unauthorized' }, REMOTE_RELAY_ERROR_CODES.unauthorized],
    [403, { error: 'Inbound off', code: 'REMOTE_INBOUND_DISABLED' }, REMOTE_RELAY_ERROR_CODES.inboundDisabled],
    [403, { error: 'Forbidden' }, 'REMOTE_RELAY_HTTP_403'],
    [404, { error: 'Conversation not found' }, REMOTE_RELAY_ERROR_CODES.notFound],
    [409, { error: 'Session is busy', code: 'SESSION_BUSY' }, 'REMOTE_RELAY_HTTP_409'],
    [500, { error: 'boom' }, 'REMOTE_RELAY_HTTP_500'],
  ];
  for (const [status, body, code] of cases) {
    const client = createClient(async () => jsonResponse(body, { status }));
    await assert.rejects(client.request(relayA, 'GET', '/api/conversation/c-1'), (error) => {
      assert.ok(error instanceof RemoteRelayError, `${status} is a RemoteRelayError`);
      assert.equal(error.code, code, `${status} → ${code}`);
      assert.equal(error.status, status);
      assert.equal(error.remoteError, body.error);
      assert.deepEqual(error.remoteBody, body);
      assert.equal(error.message.includes(OWN_TOKEN), false, 'messages never carry the token');
      return true;
    });
  }
  assert.equal((await rejection(createClient(async () => jsonResponse({ code: 'SESSION_BUSY' }, { status: 409 })))).detail, 'SESSION_BUSY');
  const html = createClient(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  const htmlError = await rejection(html);
  assert.equal(htmlError.code, 'REMOTE_RELAY_HTTP_502');
  assert.equal(htmlError.remoteError, null, 'a non-JSON error page has no remote error text');
});

async function rejection(client) {
  try {
    await client.request(relayA, 'GET', '/api/status');
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

test('the response size is capped, declared or streamed', async () => {
  const declared = createClient(async () => jsonResponse({ ok: true }, { headers: { 'content-length': '5000' } }), { maxBytes: 1000 });
  await assert.rejects(declared.request(relayA, 'GET', '/api/status'), { code: REMOTE_RELAY_ERROR_CODES.unsupported, detail: 'response too large' });

  let cancelled = false;
  const streamed = createClient(async () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(400)));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200 }), { maxBytes: 1000 });
  await assert.rejects(streamed.request(relayA, 'GET', '/api/status'), { code: REMOTE_RELAY_ERROR_CODES.unsupported });
  assert.equal(cancelled, true, 'the stream is cancelled once over the cap');

  const fits = createClient(async () => jsonResponse({ text: 'y'.repeat(100) }), { maxBytes: 1000 });
  assert.equal((await fits.request(relayA, 'GET', '/api/status')).text.length, 100);
});

test('an empty body is null and a non-JSON success is refused', async () => {
  const empty = createClient(async () => new Response(null, { status: 204 }));
  assert.equal(await empty.request(relayA, 'POST', '/api/relay/cancel', { body: {} }), null);
  const html = createClient(async () => new Response('<!doctype html><title>index</title>', { status: 200 }));
  await assert.rejects(html.request(relayA, 'GET', '/api/status'), { code: REMOTE_RELAY_ERROR_CODES.unsupported });
});

test('probe reads the identity route and normalises it', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({
    relayId: 'relay-remote-0002',
    name: 'linux-test',
    version: '0.9.4',
    platform: 'linux',
    publicUrl: 'https://relay-b.example.test',
    remoteRelays: { protocol: 1, inbound: false },
  }));
  const client = createClient(fetchImpl);
  const identity = await client.probe('https://relay-b.example.test/', CUSTOM_TOKEN);
  assert.deepEqual(identity, {
    relayId: 'relay-remote-0002',
    name: 'linux-test',
    version: '0.9.4',
    platform: 'linux',
    publicUrl: 'https://relay-b.example.test',
    protocol: 1,
    inbound: false,
  });
  assert.equal(calls[0].url, 'https://relay-b.example.test/api/relay/identity');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${CUSTOM_TOKEN}`);
});

test('probe without a token uses the own token and names a nameless relay by host', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ relayId: 'r-2', name: '', remoteRelays: {} }));
  const identity = await createClient(fetchImpl).probe('https://relay-b.example.test', '');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${OWN_TOKEN}`);
  assert.equal(identity.name, 'relay-b.example.test');
  assert.equal(identity.protocol, 1);
  assert.equal(identity.inbound, true);
});

test('probe falls back to /api/status and the app name for an older relay', async () => {
  const seen = [];
  const client = createClient(async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    if (path === '/oar/api/relay/identity') return new Response('Cannot GET /api/relay/identity', { status: 404 });
    if (path === '/oar/api/status') return jsonResponse({ version: '0.9.3', platform: 'win32', cliOnline: true });
    if (path === '/oar/api/settings/pwa-app-name') return jsonResponse({ appName: 'win-test', shortName: 'win-test' });
    return new Response('', { status: 500 });
  });
  const identity = await client.probe('https://relay-a.example.test/oar', CUSTOM_TOKEN);
  assert.deepEqual(identity, {
    relayId: null,
    name: 'win-test',
    version: '0.9.3',
    platform: 'win32',
    publicUrl: null,
    protocol: 0,
    inbound: true,
  });
  assert.deepEqual(seen, ['/oar/api/relay/identity', '/oar/api/status', '/oar/api/settings/pwa-app-name']);
});

test('an older relay without an app name is named by its URL host', async () => {
  const client = createClient(async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/status') return jsonResponse({ version: '0.8.0', platform: 'linux' });
    return new Response('Not found', { status: 404 });
  });
  const identity = await client.probe('https://relay-b.example.test', CUSTOM_TOKEN);
  assert.equal(identity.name, 'relay-b.example.test');
  assert.equal(identity.protocol, 0);
});

test('probe surfaces a wrong token as unauthorized, identity route or fallback', async () => {
  const modern = createClient(async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 }));
  await assert.rejects(modern.probe('https://relay-b.example.test', CUSTOM_TOKEN), { code: REMOTE_RELAY_ERROR_CODES.unauthorized });
  const legacy = createClient(async (url) => (new URL(url).pathname === '/api/relay/identity'
    ? new Response('Cannot GET', { status: 404 })
    : jsonResponse({ error: 'Unauthorized' }, { status: 401 })));
  await assert.rejects(legacy.probe('https://relay-b.example.test', CUSTOM_TOKEN), { code: REMOTE_RELAY_ERROR_CODES.unauthorized });
});

test('probe refuses an answer that is not an identity object', async () => {
  const client = createClient(async () => jsonResponse(['not', 'an', 'identity']));
  await assert.rejects(client.probe('https://relay-b.example.test', CUSTOM_TOKEN), { code: REMOTE_RELAY_ERROR_CODES.unsupported });
});
