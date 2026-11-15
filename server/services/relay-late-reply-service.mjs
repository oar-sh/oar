'use strict';

/**
 * Late replies: the timing. A prompt a conversation sent with send or
 * create_session stays open in the event service's ledger
 * (relay_event_own_prompts, migrations/0042-late-replies.mjs) until a wait
 * hands the agent its final outcome. Nobody waits for an open prompt: this
 * sweeper looks for its reply with the reads a wait uses
 * (remote-relay-dispatcher.mjs readOwnReplies) and hands what it finds to
 * the event service, which delivers it into the sender's conversation as a
 * late reply (relay-event-service.mjs).
 *
 * A pass runs every lateReplyPassMs, and at once after a nudge (the end of a
 * turn of a session that open prompts went to). It takes at most
 * lateReplyRowsPerPass due rows, the most overdue first, and reads each
 * (relay, session) once whatever the number of prompts to it: at most
 * lateReplyReadsPerRelay reads to one paired relay, lateReplyReadsInFlight
 * at once (lateReplyReadsInFlightPerRelay to one paired relay). A relay that
 * fails a read is skipped for the rest of the pass. A row that is not
 * settled is due again by its age (RELAY_EVENT_LATE_REPLY_CADENCE); past the
 * last step it is given up.
 *
 * In memory: one timer, the pass flag, the failed relays of the pass, and
 * per row the `seen` state of a reply whose background follow-ups have not
 * settled yet (at most lateReplySeenMax, the oldest dropped first: that row
 * then settles one check later). No row cache: each pass reads its rows
 * from SQLite.
 */

import { RELAY_EVENT_LATE_REPLY_CADENCE, RELAY_EVENT_LIMITS } from '../../shared/relay-events.mjs';

// What a wait hands over as the end of a prompt: delivered.
const FINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'cancelled']);
// The late_next_at a nudge sets: the most overdue of all, so the session
// whose turn just ended is read in the next pass, ahead of any backlog.
export const LATE_REPLY_NUDGED_AT = new Date(0).toISOString();
const LOG_PREFIX = '[late-replies]';

/**
 * For end-to-end tests only (tests/late-replies.spec.mjs): with
 * OAR_LATE_REPLY_TEST_PASS_MS set (100 to 60000), a pass runs that often and
 * every open row is due at each pass, instead of by the cadence. Anything
 * else, or unset, changes nothing.
 */
export function lateReplyTestPassMs(env = process.env) {
  const value = Number(env?.OAR_LATE_REPLY_TEST_PASS_MS);
  return Number.isInteger(value) && value >= 100 && value <= 60_000 ? value : 0;
}

function toText(value) {
  return String(value ?? '').trim();
}

function shortId(value) {
  return toText(value).slice(0, 8);
}

/** When a row of this age is checked next (ms from now), or null once it is given up. */
export function lateReplyCheckDelay(ageMs, { paired = false } = {}) {
  const step = RELAY_EVENT_LATE_REPLY_CADENCE.find((entry) => ageMs < entry.underMs);
  if (!step) return null;
  return paired ? step.pairedMs : step.localMs;
}

/**
 * `selfRelayId` is the ledger's relay id of this relay's own sessions; any
 * other is a paired relay's. `store` is the event service's ledger: `listDue(atIso, limit)`,
 * `setNextAt(messageId, atIso)`, `nudge(relayId, sessionId, atIso)` (how
 * many rows it made due), `deferRelay(relayId, byMs, dueIso)` (each of a
 * paired relay's rows due by `dueIso` moves on by `byMs` from its own time,
 * a NULL one from `dueIso`), `watcherLive(watcherId)` (itself or its
 * compaction successor), `ownWaitLive(watcherId, messageId)`,
 * `deliver(row, outcome)` (a final outcome, or `{ status: 'gone' }`) and
 * `close(row, state, reason)` (`undeliverable`, `gave_up`).
 */
