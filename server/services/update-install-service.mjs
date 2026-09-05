'use strict';

import { spawn as defaultSpawn } from 'child_process';

import {
  CLI_SPAWN_DISABLED_ERROR,
  MAX_CAPTURED_OUTPUT_CHARS,
  killTree,
  runToCompletion,
  stripTerminalEscapes,
  tailOf,
} from './cli-process-runner.mjs';
import { compareSemverIsh, parseSemverIsh } from '../../shared/update-semver.mjs';

// Applies an OAR self-update: `npm i -g @oar-sh/oar@<version>` with the log
// streamed to the UI (same snapshot/logSeq idiom as cli-install-service, which
// stays untouched — its descriptor table is provider CLIs only), then the
// existing queue-idle relay restart. The attempt is persisted BEFORE the
// restart so the next boot can prove the version actually changed; an
// unchanged version surfaces the npm log as a failure instead of false
// success.

export const UPDATE_PACKAGE_NAME = '@oar-sh/oar';
export const UPDATE_ATTEMPT_SETTING_KEY = 'update_attempt';
export const UPDATE_OUTCOME_SETTING_KEY = 'update_last_outcome';
export const UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000;
const LOG_FLUSH_MS = 250;
const ATTEMPT_LOG_TAIL_CHARS = 4_000;

export const UPDATE_INSTALL_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  ERROR: 'error',
});

/**
 * Boot-time reconciliation of a persisted update attempt. Pure; called before
 * any service exists so even a crash loop settles the outcome exactly once.
 */
/**
 * Version equality on parsed triples so a `v`-prefixed manifest version still
 * matches the package.json it installed; raw equality only when parsing fails
 * (compareSemverIsh treats unparseable input as equal, which must not read as
 * a successful update).
 */
function sameVersion(a, b) {
  if (parseSemverIsh(a) && parseSemverIsh(b)) return compareSemverIsh(a, b) === 0;
  return String(a) === String(b);
}

export function reconcileUpdateAttempt({
  readSetting,
  writeSetting,
  deleteSetting,
  runningVersion,
  nowMs = Date.now(),
  // Generous on purpose: the restart is queue-idle-deferred and can sit for
  // hours, and a swallowed failure outcome is worse than a late one.
  maxAgeMs = 7 * 24 * 3_600_000,
} = {}) {
  let attempt = null;
  try {
    attempt = JSON.parse(String(readSetting(UPDATE_ATTEMPT_SETTING_KEY) || ''));
  } catch {
    attempt = null;
  }
  if (!attempt || typeof attempt !== 'object') return null;
  deleteSetting(UPDATE_ATTEMPT_SETTING_KEY);

  const attempted = String(attempt.attemptedVersion || '');
  const startedAtMs = Date.parse(String(attempt.startedAt || '')) || 0;
  if (attempted && sameVersion(attempted, runningVersion)) {
    const outcome = { status: 'success', version: attempted, at: new Date(nowMs).toISOString() };
    writeSetting(UPDATE_OUTCOME_SETTING_KEY, JSON.stringify(outcome));
    return outcome;
  }
  if (!startedAtMs || nowMs - startedAtMs > maxAgeMs) return null; // stale leftovers: drop quietly
  const outcome = {
    status: 'failure',
    attemptedVersion: attempted,
    fromVersion: String(attempt.fromVersion || ''),
    logTail: String(attempt.logTail || ''),
    at: new Date(nowMs).toISOString(),
  };
  writeSetting(UPDATE_OUTCOME_SETTING_KEY, JSON.stringify(outcome));
  return outcome;
}

