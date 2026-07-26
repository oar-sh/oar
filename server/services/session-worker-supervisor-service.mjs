'use strict';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

const ACTIVE_WORKER_STATUSES = new Set(['ready', 'processing', 'starting']);

function hasWorkerIdentity(worker) {
  if (!worker || typeof worker !== 'object') return false;
  const workerId = String(worker.workerId || '').trim();
  const pid = Number(worker.pid);
  return workerId.length > 0 || (Number.isInteger(pid) && pid > 0);
}

function toSafeNowMs(nowFn) {
  const value = Number(nowFn());
  return Number.isFinite(value) ? value : Date.now();
}

function clampInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function defaultIsPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase();
    if (code === 'EPERM') return true;
    return false;
  }
}

function normalizePendingQuestionSessionIds(value) {
  if (!value) return new Set();
  if (value instanceof Set) {
    return new Set(Array.from(value)
      .map((sid) => normalizeSessionId(sid))
      .filter(Boolean));
  }
  if (!Array.isArray(value)) return new Set();
  return new Set(value
    .map((sid) => normalizeSessionId(sid))
    .filter(Boolean));
}

function hasStartupFailureReason(lifecycle) {
  const reason = String(lifecycle?.degradedReason || '').trim().toLowerCase();
  return reason === 'startup-heartbeat-timeout' || reason === 'stale-pid';
}

