'use strict';

/**
 * The worker swap behind the Claude billing switch.
 *
 * A Claude chat's worker is of one kind for its whole life: `claude` runs the
 * CLI on the host's subscription login, `claude-api` on the saved API key
 * (which reaches only that kind's launch). After a switch, the chat's next
 * row is of the other billing, and the delivery refuses it to the worker it
 * has (claudeBillingFence, messages-routes.mjs). This service then replaces
 * that worker, between turns:
 *
 * - it waits while the session owns a turn the relay handed out (a
 *   `processing` row: running, delivered and not yet started, a cold spawn
 *   on its way), and while the worker is not releasable: a turn, an open
 *   question, a compaction, background tasks (the worker's steering snapshot
 *   says which, and the composer shows it); a worker with no CLI process and
 *   no delivery on its way in is releasable;
 * - it stops the worker and every process of the session, and launches the
 *   new kind only once they are gone, never reusing a live one, so two CLIs
 *   never share the session's transcript;
 * - a stop that fails is retried with a backoff, and after a few the chat
 *   gets a note (`onStuck`);
 * - the first delivery to the new worker carries a note of the swap
 *   (`takeSwapNote`), which the worker shows in the turn.
 *
 * A switch back before the swap needs nothing here: the rows are re-stamped,
 * the fence lets them through, and the waiting state ages out.
 */

export const CLAUDE_BILLING_SWAP_WAIT_TTL_MS = 15_000;

/**
 * What keeps a worker from being replaced now: null when nothing does, else
 * 'turn', 'question', 'compaction' or 'background'. From the steering
 * snapshot its heartbeat sends; a worker too old to say `releasable` is read
 * from the rest of it.
 */
export function claudeWorkerReleaseHold(worker) {
  if (!worker) return null;
  const steering = worker.steering || null;
  if (steering && typeof steering.releasable === 'boolean') {
    return steering.releasable ? null : (steering.releaseHold || 'turn');
  }
  if (steering) {
    if (steering.holdReason === 'question') return 'question';
    if (steering.holdReason === 'compaction') return 'compaction';
    if (steering.turnActive) return 'turn';
    if (steering.autoCompactWindow?.backgroundWork) return 'background';
    return null;
  }
  return String(worker.status || '') === 'processing' ? 'turn' : null;
}

