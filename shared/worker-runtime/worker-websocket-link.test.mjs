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
    this.constructor.instances.push(this);
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
    connectTimeoutMs: 0,
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
    connectTimeoutMs: 0,
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
  first.receive({ type: "server.hello", reason: "connected" });
  first.close();
  assert.equal(scheduled[0]?.delay, 1000);
  scheduled.shift()?.fn();

  // A completed handshake starts the backoff over.
  const second = FakeWebSocket.instances[1];
  second.open();
  second.receive({ type: "server.hello", reason: "connected" });
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

test("the relay's first hello on each connection is reported, its acks are not", async () => {
  FakeWebSocket.instances = [];
  const hellos = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-hello",
    onServerHello: (reason) => hellos.push(reason),
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 0,
    jitterMs: 0,
    setTimeoutImpl: (fn) => { fn(); return {}; },
    clearTimeoutImpl: () => {},
  });
  link.start();
  const first = FakeWebSocket.instances[0];
  first.open();
  assert.deepEqual(hellos, [], "an open socket alone is not a hello");
  first.receive({ type: "server.hello", reason: "connected" });
  assert.deepEqual(hellos, ["connected"]);
  // The relay acks every worker.hello, which the link re-sends on each idle
  // readiness refresh: those must not fire it again.
  first.receive({ type: "server.hello", reason: "ack" });
  assert.deepEqual(hellos, ["connected"]);

  // A reconnect — possibly to a restarted relay that knows nothing of this
  // worker — reports again.
  first.close();
  const second = FakeWebSocket.instances[1];
  assert.ok(second, "the link reconnected");
  second.open();
  second.receive({ type: "server.hello", reason: "connected" });
  assert.deepEqual(hellos, ["connected", "connected"]);
  link.stop();
});

test("a throwing hello hook does not stop the link from recording capabilities", async () => {
  FakeWebSocket.instances = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-hello-throw",
    onServerHello: () => { throw new Error("hook failed"); },
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
    setTimeoutImpl: () => ({}),
    clearTimeoutImpl: () => {},
  });
  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ type: "server.hello", reason: "connected", capabilities: ["steering-held"] });
  assert.equal(link.serverSupports("steering-held"), true);
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

// Node 22's WebSocket: closing a socket that is still connecting raises
// another error and never a close event. The cap stands in for the stack
// limit that ended the real loop.
class FakeWebSocketCloseWhileConnectingErrors extends FakeWebSocket {
  constructor(url) {
    super(url);
    this.closeCalls = 0;
  }

  close() {
    this.closeCalls += 1;
    if (this.closeCalls > 50) throw new RangeError("Maximum call stack size exceeded");
    if (this.readyState === this.CONNECTING || this.readyState === 2) {
      this.readyState = 2;
      this.emit("error", { message: "Connection was closed before it was established." });
      return;
    }
    super.close();
  }

  fail() {
    this.emit("error", { message: "Received network error or non-101 status code." });
  }
}

const CONNECT_TIMEOUT_MS = 15_000;

function createReconnectHarness(WebSocketImpl, overrides = {}) {
  WebSocketImpl.instances = [];
  const timers = [];
  const logs = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-reconnect",
    WebSocketImpl,
    minBackoffMs: 1000,
    maxBackoffMs: 8_000,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    jitterMs: 0,
    dbg: (...args) => logs.push(args.join(" ")),
    setTimeoutImpl: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { if (timer) timer.cleared = true; },
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
    ...overrides,
  });
  const live = () => timers.filter((timer) => !timer.cleared && !timer.fired);
  // Reconnect delays stay under the connect deadline (backoff caps at 8s).
  const pending = () => live().filter((timer) => timer.delay !== CONNECT_TIMEOUT_MS);
  const deadlines = () => live().filter((timer) => timer.delay === CONNECT_TIMEOUT_MS);
  const fireDeadline = () => {
    const [timer] = deadlines();
    assert.ok(timer, "a connect deadline is pending");
    timer.fired = true;
    timer.fn();
  };
  const fireNext = () => {
    const [timer] = pending();
    assert.ok(timer, "a reconnect timer is pending");
    timer.fired = true;
    timer.fn();
  };
  return { link, timers, logs, pending, deadlines, fireNext, fireDeadline };
}

