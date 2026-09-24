import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createSessionWorkerWebSocketService } from './session-worker-websocket-service.mjs';

let lastWss = null;

class FakeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.closeCalls = 0;
    this.sockets = [];
    lastWss = this;
  }

  handleUpgrade(_req, _socket, _head, done) {
    const ws = new FakeSocket();
    this.sockets.push(ws);
    done(ws);
  }

  close() {
    this.closeCalls += 1;
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = 0;
  }

  send(payload) {
    this.sent.push(String(payload));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

test('worker websocket service authenticates upgrade requests', () => {
  const httpServer = new EventEmitter();
  const rawSocket = {
    wrote: '',
    destroyed: false,
    write(value) { this.wrote += String(value); },
    destroy() { this.destroyed = true; },
  };
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
  });

  const handled = service.handleUpgrade(
    { url: '/api/session-worker/ws?token=wrong', headers: { host: 'localhost:3333' } },
    rawSocket,
    Buffer.alloc(0),
  );
  assert.equal(handled, true);
  assert.match(rawSocket.wrote, /401 Unauthorized/);
  assert.equal(rawSocket.destroyed, true);
});

test('worker websocket service accepts both root and prefixed worker websocket paths', () => {
  const httpServer = new EventEmitter();
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    pathPrefix: '/cpr2',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
  });

  const rootHandled = service.handleUpgrade(
    { url: '/api/session-worker/ws?token=secret-token', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const prefixedHandled = service.handleUpgrade(
    { url: '/cpr2/api/session-worker/ws?token=secret-token', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  assert.equal(rootHandled, true);
  assert.equal(prefixedHandled, true);
  // platform-agnostic: these are HTTP route paths, not filesystem paths — a URL
  // prefix is joined with '/' on every platform, never with the host separator.
  assert.deepEqual(service.status().acceptedPaths, ['/api/session-worker/ws', '/cpr2/api/session-worker/ws']);
});

test('worker websocket service notifies connected clients on queue changes', async () => {
  const httpServer = new EventEmitter();
  let pendingCount = 0;
  let touchCalls = 0;
  let requestCalls = 0;
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount, processingCount: 0, parkedCount: 0 }),
    touchCli: () => { touchCalls += 1; },
    requestWork: async ({ sessionId }) => {
      requestCalls += 1;
      return {
        message: {
          id: 'm1',
          conversationId: 'c1',
          ownerSessionId: sessionId,
        },
      };
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-1&pid=99', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  assert.equal(service.status().connectedCount, 1);
  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'test' }));
  await new Promise((resolve) => setImmediate(resolve));
  pendingCount = 3;
  const event = service.emitQueueChanged('test');
  assert.equal(event.pendingCount, 3);
  assert.equal(touchCalls >= 1, true);
  assert.equal(requestCalls >= 1, true);
  assert.equal(socket.sent.some((payload) => payload.includes('"type":"queue.deliver"')), true);
  service.stop();
});

