'use strict';

import { timingSafeEqual } from 'node:crypto';
import { URL } from 'url';
import { normalizeBuildId } from '../../shared/build-id.mjs';

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

// The worker's credential: `Authorization: Bearer …` on the upgrade. Never
// the browser cookie (the worker socket is no browser's, agent auth §2.2).
// A `?token=` (a token in a URL ends up in logs) counts only as the owner
// token of a worker started before agent tokens, which has no other way to
// send it and would otherwise be stranded after the upgrade; an agent token
// there is refused. A new owner token closes those sockets and ends that.
// TRANSITIONAL: this `?token=` is removed in the next version. Until then
// every use is logged by the credential's shape, never its value, and the
// upgrade's URL loses the value before anything else can log it
// (redactTokenQuery).
function readAuthTokenFromUpgrade(req) {
  const header = req?.headers?.authorization;
  const value = String((Array.isArray(header) ? header[0] : header) || '').replace(/^Bearer(?:\s+|$)/i, '').trim();
  if (value) return { token: value, viaQuery: false };
  const host = String(req?.headers?.host || 'localhost');
  let query = null;
  try {
    query = normalizeText(new URL(String(req?.url || ''), `http://${host}`).searchParams.get('token'));
  } catch {
    query = null;
  }
  return query ? { token: query, viaQuery: true } : { token: null, viaQuery: false };
}