export function readUpdateOutcome(readSetting) {
  try {
    const parsed = JSON.parse(String(readSetting(UPDATE_OUTCOME_SETTING_KEY) || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createUpdateInstallService({
  runningVersion,
  installMethod = 'npm-global',
  spawnImpl = defaultSpawn,
  env = process.env,
  platform = process.platform,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
  readSetting,
  writeSetting,
  deleteSetting,
  requestRelayShutdown,
  logger = console,
} = {}) {
  const listeners = new Set();
  let state = UPDATE_INSTALL_STATES.IDLE;
  let targetVersion = null;
  let log = '';
  let logSeq = 0;
  let startedAt = null;
  let finishedAt = null;
  let lastError = null;
  let flushTimer = null;
  let pendingLog = '';
  let activeChild = null;

  function getSnapshot() {
    return {
      state,
      targetVersion,
      log,
      logSeq,
      startedAt,
      finishedAt,
      error: lastError,
      active: state === UPDATE_INSTALL_STATES.RUNNING,
      lastOutcome: readUpdateOutcome(readSetting),
    };
  }

  function broadcast() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try { listener(snapshot); } catch {}
    }
  }

  function appendLog(chunk) {
    pendingLog += chunk;
    if (flushTimer) return;
    flushTimer = setTimeoutImpl(() => {
      flushTimer = null;
      if (!pendingLog) return;
      log = stripTerminalEscapes(`${log}${pendingLog}`).slice(-MAX_CAPTURED_OUTPUT_CHARS);
      pendingLog = '';
      logSeq += 1;
      broadcast();
    }, LOG_FLUSH_MS);
    flushTimer?.unref?.();
  }

  function flushLogNow() {
    if (flushTimer) {
      clearTimeoutImpl(flushTimer);
      flushTimer = null;
    }
    if (pendingLog) {
      log = stripTerminalEscapes(`${log}${pendingLog}`).slice(-MAX_CAPTURED_OUTPUT_CHARS);
      pendingLog = '';
      logSeq += 1;
    }
  }

  async function startUpdate({ version } = {}) {
    if (state === UPDATE_INSTALL_STATES.RUNNING) {
      return { ok: false, statusCode: 409, error: 'An update is already running' };
    }
    const target = String(version || '').trim();
    if (!parseSemverIsh(target)) {
      return { ok: false, statusCode: 400, error: 'version must be a release version like 0.9.2' };
    }
    if (installMethod !== 'npm-global') {
      return { ok: false, statusCode: 400, error: 'This relay runs from a git checkout — pull to update' };
    }
    if (String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '') === '1') {
      return { ok: false, statusCode: 503, error: CLI_SPAWN_DISABLED_ERROR };
    }

    state = UPDATE_INSTALL_STATES.RUNNING;
    targetVersion = target;
    log = '';
    // A timed-out child from a previous run can still be emitting: drop any
    // buffered chunks and the armed flush so they can't bleed into this log.
    pendingLog = '';
    if (flushTimer) {
      clearTimeoutImpl(flushTimer);
      flushTimer = null;
    }
    logSeq += 1;
    startedAt = new Date(nowImpl()).toISOString();
    finishedAt = null;
    lastError = null;
    deleteSetting(UPDATE_OUTCOME_SETTING_KEY);
    broadcast();

    // npm itself is a shim on Windows; spawn npm.cmd through a shell there
    // (args are fixed strings + a validated semver, so no injection surface).
    const command = platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['install', '-g', `${UPDATE_PACKAGE_NAME}@${target}`];
    const result = await runToCompletion(
      () => spawnImpl(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env },
        ...(platform === 'win32' ? { windowsHide: true, shell: true } : { detached: true }),
      }),
      {
        timeoutMs: UPDATE_INSTALL_TIMEOUT_MS,
        setTimeoutImpl,
        clearTimeoutImpl,
        killChild: (child, signal) => killTree(child, signal, { platform }),
        onChild: (child) => { activeChild = child; },
        onOutput: (text) => appendLog(text),
      },
    );
    activeChild = null;
    flushLogNow();
    finishedAt = new Date(nowImpl()).toISOString();

    if (!result.ok) {
      state = UPDATE_INSTALL_STATES.ERROR;
      lastError = result.error || `npm exited with code ${result.code}`;
      broadcast();
      return { ok: false, statusCode: 500, error: lastError };
    }

    // Persist the attempt BEFORE the restart request: the next boot compares
    // the running version against it and turns "nothing changed" into a
    // visible failure carrying this log tail.
    writeSetting(UPDATE_ATTEMPT_SETTING_KEY, JSON.stringify({
      attemptedVersion: target,
      fromVersion: String(runningVersion),
      startedAt,
      logTail: tailOf(log, ATTEMPT_LOG_TAIL_CHARS),
    }));
    state = UPDATE_INSTALL_STATES.SUCCESS;
    broadcast();
    try {
      requestRelayShutdown({ reason: 'self-update', requestedBy: 'update-install-service', restart: true });
    } catch (error) {
      logger.warn?.(`update install: restart request failed: ${error?.message || error}`);
    }
    return { ok: true, targetVersion: target };
  }

  function cancel() {
    if (state === UPDATE_INSTALL_STATES.RUNNING && activeChild) {
      try { killTree(activeChild, 'SIGTERM', { platform }); } catch {}
      return { ok: true, cancelling: true };
    }
    // Terminal states reset to idle, mirroring cli-install-service's cancel.
    state = UPDATE_INSTALL_STATES.IDLE;
    targetVersion = null;
    lastError = null;
    broadcast();
    return { ok: true };
  }

  function clearOutcome() {
    deleteSetting(UPDATE_OUTCOME_SETTING_KEY);
    broadcast();
    return { ok: true };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { startUpdate, cancel, clearOutcome, getSnapshot, subscribe };
}