test('worker websocket service uses session identity from ready payload', async () => {
  const httpServer = new EventEmitter();
  let requestSessionId = null;
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    requestWork: async ({ sessionId }) => {
      requestSessionId = sessionId;
      return {
        message: {
          id: 'm-ready',
          conversationId: 'c-ready',
          ownerSessionId: sessionId,
        },
      };
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.ready', sessionId: 'sdk-ready', pid: 123 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestSessionId, 'sdk-ready');
  assert.equal(socket.sent.some((payload) => payload.includes('"type":"queue.deliver"')), true);
  service.stop();
});

test('worker websocket service treats hello as readiness for delivery', async () => {
  const httpServer = new EventEmitter();
  let requestSessionId = null;
  let requestPid = null;
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    requestWork: async ({ sessionId, pid }) => {
      requestSessionId = sessionId;
      requestPid = pid;
      return {
        message: {
          id: 'm-hello',
          conversationId: 'c-hello',
          ownerSessionId: sessionId,
        },
      };
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.hello', sessionId: 'sdk-hello', pid: 456 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestSessionId, 'sdk-hello');
  assert.equal(requestPid, 456);
  assert.equal(socket.sent.some((payload) => payload.includes('"type":"queue.deliver"')), true);
  service.stop();
});

test('worker websocket service records websocket heartbeat pings', async () => {
  const httpServer = new EventEmitter();
  const heartbeats = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    noteWorkerHeartbeat: (sessionId, details) => {
      heartbeats.push({ sessionId, details });
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.ping', sessionId: 'sdk-ping', pid: 789, reason: 'readiness-refresh' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].sessionId, 'sdk-ping');
  assert.equal(heartbeats[0].details.pid, 789);
  assert.equal(socket.sent.some((payload) => payload.includes('"type":"server.pong"')), true);
  service.stop();
});

test('worker websocket service preserves readiness and closes on delivery send failure', async () => {
  const httpServer = new EventEmitter();
  let requestCalls = 0;
  const sendFailures = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    requestWork: async ({ sessionId }) => {
      requestCalls += 1;
      return {
        message: {
          id: `m-fail-${requestCalls}`,
          conversationId: 'c-fail',
          ownerSessionId: sessionId,
        },
      };
    },
    onDeliverySendFailed: async (details) => {
      sendFailures.push(details);
    },
    logger: { warn: () => {}, debug: () => {} },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-fail', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );

  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  const originalSend = socket.send.bind(socket);
  socket.send = (payload) => {
    if (String(payload).includes('"type":"queue.deliver"')) {
      throw new Error('simulated send failure');
    }
    return originalSend(payload);
  };
  socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'send-failure-test' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requestCalls, 1);
  assert.equal(sendFailures.length, 1);
  assert.equal(sendFailures[0].pending.message.id, 'm-fail-1');
  assert.equal(sendFailures[0].sessionId, 'sdk-fail');
  assert.equal(socket.closeCalls, 1);
  service.stop();
});

test('a ready check from a killed worker socket never asks for work', async () => {
  // The socket outlives the process it belongs to: killing a worker blocks the
  // relay's event loop, so this service's delivery timer runs before the socket
  // close lands. Requesting work there is what respawned the killed session.
  const httpServer = new EventEmitter();
  const requestedSessions = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    isWorkerProcessAlive: (pid) => Number(pid) !== 4242,
    requestWork: async ({ sessionId }) => {
      requestedSessions.push(sessionId);
      return { message: null };
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-dead&pid=4242', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'test' }));
  await new Promise((resolve) => setImmediate(resolve));
  service.emitQueueChanged('test');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requestedSessions, [], 'a dead worker process must not be handed work');
  service.stop();
});

test('a live worker socket still gets work through the liveness probe', async () => {
  const httpServer = new EventEmitter();
  const requestedSessions = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    isWorkerProcessAlive: () => true,
    requestWork: async ({ sessionId }) => {
      requestedSessions.push(sessionId);
      return { message: null };
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-live&pid=4242', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'test' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requestedSessions, ['sdk-live']);
  service.stop();
});

test('worker.unready withdraws a standing readiness so a hold draws no work', async () => {
  // Readiness is sticky until the next delivery; a ready sent while the
  // worker could steer must not survive the question hold that followed it.
  const httpServer = new EventEmitter();
  const requestedSessions = [];
  let offerWork = false;
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    requestWork: async ({ sessionId }) => {
      requestedSessions.push(sessionId);
      return offerWork ? { message: { id: 'm-held', conversationId: 'c1' } } : { message: null };
    },
  });

  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-unready&pid=4242', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const socket = lastWss?.sockets?.[0] || null;
  socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'steering-ready' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().readyCount, 1, 'nothing to deliver: readiness stands');

  socket.emit('message', JSON.stringify({ type: 'worker.unready', reason: 'steering-held' }));
  assert.equal(service.status().readyCount, 0);
  offerWork = true;
  const before = requestedSessions.length;
  service.emitQueueChanged('new-message');
  // A ping keeps the socket live but is not readiness either.
  socket.emit('message', JSON.stringify({ type: 'worker.ping', reason: 'readiness-refresh' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestedSessions.length, before, 'a held worker is not asked for work');
  assert.equal(socket.sent.some((payload) => payload.includes('"type":"queue.deliver"')), false);

  // A held worker's hello binds identity without re-arming readiness.
  socket.emit('message', JSON.stringify({ type: 'worker.hello', reason: 'ws-open', ready: false }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().readyCount, 0);
  assert.equal(requestedSessions.length, before);

  // The hold ends: ready draws the held message.
  socket.emit('message', JSON.stringify({ type: 'worker.ready', reason: 'steering-resumed' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.some((payload) => payload.includes('"type":"queue.deliver"')), true);
  service.stop();
});

test('a worker socket closing invokes the death-detection hook with its identity', async () => {
  const httpServer = new EventEmitter();
  const closedEvents = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    onWorkerSocketClosed: (payload) => { closedEvents.push(payload); },
  });
  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-dead&pid=4242', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const ws = lastWss.sockets[lastWss.sockets.length - 1];
  assert.ok(ws);
  assert.equal(service.hasWorkerSocket('sdk-dead'), true);
  ws.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].sessionId, 'sdk-dead');
  assert.equal(closedEvents[0].pid, 4242);
  assert.equal(closedEvents[0].reason, 'close');
  assert.equal(service.hasWorkerSocket('sdk-dead'), false);
});

test('a frame claiming a different session identity closes the socket', async () => {
  // Identity binds once. Rebinding mid-connection would let one socket drain
  // deliveries for two sessions, so the offending socket is dropped instead.
  const httpServer = new EventEmitter();
  const closedEvents = [];
  const requestedSessions = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 1, processingCount: 0, parkedCount: 0 }),
    onWorkerSocketClosed: (payload) => { closedEvents.push(payload); },
    requestWork: async ({ sessionId }) => {
      requestedSessions.push(sessionId);
      return { message: null };
    },
    logger: { warn: () => {}, debug: () => {} },
  });
  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-original&pid=101', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.hello', sessionId: 'sdk-hijacker', pid: 101 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.closeCalls, 1, 'the rebinding socket is closed');
  assert.equal(service.hasWorkerSocket('sdk-original'), false);
  assert.equal(service.hasWorkerSocket('sdk-hijacker'), false);
  assert.deepEqual(requestedSessions, [], 'the rejected frame never asks for work');
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].sessionId, 'sdk-original');
  assert.equal(closedEvents[0].reason, 'identity-rebind');
  service.stop();
});

