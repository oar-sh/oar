import { normalizeWorkspaceRootKey } from './workspace-root-path-policy.mjs';

// ---------------------------------------------------------------------------
// Workspace-root relaunch policy
//
// Pure, express-free helpers behind POST /api/conversation/:id/relaunch-with-workspace-root.
// Kept separate from the route so the concurrency and reporting rules can be
// tested without an HTTP server.
// ---------------------------------------------------------------------------

// Mirrors DUPLICATE_USER_MESSAGE_WINDOW_MS in routes/messages-routes.mjs: a
// repeated request inside this window is treated as the same user intent.
export const RELAUNCH_COALESCE_WINDOW_MS = 5_000;

/**
 * Decide whether a relaunch may proceed and whether the running CLI must be stopped first.
 *
 * `workerPidAlive` / `liveProcessDetected` matter because a session whose status
 * is anything but 'ready' (e.g. 'error', or missing from the registry entirely)
 * can still have a live process. Without them the route would skip the stop and
 * the launch would silently reuse that process — in the *old* directory.
 *
 * The return shape is deliberately just { ok, stopWorker }.
 */
export function evaluateWorkspaceRootRelaunch({
  workerStatus = '',
  activeQueueCount = 0,
  workerPidAlive = false,
  liveProcessDetected = false,
} = {}) {
  const normalizedStatus = String(workerStatus || '').trim().toLowerCase();
  if (Number(activeQueueCount) > 0 || normalizedStatus === 'processing' || normalizedStatus === 'starting') {
    return {
      ok: false,
      statusCode: 409,
      error: 'Wait for the active turn to finish before changing CWD.',
    };
  }
  return {
    ok: true,
    stopWorker: normalizedStatus === 'ready' || workerPidAlive === true || liveProcessDetected === true,
  };
}

/**
 * Identity of a relaunch request. Two requests with the same key are the same
 * user intent and may share one result; two with different keys must not.
 */
export function buildRelaunchRequestKey({
  conversationId = '',
  rootPath = '',
  idempotencyKey = '',
  platform = process.platform,
} = {}) {
  const explicit = String(idempotencyKey || '').trim();
  if (explicit) return `idem:${explicit}`;
  const conv = String(conversationId || '').trim();
  return `${conv}|${normalizeWorkspaceRootKey(rootPath, platform)}`;
}

/**
 * Per-session request coalescer.
 *
 * - same key, in flight   -> await and return the same body
 * - same key, just settled -> replay the cached body
 * - different key, in flight -> busy
 */
export function createRelaunchCoalescer({
  nowMs = Date.now,
  windowMs = RELAUNCH_COALESCE_WINDOW_MS,
} = {}) {
  /** @type {Map<string, { key: string, promise: Promise<unknown>|null, result: unknown, settledAtMs: number }>} */
  const bySession = new Map();

  function prune(reference = nowMs()) {
    for (const [sessionId, entry] of bySession) {
      if (entry.promise) continue;
      if (reference - entry.settledAtMs > windowMs) bySession.delete(sessionId);
    }
  }

  function peek(sessionId, key) {
    prune();
    const entry = bySession.get(String(sessionId || ''));
    if (!entry) return { state: 'idle' };
    if (entry.key !== key) {
      return entry.promise ? { state: 'busy' } : { state: 'idle' };
    }
    if (entry.promise) return { state: 'in-flight', promise: entry.promise };
    if (nowMs() - entry.settledAtMs <= windowMs) return { state: 'cached', result: entry.result };
    return { state: 'idle' };
  }

  function begin(sessionId, key) {
    const sid = String(sessionId || '');
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    bySession.set(sid, { key, promise, result: undefined, settledAtMs: 0 });
    return { settle };
  }

  function settle(sessionId, key, result) {
    const sid = String(sessionId || '');
    const entry = bySession.get(sid);
    if (!entry || entry.key !== key) return;
    entry.promise = null;
    entry.result = result;
    entry.settledAtMs = nowMs();
  }

  function forget(sessionId) {
    bySession.delete(String(sessionId || ''));
  }

  return { peek, begin, settle, forget, prune, size: () => bySession.size };
}

/**
 * Did a relaunch actually apply the requested directory?
 * `comparable` is false when the running CLI's directory is unknown, in which
 * case the caller must not claim success either way.
 */
export function evaluateReuseCwdMismatch({
  requestedRootPath = '',
  observedRootPath = '',
  platform = process.platform,
} = {}) {
  const requested = normalizeWorkspaceRootKey(requestedRootPath, platform);
  const observed = normalizeWorkspaceRootKey(observedRootPath, platform);
  if (!requested || !observed) return { comparable: false, mismatch: false };
  return { comparable: true, mismatch: requested !== observed };
}