export function createSessionWorkerSupervisor({
  registry,
  spawnWorker = null,
  now = () => Date.now(),
  maxRestartRetries = 5,
  restartBackoffBaseMs = 1_000,
  restartBackoffMaxMs = 30_000,
  idleEvictionMs = 0,
  heartbeatTimeoutMs = 30_000,
  degradedRecoveryGraceMs = 10_000,
  killBlockGraceMs = 30_000,
  isPidAlive = defaultIsPidAlive,
  diagnosticPlanReference = null,
  log = null,
} = {}) {
  if (!registry) {
    throw new Error('createSessionWorkerSupervisor requires registry');
  }

  const pendingStarts = new Map();
  const lifecycleBySession = new Map();
  const retryLimit = Math.max(0, clampInt(maxRestartRetries, 5));
  const backoffBaseMs = Math.max(1, clampInt(restartBackoffBaseMs, 1_000));
  const backoffMaxMs = Math.max(backoffBaseMs, clampInt(restartBackoffMaxMs, 30_000));
  const idleTimeoutMs = clampInt(idleEvictionMs, 0);
  const heartbeatStaleAfterMs = Math.max(1_000, clampInt(heartbeatTimeoutMs, 30_000));
  const recoveryGraceMs = Math.max(0, clampInt(degradedRecoveryGraceMs, 10_000));
  const killGraceMs = Math.max(0, clampInt(killBlockGraceMs, 30_000));
  function resolvePlanReference() {
    const value = typeof diagnosticPlanReference === 'function'
      ? diagnosticPlanReference()
      : diagnosticPlanReference;
    return normalizeSessionId(value);
  }

  function emitMonitorLog(message) {
    if (typeof log === 'function') {
      log(message);
    }
  }

  function nowMs() {
    return toSafeNowMs(now);
  }

  function nowIso() {
    return new Date(nowMs()).toISOString();
  }

  function computeBackoffMs(retryCount) {
    const count = Math.max(1, clampInt(retryCount, 1));
    const exponent = Math.max(0, count - 1);
    return Math.min(backoffMaxMs, backoffBaseMs * (2 ** exponent));
  }

  function getOrCreateLifecycle(sessionId) {
    const existing = lifecycleBySession.get(sessionId);
    if (existing) return existing;
    const seed = registry.getWorker(sessionId);
    const nowAtMs = nowMs();
    const state = {
      retryCount: Math.max(0, clampInt(seed?.retryCount, 0)),
      backoffMs: 0,
      nextRestartAtMs: null,
      restartExhausted: false,
      lastError: null,
      lastFailureAtMs: null,
      lastActivityAtMs: nowAtMs,
      uiState: 'white',
      degradedReason: null,
      degradedAtMs: null,
      lastHeartbeatAtMs: null,
      failureCount: 0,
      stalePidDetected: false,
      recoveryCandidateAtMs: null,
      questionPending: false,
      launchMode: null,
      launchPid: null,
      launchAtMs: null,
      awaitingHeartbeat: false,
      firstObservedHeartbeatAtMs: null,
      monitorLoggedAtMs: null,
      killedAtMs: null,
    };
    lifecycleBySession.set(sessionId, state);
    return state;
  }

  function setLifecycle(sessionId, patch = {}) {
    const current = getOrCreateLifecycle(sessionId);
    const next = { ...current, ...patch };
    lifecycleBySession.set(sessionId, next);
    return next;
  }

  function toLifecycleSnapshot(sessionId, state = null) {
    const lifecycle = state || lifecycleBySession.get(sessionId) || null;
    if (!lifecycle) return null;
    return {
      retryCount: clampInt(lifecycle.retryCount, 0),
      backoffMs: clampInt(lifecycle.backoffMs, 0),
      nextRestartAt: lifecycle.nextRestartAtMs ? new Date(lifecycle.nextRestartAtMs).toISOString() : null,
      restartExhausted: Boolean(lifecycle.restartExhausted),
      lastError: lifecycle.lastError || null,
      lastFailureAt: lifecycle.lastFailureAtMs ? new Date(lifecycle.lastFailureAtMs).toISOString() : null,
      lastActivityAt: lifecycle.lastActivityAtMs ? new Date(lifecycle.lastActivityAtMs).toISOString() : null,
      uiState: String(lifecycle.uiState || 'white'),
      degradedReason: lifecycle.degradedReason || null,
      lastHeartbeatAt: lifecycle.lastHeartbeatAtMs ? new Date(lifecycle.lastHeartbeatAtMs).toISOString() : null,
      failureCount: clampInt(lifecycle.failureCount, 0),
      stalePidDetected: Boolean(lifecycle.stalePidDetected),
      questionPending: Boolean(lifecycle.questionPending),
      launchMode: lifecycle.launchMode || null,
      launchPid: Number.isInteger(Number(lifecycle.launchPid)) ? Number(lifecycle.launchPid) : null,
      launchAt: lifecycle.launchAtMs ? new Date(lifecycle.launchAtMs).toISOString() : null,
      awaitingHeartbeat: Boolean(lifecycle.awaitingHeartbeat),
      firstObservedHeartbeatAt: lifecycle.firstObservedHeartbeatAtMs ? new Date(lifecycle.firstObservedHeartbeatAtMs).toISOString() : null,
      readyWithoutHeartbeatMs: lifecycle.awaitingHeartbeat && lifecycle.launchAtMs
        ? Math.max(0, nowMs() - lifecycle.launchAtMs)
        : 0,
      diagnosticPlanReference: resolvePlanReference() || null,
      killedAt: lifecycle.killedAtMs ? new Date(lifecycle.killedAtMs).toISOString() : null,
    };
  }

  function touchActivity(sessionId, atMs = nowMs()) {
    return setLifecycle(sessionId, { lastActivityAtMs: atMs });
  }

  function noteHeartbeat(sessionId, atMs = nowMs()) {
    const lifecycle = getOrCreateLifecycle(sessionId);
    const patch = {
      lastHeartbeatAtMs: atMs,
      lastActivityAtMs: atMs,
    };
    if (lifecycle.awaitingHeartbeat) {
      patch.awaitingHeartbeat = false;
      patch.firstObservedHeartbeatAtMs = lifecycle.firstObservedHeartbeatAtMs || atMs;
      patch.monitorLoggedAtMs = null;
    }
    return setLifecycle(sessionId, patch);
  }

  function noteLaunch(sessionId, { mode = null, pid = null, atMs = nowMs() } = {}) {
    return setLifecycle(sessionId, {
      launchMode: String(mode || '').trim() || null,
      launchPid: Number.isInteger(Number(pid)) ? Number(pid) : null,
      launchAtMs: atMs,
      awaitingHeartbeat: true,
      firstObservedHeartbeatAtMs: null,
      monitorLoggedAtMs: null,
      uiState: 'white',
      degradedReason: null,
      degradedAtMs: null,
      stalePidDetected: false,
      recoveryCandidateAtMs: null,
    });
  }

  function maybeLogStartupIssue(sessionId, reason, worker, nowAtMs) {
    const lifecycle = getOrCreateLifecycle(sessionId);
    if (lifecycle.monitorLoggedAtMs) return;
    const pid = Number.isInteger(Number(worker?.pid)) ? Number(worker.pid) : null;
    const readyWithoutHeartbeatMs = lifecycle.launchAtMs
      ? Math.max(0, nowAtMs - lifecycle.launchAtMs)
      : 0;
    const plan = resolvePlanReference();
    emitMonitorLog(
      `[worker-monitor] session=${sessionId} reason=${String(reason || 'unknown')} mode=${String(lifecycle.launchMode || 'unknown')} pid=${pid || 'none'} readyWithoutHeartbeatMs=${readyWithoutHeartbeatMs}${plan ? ` plan=${plan}` : ''}`,
    );
    setLifecycle(sessionId, { monitorLoggedAtMs: nowAtMs });
  }

  function registerDegradedState(sessionId, reason, {
    atMs = nowMs(),
    stalePidDetected = false,
  } = {}) {
    const lifecycle = getOrCreateLifecycle(sessionId);
    const normalizedReason = String(reason || 'degraded').trim() || 'degraded';
    const reasonChanged = lifecycle.uiState !== 'yellow' || lifecycle.degradedReason !== normalizedReason;
    const nextFailureCount = reasonChanged ? lifecycle.failureCount + 1 : lifecycle.failureCount;
    const next = setLifecycle(sessionId, {
      uiState: 'yellow',
      degradedReason: normalizedReason,
      degradedAtMs: lifecycle.degradedAtMs || atMs,
      lastFailureAtMs: reasonChanged ? atMs : lifecycle.lastFailureAtMs,
      failureCount: nextFailureCount,
      stalePidDetected: stalePidDetected || lifecycle.stalePidDetected,
      recoveryCandidateAtMs: null,
    });
    return next;
  }

  function clearDegradedState(sessionId) {
    return setLifecycle(sessionId, {
      uiState: 'white',
      degradedReason: null,
      degradedAtMs: null,
      stalePidDetected: false,
      recoveryCandidateAtMs: null,
    });
  }

  function markKilled(sessionId) {
    if (!normalizeSessionId(sessionId)) return null;
    const killed = setLifecycle(sessionId, { killedAtMs: nowMs() });
    return toLifecycleSnapshot(sessionId, killed);
  }

  function isKillBlocked(sessionId) {
    if (killGraceMs <= 0) return false;
    const lifecycle = lifecycleBySession.get(sessionId);
    if (!lifecycle?.killedAtMs) return false;
    return (nowMs() - lifecycle.killedAtMs) < killGraceMs;
  }

  function checkPidLiveness(worker) {
    const pid = Number(worker?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { checked: false, alive: false };
    }
    try {
      return { checked: true, alive: isPidAlive(pid) === true };
    } catch {
      return { checked: true, alive: false };
    }
  }

  function shouldReuseLiveWorker(worker) {
    if (!worker || !hasWorkerIdentity(worker)) return false;
    const pidProbe = checkPidLiveness(worker);
    if (pidProbe.checked) return pidProbe.alive;
    const status = String(worker?.status || '').trim().toLowerCase();
    return ACTIVE_WORKER_STATUSES.has(status);
  }

  function assessSessionHealth(sessionId, worker, {
    nowAtMs = nowMs(),
    questionPending = false,
  } = {}) {
    const lifecycle = getOrCreateLifecycle(sessionId);
    const workerStatus = String(worker?.status || '').trim().toLowerCase();
    const workerPresent = Boolean(worker);
    const expectedAlive = workerPresent && ACTIVE_WORKER_STATUSES.has(workerStatus) && hasWorkerIdentity(worker);
    const hasErrorStatus = workerStatus === 'error';
    const expectingReply = Boolean(questionPending) || workerStatus === 'processing';
    const pidProbe = checkPidLiveness(worker);
    const awaitingHeartbeat = Boolean(lifecycle.awaitingHeartbeat);
    const startupHeartbeatOverdue = awaitingHeartbeat
      && lifecycle.launchAtMs
      && (nowAtMs - lifecycle.launchAtMs) >= heartbeatStaleAfterMs;
    const healthyCandidate = workerPresent
      && ACTIVE_WORKER_STATUSES.has(workerStatus)
      && hasWorkerIdentity(worker)
      && (!pidProbe.checked || pidProbe.alive)
      && !hasErrorStatus
      && !awaitingHeartbeat
      && !questionPending;

    if (lifecycle.restartExhausted && healthyCandidate) {
      clearRestartSchedule(sessionId);
    }

    const refreshedLifecycle = getOrCreateLifecycle(sessionId);

    if (refreshedLifecycle.restartExhausted) {
      registerDegradedState(sessionId, 'restart-exhausted', { atMs: nowAtMs });
    } else if (hasErrorStatus) {
      registerDegradedState(sessionId, String(worker?.lastError || lifecycle.lastError || 'worker-error'), { atMs: nowAtMs });
    } else if (expectedAlive && pidProbe.checked && !pidProbe.alive && (expectingReply || awaitingHeartbeat)) {
      registerDegradedState(sessionId, 'stale-pid', { atMs: nowAtMs, stalePidDetected: true });
      maybeLogStartupIssue(sessionId, 'stale-pid', worker, nowAtMs);
    } else if (startupHeartbeatOverdue) {
      registerDegradedState(sessionId, 'startup-heartbeat-timeout', { atMs: nowAtMs });
      maybeLogStartupIssue(sessionId, 'startup-heartbeat-timeout', worker, nowAtMs);
    }

    const afterDetection = getOrCreateLifecycle(sessionId);
    if (!expectingReply && afterDetection.uiState === 'yellow' && afterDetection.degradedReason === 'stale-pid') {
      clearDegradedState(sessionId);
    }
    const afterRecovery = getOrCreateLifecycle(sessionId);
    let stickyYellow = afterRecovery.uiState === 'yellow';
    const effectiveHealthyCandidate = expectedAlive
      && (!pidProbe.checked || pidProbe.alive)
      && !hasErrorStatus
      && !awaitingHeartbeat
      && !afterRecovery.restartExhausted;

    if (stickyYellow) {
      if (effectiveHealthyCandidate) {
        const recoveryCandidateAtMs = afterRecovery.recoveryCandidateAtMs || nowAtMs;
        const graceSatisfied = (nowAtMs - recoveryCandidateAtMs) >= recoveryGraceMs;
        const noNewFailures = !afterRecovery.lastFailureAtMs || afterRecovery.lastFailureAtMs <= recoveryCandidateAtMs;
        if (graceSatisfied && noNewFailures) {
          clearDegradedState(sessionId);
          stickyYellow = false;
        } else {
          setLifecycle(sessionId, {
            recoveryCandidateAtMs,
            questionPending: Boolean(questionPending),
          });
        }
      } else {
        setLifecycle(sessionId, {
          questionPending: Boolean(questionPending),
          recoveryCandidateAtMs: null,
        });
      }
    }

    const current = getOrCreateLifecycle(sessionId);
    const effectiveYellow = current.uiState === 'yellow';
    const effectiveHealthy = effectiveHealthyCandidate && !effectiveYellow;
    const finalUiState = effectiveYellow
      ? 'yellow'
      : (questionPending ? 'red' : (effectiveHealthy ? 'green' : 'white'));
    return setLifecycle(sessionId, {
      uiState: finalUiState,
      questionPending: Boolean(questionPending),
    });
  }

  function scheduleRestart(sessionId, error = null, { incrementRetry = true } = {}) {
    const lifecycle = getOrCreateLifecycle(sessionId);
    const nextRetryCount = incrementRetry ? lifecycle.retryCount + 1 : lifecycle.retryCount;
    const message = String(error?.message || error || lifecycle.lastError || 'worker failure').trim();
    const failedAtMs = nowMs();

    if (nextRetryCount > retryLimit) {
      const exhausted = setLifecycle(sessionId, {
        retryCount: nextRetryCount,
        backoffMs: 0,
        nextRestartAtMs: null,
        restartExhausted: true,
        lastError: message,
        lastFailureAtMs: failedAtMs,
        lastActivityAtMs: failedAtMs,
      });
      registerDegradedState(sessionId, 'restart-exhausted', { atMs: failedAtMs });
      return { scheduled: false, exhausted: true, lifecycle: toLifecycleSnapshot(sessionId, exhausted) };
    }

    const backoffMs = computeBackoffMs(nextRetryCount);
    const scheduled = setLifecycle(sessionId, {
      retryCount: nextRetryCount,
      backoffMs,
      nextRestartAtMs: failedAtMs + backoffMs,
      restartExhausted: false,
      lastError: message,
      lastFailureAtMs: failedAtMs,
      lastActivityAtMs: failedAtMs,
    });
    registerDegradedState(sessionId, 'spawn-failed', { atMs: failedAtMs });
    return { scheduled: true, exhausted: false, lifecycle: toLifecycleSnapshot(sessionId, scheduled) };
  }

  function clearRestartSchedule(sessionId, {
    resetDegradedState = true,
    resetKilledMarker = false,
  } = {}) {
    if (!normalizeSessionId(sessionId)) return null;
    const nowAtMs = nowMs();
    const patch = {
      retryCount: 0,
      backoffMs: 0,
      nextRestartAtMs: null,
      restartExhausted: false,
      lastError: null,
      lastFailureAtMs: null,
      lastActivityAtMs: nowAtMs,
    };
    if (resetDegradedState) {
      patch.recoveryCandidateAtMs = null;
      patch.stalePidDetected = false;
      patch.degradedReason = null;
      patch.degradedAtMs = null;
      patch.uiState = 'white';
    }
    if (resetKilledMarker) {
      patch.killedAtMs = null;
    }
    const cleared = setLifecycle(sessionId, patch);
    return toLifecycleSnapshot(sessionId, cleared);
  }

  function canAttemptRestart(sessionId) {
    const lifecycle = lifecycleBySession.get(sessionId);
    if (!lifecycle) return { allowed: true, reason: null, lifecycle: null };
    if (lifecycle.restartExhausted) {
      return { allowed: false, reason: 'restart-exhausted', lifecycle: toLifecycleSnapshot(sessionId, lifecycle) };
    }
    if (lifecycle.nextRestartAtMs && nowMs() < lifecycle.nextRestartAtMs) {
      return { allowed: false, reason: 'restart-delayed', lifecycle: toLifecycleSnapshot(sessionId, lifecycle) };
    }
    return { allowed: true, reason: null, lifecycle: toLifecycleSnapshot(sessionId, lifecycle) };
  }

  function isTransitionAllowed(fromStatus, toStatus) {
    const from = String(fromStatus || 'new').trim().toLowerCase();
    const to = String(toStatus || '').trim().toLowerCase();
    if (!to || from === to) return true;
    const allowed = {
      new: new Set(['starting', 'ready', 'error', 'processing']),
      starting: new Set(['ready', 'error']),
      ready: new Set(['processing', 'starting', 'error']),
      processing: new Set(['ready', 'error']),
      error: new Set(['starting', 'ready']),
    };
    return Boolean(allowed[from]?.has(to));
  }

  function setWorkerState(sessionId, nextState = {}) {
    const current = registry.getWorker(sessionId);
    const requestedStatus = String(nextState.status || current?.status || 'new').trim().toLowerCase();
    if (current && !isTransitionAllowed(current.status, requestedStatus)) {
      return current;
    }
    const next = registry.upsertWorker({
      ...(current || {}),
      sdkSessionId: sessionId,
      ...nextState,
      status: requestedStatus,
      updatedAt: nowIso(),
    });
    touchActivity(sessionId, nowMs());
    return next;
  }

  function getWorkerState(sdkSessionId) {
    return registry.getWorker(normalizeSessionId(sdkSessionId));
  }

  function listWorkerStates() {
    return registry.listWorkers();
  }

  async function ensureWorker(sdkSessionId, { allowProcessReuse = true } = {}) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) {
      return { ok: false, error: 'missing-session-id', worker: null };
    }

    if (isKillBlocked(sessionId)) {
      const lifecycle = getOrCreateLifecycle(sessionId);
      return {
        ok: false,
        error: 'session-killed',
        worker: registry.getWorker(sessionId) || null,
        lifecycle: toLifecycleSnapshot(sessionId, lifecycle),
      };
    }

    const existing = registry.getWorker(sessionId);
    const existingLifecycle = getOrCreateLifecycle(sessionId);
    const blockedByStartupFailure = hasStartupFailureReason(existingLifecycle);
    if (allowProcessReuse && !blockedByStartupFailure && shouldReuseLiveWorker(existing)) {
      const nowAtMs = nowMs();
      const reusedWorker = setWorkerState(sessionId, {
        ...existing,
        sdkSessionId: sessionId,
        status: 'ready',
      });
      const lifecycle = getOrCreateLifecycle(sessionId);
      if (!lifecycle.awaitingHeartbeat && !lifecycle.firstObservedHeartbeatAtMs) {
        noteLaunch(sessionId, {
          mode: 'reused',
          pid: existing?.pid || null,
          atMs: nowAtMs,
        });
      }
      // A live worker should always be allowed to serve turns even if stale restart
      // backoff/exhausted lifecycle state was left behind by earlier failures.
      clearRestartSchedule(sessionId, { resetDegradedState: false });
      assessSessionHealth(sessionId, reusedWorker, { nowAtMs, questionPending: false });
      return { ok: true, reused: true, worker: reusedWorker, lifecycle: toLifecycleSnapshot(sessionId) };
    }

    const restartGate = canAttemptRestart(sessionId);
    if (!restartGate.allowed) {
      return { ok: false, error: restartGate.reason, worker: existing, lifecycle: restartGate.lifecycle };
    }

    const inFlight = pendingStarts.get(sessionId);
    if (inFlight?.promise) {
      return inFlight.promise;
    }

    const startToken = Symbol(`start-${sessionId}`);
    const isStartActive = () => pendingStarts.get(sessionId)?.token === startToken;
    const buildStartBlockedResult = () => {
      const lifecycle = getOrCreateLifecycle(sessionId);
      const blockedError = isKillBlocked(sessionId) ? 'session-killed' : 'start-cancelled';
      return {
        ok: false,
        error: blockedError,
        worker: registry.getWorker(sessionId) || null,
        lifecycle: toLifecycleSnapshot(sessionId, lifecycle),
      };
    };

    const startPromise = Promise.resolve().then(async () => {
      if (!isStartActive() || isKillBlocked(sessionId)) {
        return buildStartBlockedResult();
      }
      const lifecycle = getOrCreateLifecycle(sessionId);
      const startingState = setWorkerState(sessionId, {
        sdkSessionId: sessionId,
        status: 'starting',
        queueDepth: existing?.queueDepth || 0,
        retryCount: lifecycle.retryCount || existing?.retryCount || 0,
      });

      try {
        if (typeof spawnWorker === 'function') {
          if (!isStartActive() || isKillBlocked(sessionId)) {
            return buildStartBlockedResult();
          }
          const spawned = await spawnWorker(sessionId, {
            allowProcessReuse: allowProcessReuse && !blockedByStartupFailure,
          });
          if (!isStartActive() || isKillBlocked(sessionId)) {
            return buildStartBlockedResult();
          }
          const readyState = setWorkerState(sessionId, {
            ...startingState,
            workerId: String(spawned?.workerId || startingState.workerId || `worker-${sessionId.slice(0, 8)}`).trim(),
            pid: Number.isInteger(Number(spawned?.pid)) ? Number(spawned.pid) : null,
            status: 'ready',
            retryCount: 0,
            lastError: null,
          });
          noteLaunch(sessionId, {
            mode: 'spawned',
            pid: spawned?.pid || null,
            atMs: nowMs(),
          });
          clearRestartSchedule(sessionId);
          assessSessionHealth(sessionId, readyState, { questionPending: false });
          return { ok: true, reused: false, worker: readyState, lifecycle: toLifecycleSnapshot(sessionId) };
        }
        const simulatedReady = setWorkerState(sessionId, {
          ...startingState,
          workerId: startingState.workerId || `worker-${sessionId.slice(0, 8)}`,
          status: 'ready',
          retryCount: 0,
          lastError: null,
        });
        noteLaunch(sessionId, {
          mode: 'spawned',
          pid: simulatedReady?.pid || null,
          atMs: nowMs(),
        });
        clearRestartSchedule(sessionId);
        assessSessionHealth(sessionId, simulatedReady, { questionPending: false });
        return { ok: true, reused: false, worker: simulatedReady, lifecycle: toLifecycleSnapshot(sessionId) };
      } catch (error) {
        const scheduled = scheduleRestart(sessionId, error, { incrementRetry: true });
        const failed = setWorkerState(sessionId, {
          ...startingState,
          status: 'error',
          retryCount: scheduled.lifecycle?.retryCount || Number(startingState.retryCount || 0) + 1,
          lastError: String(error?.message || error || 'unknown spawn failure').trim(),
        });
        assessSessionHealth(sessionId, failed, { questionPending: false });
        return {
          ok: false,
          error: scheduled.exhausted ? 'restart-exhausted' : 'spawn-failed',
          worker: failed,
          lifecycle: toLifecycleSnapshot(sessionId),
        };
      } finally {
        if (isStartActive()) {
          pendingStarts.delete(sessionId);
        }
      }
    });

    pendingStarts.set(sessionId, {
      token: startToken,
      promise: startPromise,
    });
    return startPromise;
  }

  async function cancelPendingStart(sdkSessionId, { wait = false } = {}) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) {
      return { cancelled: false, hadPending: false, waited: false };
    }
    const pending = pendingStarts.get(sessionId);
    if (!pending?.promise) {
      return { cancelled: true, hadPending: false, waited: false };
    }
    pendingStarts.delete(sessionId);
    if (!wait) {
      return { cancelled: true, hadPending: true, waited: false };
    }
    try {
      await pending.promise;
    } catch {
      // Ignore start promise errors while cancelling in-flight starts.
    }
    return { cancelled: true, hadPending: true, waited: true };
  }

  function markProcessing(sdkSessionId, queueDepth = 0) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const next = setWorkerState(sessionId, {
      sdkSessionId: sessionId,
      status: 'processing',
      queueDepth: Math.max(0, Number(queueDepth || 0)),
    });
    assessSessionHealth(sessionId, next, { questionPending: false });
    return next;
  }

  function markIdle(sdkSessionId, queueDepth = 0) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const next = setWorkerState(sessionId, {
      sdkSessionId: sessionId,
      status: 'ready',
      queueDepth: Math.max(0, Number(queueDepth || 0)),
    });
    assessSessionHealth(sessionId, next, { questionPending: false });
    return next;
  }

  function markError(sdkSessionId, error) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const current = registry.getWorker(sessionId) || { retryCount: 0 };
    const scheduled = scheduleRestart(sessionId, error, { incrementRetry: true });
    const next = setWorkerState(sessionId, {
      ...current,
      sdkSessionId: sessionId,
      status: 'error',
      retryCount: scheduled.lifecycle?.retryCount ?? (Number(current.retryCount || 0) + 1),
      lastError: String(error?.message || error || 'unknown worker error').trim(),
    });
    assessSessionHealth(sessionId, next, { questionPending: false });
    return next;
  }

  function noteSessionHeartbeat(sdkSessionId, atMs = nowMs()) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const lifecycle = noteHeartbeat(sessionId, atMs);
    const worker = registry.getWorker(sessionId);
    assessSessionHealth(sessionId, worker, { nowAtMs: atMs, questionPending: Boolean(lifecycle.questionPending) });
    return toLifecycleSnapshot(sessionId);
  }

  function resetHealth(sdkSessionId, { clearFailureCount = false } = {}) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const patch = {
      uiState: 'white',
      degradedReason: null,
      degradedAtMs: null,
      stalePidDetected: false,
      recoveryCandidateAtMs: null,
      questionPending: false,
      lastFailureAtMs: null,
    };
    if (clearFailureCount) patch.failureCount = 0;
    const lifecycle = setLifecycle(sessionId, patch);
    return toLifecycleSnapshot(sessionId, lifecycle);
  }

  function getLifecycleState(sdkSessionId) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const worker = registry.getWorker(sessionId);
    assessSessionHealth(sessionId, worker, {
      nowAtMs: nowMs(),
      questionPending: Boolean(getOrCreateLifecycle(sessionId).questionPending),
    });
    return toLifecycleSnapshot(sessionId, lifecycleBySession.get(sessionId));
  }

  function evictIdleWorkers({ idleForMs = idleTimeoutMs } = {}) {
    const timeoutMs = clampInt(idleForMs, idleTimeoutMs);
    if (timeoutMs <= 0) return [];
    const cutoff = nowMs() - timeoutMs;
    const evicted = [];
    for (const worker of registry.listWorkers()) {
      const sessionId = normalizeSessionId(worker.sdkSessionId);
      if (!sessionId) continue;
      if (worker.status !== 'ready') continue;
      if (pendingStarts.has(sessionId)) continue;
      const lifecycle = getOrCreateLifecycle(sessionId);
      const lastActivityAtMs = lifecycle.lastActivityAtMs || Date.parse(worker.updatedAt) || 0;
      if (lastActivityAtMs > cutoff) continue;
      const removed = registry.removeWorker(sessionId);
      lifecycleBySession.delete(sessionId);
      if (!removed) continue;
      evicted.push({
        sdkSessionId: sessionId,
        workerId: worker.workerId || null,
        idleForMs: Math.max(0, nowMs() - lastActivityAtMs),
      });
    }
    return evicted;
  }

  function snapshot({ pendingQuestionSessionIds = null } = {}) {
    const workers = registry.listWorkers();
    const questionPendingSet = normalizePendingQuestionSessionIds(pendingQuestionSessionIds);
    const workerBySession = new Map();
    for (const worker of workers) {
      const sid = normalizeSessionId(worker?.sdkSessionId);
      if (!sid) continue;
      workerBySession.set(sid, worker);
    }

    const knownSessionIds = new Set([
      ...Array.from(workerBySession.keys()),
      ...Array.from(lifecycleBySession.keys()),
      ...Array.from(questionPendingSet.values()),
    ]);

    const workerRows = [];
    const lifecycleRows = [];
    const healthCounts = { white: 0, green: 0, red: 0, yellow: 0 };

    for (const sdkSessionId of knownSessionIds) {
      const worker = workerBySession.get(sdkSessionId) || null;
      const lifecycle = assessSessionHealth(sdkSessionId, worker, {
        nowAtMs: nowMs(),
        questionPending: questionPendingSet.has(sdkSessionId),
      });
      const lifecycleSnapshot = toLifecycleSnapshot(sdkSessionId, lifecycle);
      lifecycleRows.push({
        sdkSessionId,
        ...lifecycleSnapshot,
      });
      const uiState = String(lifecycleSnapshot?.uiState || 'white');
      if (Object.hasOwn(healthCounts, uiState)) {
        healthCounts[uiState] += 1;
      }
      if (worker) {
        workerRows.push({
          ...worker,
          uiState,
          degradedReason: lifecycleSnapshot?.degradedReason || null,
          lastHeartbeatAt: lifecycleSnapshot?.lastHeartbeatAt || null,
          lastFailureAt: lifecycleSnapshot?.lastFailureAt || null,
          failureCount: lifecycleSnapshot?.failureCount || 0,
          stalePidDetected: lifecycleSnapshot?.stalePidDetected === true,
          questionPending: lifecycleSnapshot?.questionPending === true,
          launchMode: lifecycleSnapshot?.launchMode || null,
          launchPid: lifecycleSnapshot?.launchPid || null,
          launchAt: lifecycleSnapshot?.launchAt || null,
          awaitingHeartbeat: lifecycleSnapshot?.awaitingHeartbeat === true,
          firstObservedHeartbeatAt: lifecycleSnapshot?.firstObservedHeartbeatAt || null,
          readyWithoutHeartbeatMs: lifecycleSnapshot?.readyWithoutHeartbeatMs ?? 0,
          diagnosticPlanReference: lifecycleSnapshot?.diagnosticPlanReference || null,
        });
      }
    }

    const counts = workers.reduce((acc, worker) => {
      const key = String(worker.status || 'unknown');
      acc[key] = Number(acc[key] || 0) + 1;
      return acc;
    }, {});

    const overallUiState = healthCounts.yellow > 0
      ? 'yellow'
      : (healthCounts.red > 0 ? 'red' : (healthCounts.green > 0 ? 'green' : 'white'));

    return {
      workerCount: workers.length,
      counts,
      workers: workerRows,
      pendingStarts: pendingStarts.size,
      lifecycle: lifecycleRows,
      health: {
        uiState: overallUiState,
        degradedReason: overallUiState === 'yellow'
          ? (lifecycleRows.find((item) => item.uiState === 'yellow')?.degradedReason || 'degraded')
          : null,
        counts: healthCounts,
        heartbeatTimeoutMs: heartbeatStaleAfterMs,
        degradedRecoveryGraceMs: recoveryGraceMs,
      },
    };
  }

  return {
    ensureWorker,
    getWorkerState,
    listWorkerStates,
    markProcessing,
    markIdle,
    markError,
    noteSessionHeartbeat,
    resetHealth,
    scheduleRestart: (sdkSessionId, error, options) => {
      const sessionId = normalizeSessionId(sdkSessionId);
      if (!sessionId) return null;
      return scheduleRestart(sessionId, error, options);
    },
    clearRestartSchedule: (sdkSessionId, options) => {
      const sessionId = normalizeSessionId(sdkSessionId);
      if (!sessionId) return null;
      return clearRestartSchedule(sessionId, options);
    },
    isKillBlocked: (sdkSessionId) => {
      const sessionId = normalizeSessionId(sdkSessionId);
      if (!sessionId) return false;
      return isKillBlocked(sessionId);
    },
    markKilled: (sdkSessionId) => {
      const sessionId = normalizeSessionId(sdkSessionId);
      if (!sessionId) return null;
      return markKilled(sessionId);
    },
    cancelPendingStart,
    getLifecycleState,
    canAttemptRestart: (sdkSessionId) => {
      const sessionId = normalizeSessionId(sdkSessionId);
      if (!sessionId) return { allowed: false, reason: 'missing-session-id', lifecycle: null };
      return canAttemptRestart(sessionId);
    },
    evictIdleWorkers,
    snapshot,
  };
}
