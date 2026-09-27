'use strict';

/**
 * Deferred host suspend: a "💤 Suspend host" request is queued and fulfilled
 * only once nothing is running any more — no queued/processing turn, no live
 * background task, no open CI run of a watched workspace — for a sustained
 * idle window. Idle at request time means a short countdown instead, so the
 * banner still gives the user a moment to cancel.
 *
 * Everything lives in memory: a relay restart drops the request (dispose()
 * reports it so the caller can push a notice). The service is pure
 * orchestration; the activity collector, the suspend command and the timers
 * are injected so the state machine is unit-testable with fake clocks.
 */

export const HOST_SUSPEND_IDLE_WINDOW_MS = 2 * 60 * 1000;
export const HOST_SUSPEND_IDLE_COUNTDOWN_MS = 30 * 1000;
const DEFAULT_POLL_MS = 1000;

export const HOST_SUSPEND_STATUSES = Object.freeze(['idle', 'queued', 'countdown', 'suspending']);

function clampText(value, max, fallback) {
  const text = String(value ?? '').trim().slice(0, max);
  return text || fallback;
}

/**
 * Normalise a blocker so the client can render it without guessing. Blockers
 * with the same `kind` and `detail` are treated as identical when deciding
 * whether the state changed.
 */
export function normalizeHostActivityBlocker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim();
  if (!kind) return null;
  const count = Number(raw.count);
  return {
    kind,
    conversationId: raw.conversationId ? String(raw.conversationId) : null,
    title: raw.title ? String(raw.title).slice(0, 160) : null,
    count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : null,
    detail: String(raw.detail || '').slice(0, 400),
  };
}

export function blockersFromActivity(activity) {
  const list = Array.isArray(activity?.blockers) ? activity.blockers : Array.isArray(activity) ? activity : [];
  return list.map(normalizeHostActivityBlocker).filter(Boolean);
}

