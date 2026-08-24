import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createTunnelWorkerPathGuard } from './tunnel-worker-path-guard.mjs';

function createRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function createSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.write = (chunk) => { socket.written.push(String(chunk)); return true; };
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

function runRequest(guard, req) {
  const res = createRes();
  let nextCalled = false;
  guard.requestMiddleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const quietLogger = { warn() {}, log() {} };

test('guard blocks a worker path carrying cf-ray', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const { res, nextCalled } = runRequest(guard, {
    url: '/api/session-worker/ws',
    headers: { 'cf-ray': '8a1b2c3d4e5f6789-AMS' },
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('guard allows a worker path without a tunnel marker', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const { res, nextCalled } = runRequest(guard, {
    url: '/api/session-worker/ws?token=abc',
    headers: { host: '127.0.0.1:3333' },
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('guard allows non-worker paths carrying cf-ray', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  for (const url of ['/shared/tok123', '/api/shared/tok123', '/api/status', '/']) {
    const { nextCalled } = runRequest(guard, { url, headers: { 'cf-ray': 'ray' } });
    assert.equal(nextCalled, true, `expected ${url} to pass`);
  }
});

test('guard honours a configured extra marker header', () => {
  const guard = createTunnelWorkerPathGuard({
    extraMarkerHeaders: ['X-Relay-Edge'],
    logger: quietLogger,
  });
  const blocked = runRequest(guard, {
    url: '/api/session-worker/ws',
    headers: { 'x-relay-edge': '1' },
  });
  assert.equal(blocked.res.statusCode, 403);
  const allowed = runRequest(guard, { url: '/api/session-worker/ws', headers: {} });
  assert.equal(allowed.nextCalled, true);
});

test('guard ignores an empty marker header value', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const { nextCalled } = runRequest(guard, {
    url: '/api/session-worker/ws',
    headers: { 'cf-ray': '   ' },
  });
  assert.equal(nextCalled, true);
});

test('guard covers the prefixed worker path', () => {
  const guard = createTunnelWorkerPathGuard({ pathPrefix: '/relay', logger: quietLogger });
  // platform-agnostic: an HTTP route path, not a filesystem path — the prefix is
  // joined with '/' on every platform, never with the host separator.
  assert.ok(guard.workerPaths.includes('/relay/api/session-worker/ws'));
  const { res } = runRequest(guard, {
    url: '/relay/api/session-worker/ws',
    headers: { 'cf-ray': 'ray' },
  });
  assert.equal(res.statusCode, 403);
});

test('guard destroys a worker upgrade carrying cf-ray', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const socket = createSocket();
  const handled = guard.handleUpgrade({
    url: '/api/session-worker/ws',
    headers: { 'cf-ray': 'ray' },
  }, socket);
  assert.equal(handled, true);
  assert.equal(socket.destroyed, true);
  assert.match(socket.written.join(''), /403 Forbidden/);
});

test('guard lets a local worker upgrade through', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const socket = createSocket();
  const handled = guard.handleUpgrade({
    url: '/api/session-worker/ws',
    headers: { host: '127.0.0.1:3333' },
  }, socket);
  assert.equal(handled, false);
  assert.equal(socket.destroyed, false);
});

test('guard lets a socket.io upgrade through even over the tunnel', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const socket = createSocket();
  const handled = guard.handleUpgrade({
    url: '/socket.io/?EIO=4&transport=websocket',
    headers: { 'cf-ray': 'ray' },
  }, socket);
  assert.equal(handled, false);
  assert.equal(socket.destroyed, false);
});

test('guard tolerates a malformed request url', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const { nextCalled } = runRequest(guard, { url: '://///', headers: { 'cf-ray': 'ray' } });
  assert.equal(nextCalled, true);
});

// Blast-radius guard: shared conversations arrive over Cloudflare with no
// credentials. Widening the rule to "unauthenticated request bearing cf-ray"
// would silently kill them, so assert every shared route still passes.
test('guard leaves anonymous shared-conversation routes untouched over the tunnel', () => {
  const guard = createTunnelWorkerPathGuard({ logger: quietLogger });
  const token = 'a'.repeat(64);
  const sharedPaths = [
    `/shared/${token}`,
    `/api/shared/${token}`,
    `/api/shared/${token}/presence`,
    `/api/shared/${token}/upload/${'b'.repeat(64)}/content`,
  ];
  for (const url of sharedPaths) {
    const { nextCalled, res } = runRequest(guard, { url, headers: { 'cf-ray': 'ray-ams' } });
    assert.equal(nextCalled, true, `expected ${url} to pass the guard`);
    assert.equal(res.statusCode, null, `expected ${url} not to be blocked`);
  }
});

test('guard leaves shared routes untouched behind a path prefix too', () => {
  const guard = createTunnelWorkerPathGuard({ pathPrefix: '/relay', logger: quietLogger });
  const token = 'c'.repeat(64);
  const { nextCalled } = runRequest(guard, {
    url: `/relay/api/shared/${token}`,
    headers: { 'cf-ray': 'ray' },
  });
  assert.equal(nextCalled, true);
});
