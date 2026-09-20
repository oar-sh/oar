import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerWebSocketLink } from "./worker-websocket-link.mjs";

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.OPEN = 1;
    this.CONNECTING = 0;
    this.CLOSED = 3;
    this.readyState = this.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(payload);
    }
  }

  open() {
    this.readyState = this.OPEN;
    this.emit("open");
  }

  receive(data) {
    this.emit("message", { data: JSON.stringify(data) });
  }

  close() {
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  send(payload) {
    this.sent.push(String(payload));
  }
}

class FakeWebSocketStaticConstants {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = this.constructor.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocketStaticConstants.instances.push(this);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type, payload = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(payload);
    }
  }

  open() {
    this.readyState = this.constructor.OPEN;
    this.emit("open");
  }

  close() {
    this.readyState = this.constructor.CLOSED;
    this.emit("close");
  }

  send(payload) {
    this.sent.push(String(payload));
  }
}

test("worker websocket link sends ready and processes delivered queue messages", async () => {
  FakeWebSocket.instances = [];
  const deliveries = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-1",
    getPid: () => 4242,
    onDeliver: async (pending, reason) => {
      deliveries.push({ pending, reason });
    },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /token=tok/);
  assert.match(socket.url, /sessionId=sdk-1/);
  assert.match(socket.url, /pid=4242/);

  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.length, 2);
  assert.match(socket.sent[0], /"type":"worker.hello"/);
  assert.match(socket.sent[1], /"type":"worker.ready"/);

  socket.receive({ type: "queue.deliver", reason: "test", pending: { message: { id: "m1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, [{ pending: { message: { id: "m1" } }, reason: "test" }]);
  assert.equal(socket.sent.length, 3);
  assert.match(socket.sent[2], /"type":"worker.ready"/);
  link.stop();
});

test("worker websocket link handles queue changes with websocket readiness only", async () => {
  FakeWebSocket.instances = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-queue",
    getPid: () => 1001,
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));

  const before = socket.sent.length;
  socket.receive({ type: "queue.changed", reason: "new-message", pendingCount: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.sent.length, before + 1);
  assert.match(socket.sent.at(-1), /"type":"worker.ready"/);
  assert.match(socket.sent.at(-1), /"reason":"queue-changed"/);
  assert.equal(link.status().lastQueueChangedAt > 0, true);
  link.stop();
});

test("worker websocket link refreshes readiness and reconnects stale sockets", async () => {
  FakeWebSocket.instances = [];
  let nowMs = 1000;
  const intervals = [];
  const scheduledReconnects = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-refresh",
    getPid: () => 2002,
    WebSocketImpl: FakeWebSocket,
    readyRefreshMs: 1000,
    staleConnectionMs: 5000,
    jitterMs: 0,
    now: () => nowMs,
    setIntervalImpl: (fn, delay) => {
      intervals.push({ fn, delay });
      return { delay };
    },
    clearIntervalImpl: () => {},
    setTimeoutImpl: (fn, delay) => {
      scheduledReconnects.push({ fn, delay });
      return { delay };
    },
    clearTimeoutImpl: () => {},
  });

  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.equal(intervals[0]?.delay, 1000);

  nowMs = 2000;
  intervals[0].fn();
  assert.match(socket.sent.at(-3), /"type":"worker.ping"/);
  assert.match(socket.sent.at(-2), /"type":"worker.hello"/);
  assert.match(socket.sent.at(-1), /"type":"worker.ready"/);

  nowMs = 8001;
  intervals[0].fn();
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(scheduledReconnects[0]?.delay, 1000);
  link.stop();
});

test("worker websocket link reconnect backoff caps at 8 seconds", () => {
  FakeWebSocket.instances = [];
  const scheduled = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    WebSocketImpl: FakeWebSocket,
    minBackoffMs: 1000,
    maxBackoffMs: 8_000,
    jitterMs: 0,
    setTimeoutImpl: (fn, delay) => {
      scheduled.push({ fn, delay });
      return { delay };
    },
    clearTimeoutImpl: () => {},
  });

  link.start();
  const first = FakeWebSocket.instances[0];
  first.open();
  first.close();
  assert.equal(scheduled[0]?.delay, 1000);
  scheduled.shift()?.fn();

  const second = FakeWebSocket.instances[1];
  second.open();
  second.close();
  assert.equal(scheduled[0]?.delay, 1000);
  scheduled.shift()?.fn();

  const third = FakeWebSocket.instances[2];
  third.close();
  assert.equal(scheduled[0]?.delay, 2000);
  scheduled.shift()?.fn();

  const fourth = FakeWebSocket.instances[3];
  fourth.close();
  assert.equal(scheduled[0]?.delay, 4000);
  scheduled.shift()?.fn();

  const fifth = FakeWebSocket.instances[4];
  fifth.close();
  assert.equal(scheduled[0]?.delay, 8000);
  scheduled.shift()?.fn();

  const sixth = FakeWebSocket.instances[5];
  sixth.close();
  assert.equal(scheduled[0]?.delay, 8_000);
  scheduled.shift()?.fn();

  const seventh = FakeWebSocket.instances[6];
  seventh.close();
  assert.equal(scheduled[0]?.delay, 8_000);
  scheduled.shift()?.fn();

  const eighth = FakeWebSocket.instances[7];
  eighth.close();
  assert.equal(scheduled[0]?.delay, 8_000);
  link.stop();
});

