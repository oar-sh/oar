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

test("a same-id redelivery coalesces; a different id reaches a steering worker's runner", async () => {
  // The old "coalesce anything mid-delivery" rule dropped a DIFFERENT message's
  // payload onto the in-flight promise whenever the server's sticky readiness
  // outlived a hold — the row then sat `processing` until heartbeat recovery.
  // Only a redelivery of the same message may coalesce; a different one goes
  // to the runner, which steers it in or hands it back to the queue.
  FakeWebSocket.instances = [];
  const deliveries = [];
  const settles = new Map();
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-serial",
    getSteeringReady: () => false,
    onDeliver: async (pending) => {
      const id = pending?.message?.id;
      deliveries.push(id);
      if (id === "m2") return false; // the runner handed it back
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
  const readySignals = () => socket.sent.filter((frame) => frame.includes('"type":"worker.ready"')).length;
  const readyBefore = readySignals();

  // A redelivery of m1 (socket reconnect shape) and a refresh land while m1
  // is still running: no second run of m1, no ready signal.
  socket.receive({ type: "queue.deliver", pending: { message: { id: "m1" } } });
  socket.receive({ type: "queue.changed", reason: "new-message" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1"]);
  assert.equal(readySignals(), readyBefore);

  // A different message is never dropped: the runner sees it (and here hands
  // it back), and the hand-back completing does not re-arm readiness while
  // m1 is still in flight without steering.
  socket.receive({ type: "queue.deliver", pending: { message: { id: "m2" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deliveries, ["m1", "m2"]);
  assert.equal(readySignals(), readyBefore);
  assert.equal(link.status().delivering, true);

  settles.get("m1")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(link.status().delivering, false);
  assert.equal(readySignals() > readyBefore, true);
  link.stop();
});

test("a worker without the steering opt-in keeps strict single-flight", async () => {
  // Copilot, Cursor and Grok runners have no hand-back path; running a second
  // message concurrently would break them, so they keep coalescing and the
  // heartbeat recovers the row.
  FakeWebSocket.instances = [];
  const deliveries = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-legacy",
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

test("a held worker never signals ready and withdraws readiness with worker.unready", async () => {
  FakeWebSocket.instances = [];
  let held = true;
  const intervals = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-held",
    getPid: () => 77,
    getSteeringReady: () => false,
    getDeliveryHeld: () => held,
    WebSocketImpl: FakeWebSocket,
    readyRefreshMs: 1000,
    jitterMs: 0,
    setIntervalImpl: (fn, delay) => {
      intervals.push({ fn, delay });
      return { delay };
    },
    clearIntervalImpl: () => {},
  });

  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  const frames = () => socket.sent.map((frame) => JSON.parse(frame));
  // Hello still binds the identity, but says it is not ready; no ready frame.
  assert.equal(frames()[0].type, "worker.hello");
  assert.equal(frames()[0].ready, false);
  assert.equal(frames().some((frame) => frame.type === "worker.ready"), false);

  // Queue changes and server hellos do not re-arm a held worker, even idle.
  socket.receive({ type: "queue.changed", reason: "new-message" });
  socket.receive({ type: "server.hello", reason: "ack" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames().some((frame) => frame.type === "worker.ready"), false);

  // The refresh tick re-asserts the hold instead of hello/ready.
  intervals[0].fn();
  assert.equal(frames().at(-1).type, "worker.unready");
  assert.equal(frames().at(-1).sessionId, "sdk-held");
  assert.equal(frames().some((frame) => frame.type === "worker.ready"), false);

  // The worker's own flip reports go straight out.
  assert.equal(link.notifyUnready("steering-held"), true);
  assert.equal(frames().at(-1).reason, "steering-held");
  held = false;
  assert.equal(await link.notifyReady("steering-resumed"), true);
  assert.equal(frames().at(-1).type, "worker.ready");
  assert.equal(frames().at(-1).reason, "steering-resumed");
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

test("the link records what the relay advertises and forgets it on reconnect", async () => {
  FakeWebSocket.instances = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-caps",
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
    setTimeoutImpl: () => ({}),
    clearTimeoutImpl: () => {},
  });
  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  assert.equal(link.serverSupports("steering-held"), false, "nothing assumed before the hello");
  // An older relay's hello carries no capabilities.
  socket.receive({ type: "server.hello", reason: "connected" });
  assert.equal(link.serverSupports("steering-held"), false);
  socket.receive({ type: "server.hello", reason: "ack", capabilities: ["worker-unready", "steering-held"] });
  assert.equal(link.serverSupports("steering-held"), true);
  assert.equal(link.serverSupports("worker-unready"), true);
  socket.close();
  assert.equal(link.serverSupports("steering-held"), false, "a reconnect may reach a different relay");
  link.stop();
});

test("throwing steering and hold probes fail closed on readiness", async () => {
  FakeWebSocket.instances = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-throw",
    getSteeringReady: () => { throw new Error("probe failed"); },
    getDeliveryHeld: () => { throw new Error("probe failed"); },
    onDeliver: async () => {
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
  socket.receive({ type: "queue.changed", reason: "new-message" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.some((frame) => frame.includes('"type":"worker.ready"')), false);
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
