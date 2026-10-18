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
 *
 * Ended tasks: a task that leaves the set while it names an `outputPath` (a
 * shell or Monitor task with a console) is kept as an ended row for an hour,
 * at most 20 per key, so the panel can still show how it ended and open its
 * output. A settle post (`settle`) says how; one that arrives before the set
 * drops the task is kept until it does. Memory only, like the sets.
 *
 * Health: the health poller's last reading per live task (`setHealth`), served
 * with the task rows (`withHealth`) and carried onto the ended row, where the
 * poller's reading after the end replaces it (`setEndedHealth`).
 */

import { backgroundTaskDigest, sameBackgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';
import { TASK_OUTPUT_LIMITS } from '../../shared/task-output-text.mjs';

function keyOf(value) {
  return String(value || '').trim();
}

const ENDED_STATUSES = new Set(['completed', 'failed', 'stopped', 'unknown']);

/** A worker's word for how a task ended, as one of completed, failed, stopped, unknown. */
export function normalizeEndedTaskStatus(status, exitCode = null) {
  const text = String(status || '').trim().toLowerCase();
  if (ENDED_STATUSES.has(text)) return text;
  if (['complete', 'done', 'success', 'succeeded', 'ok', 'exited'].includes(text)) {
    return Number.isInteger(exitCode) && exitCode !== 0 ? 'failed' : 'completed';
  }
  if (['error', 'errored', 'failure'].includes(text)) return 'failed';
  if (['killed', 'cancelled', 'canceled', 'aborted', 'interrupted', 'timeout', 'timed_out'].includes(text)) return 'stopped';
  if (Number.isInteger(exitCode)) return exitCode === 0 ? 'completed' : 'failed';
  return 'unknown';
}

function exitCodeOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

export function createBackgroundTaskStore({
  now = () => Date.now(),
  endedKeepMs = TASK_OUTPUT_LIMITS.endedKeepMs,
  endedMax = TASK_OUTPUT_LIMITS.endedMax,
} = {}) {
  const sets = new Map();
  // key → Map(taskId → ended row), newest last.
  const endedRows = new Map();
  // key → Map(taskId → { status, exitCode, outputPath, at }): how a task
  // ended, told before the set dropped it.
  const settledAhead = new Map();
  // key → Map(taskId → the health poller's last reading).
  const healthByKey = new Map();
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
      const next = Array.isArray(tasks) ? tasks : [];
      const nextIds = new Set(next.map((task) => keyOf(task?.taskId)).filter(Boolean));
      // Tasks that left the set with a console become ended rows.
      for (const task of sets.get(id)?.tasks || []) {
        const taskId = keyOf(task?.taskId);
        if (!taskId || nextIds.has(taskId) || !task?.outputPath) continue;
        const ahead = settledAhead.get(id)?.get(taskId) || null;
        addEnded(id, {
          ...task,
          ...(ahead?.steps !== undefined ? { steps: ahead.steps } : {}),
          status: ahead?.status || 'unknown',
          exitCode: ahead ? ahead.exitCode : (task.exitCode ?? null),
          health: healthByKey.get(id)?.get(taskId) || task.health || undefined,
        });
      }
      // A task back in the set (a resync after a restart) is not ended.
      for (const taskId of nextIds) {
        endedRows.get(id)?.delete(taskId);
        settledAhead.get(id)?.delete(taskId);
      }
      const health = healthByKey.get(id);
      if (health) {
        for (const taskId of [...health.keys()]) if (!nextIds.has(taskId)) health.delete(taskId);
        if (!health.size) healthByKey.delete(id);
      }
      if (next.length === 0) {
        sets.delete(id);
        return;
      }
      sets.set(id, { tasks: next, updatedAt: now() });
    },
    /**
     * How a task ended (`/api/background-task-settled`): updates its ended
     * row, or is kept for the moment the set drops it, or, for a task this
     * runtime never saw live that names its output, becomes an ended row of
     * its own. Returns the ended row when there is one.
     */
    settle(conversationId, taskId, { status, exitCode, outputPath, description, taskType, startedAt, outputKind, steps } = {}) {
      const id = keyOf(conversationId);
      const task = keyOf(taskId);
      if (!id || !task) return null;
      prune(id);
      const code = exitCodeOf(exitCode);
      const normalized = normalizeEndedTaskStatus(status, code);
      const stepCount = Number.isInteger(steps) && steps >= 0 ? steps : undefined;
      const existing = endedRows.get(id)?.get(task);
      if (existing) {
        existing.status = normalized;
        existing.exitCode = code;
        if (!existing.outputPath && outputPath) {
          existing.outputPath = outputPath;
          if (existing.outputKind !== 'file' && existing.outputKind !== 'spool') existing.outputKind = outputKind === 'spool' ? 'spool' : 'file';
        }
        if (stepCount !== undefined) existing.steps = stepCount;
        return existing;
      }
      const live = (sets.get(id)?.tasks || []).find((entry) => keyOf(entry?.taskId) === task);
      if (live) {
        let ahead = settledAhead.get(id);
        if (!ahead) settledAhead.set(id, ahead = new Map());
        ahead.set(task, { status: normalized, exitCode: code, steps: stepCount, at: now() });
        // The first path a task names wins. A row that had none was read
        // from a snapshot (or not at all): from now on it is the file.
        if (outputPath && !live.outputPath) {
          live.outputPath = outputPath;
          if (live.outputKind !== 'file' && live.outputKind !== 'spool') live.outputKind = outputKind === 'spool' ? 'spool' : 'file';
        }
        return null;
      }
      if (!outputPath) return null;
      return addEnded(id, {
        taskId: task,
        taskType: keyOf(taskType) || 'local_bash',
        description: String(description || '').trim().slice(0, 500),
        startedAt: Number(startedAt) || null,
        outputPath,
        outputKind: outputKind || 'file',
        stoppable: false,
        status: normalized,
        exitCode: code,
        ...(stepCount !== undefined ? { steps: stepCount } : {}),
      });
    },
    /** The ended rows of these keys, newest first. */
    ended(...keys) {
      const rows = [];
      for (const id of new Set(keys.map(keyOf).filter(Boolean))) {
        prune(id);
        rows.push(...(endedRows.get(id)?.values() || []));
      }
      return rows.sort((a, b) => b.endedAt - a.endedAt).map((row) => ({ ...row }));
    },
    /** The poller's last reading for a live task, or null. */
    health(conversationId, taskId) {
      return healthByKey.get(keyOf(conversationId))?.get(keyOf(taskId)) || null;
    },
    setHealth(conversationId, taskId, value) {
      const id = keyOf(conversationId);
      const task = keyOf(taskId);
      if (!id || !task) return;
      let health = healthByKey.get(id);
      if (!value) {
        health?.delete(task);
        return;
      }
      if (!health) healthByKey.set(id, health = new Map());
      health.set(task, value);
    },
    /** The keys that hold ended rows. */
    endedKeys() {
      return [...endedRows.keys()];
    },
    /**
     * The poller's reading of an ended task's file, taken after the end: the
     * last output (a test runner's summary) often lands between two readings
     * of the live task. Returns false when there is no such row.
     */
    setEndedHealth(conversationId, taskId, value) {
      const row = endedRows.get(keyOf(conversationId))?.get(keyOf(taskId));
      if (!row || !value) return false;
      row.health = value;
      return true;
    },
    /** Task rows with the poller's last reading on each as `health`. */
    withHealth(tasks, ...keys) {
      const ids = keys.map(keyOf).filter(Boolean);
      return (Array.isArray(tasks) ? tasks : []).map((task) => {
        const taskId = keyOf(task?.taskId);
        const health = ids.map((id) => healthByKey.get(id)?.get(taskId)).find(Boolean);
        return health ? { ...task, health } : task;
      });
    },
    /**
     * A task of these keys, live or ended: `{ key, task, ended }` or null.
     * The live set wins over an ended row.
     */
    findTask(keys, taskId) {
      const task = keyOf(taskId);
      const ids = [...new Set((Array.isArray(keys) ? keys : [keys]).map(keyOf).filter(Boolean))];
      if (!task) return null;
      for (const id of ids) {
        const live = (sets.get(id)?.tasks || []).find((entry) => keyOf(entry?.taskId) === task);
        if (live) {
          const health = healthByKey.get(id)?.get(task);
          return { key: id, task: health ? { ...live, health } : live, ended: false };
        }
      }
      for (const id of ids) {
        prune(id);
        const row = endedRows.get(id)?.get(task);
        if (row) return { key: id, task: { ...row }, ended: true };
      }
      return null;
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
    /**
     * Drops expired ended rows and pending settles of every key, also of
     * conversations nobody reads again (the per-key prune runs on reads).
     * Called from the health poller's tick.
     */
    pruneAll() {
      for (const id of new Set([...endedRows.keys(), ...settledAhead.keys()])) prune(id);
    },
    forget(...keys) {
      for (const id of keys.map(keyOf).filter(Boolean)) {
        sets.delete(id);
        reported.delete(id);
        applied.delete(id);
        holders.delete(id);
        announced.delete(id);
        endedRows.delete(id);
        settledAhead.delete(id);
        healthByKey.delete(id);
      }
    },
  };

  function prune(id) {
    const cutoff = now() - endedKeepMs;
    const rows = endedRows.get(id);
    if (rows) {
      for (const [taskId, row] of rows) if (row.endedAt < cutoff) rows.delete(taskId);
      if (!rows.size) endedRows.delete(id);
    }
    const ahead = settledAhead.get(id);
    if (ahead) {
      for (const [taskId, entry] of ahead) if (entry.at < cutoff) ahead.delete(taskId);
      if (!ahead.size) settledAhead.delete(id);
    }
  }

  function addEnded(id, task) {
    let rows = endedRows.get(id);
    if (!rows) endedRows.set(id, rows = new Map());
    const taskId = keyOf(task.taskId);
    rows.delete(taskId);
    const row = {
      ...task,
      taskId,
      status: normalizeEndedTaskStatus(task.status, exitCodeOf(task.exitCode)),
      exitCode: exitCodeOf(task.exitCode),
      endedAt: now(),
      stoppable: false,
    };
    if (!row.health) delete row.health;
    rows.set(taskId, row);
    settledAhead.get(id)?.delete(taskId);
    while (rows.size > endedMax) rows.delete(rows.keys().next().value);
    prune(id);
    return row;
  }
}
