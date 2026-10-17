import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  createLocalRequestCheck,
  expressRequestView,
  isLoopbackAddress,
  isSameOriginRequest,
  requestHostOf,
  resolveTunnelMarkerHeaders,
} from './request-boundary.mjs';

function req({ peer = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: peer }, headers };
}

test('loopback addresses: v4 range, v6 and the mapped forms', () => {
  for (const value of ['127.0.0.1', '127.0.1.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackAddress(value), true, value);
  }
  for (const value of ['', null, '10.0.0.5', '192.168.7.31', '::ffff:192.168.7.31', '128.0.0.1', 'localhost', '::2']) {
    assert.equal(isLoopbackAddress(value), false, String(value));
  }
});

test('truly local: a loopback peer without marker or forwarding headers', () => {
  const check = createLocalRequestCheck();
  assert.equal(check.isTrulyLocal(req()), true);
  assert.equal(check.isTrulyLocal(req({ peer: '::1', headers: { host: '127.0.0.1:3333', authorization: 'Bearer x' } })), true);
  assert.equal(check.explain(req()), null);
});

test('not truly local: a remote peer, whatever the headers say', () => {
  const check = createLocalRequestCheck();
  assert.deepEqual(check.explain(req({ peer: '192.168.7.31' })), { reason: 'peer', header: null });
  assert.equal(check.isTrulyLocal({ headers: {} }), false);
  assert.equal(check.isTrulyLocal(null), false);
});

test('not truly local: a loopback peer that carries a tunnel marker', () => {
  const check = createLocalRequestCheck({ markerHeaders: ['x-relay-edge'] });
  assert.deepEqual(check.explain(req({ headers: { 'cf-ray': '8a1b2c3d4e5f6789-AMS' } })), { reason: 'marker', header: 'cf-ray' });
  assert.deepEqual(check.explain(req({ headers: { 'x-relay-edge': '1' } })), { reason: 'marker', header: 'x-relay-edge' });
  assert.equal(check.isTrulyLocal(req({ headers: { 'cf-ray': '  ' } })), true);
});

test('not truly local: a loopback peer that a same-host proxy forwarded', () => {
  const check = createLocalRequestCheck();
  for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
    assert.deepEqual(check.explain(req({ headers: { [header]: '203.0.113.9' } })), { reason: 'forwarded', header }, header);
  }
  assert.equal(check.isTrulyLocal(req({ headers: { 'x-forwarded-for': ['203.0.113.9'] } })), false);
});

test('marker headers from config and environment are merged, cf-ray always included', () => {
  assert.deepEqual(resolveTunnelMarkerHeaders([], 'X-Edge-A, x-edge-b'), ['cf-ray', 'x-edge-a', 'x-edge-b']);
  assert.deepEqual(resolveTunnelMarkerHeaders(['X-Edge-A'], ''), ['cf-ray', 'x-edge-a']);
  assert.deepEqual(resolveTunnelMarkerHeaders(['x-edge-a', 'CF-Ray'], 'x-edge-a'), ['cf-ray', 'x-edge-a']);
  assert.deepEqual(resolveTunnelMarkerHeaders(undefined, undefined), ['cf-ray']);
});

function trustingApp(trustProxy = 'loopback') {
  const app = express();
  app.set('trust proxy', trustProxy);
  return app;
}

test('request host follows trust proxy: X-Forwarded-Host only from a trusted peer', () => {
  const app = trustingApp();
  const viaProxy = expressRequestView(app, req({ headers: { host: '127.0.0.1:3333', 'x-forwarded-host': 'relay.example.com' } }));
  assert.equal(requestHostOf(viaProxy), 'relay.example.com');
  const direct = expressRequestView(app, req({ peer: '192.168.7.31', headers: { host: '192.168.7.20:3333', 'x-forwarded-host': 'evil.example.test' } }));
  assert.equal(requestHostOf(direct), '192.168.7.20:3333');
  assert.equal(requestHostOf({ headers: { host: 'relay.example.com', 'x-forwarded-host': 'evil.example.test' } }), 'relay.example.com');
});

