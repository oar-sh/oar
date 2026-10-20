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
 *
 * Across a restart (`persistence`, the `background_task_rows` table): the
 * console rows survive, the live sets do not. Ended rows come back as they
 * were, for the rest of their hour. A live task with a console comes back
 * held (`restored`): its console stays readable, but no panel, state or
 * suspend check counts it as running, because only the worker can say that.
 * The worker's next set settles it: a task in the set is live again, one not
 * in it ended while the relay was away. A worker that never reports (it died
 * with the relay) has its held tasks marked ended (`endUnconfirmed`), never
 * running again. Health readings are not stored: the poller reads the files
 * again. Sub-agent rows have no console and are not stored either.
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

// A stored live row is confirmed at most this often while its worker's
// digest agrees (its `updated_at`), and one not confirmed for this long is a
// leftover of a worker that went away without a word: not restored.
const LIVE_TOUCH_EVERY_MS = 30 * 60_000;
const LIVE_STALE_MS = 6 * 60 * 60_000;

// What of a live console task is stored: what the console and an ended row
// need, not what changes with every progress post.
const STORED_LIVE_FIELDS = ['taskId', 'taskType', 'description', 'command', 'startedAt', 'outputPath', 'outputKind', 'stoppable', 'toolUseId'];

function storedLiveRow(task, ahead) {
  const row = {};
  for (const field of STORED_LIVE_FIELDS) if (task?.[field] !== undefined && task?.[field] !== null) row[field] = task[field];
  // How it ended, told before the set dropped it.
  if (ahead) row.settled = { status: ahead.status, exitCode: ahead.exitCode, ...(ahead.steps !== undefined ? { steps: ahead.steps } : {}) };
  return row;
}