test("a connect that fails without a close event still leaves one reconnect timer (Node 22)", () => {
  const { link, logs, pending, deadlines, fireNext } = createReconnectHarness(FakeWebSocketCloseWhileConnectingErrors);
  link.start();
  const first = FakeWebSocketCloseWhileConnectingErrors.instances[0];
  first.fail();

  assert.equal(first.closeCalls, 1, "the socket is closed once, not from every error it raises");
  assert.equal(logs.filter((line) => line.startsWith("worker ws disconnected")).length, 1);
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 1000);
  assert.equal(link.status().connected, false);

  // Late events from the given-up socket change nothing.
  first.emit("close");
  first.emit("error", { message: "late" });
  assert.equal(pending().length, 1);

  fireNext();
  const second = FakeWebSocketCloseWhileConnectingErrors.instances[1];
  assert.ok(second, "the link connected again");
  second.open();
  second.receive({ type: "server.hello", reason: "connected" });
  assert.equal(link.status().connected, true);
  assert.equal(link.status().reconnectAttempt, 0);
  assert.equal(pending().length, 0);
  assert.equal(deadlines().length, 0, "the hello ends the connect deadline");
  link.stop();
});

test("failed connects without close events back off without stacking timers", () => {
  const { link, pending, fireNext } = createReconnectHarness(FakeWebSocketCloseWhileConnectingErrors);
  link.start();
  const delays = [];
  for (let index = 0; index < 6; index += 1) {
    FakeWebSocketCloseWhileConnectingErrors.instances.at(-1).fail();
    assert.equal(pending().length, 1, `one timer after failure ${index + 1}`);
    delays.push(pending()[0].delay);
    fireNext();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(FakeWebSocketCloseWhileConnectingErrors.instances.length, 7);
  link.stop();
});

test("an error followed by a close event schedules one reconnect, not two", () => {
  const { link, pending } = createReconnectHarness(FakeWebSocket);
  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  // Node 24 and browsers: the close called from the error handler fires close.
  socket.emit("error", { message: "Received network error or non-101 status code." });
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 1000);
  link.stop();
  assert.equal(pending().length, 0, "stop clears the reconnect");
});

test("a stale connection reconnects even when its close never completes", () => {
  class FakeWebSocketSilentClose extends FakeWebSocket {
    close() { this.readyState = 2; }
  }
  let nowMs = 1000;
  const intervals = [];
  const { link, pending } = createReconnectHarness(FakeWebSocketSilentClose, {
    now: () => nowMs,
    readyRefreshMs: 1000,
    staleConnectionMs: 5000,
    setIntervalImpl: (fn) => { intervals.push(fn); return {}; },
  });
  link.start();
  FakeWebSocketSilentClose.instances[0].open();
  nowMs = 7000;
  intervals[0]();
  assert.equal(pending().length, 1);
  assert.equal(link.status().connected, false);
  link.stop();
});

test("a link stopped during a failing connect schedules nothing", () => {
  const { link, pending } = createReconnectHarness(FakeWebSocketCloseWhileConnectingErrors);
  link.start();
  const socket = FakeWebSocketCloseWhileConnectingErrors.instances[0];
  link.stop();
  socket.fail();
  assert.equal(pending().length, 0);
});

test("a rejected handshake (error, then close) leaves one reconnect timer and one log line", () => {
  const { link, logs, pending, deadlines } = createReconnectHarness(FakeWebSocket);
  link.start();
  const socket = FakeWebSocket.instances[0];
  assert.equal(deadlines().length, 1, "a connect deadline runs while connecting");
  // A non-101 answer (a 401, a relay not listening yet): error, then close.
  socket.emit("error", { message: "Received network error or non-101 status code." });
  socket.emit("close", { code: 1006 });
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 1000);
  assert.equal(deadlines().length, 0, "the deadline ends with the socket");
  assert.deepEqual(logs.filter((line) => line.startsWith("worker ws disconnected")), [
    "worker ws disconnected error: Received network error or non-101 status code. attempt=1 retryInMs=1000",
  ]);
  link.stop();
});

