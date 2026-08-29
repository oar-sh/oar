import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createPreviewRegistry,
  normalizePreviewsConfig,
} from './preview-registry-service.mjs';
import {
  createPreviewProxyServer,
  rewriteLocation,
  rewriteSetCookie,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  stripRelayCookies,
} from './preview-proxy-server.mjs';

const BASE_PATH = `/test_${'a'.repeat(32)}/`;
const silentLogger = { log() {}, warn() {}, error() {} };

function previewConfig(overrides = {}) {
  return normalizePreviewsConfig({
    enabled: true,
    publicBaseUrl: 'https://preview.example.com',
    // 0 = ephemeral: every run binds a free port, so the suite never collides
    // with a relay running on the same machine.
    port: 0,
    ...overrides,
  }, { env: {}, relayPort: 3333, relayHostnames: ['relay.example.com'], reservedPorts: [4445] });
}

// A fixture "dev server": records what the proxy forwarded and can be told what
// to answer with.
async function startUpstream(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    handler(req, res, received);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    received,
    port: server.address().port,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

// A minimal echo upgrade handler — enough to prove the handshake and both pipe
// directions without pulling in a websocket library. Upgraded sockets are
// tracked because the http.Server detaches them, so neither close() nor
// closeAllConnections() can reach them at teardown.
async function startEchoUpstream() {
  const sockets = new Set();
  const server = http.createServer((_req, res) => res.end('http'));
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `X-Upstream-Path: ${req.url}`,
      '\r\n',
    ].join('\r\n'));
    socket.on('data', (chunk) => socket.write(chunk));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

async function startLane(config = previewConfig()) {
  const registry = createPreviewRegistry({ config });
  const proxy = createPreviewProxyServer({ registry, logger: silentLogger, relayBearerTokens: ['relay-token'] });
  const address = await proxy.start();
  return {
    registry,
    proxy,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await proxy.stop();
    },
  };
}