test("a delivery mid-delivery is coalesced when the worker is not steering-ready", async () => {
  FakeWebSocket.instances = [];
  const deliveries = [];
  let releaseFirst = null;
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-serial",
    onDeliver: async (pending) => {
      deliveries.push(pending?.message?.id);
      await new Promise((resolve) => { releaseFirst = releaseFirst || resolve; });
    },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));

  socket.receive({ type: "queue.deliver", pending: { message: { id: "m1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  const readySignals = () => socket.sent.filter((frame) => frame.includes('"type":"worker.ready"')).length;
  const readyBefore = readySignals();

  // A redelivery (socket reconnect shape) and a refresh both land while m1 is
  // still running: no second onDeliver, no ready signal.
  socket.receive({ type: "queue.deliver", pending: { message: { id: "m1-redelivered" } } });
  socket.receive({ type: "queue.changed", reason: "new-message" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1"]);
  assert.equal(readySignals(), readyBefore);
  assert.equal(link.status().delivering, true);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(link.status().delivering, false);
  assert.equal(readySignals() > readyBefore, true);
  link.stop();
});

test("a steering-ready worker keeps signalling readiness and runs a concurrent delivery", async () => {
  FakeWebSocket.instances = [];
  const deliveries = [];
  const settles = new Map();
  let steeringReady = false;
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-steer",
    getSteeringReady: () => steeringReady,
    onDeliver: async (pending) => {
      const id = pending?.message?.id;
      deliveries.push(id);
      await new Promise((resolve) => settles.set(id, resolve));
      return true;
    },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));

  socket.receive({ type: "queue.deliver", pending: { message: { id: "m1" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1"]);

  // The turn runner reports it can absorb another message: a queue change now
  // re-arms the server through worker.ready, and the resulting delivery runs
  // as its own delivery instead of being coalesced onto m1.
  steeringReady = true;
  const readySignals = () => socket.sent.filter((frame) => frame.includes('"type":"worker.ready"')).length;
  const readyBefore = readySignals();
  socket.receive({ type: "queue.changed", reason: "new-message" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readySignals(), readyBefore + 1);

  socket.receive({ type: "queue.deliver", pending: { message: { id: "m2-steered" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1", "m2-steered"]);
  assert.equal(link.status().delivering, true);

  // Steering is unbounded per turn: a third delivery rides alongside the
  // first two while the probe keeps answering true.
  socket.receive({ type: "queue.deliver", pending: { message: { id: "m3-steered" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1", "m2-steered", "m3-steered"]);
  assert.equal(link.status().delivering, true);

  // All deliveries settle with the turn; the link is idle only after the
  // last one resolves.
  settles.get("m3-steered")();
  settles.get("m2-steered")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(link.status().delivering, true);
  settles.get("m1")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(link.status().delivering, false);
  link.stop();
});

test("a throwing steering probe falls back to the strict single-flight contract", async () => {
  FakeWebSocket.instances = [];
  const deliveries = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-throw",
    getSteeringReady: () => { throw new Error("probe failed"); },
    onDeliver: async (pending) => {
      deliveries.push(pending?.message?.id);
      await new Promise(() => {});
    },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });

  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));

  socket.receive({ type: "queue.deliver", pending: { message: { id: "m1" } } });
  socket.receive({ type: "queue.deliver", pending: { message: { id: "m2" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1"]);
  link.stop();
});

test("worker websocket link supports websocket implementations with static state constants", async () => {
  FakeWebSocketStaticConstants.instances = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-static",
    getPid: () => 4242,
    WebSocketImpl: FakeWebSocketStaticConstants,
    jitterMs: 0,
  });

  link.start();
  assert.equal(FakeWebSocketStaticConstants.instances.length, 1);
  const socket = FakeWebSocketStaticConstants.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.sent.length, 2);
  assert.match(socket.sent[0], /"type":"worker.hello"/);
  assert.match(socket.sent[1], /"type":"worker.ready"/);
  link.stop();
});
