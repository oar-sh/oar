'use strict';

/**
 * Live background-task sets, published by the session workers (REPLACE
 * semantics, mirroring the SDK's background_tasks_changed signal) and keyed
 * by the id the worker posts, its SDK session id.
 *
 * Memory only, and a relay restart starts it empty while the workers and
 * their tasks keep running. The worker is the source of truth: its heartbeat
 * carries a digest of its task ids, the relay compares it with the set held
 * here and asks for the full set when the two differ (a restart, a lost
 * post). `reported` remembers which workers this runtime has heard from
 * about their tasks at all: until then "no set" means "not told yet", not
 * "no tasks".
 */

import { backgroundTaskDigest, sameBackgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';

function keyOf(value) {
  return String(value || '').trim();
}

export function createBackgroundTaskStore({ now = () => Date.now() } = {}) {
  const sets = new Map();
  const reported = new Set();
  // key → the order of the newest set applied, `{ epoch, seq }` as the
  // worker numbered it. `epoch` names the worker process; it is compared
  // for equality only, never as a time.
  const applied = new Map();
  // key → the pid of the worker process whose heartbeat came last: the
  // process that holds the session, by the worker's own word.
  const holders = new Map();
  // Keys whose pages were told of the placeholder for unreported work.
  const announced = new Set();

  return {
    sets,
    replace(conversationId, tasks) {
      const id = keyOf(conversationId);
      if (!id) return;
      reported.add(id);
      if (!Array.isArray(tasks) || tasks.length === 0) {
        sets.delete(id);
        return;
      }
      sets.set(id, { tasks, updatedAt: now() });
    },
    get(conversationId) {
      return sets.get(keyOf(conversationId))?.tasks || [];
    },
    /** The digest of the set held under the first of `keys` that has one. */
    digestFor(...keys) {
      const held = keys.map(keyOf).find((key) => key && sets.has(key));
      return backgroundTaskDigest((held ? sets.get(held).tasks : []).map((task) => task?.taskId));
    },
    /**
     * A worker's heartbeat digest against the set held for it: true when
     * they agree. Agreement counts as a report, an empty set included.
     */
    matches(digest, ...keys) {
      const same = sameBackgroundTaskDigest(digest, this.digestFor(...keys));
      if (same) for (const key of keys.map(keyOf).filter(Boolean)) reported.add(key);
      return same;
    },
    /** Whether this runtime has heard from the worker about its tasks. */
    hasReport(...keys) {
      return keys.map(keyOf).some((key) => key && reported.has(key));
    },
    /**
     * Whether a set with this order may be applied, as `{ accepted, reason }`.
     * Accepting records it. `seq` is the worker process's count of set
     * posts, `epoch` names that process. A set without an order, from a
     * worker that numbers none, always applies.
     *
     * Refused are:
     *  - `older`: same process, a count not above the newest applied. The
     *    post was overtaken on the way.
     *  - `not-holder`: the post's `pid` is not the pid of the process whose
     *    heartbeat came last for the session (`noteHolder`): a late post of
     *    the process before it, or a new process that has not beaten yet,
     *    which is told so and beats.
     *
     * A different epoch from the holder, or from a process that cannot be
     * placed (no pid on the post, no heartbeat yet), is a new process and
     * starts the count over, whichever of the two epochs is the larger: a clock that
     * stepped back between two starts must not turn every set away. A late
     * post that slips through that way is put right by the next heartbeat's
     * digest.
     */
    acceptOrder(conversationId, order, { pid = null } = {}) {
      const id = keyOf(conversationId);
      const epoch = Number(order?.epoch);
      const seq = Number(order?.seq);
      if (!id || !Number.isFinite(epoch) || !Number.isInteger(seq) || seq < 0) return { accepted: true, reason: null };
      const holder = holders.get(id);
      const from = Number(pid);
      if (holder && Number.isInteger(from) && from > 0 && from !== holder) return { accepted: false, reason: 'not-holder' };
      const last = applied.get(id);
      if (last && epoch === last.epoch && seq <= last.seq) return { accepted: false, reason: 'older' };
      applied.set(id, { epoch, seq });
      return { accepted: true, reason: null };
    },
    /** A heartbeat of the session's worker came from this process. */
    noteHolder(conversationId, pid) {
      const id = keyOf(conversationId);
      const from = Number(pid);
      if (id && Number.isInteger(from) && from > 0) holders.set(id, from);
    },
    /** Records whether the pages know of the key's placeholder; true when that changed. */
    announce(conversationId, shown) {
      const id = keyOf(conversationId);
      if (!id || announced.has(id) === !!shown) return false;
      if (shown) announced.add(id);
      else announced.delete(id);
      return true;
    },
    /** The conversation is gone: everything held for these keys goes. */
    forget(...keys) {
      for (const id of keys.map(keyOf).filter(Boolean)) {
        sets.delete(id);
        reported.delete(id);
        applied.delete(id);
        holders.delete(id);
        announced.delete(id);
      }
    },
  };
}