test("a connect that never finishes is given up at the deadline and retried", () => {
  class FakeWebSocketSilent extends FakeWebSocket {
    // A relay hung in its shutdown: the close handshake never completes.
    close() { this.readyState = 2; this.closeCalls = (this.closeCalls || 0) + 1; }
  }
  const { link, logs, pending, deadlines, fireNext, fireDeadline } = createReconnectHarness(FakeWebSocketSilent);
  link.start();
  const first = FakeWebSocketSilent.instances[0];
  assert.equal(deadlines()[0].delay, CONNECT_TIMEOUT_MS);
  assert.equal(pending().length, 0);

  fireDeadline();
  assert.equal(first.closeCalls, 1);
  assert.equal(pending().length, 1);
  assert.equal(link.status().connected, false);
  assert.match(logs.at(-1), /^worker ws disconnected connect-timeout attempt=1/);

  // Late events from the abandoned socket do not add a second timer.
  first.emit("error", { message: "late" });
  first.emit("close", { code: 1006 });
  assert.equal(pending().length, 1);

  fireNext();
  assert.equal(FakeWebSocketSilent.instances.length, 2, "exactly one new socket");
  const second = FakeWebSocketSilent.instances[1];
  assert.equal(deadlines().length, 1, "the new socket has its own deadline");
  second.open();
  second.receive({ type: "server.hello", reason: "connected" });
  assert.equal(deadlines().length, 0);
  assert.equal(link.status().reconnectAttempt, 0);
  link.stop();
});

test("a socket that opens but never gets the relay's hello is a failed handshake", () => {
  const { link, logs, pending, fireNext, fireDeadline } = createReconnectHarness(FakeWebSocket);
  link.start();
  FakeWebSocket.instances[0].open();
  fireDeadline();
  assert.equal(FakeWebSocket.instances[0].readyState, FakeWebSocket.instances[0].CLOSED);
  assert.equal(pending().length, 1, "close after the deadline adds nothing");
  assert.equal(pending()[0].delay, 1000);
  assert.match(logs.at(-1), /^worker ws disconnected no-server-hello attempt=1/);

  // An open without a hello does not reset the backoff: a relay that accepts
  // and drops the socket is not retried every second.
  fireNext();
  const second = FakeWebSocket.instances[1];
  second.open();
  second.close();
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 2000);
  link.stop();
});

test("a socket constructor that throws still schedules the next attempt", () => {
  let failures = 1;
  class FakeWebSocketThrows extends FakeWebSocket {
    constructor(url) {
      if (failures > 0) {
        failures -= 1;
        throw new SyntaxError("Invalid URL");
      }
      super(url);
    }
  }
  const { link, logs, pending, fireNext } = createReconnectHarness(FakeWebSocketThrows);
  assert.doesNotThrow(() => link.start());
  assert.equal(pending().length, 1);
  assert.match(logs.at(-1), /^worker ws disconnected connect-failed: Invalid URL attempt=1/);
  fireNext();
  assert.equal(FakeWebSocketThrows.instances.length, 1);
  link.stop();
});

test("a draining relay whose close never completes is reconnected to", () => {
  class FakeWebSocketSilentClose extends FakeWebSocket {
    close() { this.readyState = 2; }
  }
  const { link, pending } = createReconnectHarness(FakeWebSocketSilentClose);
  link.start();
  const socket = FakeWebSocketSilentClose.instances[0];
  socket.open();
  socket.receive({ type: "server.hello", reason: "connected" });
  socket.receive({ type: "server.draining", reason: "relay-shutdown" });
  assert.equal(pending().length, 1);
  assert.equal(link.status().connected, false);
  // The close that finally lands (the relay force-exited) changes nothing.
  socket.emit("close", { code: 1006 });
  assert.equal(pending().length, 1);
  link.stop();
});