async function fetchLane(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual', ...options });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

// ─── pure header logic ────────────────────────────────────────────────────────

test('stripRelayCookies removes only the relay cookie', () => {
  assert.equal(
    stripRelayCookies('theme=dark; copilot_auth=secret; sid=abc'),
    'theme=dark; sid=abc',
  );
  assert.equal(stripRelayCookies('copilot_auth=secret'), '');
  assert.equal(stripRelayCookies(''), '');
  // A cookie merely containing the name is not the relay cookie.
  assert.equal(stripRelayCookies('my_copilot_auth=x'), 'my_copilot_auth=x');
});

test('sanitizeRequestHeaders drops hop-by-hop headers and rewrites Host', () => {
  const headers = sanitizeRequestHeaders({
    host: 'preview.example.com',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    'proxy-authorization': 'Basic xyz',
    upgrade: 'websocket',
    accept: 'text/html',
  }, {
    targetHost: '127.0.0.1', targetPort: 5173, basePath: BASE_PATH, forwardedHost: 'preview.example.com',
  });

  assert.equal(headers.host, '127.0.0.1:5173');
  assert.equal(headers.accept, 'text/html');
  assert.equal(headers['x-forwarded-prefix'], BASE_PATH.replace(/\/$/, ''));
  assert.equal(headers['x-forwarded-host'], 'preview.example.com');
  assert.equal(headers['x-forwarded-proto'], 'https');
  for (const dropped of ['connection', 'transfer-encoding', 'proxy-authorization', 'upgrade']) {
    assert.equal(headers[dropped], undefined, `${dropped} should not be forwarded`);
  }
});

test('sanitizeRequestHeaders withholds the relay bearer token but passes app auth', () => {
  const withRelayToken = sanitizeRequestHeaders(
    { authorization: 'Bearer relay-token' },
    { targetHost: '127.0.0.1', targetPort: 5173, basePath: BASE_PATH, bearerTokens: ['relay-token'] },
  );
  assert.equal(withRelayToken.authorization, undefined);

  const withAppToken = sanitizeRequestHeaders(
    { authorization: 'Bearer app-token' },
    { targetHost: '127.0.0.1', targetPort: 5173, basePath: BASE_PATH, bearerTokens: ['relay-token'] },
  );
  assert.equal(withAppToken.authorization, 'Bearer app-token');
});

test('rewriteLocation prefixes root-relative redirects', () => {
  const opts = { basePath: BASE_PATH, targetHost: '127.0.0.1', targetPort: 5173 };
  assert.equal(rewriteLocation('/login', opts), `${BASE_PATH.replace(/\/$/, '')}/login`);
  // Already-prefixed and protocol-relative targets are left alone.
  assert.equal(rewriteLocation(`${BASE_PATH}login`, opts), `${BASE_PATH}login`);
  assert.equal(rewriteLocation('//evil.example.com/x', opts), '//evil.example.com/x');
  assert.equal(rewriteLocation('relative/path', opts), 'relative/path');
  assert.equal(rewriteLocation('', opts), '');
});

test('rewriteLocation folds an upstream self-redirect back into the prefix', () => {
  const opts = { basePath: BASE_PATH, targetHost: '127.0.0.1', targetPort: 5173 };
  assert.equal(
    rewriteLocation('http://127.0.0.1:5173/dash?tab=1', opts),
    `${BASE_PATH.replace(/\/$/, '')}/dash?tab=1`,
  );
  // A genuine off-site redirect (OAuth, docs) must survive untouched.
  assert.equal(rewriteLocation('https://accounts.example.com/oauth', opts), 'https://accounts.example.com/oauth');
});

test('rewriteSetCookie scopes cookies to the preview and drops Domain', () => {
  const rewritten = rewriteSetCookie('sid=abc; Path=/; Domain=example.com; HttpOnly; SameSite=Lax', {
    basePath: BASE_PATH,
  });
  assert.equal(rewritten, `sid=abc; HttpOnly; SameSite=Lax; Path=${BASE_PATH}`);
});

test('rewriteSetCookie refuses to let an app set a relay credential', () => {
  assert.equal(rewriteSetCookie('copilot_auth=stolen; Path=/', { basePath: BASE_PATH }), null);
});

test('sanitizeResponseHeaders strips worker-scope widening and adds noindex', () => {
  const headers = sanitizeResponseHeaders({
    'content-type': 'text/html',
    'service-worker-allowed': '/',
    connection: 'keep-alive',
    'set-cookie': ['a=1; Path=/', 'copilot_auth=x; Path=/'],
    location: '/next',
  }, { basePath: BASE_PATH, targetHost: '127.0.0.1', targetPort: 5173 });

  assert.equal(headers['content-type'], 'text/html');
  assert.equal(headers['service-worker-allowed'], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers['x-robots-tag'], 'noindex, nofollow, noarchive');
  assert.deepEqual(headers['set-cookie'], [`a=1; Path=${BASE_PATH}`]);
  assert.equal(headers.location, `${BASE_PATH.replace(/\/$/, '')}/next`);
});

// ─── isolation ────────────────────────────────────────────────────────────────

test('the preview listener exposes no relay surface', async (t) => {
  const lane = await startLane();
  t.after(() => lane.close());

  // A regression on any of these is the feature's whole failure mode, so they
  // are asserted against the really-bound port rather than a mock.
  const relayPaths = [
    '/',
    '/index.html',
    '/api/conversations',
    '/api/previews',
    '/socket.io/?EIO=4&transport=polling',
    `/shared/${'a'.repeat(32)}`,
    '/manifest.webmanifest',
    '/sw.js',
    '/app/store.js',
  ];
  for (const path of relayPaths) {
    const response = await fetchLane(lane.origin, path);
    assert.equal(response.status, 404, `${path} must not be served by the preview lane`);
    assert.match(response.body, /No such preview/);
  }
});

test('an unknown or closed token 404s', async (t) => {
  const upstream = await startUpstream((_req, res) => res.end('hello'));
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ conversationId: 'conv-1', port: upstream.port });
  assert.equal((await fetchLane(lane.origin, `${preview.basePath}`)).status, 200);

  lane.registry.close(preview.token);
  assert.equal((await fetchLane(lane.origin, `${preview.basePath}`)).status, 404);
  assert.equal((await fetchLane(lane.origin, `/test_${'f'.repeat(32)}/`)).status, 404);
});

// ─── proxying ─────────────────────────────────────────────────────────────────