test('an Express view of a raw request derives ip through trust proxy', () => {
  const app = trustingApp();
  const forged = expressRequestView(app, req({ peer: '192.168.7.31', headers: { 'x-forwarded-for': '203.0.113.9' } }));
  assert.equal(forged.ip, '192.168.7.31');
  const proxied = expressRequestView(app, req({ peer: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } }));
  assert.equal(proxied.ip, '203.0.113.9');
});

test('same origin: no Origin passes, matching host passes, anything else is refused', () => {
  const app = trustingApp();
  const view = (headers, peer = '127.0.0.1') => expressRequestView(app, req({ peer, headers }));
  assert.equal(isSameOriginRequest(view({ host: '127.0.0.1:3333' })), true);
  assert.equal(isSameOriginRequest(view({ host: '127.0.0.1:3333', origin: 'http://127.0.0.1:3333' })), true);
  assert.equal(isSameOriginRequest(view({ host: 'relay.example.com', origin: 'https://relay.example.com' })), true);
  assert.equal(isSameOriginRequest(view({ host: 'relay.example.com:443', origin: 'https://relay.example.com' })), true);
  assert.equal(isSameOriginRequest(view({ host: '127.0.0.1:3333', 'x-forwarded-host': 'relay.example.com', origin: 'https://relay.example.com' })), true);
  assert.equal(isSameOriginRequest(view({ host: '127.0.0.1:3333', origin: 'http://127.0.0.1:8080' })), false);
  assert.equal(isSameOriginRequest(view({ host: 'relay.example.com', origin: 'https://evil.example.test' })), false);
  assert.equal(isSameOriginRequest(view({ host: 'relay.example.com', origin: 'null' })), false);
  assert.equal(isSameOriginRequest(view({ host: 'relay.example.com', origin: 'not a url' })), false);
  // A direct client cannot make a foreign origin look same-origin with X-Forwarded-Host.
  assert.equal(isSameOriginRequest(view({ host: '192.168.7.20:3333', 'x-forwarded-host': 'evil.example.test', origin: 'https://evil.example.test' }, '192.168.7.31')), false);
});

test('same origin: an explicitly allowed origin passes', () => {
  const app = trustingApp();
  const view = expressRequestView(app, req({ headers: { host: '127.0.0.1:3333', origin: 'https://relay.example.com' } }));
  assert.equal(isSameOriginRequest(view), false);
  assert.equal(isSameOriginRequest(view, { allowedOrigins: ['https://relay.example.com/'] }), true);
  assert.equal(isSameOriginRequest(view, { allowedOrigins: 'https://other.example.test, https://relay.example.com' }), true);
});

test('an Express view works on a real IncomingMessage', async () => {
  const app = trustingApp();
  const server = http.createServer((rawReq, res) => {
    const view = expressRequestView(app, rawReq);
    res.end(JSON.stringify({ ip: view.ip, host: requestHostOf(view), local: createLocalRequestCheck().isTrulyLocal(rawReq) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const plain = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    assert.deepEqual(plain, { ip: '127.0.0.1', host: `127.0.0.1:${port}`, local: true });
    const proxied = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json();
    assert.deepEqual(proxied, { ip: '203.0.113.9', host: `127.0.0.1:${port}`, local: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a socket.io server gated with isSameOriginRequest refuses a foreign origin and takes its own', async () => {
  const { Server } = await import('socket.io');
  const app = trustingApp();
  const server = http.createServer(app);
  const io = new Server(server, {
    path: '/relay/socket.io',
    allowRequest: (rawReq, callback) => callback(null, isSameOriginRequest(expressRequestView(app, rawReq))),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const handshake = (headers) => fetch(`http://127.0.0.1:${port}/relay/socket.io/?EIO=4&transport=polling`, { headers });
    assert.equal((await handshake({ origin: 'https://evil.example.test' })).status, 403);
    assert.equal((await handshake({ origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await handshake({})).status, 200);
    // Behind the tunnel: the edge's host arrives as X-Forwarded-Host from loopback.
    assert.equal((await handshake({ origin: 'https://relay.example.com', 'x-forwarded-host': 'relay.example.com' })).status, 200);
  } finally {
    io.close();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
