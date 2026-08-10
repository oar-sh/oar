'use strict';

import { URL } from 'url';

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizePathPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/, '');
}

export function buildAcceptedWorkerPaths(pathPrefix) {
  const basePath = '/api/session-worker/ws';
  const prefixed = `${normalizePathPrefix(pathPrefix)}${basePath}` || basePath;
  return Array.from(new Set([basePath, prefixed]));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(/;\s*/)) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function readAuthTokenFromUpgrade(req) {
  const host = String(req?.headers?.host || 'localhost');
  let parsedUrl = null;
  try {
    parsedUrl = new URL(String(req?.url || ''), `http://${host}`);
  } catch {
    parsedUrl = null;
  }
  const authHeader = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const queryToken = normalizeText(parsedUrl?.searchParams?.get('token'));
  const cookies = parseCookies(req?.headers?.cookie);
  const cookieToken = normalizeText(cookies.copilot_auth);
  return authHeader || queryToken || cookieToken || null;
}

function normalizeQueueSnapshot(value) {
  const queue = value && typeof value === 'object' ? value : {};
  const pendingCount = Math.max(0, Number(queue.pendingCount) || 0);
  const processingCount = Math.max(0, Number(queue.processingCount) || 0);
  const parkedCount = Math.max(0, Number(queue.parkedCount) || 0);
  return { pendingCount, processingCount, parkedCount };
}

function normalizePositiveInt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const intValue = Math.trunc(numeric);
  return intValue > 0 ? intValue : null;
}

function parseUpgradeIdentity(req) {
  const host = String(req?.headers?.host || 'localhost');
  let parsedUrl = null;
  try {
    parsedUrl = new URL(String(req?.url || ''), `http://${host}`);
  } catch {
    parsedUrl = null;
  }
  return {
    sessionId: normalizeText(parsedUrl?.searchParams?.get('sessionId')),
    pid: normalizePositiveInt(parsedUrl?.searchParams?.get('pid')),
  };
}

function queueSnapshotChanged(left, right) {
  if (!left || !right) return true;
  return left.pendingCount !== right.pendingCount
    || left.processingCount !== right.processingCount
    || left.parkedCount !== right.parkedCount;
}

