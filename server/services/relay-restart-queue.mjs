'use strict';

/**
 * A queued relay restart (or shutdown), as every device sees it: what it
 * waits for, how long it has waited, and the question it asks once it has
 * waited too long.
 *
 * The request waits until no turn is processing (relay-shutdown-gate.mjs);
 * while it waits, no pending row is handed to a worker. A turn that runs for
 * hours would hold every session's new messages for hours, so the wait has a
 * maximum (Settings › General). Past it the relay does not force anything:
 * the request stays queued and turns into a question — restart now, keep
 * waiting another period, or cancel — that the banner shows and a push
 * notification announces once. Only the user, or an API caller that says
 * `immediate`, restarts with turns running.
 *
 * Memory only, like the request itself. The service is pure orchestration:
 * the queue counts, the picture of what runs, the shutdown itself and the
 * timers are injected, so the state machine is unit-testable with fake
 * clocks.
 */

import { queuedShutdownCanProceed } from './relay-shutdown-gate.mjs';

export const RELAY_RESTART_MAX_WAIT_SETTING_KEY = 'relay_restart_max_wait_minutes';
// 0 is "no limit": the queued restart waits, and holds new turns, until the
// running turns end or someone decides.
export const RELAY_RESTART_MAX_WAIT_CHOICES = Object.freeze([5, 10, 15, 30, 60, 120, 240, 0]);
export const DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES = 30;
const DEFAULT_POLL_MS = 1000;

function asMaxWaitChoice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return null;
  return RELAY_RESTART_MAX_WAIT_CHOICES.includes(numeric) ? numeric : null;
}

/** An unset or unreadable setting means the default, not "no limit". */
export function readRelayRestartMaxWaitSetting(storedValue) {
  const minutes = asMaxWaitChoice(storedValue);
  return minutes === null ? DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES : minutes;
}

export function parseRelayRestartMaxWaitUpdate(value) {
  const minutes = asMaxWaitChoice(value);
  if (minutes === null) {
    return { ok: false, error: `maxWaitMinutes must be one of ${RELAY_RESTART_MAX_WAIT_CHOICES.join(', ')} (0 = no limit)` };
  }
  return { ok: true, minutes };
}

/**
 * A test relay's override of the setting, in milliseconds
 * (OAR_RELAY_RESTART_MAX_WAIT_MS): null when unset or unreadable. Lets an
 * end-to-end run reach the question in seconds.
 */
export function resolveRelayRestartMaxWaitOverrideMs(env = process.env) {
  const text = String(env?.OAR_RELAY_RESTART_MAX_WAIT_MS ?? '').trim();
  if (!text) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.min(Math.round(numeric), 24 * 60 * 60 * 1000);
}

function clampText(value, max, fallback) {
  const text = String(value ?? '').trim().slice(0, max);
  return text || fallback;
}

export function normalizeRestartRequestFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const EMPTY_PICTURE = Object.freeze({
  waitingFor: [],
  held: { count: 0, conversations: [] },
  backgroundTasks: [],
  survival: null,
});