test('a request is forwarded with the prefix stripped and forwarding headers set', async (t) => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ port: upstream.port });
  const response = await fetchLane(lane.origin, `${preview.basePath}assets/app.js?v=1`);

  assert.equal(response.status, 200);
  assert.equal(response.body, 'ok');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

  const forwarded = upstream.received.at(-1);
  assert.equal(forwarded.url, '/assets/app.js?v=1');
  assert.equal(forwarded.headers['x-forwarded-prefix'], preview.basePath.replace(/\/$/, ''));
  assert.equal(forwarded.headers.host, `127.0.0.1:${upstream.port}`);
  assert.equal(lane.registry.get(preview.token).hits, 1);
});

test('relay credentials never reach the previewed app', async (t) => {
  const upstream = await startUpstream((_req, res) => res.end('ok'));
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ port: upstream.port });
  await fetchLane(lane.origin, preview.basePath, {
    headers: {
      cookie: 'copilot_auth=super-secret; theme=dark',
      authorization: 'Bearer relay-token',
    },
  });

  const forwarded = upstream.received.at(-1);
  assert.equal(forwarded.headers.cookie, 'theme=dark');
  assert.equal(forwarded.headers.authorization, undefined);
  assert.equal(JSON.stringify(forwarded.headers).includes('super-secret'), false);
});

test('a bare prefix redirects to the trailing slash, keeping the query', async (t) => {
  const upstream = await startUpstream((_req, res) => res.end('ok'));
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ port: upstream.port });
  const response = await fetchLane(lane.origin, preview.basePath.replace(/\/$/, '') + '?a=1');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), `${preview.basePath}?a=1`);
});

test('POST bodies stream through unparsed', async (t) => {
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ port: upstream.port });
  const response = await fetchLane(lane.origin, `${preview.basePath}submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.deepEqual(JSON.parse(response.body), { received: '{"hello":"world"}' });
});

test('redirects and cookies are rewritten end to end', async (t) => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(302, {
      location: '/login',
      'set-cookie': ['sid=abc; Path=/; Domain=localhost', 'copilot_auth=stolen; Path=/'],
    });
    res.end();
  });
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ port: upstream.port });
  const response = await fetchLane(lane.origin, preview.basePath);

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${preview.basePath.replace(/\/$/, '')}/login`);
  const cookies = response.headers.getSetCookie();
  assert.deepEqual(cookies, [`sid=abc; Path=${preview.basePath}`]);
});