export function createSessionWorkerWebSocketService({
  WebSocketServerImpl,
  httpServer,
  authToken,
  queueCounts,
  touchCli = () => {},
  noteWorkerHeartbeat = () => {},
  onDeliverySendFailed = async () => {},
  requestWork = async () => null,
  pathPrefix = '',
  pollIntervalMs = 1000,
  nowIso = () => new Date().toISOString(),
  logger = console,
} = {}) {
  if (!WebSocketServerImpl) throw new Error('createSessionWorkerWebSocketService requires WebSocketServerImpl');
  if (!httpServer) throw new Error('createSessionWorkerWebSocketService requires httpServer');
  if (typeof queueCounts !== 'function') throw new Error('createSessionWorkerWebSocketService requires queueCounts');

  const acceptedPaths = buildAcceptedWorkerPaths(pathPrefix);
  const wsPath = acceptedPaths[acceptedPaths.length - 1];
  const wss = new WebSocketServerImpl({ noServer: true });
  const clients = new Set();
  const clientState = new Map();
  const noop = () => {};
  const logDebug = typeof logger?.debug === 'function' ? logger.debug.bind(logger) : noop;
  const logWarn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : noop;

  let interval = null;
  let lastSnapshot = null;
  let attached = false;

  function toQueueChangedEvent(reason = 'queue-update') {
    const snapshot = normalizeQueueSnapshot(queueCounts());
    return {
      type: 'queue.changed',
      reason: String(reason || 'queue-update'),
      pendingCount: snapshot.pendingCount,
      processingCount: snapshot.processingCount,
      parkedCount: snapshot.parkedCount,
      timestamp: nowIso(),
    };
  }

  function emitQueueChanged(reason = 'queue-update') {
    const event = toQueueChangedEvent(reason);
    const payload = JSON.stringify(event);
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        // Ignore transient socket send failures. close/cleanup handlers own lifecycle.
      }
    }
    return event;
  }

  function emitEvent(socket, event) {
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  function noteHeartbeat(meta, reason = 'worker-message') {
    if (!meta?.sessionId) return;
    try {
      noteWorkerHeartbeat(meta.sessionId, {
        pid: meta.pid,
        reason,
        timestamp: nowIso(),
      });
    } catch {
      // Heartbeat bookkeeping should not break socket delivery.
    }
  }

  async function maybeDeliverToSocket(socket, reason = 'ready') {
    const meta = clientState.get(socket);
    if (!meta || meta.delivering || !meta.ready) return false;
    if (!meta.sessionId) return false;
    if (socket.readyState !== socket.OPEN) return false;
    meta.delivering = true;
    try {
      const pending = await requestWork({
        sessionId: meta.sessionId,
        pid: meta.pid,
        reason,
      });
      touchCli();
      if (!pending || typeof pending !== 'object') return false;
      if (pending.message) {
        const deliveredAt = nowIso();
        const sent = emitEvent(socket, {
          type: 'queue.deliver',
          reason,
          pending,
          timestamp: deliveredAt,
        });
        if (sent) {
          meta.ready = false;
          meta.lastDeliveredAt = deliveredAt;
          meta.deliveryFailures = 0;
          return true;
        }
        meta.deliveryFailures = Number(meta.deliveryFailures || 0) + 1;
        meta.ready = true;
        logWarn(`[worker-ws] delivery send failed for ${String(meta.sessionId || 'unknown').slice(0, 8)} reason=${reason}`);
        await Promise.resolve(onDeliverySendFailed({
          pending,
          sessionId: meta.sessionId,
          pid: meta.pid,
          reason,
          deliveryFailures: meta.deliveryFailures,
        })).catch((error) => {
          logWarn(`[worker-ws] delivery send failure recovery failed for ${String(meta.sessionId || 'unknown').slice(0, 8)}: ${error?.message || error}`);
        });
        try { socket.close(); } catch {}
        return false;
      }
      if (pending.paused || pending.reason || pending.routing?.blockedReason) {
        emitEvent(socket, {
          type: 'queue.blocked',
          reason: String(pending.reason || pending.routing?.blockedReason || reason || 'blocked'),
          pending,
          timestamp: nowIso(),
        });
      }
      return false;
    } catch (error) {
      logWarn(`[worker-ws] delivery failed for ${String(meta.sessionId || 'unknown').slice(0, 8)}: ${error?.message || error}`);
      emitEvent(socket, {
        type: 'queue.error',
        reason: 'delivery-failed',
        error: String(error?.message || error || 'unknown delivery failure'),
        timestamp: nowIso(),
      });
      return false;
    } finally {
      meta.delivering = false;
    }
  }

  async function maybeDeliverToReadyClients(reason = 'queue-update') {
    const deliveries = [];
    for (const socket of clients) {
      const meta = clientState.get(socket);
      if (!meta?.ready || meta.delivering) continue;
      deliveries.push(maybeDeliverToSocket(socket, reason));
    }
    if (!deliveries.length) return;
    await Promise.allSettled(deliveries);
  }

  function monitorQueue() {
    const snapshot = normalizeQueueSnapshot(queueCounts());
    const changed = queueSnapshotChanged(snapshot, lastSnapshot);
    lastSnapshot = snapshot;
    if (changed) {
      emitQueueChanged('queue-count-changed');
    }
    void maybeDeliverToReadyClients(changed ? 'queue-count-changed' : 'ready-check');
  }

  function rejectUpgrade(socket) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch {}
    try {
      socket.destroy();
    } catch {}
  }

  function matchesPath(req) {
    const host = String(req?.headers?.host || 'localhost');
    let pathname = '';
    try {
      pathname = new URL(String(req?.url || ''), `http://${host}`).pathname;
    } catch {
      return false;
    }
    return acceptedPaths.includes(pathname);
  }

  function handleUpgrade(req, socket, head) {
    if (!matchesPath(req)) return false;
    const token = readAuthTokenFromUpgrade(req);
    if (String(token || '') !== String(authToken || '')) {
      rejectUpgrade(socket);
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  function onConnection(ws, req) {
    clients.add(ws);
    const identity = parseUpgradeIdentity(req);
    clientState.set(ws, {
      sessionId: identity.sessionId,
      pid: identity.pid,
      ready: false,
      delivering: false,
      connectedAt: nowIso(),
      lastDeliveredAt: null,
      deliveryFailures: 0,
    });
    touchCli();
    emitEvent(ws, {
      type: 'server.hello',
      reason: 'connected',
      queue: normalizeQueueSnapshot(queueCounts()),
      sessionId: identity.sessionId,
      timestamp: nowIso(),
    });

    ws.on('message', (raw) => {
      touchCli();
      let payload = null;
      try {
        payload = JSON.parse(String(raw || ''));
      } catch {
        payload = null;
      }
      const meta = clientState.get(ws);
      if (!meta || !payload || typeof payload !== 'object') return;
      if (payload.type === 'worker.hello') {
        meta.sessionId = normalizeText(payload.sessionId) || meta.sessionId;
        meta.pid = normalizePositiveInt(payload.pid) || meta.pid;
        meta.ready = true;
        meta.lastHelloAt = nowIso();
        noteHeartbeat(meta, 'worker-hello');
        emitEvent(ws, {
          type: 'server.hello',
          reason: 'ack',
          queue: normalizeQueueSnapshot(queueCounts()),
          sessionId: meta.sessionId,
          timestamp: nowIso(),
        });
        void maybeDeliverToSocket(ws, 'worker-hello');
        return;
      }
      if (payload.type === 'worker.ready') {
        meta.sessionId = normalizeText(payload.sessionId) || meta.sessionId;
        meta.pid = normalizePositiveInt(payload.pid) || meta.pid;
        meta.ready = true;
        meta.lastReadyAt = nowIso();
        noteHeartbeat(meta, String(payload.reason || 'worker-ready'));
        void maybeDeliverToSocket(ws, String(payload.reason || 'worker-ready'));
        return;
      }
      if (payload.type === 'worker.ping') {
        meta.sessionId = normalizeText(payload.sessionId) || meta.sessionId;
        meta.pid = normalizePositiveInt(payload.pid) || meta.pid;
        meta.lastPingAt = nowIso();
        noteHeartbeat(meta, String(payload.reason || 'worker-ping'));
        emitEvent(ws, {
          type: 'server.pong',
          reason: String(payload.reason || 'worker-ping'),
          sessionId: meta.sessionId,
          timestamp: nowIso(),
        });
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      clientState.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
      clientState.delete(ws);
    });
  }

  function start() {
    if (!attached) {
      httpServer.on('upgrade', onUpgrade);
      wss.on('connection', onConnection);
      attached = true;
    }
    if (!interval) {
      interval = setInterval(monitorQueue, Math.max(250, Number(pollIntervalMs) || 1000));
      if (typeof interval.unref === 'function') interval.unref();
    }
    lastSnapshot = normalizeQueueSnapshot(queueCounts());
    emitQueueChanged('started');
    logDebug(`[worker-ws] listening on ${wsPath}`);
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (attached) {
      httpServer.off('upgrade', onUpgrade);
      attached = false;
    }
    for (const socket of clients) {
      try { socket.close(); } catch {}
    }
    clients.clear();
    clientState.clear();
    try { wss.close(); } catch (error) {
      logWarn(`[worker-ws] close failed: ${error?.message || error}`);
    }
  }

  function emitDraining(reason = 'relay-shutdown') {
    for (const socket of clients) {
      emitEvent(socket, {
        type: 'server.draining',
        reason,
        timestamp: nowIso(),
      });
    }
  }

  function status() {
    let readyCount = 0;
    let deliveringCount = 0;
    for (const meta of clientState.values()) {
      if (meta?.ready) readyCount += 1;
      if (meta?.delivering) deliveringCount += 1;
    }
    return {
      connectedCount: clients.size,
      readyCount,
      deliveringCount,
      path: wsPath,
      acceptedPaths,
    };
  }

  function onUpgrade(req, socket, head) {
    handleUpgrade(req, socket, head);
  }

  return {
    start,
    stop,
    status,
    emitQueueChanged,
    emitDraining,
    handleUpgrade,
  };
}