const TOKEN_QUERY_PATTERN = /([?&]token=)[^&#]*/gi;
const TOKEN_QUERY_TEST = /[?&]token=/i;

/** A request URL with every `token=` value replaced, for anything that logs it. */
export function redactTokenQuery(url) {
  return String(url ?? '').replace(TOKEN_QUERY_PATTERN, '$1[redacted]');
}

/** What a credential looks like, for a log line: its prefix, or that it has none. */
export function credentialShape(token) {
  const prefix = /^oar[a-z]1_/.exec(String(token || ''));
  return prefix ? `${prefix[0]}…` : 'an unprefixed value';
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

// The worker keepalive beats every 30 s while the worker is idle and every
// 10 s while it works (shared/worker-runtime/worker-keepalive.mjs; an older
// worker always every 10 s), and the link itself abandons a connection after
// 90 s of server silence (staleConnectionMs). Mirror that on this side: three
// missed idle beats and a retained socket no longer proves the worker is
// alive.
export const WORKER_SOCKET_LIVENESS_MAX_SILENCE_MS = 90_000;

// Protocol features this relay understands, advertised in server.hello. A
// worker that updated on disk before the relay restarted must not rely on
// them otherwise: an older relay ignores worker.unready / hello ready:false
// and treats a `steering-held` requeue as a failure (retry, backoff,
// worker marked errored). `idle-keepalive`: an idle worker may beat every
// 30 s; an older relay's liveness and CLI windows expect a beat every 10 s.
export const WORKER_PROTOCOL_CAPABILITIES = Object.freeze(['worker-unready', 'steering-held', 'idle-keepalive']);

export function createSessionWorkerWebSocketService({
  WebSocketServerImpl,
  httpServer,
  // `authorizeUpgrade({ token, sessionId })`, asked on every upgrade (never
  // captured at start): false to refuse, true for a credential that may open
  // any session's socket (a legacy owner token), or `(sessionId) => boolean`
  // for one bound to a session (an agent token), which the socket's later
  // identity frames must keep to. Without it, `authToken` is compared in
  // constant time.
  authorizeUpgrade = null,
  authToken,
  queueCounts,
  touchCli = () => {},
  noteWorkerHeartbeat = () => {},
  onDeliverySendFailed = async () => {},
  onWorkerSocketClosed = async () => {},
  // The number of open worker sockets changed: (count). The CLI presence
  // window is wider while a worker socket is open.
  onSocketCountChange = () => {},
  // Every queue snapshot the poll takes: ({pendingCount, processingCount,
  // parkedCount}). The relay arms its worker prime while rows are pending.
  onQueueSnapshot = () => {},
  // The earliest future retry time of a pending row, in ms (null: none). A
  // one-shot timer fires then, so a backoff or a usage-limit hold ends on
  // time rather than at the next poll.
  nextDueAtMs = () => null,
  // That timer fired with a row due: the relay wakes its queue (prime, hand
  // out, arm), since a row whose hold ended may have no worker yet.
  onDue = () => {},
  requestWork = async () => null,
  // A worker stated its kind ("claude", "claude-api", ...) in a hello or a
  // ready: (sessionId, kind, pid). The registry keeps it.
  onWorkerKind = () => {},
  // A worker stated the build id of the code it started on, in a hello or a
  // ready: (sessionId, buildId, pid). The registry keeps it, so the relay can
  // tell a worker on older code from one that runs what the relay runs.
  onWorkerBuildId = () => {},
  // A worker said hello: ({ sessionId, pid, kind, buildId }), with what the
  // socket knows of it. Called before the hello's own request for work, so
  // the relay can register the process and fence it first (a stale worker
  // reconnecting to a new relay: the worker recycle).
  onWorkerHello = () => {},
  // The relay's own build id, sent in every server.hello so a worker can log
  // that it runs other code; null leaves the key out.
  buildId = null,
  // Liveness probe for a socket's worker process. A killed worker's socket
  // survives its process by an event-loop turn (the kill path blocks the loop,
  // so this service's timer runs before the socket close lands), and asking for
  // work on its behalf makes the relay spawn a replacement for the session that
  // was just killed.
  isWorkerProcessAlive = () => true,
  pathPrefix = '',
  pollIntervalMs = 1000,
  nowIso = () => new Date().toISOString(),
  nowMs = () => Date.now(),
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

  const relayBuildId = normalizeBuildId(buildId);

  let interval = null;
  let dueTimer = null;
  // The retry time the armed due timer stands for.
  let dueTimerForMs = null;
  let stopped = false;
  let lastSnapshot = null;
  let attached = false;

  function nowMsSafe() {
    const value = Number(nowMs());
    return Number.isFinite(value) ? value : Date.now();
  }

  function noteSocketCount() {
    try { onSocketCountChange(clients.size); } catch {}
  }

  function removeSocket(socket, reason) {
    const meta = clientState.get(socket);
    const removed = clients.delete(socket);
    clientState.delete(socket);
    if (removed) noteSocketCount();
    // Death-detection hook: a worker socket closing while its session owns
    // an in-flight processing row used to be silently forgotten, leaving
    // the row to the 600s stale sweep. The handler PID-probes and recovers.
    if (meta?.sessionId) {
      Promise.resolve(onWorkerSocketClosed({
        sessionId: meta.sessionId,
        pid: meta.pid || null,
        reason,
      })).catch(() => {});
    }
  }

  function supersedePriorSockets(ws, sessionId) {
    for (const socket of Array.from(clients)) {
      if (socket === ws) continue;
      const meta = clientState.get(socket);
      if (meta?.sessionId !== sessionId) continue;
      // One authoritative socket generation per session: the newest connection
      // wins, and the prior socket is dropped synchronously so it can neither
      // be handed work nor count as liveness while its close event is in
      // flight. Before this, multiple ready sockets could claim one session
      // and each pull rows for it.
      logWarn(`[worker-ws] superseding prior socket for ${sessionId.slice(0, 8)}`);
      removeSocket(socket, 'superseded');
      try { socket.close(); } catch {}
    }
  }

  function bindSocketIdentity(ws, meta, payload) {
    const claimedSessionId = normalizeText(payload.sessionId);
    const claimedPid = normalizePositiveInt(payload.pid);
    // A socket's identity binds once (upgrade URL or first identifying frame).
    // A later frame claiming a different session or PID is a misidentified or
    // rekeyed worker; closing is safer than ignoring the frame — the worker
    // reconnects and re-binds atomically instead of keeping a socket that
    // receives one session's deliveries while claiming to be another.
    if ((meta.sessionId && claimedSessionId && claimedSessionId !== meta.sessionId)
      || (meta.pid && claimedPid && claimedPid !== meta.pid)) {
      logWarn(`[worker-ws] identity rebind rejected for ${String(meta.sessionId || 'unknown').slice(0, 8)} claimed=${String(claimedSessionId || 'none').slice(0, 8)}`);
      removeSocket(ws, 'identity-rebind');
      try { ws.close(); } catch {}
      return false;
    }
    // A socket opened with a session-bound credential binds only to that
    // session (an agent token of one conversation never serves another).
    if (!meta.sessionId && claimedSessionId && typeof meta.mayBind === 'function' && meta.mayBind(claimedSessionId) !== true) {
      logWarn(`[worker-ws] identity bind rejected: the token is not this session's (claimed=${String(claimedSessionId).slice(0, 8)})`);
      removeSocket(ws, 'identity-unauthorized');
      try { ws.close(); } catch {}
      return false;
    }
    if (!meta.sessionId && claimedSessionId) {
      meta.sessionId = claimedSessionId;
      supersedePriorSockets(ws, claimedSessionId);
    }
    if (!meta.pid && claimedPid) meta.pid = claimedPid;
    return true;
  }

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

  function emitQueueChanged(reason = 'queue-update', { skip = null } = {}) {
    const event = toQueueChangedEvent(reason);
    const payload = JSON.stringify(event);
    for (const socket of clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (skip?.has(socket)) continue;
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

  // The kind a hello or ready states, kept on the socket (a process does not
  // change kind) and reported once per change.
  function noteWorkerKind(meta, payload) {
    const kind = String(payload?.kind || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind) || meta.workerKind === kind) return;
    meta.workerKind = kind;
    try { onWorkerKind(meta.sessionId, kind, meta.pid); } catch {}
  }

  // The build id a hello or ready states, kept and reported like the kind. A
  // value that is malformed or too long is ignored rather than stored, since
  // the worker side is not trusted to bound what it sends.
  function noteWorkerBuildId(meta, payload) {
    const workerBuildId = normalizeBuildId(payload?.buildId);
    if (!workerBuildId || meta.workerBuildId === workerBuildId) return;
    meta.workerBuildId = workerBuildId;
    try { onWorkerBuildId(meta.sessionId, workerBuildId, meta.pid); } catch {}
  }

  // Both server.hello frames (on connection and the ack of worker.hello) carry
  // the same fields; an unknown relay build id leaves its key out rather than
  // sending null.
  function serverHello(reason, sessionId) {
    const event = {
      type: 'server.hello',
      reason,
      capabilities: WORKER_PROTOCOL_CAPABILITIES,
      queue: normalizeQueueSnapshot(queueCounts()),
      sessionId,
      timestamp: nowIso(),
    };
    if (relayBuildId) event.buildId = relayBuildId;
    return event;
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
    if (meta.pid && isWorkerProcessAlive(meta.pid) === false) return false;
    meta.delivering = true;
    try {
      const pending = await requestWork({
        sessionId: meta.sessionId,
        pid: meta.pid,
        reason,
        // What this socket's worker said it is: a Claude chat's row goes only
        // to a worker of its billing.
        workerKind: meta.workerKind || null,
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

  /** Hands a row to every ready socket; resolves to the sockets that got one. */
  async function maybeDeliverToReadyClients(reason = 'queue-update') {
    const sockets = [];
    const deliveries = [];
    for (const socket of clients) {
      const meta = clientState.get(socket);
      if (!meta?.ready || meta.delivering) continue;
      sockets.push(socket);
      deliveries.push(maybeDeliverToSocket(socket, reason));
    }
    const handed = new Set();
    if (!deliveries.length) return handed;
    const results = await Promise.allSettled(deliveries);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value === true) handed.add(sockets[index]);
    });
    return handed;
  }

  // Ready sockets get their rows first; then every other socket hears that
  // the queue changed (a worker the relay does not count as ready, a steering
  // one mid-turn, answers with a ready of its own). A socket just handed a
  // row is busy with it and is not told.
  async function deliverThenAnnounce(reason, { announce = true } = {}) {
    const handed = await maybeDeliverToReadyClients(reason);
    if (announce) emitQueueChanged(reason, { skip: handed });
    return handed;
  }

  /**
   * The queue may have work: a write, a gate that lifted, a retry come due.
   * Hands rows out now instead of at the next poll.
   */
  async function notifyQueueChanged(reason = 'queue-update') {
    if (stopped) return new Set();
    lastSnapshot = normalizeQueueSnapshot(queueCounts());
    // A turn that ended with nothing behind it: no row to hand out, so no
    // dequeue attempt per ready socket and no announcement.
    const handed = lastSnapshot.pendingCount > 0 ? await deliverThenAnnounce(reason) : new Set();
    armDueTimer();
    return handed;
  }

  // The backstop. With nothing pending nothing can be handed out: no dequeue
  // attempt, only the count change announced. With rows pending (a retry in
  // backoff, a gate, a worker not yet up) every tick tries the ready sockets,
  // as a net under the event-driven wakes.
  function monitorQueue() {
    const snapshot = normalizeQueueSnapshot(queueCounts());
    try { onQueueSnapshot(snapshot); } catch {}
    const changed = queueSnapshotChanged(snapshot, lastSnapshot);
    lastSnapshot = snapshot;
    if (snapshot.pendingCount > 0) {
      void deliverThenAnnounce(changed ? 'queue-count-changed' : 'ready-check', { announce: changed });
    } else if (changed) {
      emitQueueChanged('queue-count-changed');
    }
    armDueTimer();
  }

  const DUE_TIMER_MIN_MS = 50;
  const DUE_TIMER_MAX_MS = 60_000;

  function clearDueTimer() {
    dueTimerForMs = null;
    if (!dueTimer) return;
    clearTimeout(dueTimer);
    dueTimer = null;
  }

  /**
   * One timer for the earliest future retry time. An armed timer for the same
   * time is kept; any other arm clears the one before. A time further than a
   * minute away is re-read after a minute.
   */
  function armDueTimer() {
    if (stopped) {
      clearDueTimer();
      return;
    }
    // A timer whose time has come fires and re-arms itself: a poll in the
    // same instant (its row no longer "future") must not clear it unfired.
    if (dueTimer && dueTimerForMs !== null && dueTimerForMs <= nowMsSafe()) return;
    let dueAt = null;
    try { dueAt = nextDueAtMs(); } catch { dueAt = null; }
    const dueMs = Number(dueAt);
    if (dueAt === null || dueAt === undefined || !Number.isFinite(dueMs)) {
      clearDueTimer();
      return;
    }
    if (dueTimer && dueTimerForMs === dueMs) return;
    clearDueTimer();
    const untilDueMs = dueMs - nowMsSafe();
    const delayMs = Math.min(DUE_TIMER_MAX_MS, Math.max(DUE_TIMER_MIN_MS, untilDueMs));
    // A time further than the cap: this firing only re-reads.
    const reachesDue = untilDueMs <= DUE_TIMER_MAX_MS;
    dueTimerForMs = dueMs;
    dueTimer = setTimeout(() => {
      dueTimer = null;
      dueTimerForMs = null;
      if (stopped) return;
      if (reachesDue) {
        // Whatever came due may go now; a row that was claimed or cancelled
        // meanwhile makes this a wake with nothing to do.
        try { onDue('retry-due'); } catch {}
      }
      armDueTimer();
    }, delayMs);
    if (typeof dueTimer.unref === 'function') dueTimer.unref();
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

  // null to refuse; else `{ mayBind }` (null: any session).
  function upgradeAuthorization({ token, viaQuery }, identity) {
    if (typeof authorizeUpgrade === 'function') {
      let answer = false;
      try {
        answer = authorizeUpgrade({ token: String(token || ''), sessionId: identity?.sessionId || '' });
      } catch {
        answer = false;
      }
      // true: a credential for any session, the owner token of a worker
      // started before agent tokens. A rotation drops those sockets.
      if (answer === true) return { mayBind: null, ownerToken: true };
      // An agent token is taken from the header only.
      if (viaQuery) return null;
      if (typeof answer !== 'function') return null;
      if (identity?.sessionId && answer(identity.sessionId) !== true) return null;
      return { mayBind: answer };
    }
    const presented = Buffer.from(String(token || ''), 'utf8');
    const expected = Buffer.from(String(authToken || ''), 'utf8');
    const ok = presented.length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected);
    return ok ? { mayBind: null, ownerToken: true } : null;
  }
  const upgradeAuthorizations = new WeakMap();

  function handleUpgrade(req, socket, head) {
    if (!matchesPath(req)) return false;
    const presented = readAuthTokenFromUpgrade(req);
    // The URL keeps no token value past this point (ws, its errors, the
    // connection handler and every log see the redacted one).
    if (TOKEN_QUERY_TEST.test(String(req?.url || ''))) {
      try { req.url = redactTokenQuery(req.url); } catch {}
    }
    const identity = parseUpgradeIdentity(req);
    const authorization = upgradeAuthorization(presented, identity);
    if (presented.viaQuery) {
      const who = `${String(identity.sessionId || 'unknown').slice(0, 8)} pid=${identity.pid || 'unknown'}`;
      logWarn(authorization
        ? `[worker-ws] worker ${who} opened its socket with the owner token in the URL (?token=, ${credentialShape(presented.token)}): a worker started before agent tokens. Transitional, removed in the next version; restarting the worker moves it to its agent token.`
        : `[worker-ws] worker ${who} refused: a ?token= in the URL (${credentialShape(presented.token)}) is taken only as an old worker's owner token. Transitional, removed in the next version.`);
    }
    if (!authorization) {
      rejectUpgrade(socket);
      return true;
    }
    upgradeAuthorizations.set(req, authorization);
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
      mayBind: upgradeAuthorizations.get(req)?.mayBind || null,
      ownerToken: upgradeAuthorizations.get(req)?.ownerToken === true,
      ready: false,
      delivering: false,
      connectedAt: nowIso(),
      lastSeenAtMs: nowMsSafe(),
      lastDeliveredAt: null,
      deliveryFailures: 0,
    });
    if (identity.sessionId) supersedePriorSockets(ws, identity.sessionId);
    noteSocketCount();
    touchCli();
    emitEvent(ws, serverHello('connected', identity.sessionId));

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
        if (!bindSocketIdentity(ws, meta, payload)) return;
        meta.lastSeenAtMs = nowMsSafe();
        noteWorkerKind(meta, payload);
        noteWorkerBuildId(meta, payload);
        // A worker holding deliveries (open question card, compaction) binds
        // its identity with hello but must not be handed work.
        meta.ready = payload.ready !== false;
        meta.lastHelloAt = nowIso();
        noteHeartbeat(meta, 'worker-hello');
        if (meta.sessionId) {
          try {
            onWorkerHello({
              sessionId: meta.sessionId,
              pid: meta.pid || null,
              kind: meta.workerKind || null,
              buildId: meta.workerBuildId || null,
            });
          } catch {}
        }
        emitEvent(ws, serverHello('ack', meta.sessionId));
        void maybeDeliverToSocket(ws, 'worker-hello');
        return;
      }
      if (payload.type === 'worker.ready') {
        if (!bindSocketIdentity(ws, meta, payload)) return;
        meta.lastSeenAtMs = nowMsSafe();
        noteWorkerKind(meta, payload);
        noteWorkerBuildId(meta, payload);
        meta.ready = true;
        meta.lastReadyAt = nowIso();
        const readyReason = String(payload.reason || 'worker-ready');
        noteHeartbeat(meta, readyReason);
        // A keepalive's ready with nothing pending has nothing to draw: one
        // count instead of a dequeue attempt. Any row that appears wakes the
        // queue, and this socket stays ready for it.
        if (readyReason === 'readiness-refresh' && normalizeQueueSnapshot(queueCounts()).pendingCount === 0) return;
        void maybeDeliverToSocket(ws, readyReason);
        return;
      }
      if (payload.type === 'worker.unready') {
        // Readiness is otherwise sticky until the next delivery: a ready sent
        // while the worker could steer would still stand after a hold began,
        // and the delivery it drew would only be handed back.
        if (!bindSocketIdentity(ws, meta, payload)) return;
        meta.lastSeenAtMs = nowMsSafe();
        meta.ready = false;
        meta.lastUnreadyAt = nowIso();
        noteHeartbeat(meta, String(payload.reason || 'worker-unready'));
        return;
      }
      if (payload.type === 'worker.ping') {
        if (!bindSocketIdentity(ws, meta, payload)) return;
        meta.lastSeenAtMs = nowMsSafe();
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
    ws.on('close', () => removeSocket(ws, 'close'));
    ws.on('error', () => removeSocket(ws, 'error'));
  }

  function hasWorkerSocket(sessionId) {
    const wanted = normalizeText(sessionId);
    if (!wanted) return false;
    for (const meta of clientState.values()) {
      if (meta?.sessionId === wanted) return true;
    }
    return false;
  }

  /**
   * Socket-backed liveness for dead-worker recovery. Mere socket retention is
   * not proof of life — a dead worker's socket lingers until its close event
   * lands — so the socket must have been heard from within the liveness
   * window, or its claimed PID must probe alive.
   */
  function hasLiveWorkerSocket(sessionId) {
    const wanted = normalizeText(sessionId);
    if (!wanted) return false;
    const cutoffMs = nowMsSafe() - WORKER_SOCKET_LIVENESS_MAX_SILENCE_MS;
    for (const meta of clientState.values()) {
      if (meta?.sessionId !== wanted) continue;
      if (Number(meta.lastSeenAtMs || 0) >= cutoffMs) return true;
      if (meta.pid && isWorkerProcessAlive(meta.pid) === true) return true;
    }
    return false;
  }

  function start() {
    stopped = false;
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
    armDueTimer();
    logDebug(`[worker-ws] listening on ${wsPath}`);
  }

  function stop() {
    stopped = true;
    clearDueTimer();
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
    noteSocketCount();
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

  /**
   * Fire-and-forget control push to a connected session worker (e.g. "stop
   * background task"). Returns false when the session has no open socket —
   * the caller surfaces that as "worker offline" instead of queueing.
   */
  function sendControlToSession(sessionId, control) {
    const normalized = normalizeText(sessionId);
    if (!normalized) return false;
    for (const socket of clients) {
      const meta = clientState.get(socket);
      if (meta?.sessionId !== normalized) continue;
      if (emitEvent(socket, { type: 'worker.control', control, timestamp: nowIso() })) return true;
    }
    return false;
  }

  /**
   * The owner token was replaced: the sockets that opened with it (workers
   * started before agent tokens) close now, as the old token no longer
   * opens anything. Sockets opened with an agent token stay. The count.
   */
  function dropOwnerTokenSockets() {
    let dropped = 0;
    for (const socket of [...clients]) {
      if (clientState.get(socket)?.ownerToken !== true) continue;
      try { socket.close(4001, 'owner token replaced'); } catch {}
      dropped += 1;
    }
    return dropped;
  }

  return {
    start,
    stop,
    status,
    dropOwnerTokenSockets,
    emitQueueChanged,
    notifyQueueChanged,
    emitDraining,
    handleUpgrade,
    sendControlToSession,
    hasWorkerSocket,
    hasLiveWorkerSocket,
  };
}