test('a 304 and a HEAD response carry no body', async (t) => {
  const upstream = await startUpstream((req, res) => {
    if (req.url === '/cached') {
      res.writeHead(304, { etag: 'W/"1"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
    res.end('ok');
  });
  const lane = await startLane();
  t.after(async () => { await lane.close(); await upstream.close(); });

  const { preview } = lane.registry.create({ port: upstream.port });
  const cached = await fetchLane(lane.origin, `${preview.basePath}cached`);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, '');

  const head = await fetchLane(lane.origin, preview.basePath, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('a dead upstream yields a readable 502, and the link keeps working after a restart', async (t) => {
  const upstream = await startUpstream((_req, res) => res.end('alive'));
  const port = upstream.port;
  const lane = await startLane();
  t.after(() => lane.close());

  const { preview } = lane.registry.create({ port });
  assert.equal((await fetchLane(lane.origin, preview.basePath)).body, 'alive');

  await upstream.close();
  const dead = await fetchLane(lane.origin, preview.basePath);
  assert.equal(dead.status, 502);
  assert.match(dead.body, /Preview upstream unreachable/);
  assert.match(dead.body, new RegExp(`127\\.0\\.0\\.1:${port}`));

  // Same port, new process: the token is still registered, so the public link
  // recovers without the user touching anything.
  const restarted = http.createServer((_req, res) => res.end('back'));
  restarted.listen(port, '127.0.0.1');
  await once(restarted, 'listening');
  t.after(async () => {
    restarted.closeAllConnections?.();
    restarted.close();
    await once(restarted, 'close');
  });

  assert.equal((await fetchLane(lane.origin, preview.basePath)).body, 'back');
});

test('websocket upgrades are proxied through the prefix', async (t) => {
  // A minimal echo upgrade handler — enough to prove the handshake and both
  // pipe directions without pulling in a websocket library.
  const upstream = await startEchoUpstream();
  const lane = await startLane();
  t.after(async () => {
    await lane.close();
    await upstream.close();
  });

  const { preview } = lane.registry.create({ port: upstream.port });
  const laneAddress = lane.proxy.address;
  const request = http.request({
    host: '127.0.0.1',
    port: laneAddress.port,
    path: `${preview.basePath}hmr`,
    headers: { connection: 'Upgrade', upgrade: 'websocket', host: 'preview.example.com' },
  });
  request.end();

  const [res, socket, head] = await once(request, 'upgrade');
  assert.equal(res.statusCode, 101);
  assert.equal(res.headers['x-upstream-path'], '/hmr');
  assert.equal(head.length, 0);

  socket.write('ping');
  const [echoed] = await once(socket, 'data');
  assert.equal(echoed.toString('utf8'), 'ping');
  socket.destroy();
});

test('an upgrade on an unknown token is refused without reaching any upstream', async (t) => {
  const lane = await startLane();
  t.after(() => lane.close());

  const request = http.request({
    host: '127.0.0.1',
    port: lane.proxy.address.port,
    path: '/socket.io/?EIO=4',
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  });
  request.end();

  const [res] = await once(request, 'response');
  assert.equal(res.statusCode, 404);
  res.resume();
});

test('a static preview serves its directory through the lane', async (t) => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = mkdtempSync(pathMod.join(os.tmpdir(), 'lane-static-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  mkdirSync(pathMod.join(dir, 'assets'));
  writeFileSync(pathMod.join(dir, 'index.html'), '<h1>static</h1>');
  writeFileSync(pathMod.join(dir, 'assets', 'app.js'), 'ok()');
  writeFileSync(pathMod.join(dir, '.env'), 'SECRET=1');

  const lane = await startLane();
  t.after(() => lane.close());
  const { preview } = lane.registry.createStatic({ rootDir: realpathSync(dir), label: 'site' });

  const index = await fetchLane(lane.origin, preview.basePath);
  assert.equal(index.status, 200);
  assert.equal(index.body, '<h1>static</h1>');
  assert.equal(index.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

  const asset = await fetchLane(lane.origin, `${preview.basePath}assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);

  // Jail and denylist hold over the wire, not just in the resolver.
  assert.equal((await fetchLane(lane.origin, `${preview.basePath}.env`)).status, 404);
  assert.equal((await fetchLane(lane.origin, `${preview.basePath}..%2f..%2fetc%2fpasswd`)).status, 404);

  // Directory redirect keeps the token prefix.
  const redirect = await fetchLane(lane.origin, `${preview.basePath}assets`);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), `${preview.basePath}assets/`);

  // No upstream: an upgrade attempt is refused like an unknown token.
  const request = http.request({
    host: '127.0.0.1',
    port: lane.proxy.address.port,
    path: `${preview.basePath}ws`,
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  });
  request.end();
  const [res] = await once(request, 'response');
  assert.equal(res.statusCode, 404);
  res.resume();
});

test('stop() completes while a websocket is still open', async (t) => {
  // An upgraded socket is detached from the http.Server, so a shutdown that
  // relied on close()/closeAllConnections() alone would hang for as long as a
  // browser held an HMR connection.
  const upstream = await startEchoUpstream();
  const lane = await startLane();
  t.after(() => upstream.close());

  const { preview } = lane.registry.create({ port: upstream.port });
  const request = http.request({
    host: '127.0.0.1',
    port: lane.proxy.address.port,
    path: `${preview.basePath}hmr`,
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  });
  request.end();
  const [, socket] = await once(request, 'upgrade');
  t.after(() => socket.destroy());

  await lane.close();
  assert.equal(lane.proxy.listening, false);
});

test('start() is a no-op while the lane is disabled', async () => {
  const registry = createPreviewRegistry({ config: normalizePreviewsConfig({}, { relayPort: 3333 }) });
  const proxy = createPreviewProxyServer({ registry, logger: silentLogger });
  assert.equal(await proxy.start(), null);
  assert.equal(proxy.listening, false);
  await proxy.stop();
});