export function createRelayRestartQueue({
  // () => { pendingCount, processingCount, parkedCount }
  getCounts,
  // ({ action }) => { waitingFor, held, backgroundTasks, survival }; see
  // relay-restart-picture.mjs. Optional: without it the state names nothing.
  collectPicture = null,
  // ({ action, reason, requestedBy, immediate, counts }) => void: exits the
  // runtime. Called at most once per request.
  startShutdown,
  // () => the maximum wait in ms, 0 for no limit.
  getMaxWaitMs = () => DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES * 60_000,
  isShuttingDown = () => false,
  onStateChange = null,
  // (state) => void, once per waiting period that ran out.
  onMaxWaitReached = null,
  logger = console,
  logPrefix = () => '',
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  if (typeof getCounts !== 'function') throw new Error('getCounts is required');
  if (typeof startShutdown !== 'function') throw new Error('startShutdown is required');

  let request = null;
  let pollTimer = null;
  let picture = EMPTY_PICTURE;
  let lastEmittedKey = '';

  function log(line) {
    try { logger.log?.(`${logPrefix()}${line}`); } catch {}
  }

  function maxWaitMs() {
    let value = 0;
    try { value = Number(getMaxWaitMs()); } catch {}
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  function counts() {
    try { return getCounts() || {}; } catch { return {}; }
  }

  function readPicture(action) {
    if (typeof collectPicture !== 'function') return EMPTY_PICTURE;
    try {
      const next = collectPicture({ action }) || {};
      return {
        waitingFor: Array.isArray(next.waitingFor) ? next.waitingFor : [],
        held: next.held && typeof next.held === 'object' ? next.held : { count: 0, conversations: [] },
        backgroundTasks: Array.isArray(next.backgroundTasks) ? next.backgroundTasks : [],
        survival: next.survival || null,
      };
    } catch (error) {
      log(`Relay restart: could not read what runs (${error?.message || error})`);
      return EMPTY_PICTURE;
    }
  }

  function deadlineAt() {
    if (!request) return null;
    const limit = maxWaitMs();
    return limit > 0 ? request.periodStartedAt + limit : null;
  }

  function publicState() {
    const shuttingDown = isShuttingDown() === true;
    const queue = counts();
    if (!request) {
      return {
        status: shuttingDown ? 'shutting_down' : 'idle',
        action: shuttingDown ? 'shutdown' : null,
        restart: false,
        reason: null,
        requestedBy: null,
        requestedAt: null,
        queue,
        maxWaitMs: maxWaitMs(),
      };
    }
    const deadline = deadlineAt();
    return {
      status: shuttingDown ? 'shutting_down' : 'queued',
      action: request.action,
      restart: request.action === 'restart',
      reason: request.reason,
      requestedBy: request.requestedBy,
      requestedAt: iso(request.requestedAt),
      queue,
      // While queued, no pending row goes to a worker (relay-shutdown-gate.mjs).
      holdsNewTurns: true,
      maxWaitMs: maxWaitMs(),
      waitingSince: iso(request.periodStartedAt),
      deadlineAt: iso(deadline),
      // Set once the maximum wait ran out: the relay asks, it does not act.
      question: request.askedAt ? { askedAt: iso(request.askedAt) } : null,
      keptWaiting: request.keptWaiting,
      waitingFor: picture.waitingFor,
      held: picture.held,
      backgroundTasks: picture.backgroundTasks,
      survival: picture.survival,
    };
  }

  function emit(force = false) {
    const state = publicState();
    // The waited time ticks on the client; only real changes go out.
    const key = JSON.stringify([
      state.status, state.action, state.requestedAt, state.waitingSince, state.deadlineAt, state.question,
      // Not the raw queue counts: each new held message would rebuild every
      // banner; `held` carries the count.
      state.waitingFor, state.held, state.backgroundTasks, state.survival,
    ]);
    if (!force && key === lastEmittedKey) return;
    lastEmittedKey = key;
    try { onStateChange?.(state); } catch (error) {
      log(`Relay restart: state listener failed (${error?.message || error})`);
    }
  }

  function stopPolling() {
    if (!pollTimer) return;
    try { clearIntervalImpl(pollTimer); } catch {}
    pollTimer = null;
  }

  function fire({ immediate = false, by = null } = {}) {
    const info = request;
    const queue = counts();
    request = null;
    picture = EMPTY_PICTURE;
    stopPolling();
    const action = info?.action === 'restart' ? 'restart' : 'shutdown';
    const running = Number(queue.processingCount || 0);
    if (immediate && running > 0) {
      log(`Relay ${action} now, requested by ${by || info?.requestedBy || 'unknown'}: not waiting for ${running} running turn${running === 1 ? '' : 's'} (reason=${info?.reason || 'manual-request'})`);
    } else {
      log(
        `Relay ${action} request accepted by ${info?.requestedBy || 'unknown'}`
        + `; no turn is processing (${queue.pendingCount || 0} pending, ${queue.parkedCount || 0} parked wait), exiting now (reason=${info?.reason || 'manual-request'})`,
      );
    }
    try {
      startShutdown({ action, reason: info?.reason || 'manual-request', requestedBy: info?.requestedBy || 'unknown', immediate, counts: queue });
    } catch (error) {
      log(`Relay ${action} failed to start: ${error?.message || error}`);
    }
    emit(true);
  }

  function evaluate() {
    if (!request || isShuttingDown()) return;
    const queue = counts();
    // Only the processing turns hold it; pending and parked rows wait it out.
    if (queuedShutdownCanProceed(queue)) {
      fire();
      return;
    }
    picture = readPicture(request.action);
    const deadline = deadlineAt();
    // A raised maximum (or none) moved the deadline into the future: the
    // question no longer stands.
    if (request.askedAt && (deadline === null || now() < deadline)) request.askedAt = null;
    if (deadline !== null && !request.askedAt && now() >= deadline) {
      request.askedAt = now();
      const waitedMin = Math.round((now() - request.periodStartedAt) / 60_000);
      log(`Relay ${request.action} has waited ${waitedMin} min for ${queue.processingCount} running turn${Number(queue.processingCount) === 1 ? '' : 's'}; asking instead of restarting`);
      emit();
      try { onMaxWaitReached?.(publicState()); } catch {}
      return;
    }
    emit();
  }

  function ensurePolling() {
    if (pollTimer || !request) return;
    pollTimer = setIntervalImpl(() => evaluate(), pollMs);
    pollTimer?.unref?.();
  }

  /**
   * Queue a restart or shutdown, or with `immediate` start it at once,
   * running turns or not. A restart asked for while a shutdown waits turns
   * it into a restart.
   */
  function requestShutdown({ reason = 'manual-request', requestedBy = 'localhost-api', restart = false, immediate = false, expectRequestedAt = null } = {}) {
    const safeReason = clampText(reason, 140, 'manual-request');
    const safeRequestedBy = clampText(requestedBy, 80, 'localhost-api');
    const restartRequested = normalizeRestartRequestFlag(restart);
    const immediateRequested = normalizeRestartRequestFlag(immediate);
    const requestedAction = restartRequested ? 'restart' : 'shutdown';
    if (isShuttingDown()) {
      return {
        accepted: false,
        status: 'shutting_down',
        action: requestedAction,
        restart: restartRequested,
        reason: safeReason,
      };
    }
    // "Restart now" from a banner or dialog names the request it saw: one
    // that is gone (it fired, was cancelled, or the relay restarted since)
    // is not a reason to restart now.
    const expected = String(expectRequestedAt ?? '').trim();
    if (immediateRequested && expected && (!request || iso(request.requestedAt) !== expected)) {
      return { accepted: false, stale: true, ...publicState() };
    }
    const at = now();
    if (!request) {
      request = {
        action: requestedAction,
        reason: safeReason,
        requestedBy: safeRequestedBy,
        requestedAt: at,
        periodStartedAt: at,
        askedAt: null,
        keptWaiting: 0,
      };
    } else if (restartRequested && request.action !== 'restart') {
      request = { ...request, action: 'restart', reason: safeReason, requestedBy: safeRequestedBy };
    }
    // What it waits for and what it holds, read before a shutdown that
    // starts now clears it: the caller's answer names both.
    picture = readPicture(request.action);
    const answer = {
      accepted: true,
      status: 'queued',
      action: request.action,
      restart: request.action === 'restart',
      requestedAt: iso(request.requestedAt),
      reason: request.reason,
      requestedBy: request.requestedBy,
      immediate: immediateRequested,
      maxWaitMs: maxWaitMs(),
      deadlineAt: iso(deadlineAt()),
      waitingFor: picture.waitingFor,
      held: picture.held,
      backgroundTasks: picture.backgroundTasks,
      survival: picture.survival,
    };
    if (immediateRequested) {
      fire({ immediate: true, by: safeRequestedBy });
      return { ...answer, status: 'shutting_down', queue: counts() };
    }
    evaluate();
    if (request) {
      ensurePolling();
      emit(true);
    } else {
      answer.status = 'shutting_down';
    }
    return { ...answer, queue: counts() };
  }

  function cancel({ requestedBy = 'localhost-api' } = {}) {
    if (isShuttingDown()) return { cancelled: false, ...publicState(), status: 'shutting_down' };
    if (!request) return { cancelled: false, ...publicState() };
    const dropped = { action: request.action, reason: request.reason, requestedBy: request.requestedBy, requestedAt: iso(request.requestedAt) };
    request = null;
    picture = EMPTY_PICTURE;
    stopPolling();
    log(`Relay ${dropped.action} request cancelled by ${clampText(requestedBy, 80, 'localhost-api')}`);
    emit(true);
    return { cancelled: true, dropped, ...publicState() };
  }

  /** Answer to the question: wait another full period, counted from now. */
  function keepWaiting({ requestedBy = 'localhost-api' } = {}) {
    // Only an answer to the question: without one there is nothing to extend.
    if (isShuttingDown() || !request || !request.askedAt) return { extended: false, ...publicState() };
    request.periodStartedAt = now();
    request.askedAt = null;
    request.keptWaiting += 1;
    log(`Relay ${request.action} keeps waiting another ${Math.round(maxWaitMs() / 60_000)} min (by ${clampText(requestedBy, 80, 'localhost-api')})`);
    evaluate();
    emit(true);
    return { extended: true, ...publicState() };
  }

  return {
    request: requestShutdown,
    cancel,
    keepWaiting,
    getState: publicState,
    isQueued: () => !!request && !isShuttingDown(),
    /** Re-check now (the setting changed): may fire or ask. Readers use getState. */
    refresh() { evaluate(); return publicState(); },
    dispose() { stopPolling(); },
  };
}