export function createHostSuspendService({
  collectActivity,
  runSuspend,
  onStateChange = null,
  onSuspended = null,
  onDropped = null,
  logger = console,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  pollMs = DEFAULT_POLL_MS,
  idleWindowMs = HOST_SUSPEND_IDLE_WINDOW_MS,
  idleCountdownMs = HOST_SUSPEND_IDLE_COUNTDOWN_MS,
} = {}) {
  if (typeof collectActivity !== 'function') throw new Error('collectActivity is required');
  if (typeof runSuspend !== 'function') throw new Error('runSuspend is required');

  let status = 'idle';
  let request = null;
  let blockers = [];
  let idleSince = null;
  let fireAt = null;
  let everBlocked = false;
  let checkedAt = null;
  let lastError = null;
  let pollTimer = null;
  let lastEmittedKey = '';
  let ticking = false;

  function publicState() {
    return {
      status,
      pending: status === 'queued' || status === 'countdown' || status === 'suspending',
      reason: request?.reason || null,
      requestedBy: request?.requestedBy || null,
      requestedAt: request?.requestedAt || null,
      idleSince: idleSince ? new Date(idleSince).toISOString() : null,
      fireAt: fireAt ? new Date(fireAt).toISOString() : null,
      idleWindowMs: everBlocked ? idleWindowMs : idleCountdownMs,
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
      blockers: blockers.map((b) => ({ ...b })),
      lastError,
    };
  }

  function emit(force = false) {
    const state = publicState();
    // Countdowns tick on the client from fireAt; only real transitions go out.
    const key = JSON.stringify([
      state.status,
      state.requestedAt,
      state.fireAt,
      state.blockers.map((b) => `${b.kind}|${b.conversationId}|${b.count}|${b.detail}`),
      state.lastError,
    ]);
    if (!force && key === lastEmittedKey) return;
    lastEmittedKey = key;
    try { onStateChange?.(state); } catch (error) {
      try { logger.warn?.(`[host-suspend] state listener failed: ${error?.message || error}`); } catch {}
    }
  }

  function stopPolling() {
    if (!pollTimer) return;
    try { clearIntervalImpl(pollTimer); } catch {}
    pollTimer = null;
  }

  function resetToIdle() {
    status = 'idle';
    request = null;
    blockers = [];
    idleSince = null;
    fireAt = null;
    everBlocked = false;
    lastError = null;
    stopPolling();
  }

  function collect() {
    try {
      const activity = collectActivity({ request: request ? { ...request } : null });
      lastError = null;
      return blockersFromActivity(activity);
    } catch (error) {
      // An unreadable activity picture must not sleep the box under running
      // agents: report it as a blocker until the collector recovers.
      lastError = String(error?.message || error || 'activity check failed').slice(0, 300);
      return [{
        kind: 'error',
        conversationId: null,
        title: null,
        count: null,
        detail: `Activity check failed: ${lastError}`,
      }];
    }
  }

  function evaluate() {
    if (status !== 'queued' && status !== 'countdown') return;
    const at = now();
    checkedAt = at;
    blockers = collect();
    if (blockers.length) {
      everBlocked = true;
      idleSince = null;
      fireAt = null;
      status = 'queued';
      emit();
      return;
    }
    if (!idleSince) idleSince = at;
    const windowMs = everBlocked ? idleWindowMs : idleCountdownMs;
    fireAt = idleSince + windowMs;
    status = 'countdown';
    if (at >= fireAt) {
      fire();
      return;
    }
    emit();
  }

  function fire() {
    status = 'suspending';
    stopPolling();
    const state = publicState();
    emit(true);
    try { logger.log?.(`[host-suspend] everything idle for ${Math.round((state.idleWindowMs || 0) / 1000)} s; suspending host (requested by ${state.requestedBy || 'unknown'})`); } catch {}
    let result = null;
    try {
      result = runSuspend({ state });
    } catch (error) {
      lastError = String(error?.message || error || 'suspend failed').slice(0, 300);
      try { logger.warn?.(`[host-suspend] suspend command failed: ${lastError}`); } catch {}
    }
    const failed = result && result.ok === false;
    if (failed && !lastError) lastError = String(result.error || 'suspend failed').slice(0, 300);
    const finalError = lastError;
    resetToIdle();
    lastError = finalError;
    emit(true);
    if (!finalError) {
      try { onSuspended?.(state); } catch {}
    }
  }

  function tick() {
    if (ticking) return;
    ticking = true;
    try { evaluate(); } finally { ticking = false; }
  }

  function requestSuspend({ reason = 'manual-suspend', requestedBy = 'localhost-api' } = {}) {
    if (status === 'suspending') return { accepted: false, state: publicState() };
    if (status === 'queued' || status === 'countdown') {
      return { accepted: false, alreadyPending: true, state: publicState() };
    }
    request = {
      reason: clampText(reason, 140, 'manual-suspend'),
      requestedBy: clampText(requestedBy, 80, 'localhost-api'),
      requestedAt: new Date(now()).toISOString(),
    };
    everBlocked = false;
    idleSince = null;
    fireAt = null;
    lastError = null;
    status = 'queued';
    evaluate();
    if (status === 'queued' || status === 'countdown') {
      pollTimer = setIntervalImpl(tick, pollMs);
      pollTimer?.unref?.();
    }
    return { accepted: true, state: publicState() };
  }

  function cancel({ requestedBy = 'localhost-api' } = {}) {
    if (status !== 'queued' && status !== 'countdown') {
      return { cancelled: false, state: publicState() };
    }
    try { logger.log?.(`[host-suspend] queued suspend cancelled by ${clampText(requestedBy, 80, 'unknown')}`); } catch {}
    resetToIdle();
    emit(true);
    return { cancelled: true, state: publicState() };
  }

  function dispose({ reason = 'shutdown' } = {}) {
    const wasPending = status === 'queued' || status === 'countdown';
    const state = publicState();
    resetToIdle();
    if (wasPending) {
      try { logger.log?.(`[host-suspend] queued suspend dropped (${reason})`); } catch {}
      try { onDropped?.(state, reason); } catch {}
    }
  }

  return {
    request: requestSuspend,
    cancel,
    getState: publicState,
    /** Re-run the activity check now (used by the status/GET routes). */
    refresh() { if (status === 'queued' || status === 'countdown') tick(); return publicState(); },
    dispose,
  };
}