export function createClaudeBillingSwapService({
  // sid → the registry's entry for the session's worker, or null.
  getWorker = () => null,
  // sid → whether the session owns a turn the relay handed out and has not
  // seen finish (a `processing` queue row: a running turn, a delivery not yet
  // acknowledged, a continuation). The relay's own record, asked before the
  // worker's last snapshot, which can lag a claim by a pulse.
  hasRunningTurn = () => false,
  // async sid → { ok, error?, remainingPids? }: every process of the session
  // stopped, and the registry and the supervisor's restart state cleared.
  stopWorker,
  // async sid → { ok, error? }: launch the session's worker (its kind follows
  // the chat's billing), never reusing a live process.
  launchWorker,
  // ({ sdkSessionId, conversationId, rowBilling, attempts, error }): the
  // old worker would not stop, again; once per episode.
  onStuck = () => {},
  // ({ sdkSessionId, conversationId, pending }) whenever the waiting state
  // of a chat changes (null once it is over).
  onPendingChange = () => {},
  now = () => Date.now(),
  retryBaseMs = 5_000,
  retryMaxMs = 60_000,
  stuckAfter = 3,
  // A running-turn probe that fails is logged at most this often per session,
  // and reaches the chat once it has failed `stuckAfter` times over at least
  // `probeStuckAfterMs` (a brief database hiccup says nothing).
  probeLogEveryMs = 60_000,
  probeStuckAfterMs = 30_000,
  logger = console,
} = {}) {
  if (typeof stopWorker !== 'function' || typeof launchWorker !== 'function') {
    throw new Error('createClaudeBillingSwapService requires stopWorker and launchWorker');
  }
  const bySession = new Map();
  const swapNotes = new Map();

  function stateFor(sid) {
    let state = bySession.get(sid);
    if (!state) {
      state = {
        inFlight: false,
        failures: 0,
        nextAttemptAt: 0,
        // The two causes of a stuck swap are noted apart: one does not
        // silence the other.
        stuckNoted: false,
        probeFailures: 0,
        probeFailingSince: 0,
        probeStuckNoted: false,
        lastProbeLogAt: -Infinity,
        pending: null,
        conversationId: '',
      };
      bySession.set(sid, state);
    }
    return state;
  }

  function setPending(sid, state, pending) {
    const before = JSON.stringify(state.pending ? { ...state.pending, seenAt: 0 } : null);
    state.pending = pending ? { ...pending, seenAt: now() } : null;
    const after = JSON.stringify(state.pending ? { ...state.pending, seenAt: 0 } : null);
    if (before === after) return;
    try {
      onPendingChange({
        sdkSessionId: sid,
        conversationId: state.conversationId,
        pending: state.pending ? publicPending(state.pending) : null,
      });
    } catch {}
  }

  function publicPending(pending) {
    return {
      to: pending.to,
      waitingFor: pending.waitingFor || null,
      backgroundTaskCount: Number(pending.backgroundTaskCount || 0),
      swapping: pending.swapping === true,
    };
  }

  async function run(sid, state, fence) {
    let stopped = null;
    try {
      stopped = await stopWorker(sid);
    } catch (error) {
      stopped = { ok: false, error: error?.message || String(error) };
    }
    if (!stopped?.ok) {
      state.failures += 1;
      state.nextAttemptAt = now() + Math.min(retryMaxMs, retryBaseMs * (2 ** (state.failures - 1)));
      try { logger.warn?.(`[claude-billing] swap of ${sid.slice(0, 8)} could not stop the old worker (${state.failures}): ${stopped?.error || 'unknown'}`); } catch {}
      if (state.failures >= stuckAfter && !state.stuckNoted) {
        state.stuckNoted = true;
        try {
          onStuck({
            sdkSessionId: sid,
            conversationId: state.conversationId,
            rowBilling: fence.rowBilling,
            attempts: state.failures,
            error: stopped?.error || null,
            reason: 'stop',
          });
        } catch {}
      }
      setPending(sid, state, { to: fence.rowBilling, waitingFor: 'stop', backgroundTaskCount: 0 });
      return;
    }
    swapNotes.set(sid, { from: fence.workerKind || null, to: fence.rowBilling });
    let launched = null;
    try {
      launched = await launchWorker(sid);
    } catch (error) {
      launched = { ok: false, error: error?.message || String(error) };
    }
    state.failures = 0;
    state.stuckNoted = false;
    state.nextAttemptAt = 0;
    try {
      logger.log?.(`[claude-billing] swapped ${sid.slice(0, 8)} ${fence.workerKind || 'unknown'} → ${fence.rowBilling}${launched?.ok ? '' : ` (launch: ${launched?.error || 'pending'})`}`);
    } catch {}
    setPending(sid, state, null);
  }

  /**
   * A delivery refused a row to this session's worker (the fence). Starts
   * the swap when the worker is releasable; otherwise notes what it waits
   * for. Returns `{ state: 'swapping' | 'waiting' | 'in-flight' | 'backoff',
   * waitingFor? }`.
   */
  function request(fence = {}) {
    const sid = String(fence.requesterSessionId || '').trim();
    if (!sid || !fence.rowBilling) return { state: 'ignored' };
    const state = stateFor(sid);
    state.conversationId = String(fence.conversationId || state.conversationId || '');
    if (state.inFlight) return { state: 'in-flight' };
    if (now() < state.nextAttemptAt) {
      if (state.pending) state.pending.seenAt = now();
      return { state: 'backoff' };
    }
    const worker = getWorker(sid);
    let running = false;
    try {
      running = hasRunningTurn(sid) === true;
      // The probe answers: its failure streak, and its note, are over.
      state.probeFailures = 0;
      state.probeFailingSince = 0;
      state.probeStuckNoted = false;
    } catch (error) {
      // Unknown counts as running: the old worker is never stopped on a
      // guess. Said in the log (not on every fence), and a probe that keeps
      // failing reaches the chat as the stuck note.
      running = true;
      noteProbeFailure(sid, state, fence, error);
    }
    const hold = running ? 'turn' : claudeWorkerReleaseHold(worker);
    if (hold) {
      setPending(sid, state, {
        to: fence.rowBilling,
        waitingFor: hold,
        backgroundTaskCount: hold === 'background' ? Number(worker?.steering?.backgroundTaskCount || 0) : 0,
      });
      return { state: 'waiting', waitingFor: hold };
    }
    state.inFlight = true;
    setPending(sid, state, { to: fence.rowBilling, waitingFor: null, swapping: true });
    void run(sid, state, fence).finally(() => { state.inFlight = false; });
    return { state: 'swapping' };
  }

  function noteProbeFailure(sid, state, fence, error) {
    if (state.probeFailures === 0) state.probeFailingSince = now();
    state.probeFailures += 1;
    const message = String(error?.message || error || 'unknown');
    if (now() - state.lastProbeLogAt >= probeLogEveryMs) {
      state.lastProbeLogAt = now();
      try { logger.warn?.(`[claude-billing] swap of ${sid.slice(0, 8)} cannot tell whether a turn runs (${state.probeFailures}): ${message}; waiting`); } catch {}
    }
    const lasting = now() - state.probeFailingSince >= probeStuckAfterMs;
    if (state.probeFailures >= stuckAfter && lasting && !state.probeStuckNoted) {
      state.probeStuckNoted = true;
      try {
        onStuck({
          sdkSessionId: sid,
          conversationId: state.conversationId,
          rowBilling: fence.rowBilling,
          attempts: state.probeFailures,
          error: message,
          reason: 'probe',
        });
      } catch {}
    }
  }

  /** The note the first delivery after a swap carries, once. */
  function takeSwapNote(sid) {
    const key = String(sid || '').trim();
    const note = swapNotes.get(key) || null;
    if (note) swapNotes.delete(key);
    return note;
  }

  /**
   * What a chat waits for, for the composer: null when nothing, or the
   * fence stopped asking (a switch back, the swap done) long enough ago.
   */
  function pendingFor(sid) {
    const state = bySession.get(String(sid || '').trim());
    if (!state?.pending) return null;
    if (!state.inFlight && now() - Number(state.pending.seenAt || 0) > CLAUDE_BILLING_SWAP_WAIT_TTL_MS) return null;
    return publicPending(state.pending);
  }

  return {
    request,
    takeSwapNote,
    pendingFor,
  };
}
