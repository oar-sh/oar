function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizePositiveInt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const intValue = Math.trunc(numeric);
  return intValue > 0 ? intValue : null;
}

function resolveSocketStateValue(socket, stateName, fallback) {
  const candidates = [
    socket?.[stateName],
    socket?.constructor?.[stateName],
    globalThis?.WebSocket?.[stateName],
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function toWebSocketUrl(serverUrl, token, getSessionId, getPid) {
  const source = new URL(String(serverUrl || "http://localhost:3333"));
  source.protocol = source.protocol === "https:" ? "wss:" : "ws:";
  source.pathname = "/api/session-worker/ws";
  source.search = "";
  if (token) source.searchParams.set("token", token);
  const sessionId = normalizeText(typeof getSessionId === "function" ? getSessionId() : null);
  if (sessionId) source.searchParams.set("sessionId", sessionId);
  const pid = normalizePositiveInt(typeof getPid === "function" ? getPid() : null);
  if (pid) source.searchParams.set("pid", String(pid));
  return source.toString();
}

export function createWorkerWebSocketLink({
  serverUrl,
  token,
  dbg = () => {},
  onDeliver = async () => {},
  // Fire-and-forget control pushes from the server (e.g. stop a background
  // task). Never blocks delivery; failures are the handler's to log.
  onControl = () => {},
  getSessionReady = () => false,
  // Mid-turn steering opt-in. A worker whose runner can absorb another
  // delivered message into the live turn (the Claude session runner; the
  // Copilot runner's steerIntoActiveTurn is compatible but not yet opted in)
  // reports so here, and the link then keeps signalling readiness while a
  // delivery is still in flight and runs the resulting concurrent delivery
  // instead of coalescing it. Workers that leave this unset keep the strict
  // single-flight contract.
  getSteeringReady = null,
  // Steering-capable workers only: true while the runner is holding deliveries
  // (a question card or plan approval is open, a compaction or adoption is in
  // progress, a turn-opening delivery is mid-flight). A held worker never
  // signals readiness — idle or not — and tells the server so with
  // worker.unready, because a delivery landing in a hold is handed back.
  getDeliveryHeld = null,
  // Called with the hello's reason once per connection, on the relay's first
  // server.hello: from then on the relay (possibly a restarted one that knows
  // nothing of this worker) has the socket. Later hellos only ack the
  // worker.hello every idle readiness refresh re-sends, and are not reported.
  onServerHello = () => {},
  getSessionId = () => null,
  getPid = () => null,
  minBackoffMs = 1000,
  maxBackoffMs = 8_000,
  jitterMs = 250,
  // A connection counts as made only at the relay's first server.hello (the
  // relay sends it as soon as it accepts the socket). One still connecting,
  // or open but silent, when this runs out is given up and retried: a relay
  // that hangs in its shutdown can hold a socket in either state without
  // ever ending it.
  connectTimeoutMs = 15_000,
  // Failed attempts after the first few are logged at most once per this
  // interval, with a count of the ones in between.
  failureLogIntervalMs = 60_000,
  readyRefreshMs = 10_000,
  staleConnectionMs = 30_000,
  WebSocketImpl = globalThis.WebSocket,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = () => Date.now(),
} = {}) {
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let readyRefreshTimer = null;
  let reconnectAttempt = 0;
  let reconnectDelayMs = 0;
  // The current socket's connect deadline (see connectTimeoutMs).
  let connectDeadlineTimer = null;
  let lastFailureLoggedAt = null;
  let failuresNotLogged = 0;
  // Ends the current socket's connection (see connect).
  let endCurrentSocket = null;
  // Insertion-ordered: the first entry is the oldest in-flight delivery, which
  // is what a legacy worker's coalesced delivery waits on.
  const deliveriesInFlight = new Set();
  // message id → in-flight delivery. Only a redelivery of the SAME message is
  // coalesced; a different message is never folded onto another's promise.
  const deliveriesById = new Map();
  let lastOpenAt = null;
  let lastMessageAt = null;
  let lastHelloSentAt = null;
  let lastReadySentAt = null;
  let lastUnreadySentAt = null;
  // What the connected relay advertised in server.hello (see
  // WORKER_PROTOCOL_CAPABILITIES in the relay's worker websocket service).
  let serverCapabilities = new Set();
  let lastPingSentAt = null;
  let lastPongAt = null;
  let lastQueueChangedAt = null;
  let lastDeliveryAt = null;

  function getNowMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function isSocketOpen() {
    return !!ws && ws.readyState === resolveSocketStateValue(ws, "OPEN", 1);
  }

  function send(payload) {
    if (!isSocketOpen()) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function steeringCapable() {
    return typeof getSteeringReady === "function";
  }

  function steeringReady() {
    if (!steeringCapable()) return false;
    try {
      return getSteeringReady() === true;
    } catch {
      return false;
    }
  }

  function deliveryHeld() {
    if (typeof getDeliveryHeld !== "function") return false;
    try {
      return getDeliveryHeld() === true;
    } catch {
      // Fail closed: a held worker that signals ready bounces every delivery.
      return true;
    }
  }

  function notifyHello(reason = "worker-hello") {
    if (!getSessionReady()) return false;
    // The server treats hello as readiness; a held worker still has to bind
    // its identity, so it says hello without claiming to be ready.
    const held = deliveryHeld();
    const sent = send({
      type: "worker.hello",
      reason,
      sessionId: normalizeText(getSessionId()),
      pid: normalizePositiveInt(getPid()),
      ...(held ? { ready: false } : {}),
    });
    if (sent) lastHelloSentAt = getNowMs();
    return sent;
  }

  function notifyUnready(reason = "worker-unready") {
    if (!getSessionReady()) return false;
    const sent = send({
      type: "worker.unready",
      reason,
      sessionId: normalizeText(getSessionId()),
      pid: normalizePositiveInt(getPid()),
    });
    if (sent) lastUnreadySentAt = getNowMs();
    return sent;
  }

  async function notifyReady(reason = "worker-ready") {
    if (!getSessionReady()) return false;
    if (deliveryHeld()) return false;
    if (deliveriesInFlight.size && !steeringReady()) return false;
    const sent = send({
      type: "worker.ready",
      reason,
      sessionId: normalizeText(getSessionId()),
      pid: normalizePositiveInt(getPid()),
    });
    if (sent) lastReadySentAt = getNowMs();
    return sent;
  }

  function notifyPing(reason = "readiness-refresh") {
    if (!getSessionReady()) return false;
    const sent = send({
      type: "worker.ping",
      reason,
      sessionId: normalizeText(getSessionId()),
      pid: normalizePositiveInt(getPid()),
    });
    if (sent) lastPingSentAt = getNowMs();
    return sent;
  }

  async function deliverPending(pending, reason = "queue-deliver") {
    if (!getSessionReady()) return false;
    // A redelivery of a message that is already running (socket reconnect)
    // coalesces onto it rather than double-running the turn.
    const messageId = normalizeText(pending?.message?.id);
    if (messageId && deliveriesById.has(messageId)) return deliveriesById.get(messageId);
    // A DIFFERENT message while one is in flight: a steering-capable worker's
    // runner decides — it steers the message into the live turn, or hands it
    // back to the queue when the turn is holding (the server's readiness can
    // lag a hold by a round-trip). Coalescing it here used to drop its payload
    // and strand the row `processing` until heartbeat recovery. Workers
    // without the steering opt-in keep strict single-flight: their runners
    // have no hand-back path, and the heartbeat recovers the row.
    if (deliveriesInFlight.size && !steeringCapable()) {
      return deliveriesInFlight.values().next().value;
    }
    const delivery = Promise.resolve()
      .then(() => onDeliver(pending, reason))
      .catch((error) => {
        dbg("worker ws delivery failed", reason, error?.message || String(error));
        return false;
      })
      .finally(() => {
        lastDeliveryAt = getNowMs();
        deliveriesInFlight.delete(delivery);
        if (messageId && deliveriesById.get(messageId) === delivery) deliveriesById.delete(messageId);
      });
    deliveriesInFlight.add(delivery);
    if (messageId) deliveriesById.set(messageId, delivery);
    return delivery;
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function clearConnectDeadline() {
    if (!connectDeadlineTimer) return;
    clearTimeoutImpl(connectDeadlineTimer);
    connectDeadlineTimer = null;
  }

  function clearReadyRefreshTimer() {
    if (!readyRefreshTimer) return;
    clearIntervalImpl(readyRefreshTimer);
    readyRefreshTimer = null;
  }

  function closeStaleSocket(reason) {
    if (!isSocketOpen()) return false;
    dbg("worker ws stale connection closing", reason);
    const socket = ws;
    // A dead peer may never complete the close handshake: the reconnect does
    // not wait for the close event.
    endCurrentSocket?.(`stale:${reason}`);
    try { socket?.close?.(); } catch {}
    return true;
  }

  function refreshReadiness(reason = "readiness-refresh") {
    if (stopped || !getSessionReady() || !isSocketOpen()) return false;
    const nowMs = getNowMs();
    const staleMs = Math.max(0, Number(staleConnectionMs) || 0);
    if (staleMs > 0 && lastMessageAt && (nowMs - lastMessageAt) > staleMs) {
      return closeStaleSocket(`no-server-message:${reason}`);
    }
    notifyPing(reason);
    if (deliveryHeld()) {
      // Re-asserted on every refresh: a ready frame that crossed the hold on
      // the wire would otherwise leave the server's readiness stuck on.
      notifyUnready(reason);
      return true;
    }
    if (deliveriesInFlight.size) {
      // notifyReady gates itself: it only goes through mid-delivery when the
      // worker is steering-ready. Hello stays an idle-only affair.
      void notifyReady(reason);
      return true;
    }
    notifyHello(reason);
    void notifyReady(reason);
    return true;
  }

  function startReadyRefreshTimer() {
    clearReadyRefreshTimer();
    const intervalMs = Math.max(1000, Number(readyRefreshMs) || 10_000);
    readyRefreshTimer = setIntervalImpl(() => {
      refreshReadiness("readiness-refresh");
    }, intervalMs);
    if (typeof readyRefreshTimer?.unref === "function") readyRefreshTimer.unref();
  }

  // One line per failed attempt for the first few, then at most one per
  // failureLogIntervalMs: a relay that stays away for an hour must not fill
  // the worker log with a line every 8 seconds.
  function logFailedAttempt(reason) {
    const nowMs = getNowMs();
    const intervalMs = Math.max(0, Number(failureLogIntervalMs) || 0);
    if (reconnectAttempt > 3 && lastFailureLoggedAt !== null && (nowMs - lastFailureLoggedAt) < intervalMs) {
      failuresNotLogged += 1;
      return;
    }
    const notLogged = failuresNotLogged ? [`notLogged=${failuresNotLogged}`] : [];
    dbg("worker ws disconnected", reason, `attempt=${reconnectAttempt}`, `retryInMs=${reconnectDelayMs}`, ...notLogged);
    lastFailureLoggedAt = nowMs;
    failuresNotLogged = 0;
  }

  function scheduleReconnect(reason) {
    if (stopped) return;
    // One timer at a time: a second end reported for the same outage must not
    // stack another attempt or push the backoff up.
    if (reconnectTimer) return;
    reconnectAttempt += 1;
    const backoff = Math.min(maxBackoffMs, minBackoffMs * (2 ** Math.max(0, reconnectAttempt - 1)));
    const jitter = Math.floor(Math.random() * Math.max(0, jitterMs));
    reconnectDelayMs = Math.min(maxBackoffMs, backoff + jitter);
    logFailedAttempt(reason);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect() {
    if (stopped) return;
    if (ws) {
      const openState = resolveSocketStateValue(ws, "OPEN", 1);
      const connectingState = resolveSocketStateValue(ws, "CONNECTING", 0);
      if (ws.readyState === openState || ws.readyState === connectingState) return;
      // A socket left closing whose end was never reported: give it up
      // quietly, this connect is its reconnect.
      endCurrentSocket?.("replaced", { reconnect: false });
    }
    if (typeof WebSocketImpl !== "function") {
      dbg("worker ws unavailable: global WebSocket is missing");
      return;
    }
    clearReconnectTimer();
    let socket = null;
    try {
      const url = toWebSocketUrl(serverUrl, token, getSessionId, getPid);
      socket = new WebSocketImpl(url);
    } catch (error) {
      // A socket that fails in its constructor raises no events: nothing but
      // this would ever try again.
      scheduleReconnect(`connect-failed: ${error?.message || String(error)}`);
      return;
    }
    ws = socket;
    let serverHelloSeen = false;
    // Set once this socket's end has been handled, by whichever of error,
    // close, the connect deadline or a stale/draining close comes first;
    // every later event from it is ignored. Node 22 fires no close for a
    // socket closed while still connecting, and closing it from its own
    // error handler raised the error again, so the reconnect has to be
    // scheduled from the error as well, and only once.
    let ended = false;
    function endSocket(reason, { reconnect = true } = {}) {
      if (ended) return false;
      ended = true;
      if (endCurrentSocket === endSocket) {
        endCurrentSocket = null;
        clearConnectDeadline();
      }
      if (ws === socket) {
        ws = null;
        clearReadyRefreshTimer();
        // The next connection may reach a different (restarted) relay.
        serverCapabilities = new Set();
      }
      if (stopped || !reconnect) return true;
      // A newer socket is already under way and owns the reconnect.
      if (ws) return true;
      scheduleReconnect(reason);
      return true;
    }
    endCurrentSocket = endSocket;
    clearConnectDeadline();
    const deadlineMs = Math.max(0, Number(connectTimeoutMs) || 0);
    if (deadlineMs > 0) {
      connectDeadlineTimer = setTimeoutImpl(() => {
        connectDeadlineTimer = null;
        if (ended) return;
        const opened = socket.readyState === resolveSocketStateValue(socket, "OPEN", 1);
        // Ended before the close call, as in the error handler below.
        endSocket(opened ? "no-server-hello" : "connect-timeout");
        try { socket.close?.(); } catch {}
      }, deadlineMs);
      if (typeof connectDeadlineTimer?.unref === "function") connectDeadlineTimer.unref();
    }
    socket.addEventListener("open", () => {
      if (ended) return;
      const openedAt = getNowMs();
      lastOpenAt = openedAt;
      lastMessageAt = openedAt;
      dbg("worker ws connected");
      notifyHello("ws-open");
      void notifyReady("ws-open");
      startReadyRefreshTimer();
    });
    socket.addEventListener("message", (event) => {
      if (ended) return;
      lastMessageAt = getNowMs();
      let payload = null;
      try {
        payload = JSON.parse(String(event?.data || ""));
      } catch {
        return;
      }
      if (payload?.type === "queue.deliver") {
        void deliverPending(payload.pending || null, String(payload.reason || "queue-deliver"))
          .finally(() => notifyReady("delivery-complete"));
        return;
      }
      if (payload?.type === "server.hello") {
        serverCapabilities = new Set(Array.isArray(payload.capabilities) ? payload.capabilities.map(String) : []);
        if (!serverHelloSeen) {
          serverHelloSeen = true;
          // The handshake is complete: only now does the backoff start over.
          // A relay that accepts the socket and drops it before its hello
          // keeps backing off instead of being retried every second.
          clearConnectDeadline();
          reconnectAttempt = 0;
          reconnectDelayMs = 0;
          lastFailureLoggedAt = null;
          failuresNotLogged = 0;
          try {
            onServerHello(String(payload.reason || "server-hello"));
          } catch (error) {
            dbg("worker ws hello handler failed", error?.message || String(error));
          }
        }
        void notifyReady(String(payload.reason || "server-hello"));
        return;
      }
      if (payload?.type === "server.pong") {
        lastPongAt = getNowMs();
        return;
      }
      if (payload?.type === "server.draining") {
        dbg("worker ws draining", payload.reason || "relay-shutdown");
        // A relay stuck in its shutdown may never complete the close
        // handshake: the reconnect does not wait for the close event.
        endSocket("draining");
        try { socket.close?.(); } catch {}
        return;
      }
      if (payload?.type === "queue.changed") {
        lastQueueChangedAt = getNowMs();
        void notifyReady("queue-changed");
        return;
      }
      if (payload?.type === "worker.control") {
        try {
          void onControl(payload.control || null);
        } catch (error) {
          dbg("worker ws control handler failed", error?.message || String(error));
        }
        return;
      }
      if (payload?.type === "queue.blocked") {
        dbg("worker ws blocked", payload.reason || "blocked");
      }
    });
    socket.addEventListener("close", (event) => {
      const code = Number(event?.code);
      endSocket(Number.isFinite(code) && code > 0 ? `close code=${code}` : "close");
    });
    socket.addEventListener("error", (event) => {
      if (ended) return;
      const detail = event?.message || event?.error?.message || "unknown";
      // Ended before the close call, so an error or close it raises
      // (synchronously on some runtimes) finds the socket already handled.
      endSocket(`error: ${detail}`);
      try { socket.close?.(); } catch {}
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearReconnectTimer();
    clearConnectDeadline();
    clearReadyRefreshTimer();
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
  }

  function status() {
    // Some WebSocket implementations expose OPEN only on the constructor —
    // the same reason every other check here goes through the resolver.
    const connected = !!ws && ws.readyState === resolveSocketStateValue(ws, "OPEN", 1);
    return {
      connected,
      delivering: deliveriesInFlight.size > 0,
      reconnectAttempt,
      reconnectDelayMs,
      lastOpenAt,
      lastMessageAt,
      lastHelloSentAt,
      lastReadySentAt,
      lastUnreadySentAt,
      lastPingSentAt,
      lastPongAt,
      lastQueueChangedAt,
      lastDeliveryAt,
    };
  }

  return {
    notifyReady,
    notifyUnready,
    serverSupports: (capability) => serverCapabilities.has(String(capability || "")),
    start,
    stop,
    status,
  };
}
