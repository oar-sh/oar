// Version skew of the worker keepalive, over a real socket: the real relay
// websocket service and the real worker link and keepalive, with only the
// relay's queue stubbed. A new worker beats every 30 s only on a relay that
// advertises `idle-keepalive`; on an older relay it keeps 10 s. An older
// worker (hello + ready + ping every 10 s, no keepalive) still works against
// the new relay.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { createSessionWorkerWebSocketService } from './session-worker-websocket-service.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import {
  BUSY_KEEPALIVE_MS,
  IDLE_KEEPALIVE_MS,
  createWorkerKeepalive,
} from '../../shared/worker-runtime/worker-keepalive.mjs';

const TOKEN = 'skew-token';
const SESSION = 'sdk-skew';

/** A relay from before `idle-keepalive`: its hellos advertise no capability. */
class OldRelayWebSocketServer extends WebSocketServer {
  handleUpgrade(req, socket, head, done) {
    super.handleUpgrade(req, socket, head, (ws) => {
      const send = ws.send.bind(ws);
      ws.send = (data, ...rest) => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'server.hello') delete frame.capabilities;
        return send(JSON.stringify(frame), ...rest);
      };
      done(ws);
    });
  }
}

async function startRelay(t, { offers = [], WebSocketServerImpl = WebSocketServer } = {}) {
  const httpServer = http.createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const requested = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl,
    httpServer,
    authToken: TOKEN,
    queueCounts: () => ({ pendingCount: offers.length, processingCount: 0, parkedCount: 0 }),
    requestWork: async ({ reason }) => {
      requested.push(reason);
      const message = offers.shift();
      return message ? { message } : null;
    },
    pollIntervalMs: 250,
    logger: { debug() {}, warn() {} },
  });
  service.start();
  t.after(async () => {
    service.stop();
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return { service, requested, offers, port: httpServer.address().port };
}

async function waitFor(check, label, timeoutMs = 3_000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A new worker: real link driven by a real keepalive whose waits are recorded. */
function startNewWorker(t, relay) {
  const waits = [];
  let beat = null;
  let helloSeen = false;
  let clock = 0;
  let keepalive = null;
  const link = createWorkerWebSocketLink({
    serverUrl: `http://127.0.0.1:${relay.port}`,
    token: TOKEN,
    getSessionReady: () => true,
    getSessionId: () => SESSION,
    getPid: () => process.pid,
    readyRefreshMs: 0,
    onServerHello: () => { helloSeen = true; },
    // As the worker mains wire it.
    onRelayFrame: () => keepalive?.nudge(),
  });
  keepalive = createWorkerKeepalive({
    heartbeat: { hasWork: () => false, pulseHeartbeat: async () => true },
    link,
    now: () => clock,
    setTimeoutImpl: (fn, ms) => { waits.push(ms); beat = fn; return waits.length; },
    clearTimeoutImpl: () => {},
  });
  t.after(() => {
    keepalive.stop();
    link.stop();
  });
  keepalive.start();
  link.start();
  return {
    link,
    keepalive,
    waits,
    beat: () => beat(),
    helloSeen: () => helloSeen,
    advance: (ms) => { clock += ms; },
  };
}

test('a new worker on a new relay beats every 30 s while idle', async (t) => {
  const relay = await startRelay(t);
  const worker = startNewWorker(t, relay);
  assert.deepEqual(worker.waits, [BUSY_KEEPALIVE_MS], 'before the relay is known: 10 s');
  await waitFor(() => worker.link.serverSupports('idle-keepalive'), 'server.hello with idle-keepalive');
  // The hello holds the busy cadence for 30 s; after that, idle.
  worker.beat();
  worker.advance(31_000);
  worker.beat();
  assert.deepEqual(worker.waits, [BUSY_KEEPALIVE_MS, BUSY_KEEPALIVE_MS, IDLE_KEEPALIVE_MS]);
  await waitFor(() => relay.service.hasLiveWorkerSocket(SESSION), 'the beat reached the relay');
});

test('a new worker on a relay without idle-keepalive keeps 10 s', async (t) => {
  const relay = await startRelay(t, { WebSocketServerImpl: OldRelayWebSocketServer });
  const worker = startNewWorker(t, relay);
  await waitFor(() => worker.helloSeen(), 'server.hello');
  // The hello has arrived and named no capability.
  assert.equal(worker.link.serverSupports('idle-keepalive'), false);
  worker.advance(31_000);
  worker.beat();
  worker.beat();
  assert.deepEqual(worker.waits, [BUSY_KEEPALIVE_MS, BUSY_KEEPALIVE_MS, BUSY_KEEPALIVE_MS], 'past the hold, still 10 s');
});

test('an older worker (hello + ready + ping every 10 s) is served once per ready by the new relay', async (t) => {
  const offers = [{ id: 'q-1', text: 'one' }, { id: 'q-2', text: 'two' }];
  const relay = await startRelay(t, { offers });
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/api/session-worker/ws?sessionId=${SESSION}&pid=${process.pid}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  t.after(() => { try { socket.close(); } catch {} });
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const send = (type, reason) => socket.send(JSON.stringify({ type, reason, sessionId: SESSION, pid: process.pid }));
  const delivered = () => frames.filter((frame) => frame.type === 'queue.deliver').map((frame) => frame.pending.message.id);

  // The old link's open: hello, then ready.
  send('worker.hello', 'ws-open');
  send('worker.ready', 'ws-open');
  await waitFor(() => delivered().length === 1, 'first delivery');
  // Mid-delivery the old refresh sends only a ping (its ready is gated); the
  // relay answers with a pong and hands out nothing more, poll or not.
  send('worker.ping', 'readiness-refresh');
  await waitFor(() => frames.some((frame) => frame.type === 'server.pong'), 'pong');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(delivered(), ['q-1']);
  assert.equal(relay.service.hasLiveWorkerSocket(SESSION), true);
  // Its turn done, the old worker says ready: the next row follows.
  send('worker.ready', 'delivery-complete');
  await waitFor(() => delivered().length === 2, 'second delivery');
  assert.deepEqual(delivered(), ['q-1', 'q-2']);
  // An idle refresh with hello + ready + ping: nothing left, nothing sent twice.
  send('worker.ping', 'readiness-refresh');
  send('worker.hello', 'readiness-refresh');
  send('worker.ready', 'readiness-refresh');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(delivered(), ['q-1', 'q-2']);
  const hellos = frames.filter((frame) => frame.type === 'server.hello');
  assert.ok(hellos.every((hello) => hello.capabilities.includes('idle-keepalive')), 'an old worker ignores the new capability');
});
