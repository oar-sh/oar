'use strict';

// What the relay does when its queue may hold work for a worker: hand rows to
// the workers that are ready (the socket service's notify), make sure every
// session with a pending row has a worker (the prime), and keep the prime's
// maintenance pass armed while rows wait. The wakes come from the queue's
// own writes (queue-wake-hook.mjs), from a retry time coming due, from gates
// that lift, and from the backstop poll.

/**
 * The prime: every session that owns a pending row gets its worker started
 * (rows in retry backoff included, so the worker is warm when the backoff
 * matures; rows held at the usage limit are not listed until their reset).
 */
export function createPendingWorkerPrimer({
  isEnabled = () => true,
  listPendingOwnerSessionIds,
  isKillBlocked = () => false,
  // A session whose rows were failed instead of launched (a Claude API chat
  // the key cannot serve): true to skip its launch.
  failRowsWithoutLaunch = () => false,
  ensureWorker,
  // Rows were found: the maintenance pass keeps retrying until none is.
  onRowsWaiting = () => {},
  warn = () => {},
  limit = 25,
} = {}) {
  return async function prime(reason = 'pending-worker-prime') {
    if (!isEnabled()) return 0;
    const rows = listPendingOwnerSessionIds(limit) || [];
    if (rows.length) onRowsWaiting();
    let requested = 0;
    for (const row of rows) {
      const sdkSessionId = String(row?.sdk_session_id || '').trim();
      if (!sdkSessionId) continue;
      if (isKillBlocked(sdkSessionId) === true) continue;
      try {
        // Per session: a throw here costs this session its launch, never the
        // rest of the pass.
        if (failRowsWithoutLaunch(sdkSessionId)) continue;
      } catch (error) {
        warn(`WORKER PRIME skipped session=${sdkSessionId.slice(0, 8)} err=${error?.message || error}`);
        continue;
      }
      requested += 1;
      try {
        const result = await ensureWorker(sdkSessionId);
        if (!result?.ok) {
          warn(`WORKER PRIME blocked session=${sdkSessionId.slice(0, 8)} reason=${String(result?.error || reason || 'pending-worker-prime')}`);
        }
      } catch (error) {
        warn(`WORKER PRIME failed session=${sdkSessionId.slice(0, 8)} reason=${String(reason || 'pending-worker-prime')} err=${error?.message || error}`);
      }
    }
    return requested;
  };
}

/**
 * The wake. `wake(reason)` hands rows out at once, primes, and arms the
 * maintenance pass; `wake(reason, { prime: false })` leaves the prime to that
 * pass (a queue write: the send route launches its own worker, and a write
 * burst must not run a prime per write). Primes never overlap: one asked for
 * while one runs runs once after it. `primeFromBackstop` is the poll's share:
 * a prime at most every `backstopPrimeGapMs`.
 */
export function createQueueWaker({
  prime,
  notify = () => {},
  armPrime = () => {},
  isReady = () => true,
  backstopPrimeGapMs = 5_000,
  now = () => Date.now(),
  warn = () => {},
} = {}) {
  let primeRunning = false;
  let primeAgain = null;
  let lastBackstopPrimeAt = -Infinity;

  async function runPrime(reason) {
    if (primeRunning) {
      primeAgain = reason;
      return;
    }
    primeRunning = true;
    try {
      let next = reason;
      while (next) {
        primeAgain = null;
        try {
          await prime(next);
        } catch (error) {
          warn(`WORKER PRIME pass failed reason=${next} err=${error?.message || error}`);
        }
        next = primeAgain;
      }
    } finally {
      primeRunning = false;
    }
  }

  function wake(reason = 'queue-wake', { prime: withPrime = true } = {}) {
    if (!isReady()) return false;
    try { armPrime(); } catch {}
    try { notify(reason); } catch (error) {
      warn(`queue notify failed reason=${reason} err=${error?.message || error}`);
    }
    if (withPrime) void runPrime(reason);
    return true;
  }

  function primeFromBackstop(reason = 'backstop') {
    if (!isReady()) return false;
    try { armPrime(); } catch {}
    const at = now();
    if (at - lastBackstopPrimeAt < backstopPrimeGapMs) return false;
    lastBackstopPrimeAt = at;
    void runPrime(reason);
    return true;
  }

  return {
    wake,
    primeFromBackstop,
    status: () => ({ primeRunning, primeQueued: primeAgain !== null }),
  };
}