test('a newer socket for a session supersedes and closes the prior one', async () => {
  const httpServer = new EventEmitter();
  const closedEvents = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    onWorkerSocketClosed: (payload) => { closedEvents.push(payload); },
    logger: { warn: () => {}, debug: () => {} },
  });
  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-gen&pid=201', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-gen&pid=202', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const [first, second] = lastWss.sockets;
  assert.ok(first && second);
  assert.equal(first.closeCalls, 1, 'the prior generation is closed');
  assert.equal(second.closeCalls, 0, 'the new generation stays open');
  assert.equal(service.status().connectedCount, 1);
  assert.equal(service.hasWorkerSocket('sdk-gen'), true);
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].sessionId, 'sdk-gen');
  assert.equal(closedEvents[0].pid, 201);
  assert.equal(closedEvents[0].reason, 'superseded');
  service.stop();
});

test('a stale socket no longer counts as live without a fresh heartbeat or live pid', async () => {
  const httpServer = new EventEmitter();
  let currentMs = 100_000;
  let pidAlive = false;
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl: FakeWebSocketServer,
    httpServer,
    authToken: 'secret-token',
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    isWorkerProcessAlive: () => pidAlive,
    nowMs: () => currentMs,
  });
  service.start();
  httpServer.emit('upgrade',
    { url: '/api/session-worker/ws?token=secret-token&sessionId=sdk-stale&pid=301', headers: { host: 'localhost:3333' } },
    {},
    Buffer.alloc(0),
  );
  const socket = lastWss?.sockets?.[0] || null;
  assert.ok(socket);
  socket.emit('message', JSON.stringify({ type: 'worker.ping', sessionId: 'sdk-stale', pid: 301 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.hasLiveWorkerSocket('sdk-stale'), true, 'fresh heartbeat counts as live');

  // Three missed 10s heartbeats: retention alone must stop counting as life.
  currentMs += 30_001;
  assert.equal(service.hasLiveWorkerSocket('sdk-stale'), false, 'stale socket with a dead pid is not live');
  assert.equal(service.hasWorkerSocket('sdk-stale'), true, 'the socket itself is still retained');

  pidAlive = true;
  assert.equal(service.hasLiveWorkerSocket('sdk-stale'), true, 'a verified pid keeps a silent socket live');

  socket.emit('message', JSON.stringify({ type: 'worker.ping', sessionId: 'sdk-stale', pid: 301 }));
  pidAlive = false;
  assert.equal(service.hasLiveWorkerSocket('sdk-stale'), true, 'a new heartbeat restores socket-backed liveness');
  service.stop();
});