export function createLateReplyService({
  store,
  selfRelayId,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  logger = console,
  testPassMs = lateReplyTestPassMs(),
  passMs = testPassMs || RELAY_EVENT_LIMITS.lateReplyPassMs,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!toText(selfRelayId)) throw new Error('selfRelayId is required');
  let reader = null;
  let started = false;
  let running = null;
  let again = false;
  let tickTimer = null;
  let kickTimer = null;
  // message id → the wait's `seen` state, oldest first.
  const seenByRow = new Map();

  function warn(line) {
    try { logger?.warn?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  function seenOf(messageId) {
    return seenByRow.get(messageId) || { inFlight: null };
  }

  /** A settling reply's state is kept for the next pass; any other is not. */
  function keepSeen(messageId, seen) {
    seenByRow.delete(messageId);
    if (!seen?.background && !seen?.idle) return;
    seenByRow.set(messageId, seen);
    while (seenByRow.size > RELAY_EVENT_LIMITS.lateReplySeenMax) seenByRow.delete(seenByRow.keys().next().value);
  }

  function ageOf(row, at) {
    return at - (Date.parse(String(row.created_at)) || at);
  }

  function isPaired(row) {
    return toText(row.relay_id) !== selfRelayId;
  }

  /** Due again by the cadence; a reply that is settling (or an idle session to confirm) at the next pass. */
  function moveOn(row, at, seen = seenByRow.get(row.message_id)) {
    let delay = testPassMs || (lateReplyCheckDelay(ageOf(row, at), { paired: isPaired(row) }) ?? passMs);
    if (seen?.quietSince || seen?.idle) delay = Math.min(delay, passMs);
    try { store.setNextAt(row.message_id, iso(at + delay)); } catch (error) { warn(`next check of ${shortId(row.message_id)} not stored: ${toText(error?.message || error).slice(0, 200)}`); }
  }

  function settle(row, fn) {
    seenByRow.delete(row.message_id);
    try { fn(); } catch (error) { warn(`prompt ${shortId(row.message_id)} not settled: ${toText(error?.message || error).slice(0, 200)}`); }
  }

  async function readGroup(group, failed) {
    const at = now();
    const seens = new Map(group.rows.map((row) => [row.message_id, seenOf(row.message_id)]));
    let result;
    try {
      result = await reader({
        watcherConversationId: group.rows[0].watcher_conversation_id,
        relayId: group.relayId,
        sessionId: group.sessionId,
        rows: group.rows.map((row) => ({ messageId: row.message_id, seen: seens.get(row.message_id) })),
      });
    } catch (error) {
      failed.add(group.relayId);
      warn(`relay ${shortId(group.relayId)} not read (skipped for this pass): ${toText(error?.message || error).slice(0, 200)}`);
      for (const row of group.rows) moveOn(row, at);
      return;
    }
    for (const row of group.rows) {
      if (result?.gone === 'relay') {
        settle(row, () => store.close(row, 'gave_up', 'the pairing is gone'));
        continue;
      }
      const outcome = result?.gone === 'session' ? { status: 'gone' } : result?.outcomes?.[row.message_id];
      const extra = { sessionTitle: toText(result?.title) || null, relayName: toText(result?.relayName) || null };
      if (outcome && (FINAL_STATUSES.has(toText(outcome.status)) || outcome.status === 'gone')) {
        settle(row, () => store.deliver(row, { ...outcome, ...extra }));
      } else if (result?.archived) {
        settle(row, () => store.deliver(row, { status: 'gone', ...extra }));
      } else {
        keepSeen(row.message_id, seens.get(row.message_id));
        moveOn(row, at, seens.get(row.message_id));
      }
    }
  }

  /** One pass over the due rows. Resolves when it is done; a second call meanwhile waits for it. */
  function pass() {
    if (running) {
      again = true;
      return running;
    }
    running = runPass().finally(() => {
      running = null;
      if (again && started) {
        again = false;
        kick();
      }
    });
    return running;
  }

  async function runPass() {
    if (!reader) return { rows: 0, reads: 0 };
    const at = now();
    let rows = [];
    try {
      rows = store.listDue(iso(at), RELAY_EVENT_LIMITS.lateReplyRowsPerPass) || [];
    } catch (error) {
      warn(`due rows not read: ${toText(error?.message || error).slice(0, 200)}`);
      return { rows: 0, reads: 0 };
    }
    // Rows that need no read close at once; the others group by (relay, session).
    const groups = new Map();
    for (const row of rows) {
      if (lateReplyCheckDelay(ageOf(row, at), { paired: isPaired(row) }) === null) {
        settle(row, () => store.close(row, 'gave_up', `no final outcome in ${RELAY_EVENT_LIMITS.lateReplyKeepDays} days`));
        continue;
      }
      if (store.ownWaitLive(row.watcher_conversation_id, row.message_id)) {
        moveOn(row, at);
        continue;
      }
      if (!store.watcherLive(row.watcher_conversation_id)) {
        settle(row, () => store.close(row, 'undeliverable', 'the sender is gone'));
        continue;
      }
      const key = `${toText(row.relay_id)}\n${toText(row.session_id)}`;
      if (!groups.has(key)) groups.set(key, { relayId: toText(row.relay_id), sessionId: toText(row.session_id), rows: [] });
      groups.get(key).rows.push(row);
    }
    // At most lateReplyReadsPerRelay reads to a paired relay: each of its
    // due rows moves on by one pass from its own time, so the next pass
    // reads the next ones in order (the rows read now come after them), and
    // the relay's backlog does not hold back what is due elsewhere.
    const perRelay = new Map();
    const pending = [];
    for (const group of groups.values()) {
      group.rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (group.relayId !== selfRelayId) {
        const count = perRelay.get(group.relayId) || 0;
        if (count >= RELAY_EVENT_LIMITS.lateReplyReadsPerRelay) {
          // Once per relay: all its due rows, those past the pass's rows too.
          if (count === RELAY_EVENT_LIMITS.lateReplyReadsPerRelay) {
            try { store.deferRelay(group.relayId, passMs, iso(at)); } catch (error) { warn(`relay ${shortId(group.relayId)} not deferred: ${toText(error?.message || error).slice(0, 200)}`); }
            perRelay.set(group.relayId, count + 1);
          }
          continue;
        }
        perRelay.set(group.relayId, count + 1);
      }
      pending.push(group);
    }
    const failed = new Set();
    const inFlightByRelay = new Map();
    const active = new Set();
    let reads = 0;
    const startReads = () => {
      while (active.size < RELAY_EVENT_LIMITS.lateReplyReadsInFlight) {
        const index = pending.findIndex((group) => group.relayId === selfRelayId
          || (inFlightByRelay.get(group.relayId) || 0) < RELAY_EVENT_LIMITS.lateReplyReadsInFlightPerRelay);
        if (index === -1) return;
        const [group] = pending.splice(index, 1);
        if (failed.has(group.relayId)) {
          for (const row of group.rows) moveOn(row, now());
          continue;
        }
        reads += 1;
        inFlightByRelay.set(group.relayId, (inFlightByRelay.get(group.relayId) || 0) + 1);
        const task = readGroup(group, failed).finally(() => {
          inFlightByRelay.set(group.relayId, inFlightByRelay.get(group.relayId) - 1);
          active.delete(task);
        });
        active.add(task);
      }
    };
    startReads();
    while (active.size) {
      await Promise.race(active);
      startReads();
    }
    return { rows: rows.length, reads };
  }

  /** A pass soon (one timer, however many nudges). */
  function kick() {
    if (!started || kickTimer) return;
    kickTimer = setTimer(() => {
      kickTimer = null;
      void pass();
    }, 0);
  }

  /**
   * A turn of `sessionId` (on `relayId`: `self`, or a paired relay's
   * registry id) ended: its open prompts are read in the next pass, ahead
   * of any backlog (LATE_REPLY_NUDGED_AT).
   */
  function nudge(relayId, sessionId) {
    let changed = 0;
    try {
      changed = store.nudge(toText(relayId) || selfRelayId, toText(sessionId), LATE_REPLY_NUDGED_AT) || 0;
    } catch (error) {
      warn(`nudge of ${shortId(sessionId)} failed: ${toText(error?.message || error).slice(0, 200)}`);
    }
    if (changed) kick();
    return changed;
  }

  function tick() {
    tickTimer = setTimer(() => {
      tickTimer = null;
      void pass().finally(() => {
        if (started) tick();
      });
    }, passMs);
  }

  function start() {
    if (started) return;
    started = true;
    tick();
    kick();
  }

  function stop() {
    started = false;
    if (tickTimer) clearTimer(tickTimer);
    if (kickTimer) clearTimer(kickTimer);
    tickTimer = null;
    kickTimer = null;
  }

  return {
    setReader(fn) {
      reader = typeof fn === 'function' ? fn : null;
    },
    nudge,
    pass,
    start,
    stop,
    forget(messageId) {
      seenByRow.delete(toText(messageId));
    },
    seenCount: () => seenByRow.size,
  };
}