export function createBackgroundTaskStore({
  now = () => Date.now(),
  endedKeepMs = TASK_OUTPUT_LIMITS.endedKeepMs,
  endedMax = TASK_OUTPUT_LIMITS.endedMax,
  persistence = null,
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
  // key → Map(taskId → row): live console tasks of the runtime before, held
  // until the worker's set says what became of them.
  const restored = new Map();
  // key → what was stored of its live console tasks last, to write only on change.
  const storedLive = new Map();
  // key → when its stored live rows were last written or confirmed.
  const touchedAt = new Map();
  // key → Map(taskId → when the runtime before last knew the held task running).
  const heldSince = new Map();
  const store = persistence && persistence.available !== false ? persistence : null;

  restore();

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
      // Tasks held since the restart: the worker's set says which still run
      // (their console is the one they had; the first path a task names
      // wins), and the others ended while the relay was away.
      const held = restored.get(id);
      if (held) {
        restored.delete(id);
        for (const [taskId, row] of held) {
          const live = next.find((task) => keyOf(task?.taskId) === taskId);
          if (live) {
            if (row.outputPath && live.outputPath !== row.outputPath) {
              live.outputPath = row.outputPath;
              live.outputKind = row.outputKind;
            }
            if (row.settled && !settledAhead.get(id)?.has(taskId)) {
              let ahead = settledAhead.get(id);
              if (!ahead) settledAhead.set(id, ahead = new Map());
              ahead.set(taskId, { ...row.settled, at: now() });
            }
            continue;
          }
          endRestored(id, row);
        }
        heldSince.delete(id);
      }
      // A task back in the set (a resync after a restart) is not ended.
      for (const taskId of nextIds) {
        if (endedRows.get(id)?.delete(taskId)) store?.remove(id, taskId);
        settledAhead.get(id)?.delete(taskId);
      }
      const health = healthByKey.get(id);
      if (health) {
        for (const taskId of [...health.keys()]) if (!nextIds.has(taskId)) health.delete(taskId);
        if (!health.size) healthByKey.delete(id);
      }
      if (next.length === 0) sets.delete(id);
      else sets.set(id, { tasks: next, updatedAt: now() });
      storeLive(id);
    },
    /**
     * How a task ended (`/api/background-task-settled`): updates its ended
     * row, or is kept for the moment the set drops it, or, for a task this
     * runtime never saw live that names its output, becomes an ended row of
     * its own. Returns the ended row when there is one.
     */
    settle(conversationId, taskId, { status, exitCode, outputPath, description, command, taskType, startedAt, outputKind, steps } = {}) {
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
        store?.saveEnded(id, existing);
        return existing;
      }
      // A task held since the restart that ended while the relay was away
      // (the worker sends the settle again): it is not running any more.
      const heldRow = restored.get(id)?.get(task);
      if (heldRow) {
        restored.get(id).delete(task);
        if (!restored.get(id).size) restored.delete(id);
        return endRestored(id, {
          ...heldRow,
          settled: { status: normalized, exitCode: code, ...(stepCount !== undefined ? { steps: stepCount } : {}) },
          ...(!heldRow.outputPath && outputPath ? { outputPath, outputKind: outputKind === 'spool' ? 'spool' : 'file' } : {}),
        });
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
        storeLive(id);
        return null;
      }
      if (!outputPath) return null;
      return addEnded(id, {
        taskId: task,
        taskType: keyOf(taskType) || 'local_bash',
        description: String(description || '').trim().slice(0, 500),
        ...(command ? { command } : {}),
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
      // Not stored: the poller reads the file again after a restart.
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
      // Held since the restart: its console is readable while the worker
      // has not reported yet.
      for (const id of ids) {
        const row = restored.get(id)?.get(task);
        if (row) {
          const { settled: _settled, ...rest } = row;
          return { key: id, task: { ...rest }, ended: false, restored: true };
        }
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
      // Tasks held since the restart are settled only by a set the worker
      // sends: until then the worker is asked for it, whatever its digest.
      if (keys.map(keyOf).some((key) => key && restored.has(key))) return false;
      const same = sameBackgroundTaskDigest(digest, this.digestFor(...keys));
      if (same) {
        for (const key of keys.map(keyOf).filter(Boolean)) {
          reported.add(key);
          // Its stored rows are still running: say so now and then, so a
          // restart can tell them from a dead worker's leftovers.
          if (store && storedLive.get(key) && now() - (touchedAt.get(key) || 0) >= LIVE_TOUCH_EVERY_MS) {
            if (store.touchLive?.(key)) touchedAt.set(key, now());
          }
        }
      }
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
    /**
     * Read only: every task held since the restart, as `{ key, task }`
     * (the stored row). Not running for any panel or check until the
     * worker's set confirms it.
     */
    listRestored() {
      const rows = [];
      for (const [key, held] of restored) {
        for (const row of held.values()) {
          const { settled, ...task } = row;
          rows.push({ key, task });
        }
      }
      return rows;
    },
    /** Whether tasks of these keys are held since the restart. */
    hasRestored(...keys) {
      return keys.map(keyOf).some((key) => key && restored.has(key));
    },
    /**
     * The workers that did not report since the restart: their held tasks
     * are marked ended (how is unknown), never running again. Returns the
     * keys whose ended rows changed.
     */
    endUnconfirmed() {
      const changed = [];
      for (const [id, held] of [...restored]) {
        restored.delete(id);
        for (const row of held.values()) endRestored(id, row);
        storeLive(id);
        changed.push(id);
      }
      return changed;
    },
    /**
     * Drops expired ended rows and pending settles of every key, also of
     * conversations nobody reads again (the per-key prune runs on reads).
     * Called from the health poller's tick.
     */
    pruneAll() {
      for (const id of new Set([...endedRows.keys(), ...settledAhead.keys()])) prune(id);
      store?.pruneEnded(now() - endedKeepMs);
    },
    /** The conversation is gone: everything held for these keys goes. */
    forget(...keys) {
      const ids = keys.map(keyOf).filter(Boolean);
      if (ids.length) store?.forget(ids);
      for (const id of ids) {
        restored.delete(id);
        heldSince.delete(id);
        touchedAt.delete(id);
        storedLive.delete(id);
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

  // The rows the runtime before kept: ended rows for the rest of their
  // hour, live console tasks held for the worker's word.
  function restore() {
    if (!store) return;
    const cutoff = now() - endedKeepMs;
    const ended = [];
    for (const entry of store.load()) {
      const id = keyOf(entry.key);
      const taskId = keyOf(entry.taskId);
      if (!id || !taskId) continue;
      if (entry.state === 'ended') {
        const endedAt = Number(entry.endedAt ?? entry.row.endedAt);
        if (!Number.isFinite(endedAt) || endedAt < cutoff) continue;
        ended.push({ id, row: { ...entry.row, taskId, endedAt, stoppable: false } });
        continue;
      }
      if (entry.state !== 'live') continue;
      // Not confirmed for hours: its worker went away in a runtime before
      // without a word. Nothing to show, now or as an ended row.
      const since = Number(entry.updatedAt);
      if (!Number.isFinite(since) || now() - since > LIVE_STALE_MS) {
        store.remove(id, taskId);
        continue;
      }
      let held = restored.get(id);
      if (!held) restored.set(id, held = new Map());
      held.set(taskId, { ...entry.row, taskId });
      let sinceOf = heldSince.get(id);
      if (!sinceOf) heldSince.set(id, sinceOf = new Map());
      sinceOf.set(taskId, Math.min(since, now()));
      storedLive.set(id, null);
    }
    // Oldest first, as `addEnded` keeps them.
    ended.sort((a, b) => a.row.endedAt - b.row.endedAt);
    for (const { id, row } of ended) {
      let rows = endedRows.get(id);
      if (!rows) endedRows.set(id, rows = new Map());
      rows.set(row.taskId, row);
      while (rows.size > endedMax) rows.delete(rows.keys().next().value);
    }
    store.pruneEnded(cutoff);
  }

  // A held task that is not running any more becomes an ended row, with how
  // it ended when the runtime before was told.
  // It ended at the latest when the runtime before last knew it running, so
  // that is its end time: a leftover from long ago does not count as fresh.
  function endRestored(id, row) {
    const { settled, ...task } = row;
    const since = heldSince.get(id)?.get(keyOf(task.taskId));
    heldSince.get(id)?.delete(keyOf(task.taskId));
    if (!heldSince.get(id)?.size) heldSince.delete(id);
    return addEnded(id, {
      ...task,
      ...(settled?.steps !== undefined ? { steps: settled.steps } : {}),
      status: settled?.status || 'unknown',
      exitCode: settled ? settled.exitCode : null,
    }, { endedAt: Number.isFinite(since) ? since : undefined });
  }

  // Stores the key's live console tasks when they changed (what is stored,
  // not every progress post).
  function storeLive(id) {
    if (!store) return;
    const ahead = settledAhead.get(id);
    const rows = (sets.get(id)?.tasks || [])
      .filter((task) => task?.outputPath && keyOf(task?.taskId))
      .map((task) => storedLiveRow(task, ahead?.get(keyOf(task.taskId))));
    // Held tasks stay stored until the worker's set settles them.
    for (const row of restored.get(id)?.values() || []) rows.push(row);
    const signature = JSON.stringify(rows);
    if (storedLive.get(id) === signature) return;
    if (!rows.length && !storedLive.has(id)) return;
    if (store.saveLive(id, rows)) {
      touchedAt.set(id, now());
      if (rows.length) storedLive.set(id, signature);
      else storedLive.delete(id);
    }
  }

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

  function addEnded(id, task, { endedAt = now() } = {}) {
    let rows = endedRows.get(id);
    if (!rows) endedRows.set(id, rows = new Map());
    const taskId = keyOf(task.taskId);
    rows.delete(taskId);
    const row = {
      ...task,
      taskId,
      status: normalizeEndedTaskStatus(task.status, exitCodeOf(task.exitCode)),
      exitCode: exitCodeOf(task.exitCode),
      endedAt,
      stoppable: false,
    };
    if (!row.health) delete row.health;
    rows.set(taskId, row);
    settledAhead.get(id)?.delete(taskId);
    store?.saveEnded(id, row);
    while (rows.size > endedMax) {
      const oldest = rows.keys().next().value;
      rows.delete(oldest);
      store?.remove(id, oldest);
    }
    prune(id);
    return row;
  }
}