test("a successful reconnect clears the backoff, the deadline and the log throttle", () => {
  const { link, logs, pending, deadlines, fireNext } = createReconnectHarness(FakeWebSocketCloseWhileConnectingErrors);
  link.start();
  for (let index = 0; index < 3; index += 1) {
    FakeWebSocketCloseWhileConnectingErrors.instances.at(-1).fail();
    fireNext();
  }
  assert.equal(link.status().reconnectAttempt, 3);
  const socket = FakeWebSocketCloseWhileConnectingErrors.instances.at(-1);
  socket.open();
  assert.equal(link.status().reconnectAttempt, 3, "an open alone is not a completed handshake");
  socket.receive({ type: "server.hello", reason: "connected" });
  assert.equal(link.status().reconnectAttempt, 0);
  assert.equal(link.status().reconnectDelayMs, 0);
  assert.equal(pending().length, 0);
  assert.equal(deadlines().length, 0);

  // The next outage starts again at the shortest delay, and is logged.
  const logged = logs.length;
  socket.close();
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].delay, 1000);
  assert.equal(logs.length, logged + 1);
  link.stop();
});

test("failed attempts are logged one line each at first, then at most once a minute", () => {
  let nowMs = 0;
  const { link, logs, fireNext } = createReconnectHarness(FakeWebSocketCloseWhileConnectingErrors, {
    now: () => nowMs,
  });
  link.start();
  const failAndRetry = () => {
    FakeWebSocketCloseWhileConnectingErrors.instances.at(-1).fail();
    nowMs += 8000;
    fireNext();
  };
  const disconnectLines = () => logs.filter((line) => line.startsWith("worker ws disconnected"));
  for (let index = 0; index < 3; index += 1) failAndRetry();
  assert.equal(disconnectLines().length, 3);
  // Attempts 4 to 10 fall within the minute after the third line.
  for (let index = 0; index < 7; index += 1) failAndRetry();
  assert.equal(disconnectLines().length, 3);
  failAndRetry();
  assert.equal(disconnectLines().length, 4);
  assert.match(disconnectLines().at(-1), /attempt=11 retryInMs=8000 notLogged=7$/);
  assert.equal(logs.length, disconnectLines().length, "no other line per attempt");
  link.stop();
});

test("stop ends reconnecting for good: no timer, no deadline, no new socket", () => {
  const { link, timers, pending, deadlines } = createReconnectHarness(FakeWebSocket);
  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.emit("error", { message: "connect ECONNREFUSED 192.0.2.1:3333" });
  assert.equal(pending().length, 1);
  const reconnect = pending()[0];
  link.stop();
  assert.equal(pending().length, 0);
  assert.equal(deadlines().length, 0);
  // A timer callback already on its way when stop ran does nothing.
  reconnect.fn();
  assert.equal(FakeWebSocket.instances.length, 1);

  // Stopping a connected link closes it without a reconnect.
  link.start();
  const second = FakeWebSocket.instances[1];
  second.open();
  second.receive({ type: "server.hello", reason: "connected" });
  const timersBefore = timers.length;
  link.stop();
  assert.equal(second.readyState, second.CLOSED);
  assert.equal(timers.length, timersBefore);
  assert.equal(pending().length, 0);
});

test("a worker's kind rides its hello and its ready", async () => {
  FakeWebSocket.instances = [];
  const link = createWorkerWebSocketLink({
    serverUrl: "http://localhost:3333",
    token: "tok",
    getSessionReady: () => true,
    getSessionId: () => "sdk-1",
    getPid: () => 4242,
    workerKind: "claude-api",
    onDeliver: async () => {},
    WebSocketImpl: FakeWebSocket,
    jitterMs: 0,
  });
  link.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await new Promise((resolve) => setImmediate(resolve));
  const sent = socket.sent.map((payload) => JSON.parse(payload));
  assert.deepEqual(sent.map((payload) => [payload.type, payload.kind]), [["worker.hello", "claude-api"], ["worker.ready", "claude-api"]]);
  link.stop();
});
