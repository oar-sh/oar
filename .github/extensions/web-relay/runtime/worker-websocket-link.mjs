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
  getSessionId = () => null,
  getPid = () => null,
  minBackoffMs = 1000,
  maxBackoffMs = 8_000,
  jitterMs = 250,
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
  let deliveryInFlight = null;
  let lastOpenAt = null;
  let lastMessageAt = null;
  let lastHelloSentAt = null;
  let lastReadySentAt = null;
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

  function notifyHello(reason = "worker-hello") {
    if (!getSessionReady()) return false;
    const sent = send({
      type: "worker.hello",
      reason,
      sessionId: normalizeText(getSessionId()),
      pid: normalizePositiveInt(getPid()),
    });
    if (sent) lastHelloSentAt = getNowMs();
    return sent;
  }

  async function notifyReady(reason = "worker-ready") {
    if (!getSessionReady() || deliveryInFlight) return false;
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
    if (deliveryInFlight) return deliveryInFlight;
    deliveryInFlight = Promise.resolve()
      .then(() => onDeliver(pending, reason))
      .catch((error) => {
        dbg("worker ws delivery failed", reason, error?.message || String(error));
        return false;
      })
      .finally(() => {
        lastDeliveryAt = getNowMs();
        deliveryInFlight = null;
      });
    return deliveryInFlight;
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function clearReadyRefreshTimer() {
    if (!readyRefreshTimer) return;
    clearIntervalImpl(readyRefreshTimer);
    readyRefreshTimer = null;
  }

  function closeStaleSocket(reason) {
    if (!isSocketOpen()) return false;
    dbg("worker ws stale connection closing", reason);
    try { ws?.close?.(); } catch {}
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
    if (deliveryInFlight) return true;
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

  function scheduleReconnect() {
    if (stopped) return;
    clearReconnectTimer();
    reconnectAttempt += 1;
    const backoff = Math.min(maxBackoffMs, minBackoffMs * (2 ** Math.max(0, reconnectAttempt - 1)));
    const jitter = Math.floor(Math.random() * Math.max(0, jitterMs));
    reconnectDelayMs = Math.min(maxBackoffMs, backoff + jitter);
    dbg("worker ws reconnect scheduled", `attempt=${reconnectAttempt}`, `delayMs=${reconnectDelayMs}`);
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
    }
    if (typeof WebSocketImpl !== "function") {
      dbg("worker ws unavailable: global WebSocket is missing");
      return;
    }
    const url = toWebSocketUrl(serverUrl, token, getSessionId, getPid);
    ws = new WebSocketImpl(url);
    ws.addEventListener("open", () => {
      const openedAt = getNowMs();
      reconnectAttempt = 0;
      reconnectDelayMs = 0;
      lastOpenAt = openedAt;
      lastMessageAt = openedAt;
      dbg("worker ws connected");
      notifyHello("ws-open");
      void notifyReady("ws-open");
      startReadyRefreshTimer();
    });
    ws.addEventListener("message", (event) => {
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
        void notifyReady(String(payload.reason || "server-hello"));
        return;
      }
      if (payload?.type === "server.pong") {
        lastPongAt = getNowMs();
        return;
      }
      if (payload?.type === "server.draining") {
        dbg("worker ws draining", payload.reason || "relay-shutdown");
        try { ws?.close?.(); } catch {}
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
    ws.addEventListener("close", () => {
      clearReadyRefreshTimer();
      if (stopped) return;
      dbg("worker ws disconnected");
      scheduleReconnect();
    });
    ws.addEventListener("error", (error) => {
      dbg("worker ws error", error?.message || String(error));
      try { ws?.close?.(); } catch {}
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearReconnectTimer();
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
      delivering: !!deliveryInFlight,
      reconnectAttempt,
      reconnectDelayMs,
      lastOpenAt,
      lastMessageAt,
      lastHelloSentAt,
      lastReadySentAt,
      lastPingSentAt,
      lastPongAt,
      lastQueueChangedAt,
      lastDeliveryAt,
    };
  }

  return {
    notifyReady,
    start,
    stop,
    status,
  };
}
