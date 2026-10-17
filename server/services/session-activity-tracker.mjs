'use strict';

/**
 * What each session of this relay is doing right now: a turn, background
 * tasks only, or nothing, with the tasks themselves and when anything last
 * moved.
 *
 * `list_sessions` / `read_session` read it as `state` and `tasks[]`; the
 * relay event service reads its edges (a task started or ended) and its quiet
 * time (stalled). Memory only, and a restart of the relay starts it empty
 * while the workers and their tasks keep running. What brings a running
 * task back:
 *  - the worker sends its set again when the relay asks for it on a
 *    heartbeat (`noteTaskSet` with `resync`), which restores the task with
 *    its original start time and without a second `task_started`;
 *  - sub-agent runs are read from the database;
 *  - a worker that cannot send its set again yet but says it has background
 *    work shows one placeholder task (`hasUnreportedBackgroundWork`).
 * Until the workers had time to report, `bootReporting()` says so: the
 * suspend check and `all_idle` wait that long. The recently finished tasks
 * and the activity clock are gone for good (the clock starts at the restart,
 * so nothing reads as stalled at boot).
 *
 * Sources:
 *  - `noteTaskSet` — every POST /api/background-tasks (REPLACE semantics):
 *    a new task id is a start, a task gone from the set has ended, a changed
 *    task (tool call, summary, tokens) is activity. A task that started
 *    before this runtime did was announced by the runtime before it.
 *  - `noteTaskSettled` — how a task ended, where the worker says so (the
 *    Claude worker's task_notification). A task this runtime never knew
 *    still gets its end event when the worker describes it.
 *  - `noteSubagentRun` — every sub-agent run status the relay stores; a
 *    background run's terminal status is how its task ended, and a
 *    background run with no task in the set (Copilot, Cursor) ends here.
 *  - `touch` — any activity, thought, stream or timeline post.
 */

import { isTerminalSubagentRunStatus, normalizeSubagentRunStatus } from '../../shared/subagent-timeline.mjs';

export const SESSION_STATES = Object.freeze(['running_turn', 'background_only', 'idle']);

// How long a task gone from the set waits for the word on how it ended.
export const TASK_END_GRACE_MS = 5_000;
// A `running` run row not touched for this long is not running work: its
// worker's record of its end never arrived (live: rows months old still
// `running`, counted as a running task by every reader, so a subscription
// to all sessions never saw all_idle and reported the session stalled
// again and again). The sweep in stale-subagent-run-sweep.mjs closes such
// rows; this bound keeps them out of the state meanwhile.
export const STALE_RUNNING_RUN_MAX_AGE_MS = 24 * 60 * 60_000;
// How long after a runtime start the surviving workers may still be
// reporting their tasks: four heartbeat periods and a little. Inside it an
// idle-looking relay is not known to be idle.
export const BOOT_REPORTING_WINDOW_MS = 45_000;
// The most an override may ask for: a window is a hold on suspends and on
// all_idle, and timers take no delay above 2^31 ms.
export const BOOT_REPORTING_WINDOW_MAX_MS = 10 * 60_000;
/**
 * The window of this runtime: BOOT_REPORTING_WINDOW_MS, unless
 * OAR_BOOT_REPORTING_WINDOW_MS pins another, from 0 (no hold at all: a test
 * relay that must read as idle straight after its start) to
 * BOOT_REPORTING_WINDOW_MAX_MS. An override in effect is logged once; a
 * value that is no number, or below 0, is ignored and logged too.
 */
export function resolveBootReportingWindowMs(env = process.env, log = () => {}) {
  const raw = String(env?.OAR_BOOT_REPORTING_WINDOW_MS ?? '').trim();
  if (!raw) return BOOT_REPORTING_WINDOW_MS;
  const pinned = Number(raw);
  if (!Number.isFinite(pinned) || pinned < 0) {
    log(`OAR_BOOT_REPORTING_WINDOW_MS=${raw.slice(0, 40)} is not a number of milliseconds from 0; using ${BOOT_REPORTING_WINDOW_MS}`);
    return BOOT_REPORTING_WINDOW_MS;
  }
  const windowMs = Math.min(BOOT_REPORTING_WINDOW_MAX_MS, Math.trunc(pinned));
  log(windowMs === 0
    ? 'OAR_BOOT_REPORTING_WINDOW_MS=0: no wait after a relay start; a suspend and all_idle do not wait for sessions that are still reporting'
    : `OAR_BOOT_REPORTING_WINDOW_MS: a suspend and all_idle wait ${windowMs} ms after a relay start${windowMs === pinned ? '' : ` (asked for ${raw.slice(0, 40)}, kept within 0 to ${BOOT_REPORTING_WINDOW_MAX_MS})`}`);
  return windowMs;
}
// The one task shown for a worker that reports background work the relay
// was never told the details of.
export const UNREPORTED_BACKGROUND_TASK_ID = 'unreported-background-work';
// It stays until the worker reports, and a worker on older code never does
// for a task that prints nothing: the way out is the session's Kill session.
export const UNREPORTED_BACKGROUND_TASK_DESCRIPTION = 'background work, details not reported since the relay restarted (Kill session in its ⋯ menu ends it)';
// A `running` background run row that its worker's task set does not list
// and nothing has updated for this long is not running work (see
// `runListedByWorker`).
export const UNLISTED_RUNNING_RUN_MAX_QUIET_MS = 15 * 60_000;
const RECENT_TASKS_MAX = 5;
const RECENT_TASK_TTL_MS = 60 * 60_000;
const SHELL_TASK_TYPES = new Set(['local_bash', 'bash', 'shell', 'monitor', 'local_monitor']);
const EXIT_CODE_PATTERN = /exit(?:ed)?(?: with)?(?: code| status)?[:\s]+(-?\d{1,3})\b/i;

function toText(value) {
  return String(value ?? '').trim();
}

function isoOf(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function msOf(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function taskKindOf(taskType) {
  return SHELL_TASK_TYPES.has(toText(taskType).toLowerCase()) ? 'shell' : 'subagent';
}

/** An exit code a task summary names ("Exit code 2", "exited with 1"), else null. */
export function exitCodeFromSummary(summary) {
  const match = EXIT_CODE_PATTERN.exec(String(summary || ''));
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

/** The status words of a task: running, completed, failed, stopped. */
export function normalizeTaskStatus(status) {
  const value = normalizeSubagentRunStatus(status);
  if (value === 'cancelled') return 'stopped';
  if (value === 'running' || value === 'completed' || value === 'failed') return value;
  return value ? 'completed' : 'running';
}

function taskSignature(task) {
  return JSON.stringify([
    task.summary || null,
    task.lastToolName || null,
    task.lastToolCall || null,
    task.totalTokens ?? null,
    task.workflowProgress ? JSON.stringify(task.workflowProgress).length : 0,
  ]);
}

export function createSessionActivityTracker({
  db = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  onEdge = () => {},
  // conversationId → whether its live worker reports background work that no
  // task set describes (see the placeholder in `describe`).
  hasUnreportedBackgroundWork = () => false,
  // The conversations that may be true for, so that readers which only ask
  // about the conversations this tracker knows ask about them too.
  listUnreportedBackgroundWork = () => [],
  // (conversationId, runRow) → whether the task set of the conversation's
  // worker lists the run: true, false, or null when the worker has reported
  // no set in this runtime or its sets do not speak for its runs. A
  // `running` background row that is not listed and that nothing has
  // updated for UNLISTED_RUNNING_RUN_MAX_QUIET_MS is a row whose end was
  // never written: it is kept out of the state, as the day-old ones are.
  runListedByWorker = () => null,
  bootReportingWindowMs = BOOT_REPORTING_WINDOW_MS,
  logger = console,
} = {}) {
  const startedAtMs = now();
  // conversationId → { live: Map<taskId, entry>, recent: [], lastActivityAt }
  const sessions = new Map();
  // Edges already reported for an end, by `${conversationId}:${key}`.
  const endedKeys = new Map();
  // `${conversationId}:${taskId}` of the ends nobody reported: the task was
  // only missing from a set for the grace. A later set that lists it again
  // says it never ended.
  const endedByAbsence = new Set();

  let listRuns = null;
  let getQueueRows = null;
  if (db) {
    try {
      listRuns = db.prepare(`
        SELECT * FROM subagent_runs
        WHERE conversation_id = ? AND (status = 'running' OR COALESCE(completed_at, updated_at) >= ?)
          AND parent_subagent_id IS NULL
        ORDER BY started_at ASC
        LIMIT 50
      `);
    } catch {}
    try {
      getQueueRows = db.prepare(`
        SELECT id, status, timestamp, processing_at, next_attempt_at, usage_limit_pause
        FROM queue WHERE conversation_id = ? AND status IN ('pending', 'processing', 'parked')
      `);
    } catch {}
  }

  function session(conversationId) {
    const id = toText(conversationId);
    let entry = sessions.get(id);
    if (!entry) {
      entry = { live: new Map(), recent: [], lastActivityAt: 0 };
      sessions.set(id, entry);
    }
    return entry;
  }

  function emitEdge(type, conversationId, task) {
    try {
      onEdge({ type, conversationId, task: publicTask(task) });
    } catch (error) {
      try { logger?.warn?.(`[activity] edge handler failed: ${error?.message || error}`); } catch {}
    }
  }

  function markEnded(conversationId, task) {
    const at = now();
    for (const key of [task.taskId, task.toolUseId ? `run:${task.toolUseId}` : '']) {
      if (key) endedKeys.set(`${conversationId}:${key}`, at);
    }
    if (endedKeys.size > 2000) {
      for (const [key, when] of endedKeys) {
        if (at - when > RECENT_TASK_TTL_MS) {
          endedKeys.delete(key);
          endedByAbsence.delete(key);
        }
      }
    }
  }

  function wasEnded(conversationId, task) {
    return [task.taskId, task.toolUseId ? `run:${task.toolUseId}` : '']
      .some((key) => key && endedKeys.has(`${conversationId}:${key}`));
  }

  function publicTask(task) {
    return {
      id: task.taskId || task.toolUseId || null,
      kind: task.kind,
      type: task.taskType || null,
      description: task.description || '',
      startedAt: isoOf(task.startedAtMs),
      lastActivityAt: isoOf(task.lastActivityAtMs || task.startedAtMs),
      status: task.status,
      ...(task.exitCode !== null && task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.status !== 'running' && task.statusReported === false ? { statusReported: false } : {}),
      ...(task.summary ? { summary: task.summary } : {}),
      ...(task.endedAtMs ? { endedAt: isoOf(task.endedAtMs) } : {}),
      ...(task.toolUseId ? { runId: task.toolUseId } : {}),
      ...(task.model ? { model: task.model } : {}),
    };
  }

  function finishTask(conversationId, task, { status, summary = null, exitCode = null, reported = true, absent = false } = {}) {
    if (task.graceTimer) {
      clearTimer(task.graceTimer);
      task.graceTimer = null;
    }
    const entry = session(conversationId);
    entry.live.delete(task.taskId);
    if (wasEnded(conversationId, task)) return;
    task.status = normalizeTaskStatus(status || 'completed');
    task.statusReported = reported;
    if (summary) task.summary = toText(summary).slice(0, 500);
    const code = Number.isInteger(exitCode) ? exitCode : exitCodeFromSummary(task.summary);
    task.exitCode = code;
    task.endedAtMs = now();
    markEnded(conversationId, task);
    if (absent) endedByAbsence.add(`${conversationId}:${task.taskId}`);
    entry.recent.unshift(task);
    entry.recent.length = Math.min(entry.recent.length, RECENT_TASKS_MAX);
    entry.lastActivityAt = Math.max(entry.lastActivityAt, task.endedAtMs);
    const failed = task.status === 'failed' || task.status === 'stopped' || (code !== null && code !== 0);
    emitEdge(failed ? 'task_failed' : 'task_finished', conversationId, task);
  }

  function runStatus(runId) {
    if (!db || !runId) return null;
    try {
      const row = db.prepare(`SELECT status FROM subagent_runs WHERE id = ?`).get(runId);
      return row ? normalizeSubagentRunStatus(row.status) : null;
    } catch {
      return null;
    }
  }

  /** A task left the set: settle it now if its end is known, else after the grace. */
  function taskLeft(conversationId, task) {
    if (task.settled) {
      finishTask(conversationId, task, task.settled);
      return;
    }
    const status = runStatus(task.toolUseId);
    if (status && isTerminalSubagentRunStatus(status)) {
      finishTask(conversationId, task, { status });
      return;
    }
    task.leftAtMs = now();
    task.graceTimer = setTimer(() => {
      task.graceTimer = null;
      const late = runStatus(task.toolUseId);
      if (late && isTerminalSubagentRunStatus(late)) finishTask(conversationId, task, { status: late });
      else finishTask(conversationId, task, { status: 'completed', reported: false, absent: true });
    }, TASK_END_GRACE_MS);
  }

  /** Takes back an end that was only an absence; the task's old row goes from the recent ones. */
  function unEnd(conversationId, entry, taskId, toolUseId) {
    endedByAbsence.delete(`${conversationId}:${taskId}`);
    const index = entry.recent.findIndex((task) => task.taskId === taskId);
    const [old] = index >= 0 ? entry.recent.splice(index, 1) : [null];
    for (const key of [taskId, toolUseId ? `run:${toolUseId}` : '', old?.toolUseId ? `run:${old.toolUseId}` : '']) {
      if (key) endedKeys.delete(`${conversationId}:${key}`);
    }
    return old;
  }

  /**
   * `resync`: the set is the worker's answer to the relay asking for it
   * again, not a change of the set.
   */
  function noteTaskSet(conversationId, tasks, { resync = false } = {}) {
    const id = toText(conversationId);
    if (!id) return;
    const entry = session(id);
    const at = now();
    const seen = new Set();
    for (const raw of Array.isArray(tasks) ? tasks : []) {
      const taskId = toText(raw?.taskId);
      if (!taskId) continue;
      seen.add(taskId);
      const signature = taskSignature(raw);
      const known = entry.live.get(taskId);
      if (known && !known.leftAtMs) {
        if (known.signature !== signature) {
          known.signature = signature;
          known.lastActivityAtMs = at;
          entry.lastActivityAt = at;
        }
        known.description = toText(raw.description) || known.description;
        known.toolUseId = toText(raw.toolUseId) || known.toolUseId;
        known.summary = toText(raw.summary) || known.summary;
        known.model = toText(raw.model) || known.model;
        continue;
      }
      if (known?.leftAtMs) {
        // Back in the set after it left: it did not end after all.
        if (known.graceTimer) clearTimer(known.graceTimer);
        known.graceTimer = null;
        known.leftAtMs = 0;
        continue;
      }
      let revived = null;
      if (wasEnded(id, { taskId, toolUseId: toText(raw.toolUseId) })) {
        // Settled already (its notice came before the set dropped it).
        if (!endedByAbsence.has(`${id}:${taskId}`)) continue;
        // Ended only because a set did not list it (a set that arrived out
        // of turn, a worker that left it out for a moment) and listed
        // again: it never ended. It comes back as the task it was, with no
        // second start. The end that was reported for it stays reported;
        // its real end will be another.
        revived = unEnd(id, entry, taskId, toText(raw.toolUseId)) || {};
      }
      const taskStartedAtMs = msOf(raw.startedAt);
      const task = {
        taskId,
        toolUseId: toText(raw.toolUseId) || null,
        taskType: toText(raw.taskType),
        kind: taskKindOf(raw.taskType),
        description: toText(raw.description).slice(0, 500),
        startedAtMs: taskStartedAtMs || revived?.startedAtMs || at,
        lastActivityAtMs: at,
        summary: toText(raw.summary) || null,
        model: toText(raw.model) || null,
        status: 'running',
        signature,
        settled: null,
        graceTimer: null,
        leftAtMs: 0,
      };
      entry.live.set(taskId, task);
      entry.lastActivityAt = at;
      // A task older than this runtime was announced by the one before it,
      // whichever post brings it back (the resync, or a progress update that
      // overtakes it). One that started since is new even in a resync: its
      // first post was lost. Without a start time a resync decides.
      const announcedBefore = taskStartedAtMs ? taskStartedAtMs < startedAtMs : resync;
      if (!announcedBefore && !revived) emitEdge('task_started', id, task);
    }
    for (const task of [...entry.live.values()]) {
      if (seen.has(task.taskId) || task.leftAtMs) continue;
      taskLeft(id, task);
    }
  }

  function noteTaskSettled(conversationId, {
    taskId, toolUseId, status, summary, exitCode, description, taskType, startedAt,
  } = {}) {
    const id = toText(conversationId);
    if (!id) return;
    const entry = session(id);
    const key = toText(taskId);
    const run = toText(toolUseId);
    const task = (key && entry.live.get(key))
      || [...entry.live.values()].find((candidate) => run && candidate.toolUseId === run)
      || null;
    const settled = {
      status: normalizeTaskStatus(status || 'completed'),
      summary: toText(summary) || null,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
    };
    entry.lastActivityAt = now();
    if (!task && key && endedByAbsence.delete(`${id}:${key}`)) {
      // It was taken for ended when a set no longer listed it; this is the
      // word on how it ended. A real end is final: no later set brings the
      // task back.
      const ended = entry.recent.find((candidate) => candidate.taskId === key);
      if (ended) {
        ended.status = settled.status;
        ended.statusReported = true;
        if (settled.summary) ended.summary = settled.summary.slice(0, 500);
        ended.exitCode = settled.exitCode ?? exitCodeFromSummary(ended.summary);
      }
      return;
    }
    if (!task) {
      // A task this runtime never knew (it ended while the relay was away, or
      // its set never arrived): the end is still an event when the worker
      // says what the task was. Once only, like every end: a sub-agent's
      // end also comes as its run's status, so the notice is paired with
      // the run that carries its task id when it names no run. (With no
      // such link the two are two ends; rare, and better than a guess.)
      if (!key || !toText(description)) return;
      const runId = run || (taskKindOf(taskType) === 'subagent'
        ? runOfUnknownTask(id, { taskId: key })
        : '');
      const unknown = {
        taskId: key,
        toolUseId: runId || null,
        taskType: toText(taskType),
        kind: taskKindOf(taskType),
        description: toText(description).slice(0, 500),
        startedAtMs: msOf(startedAt) || now(),
        lastActivityAtMs: now(),
        summary: null,
        model: null,
        status: 'running',
      };
      finishTask(id, unknown, settled);
      return;
    }
    task.settled = settled;
    // Gone from the set already, or about to: settle now either way. A task
    // still listed would leave with this status anyway.
    finishTask(id, task, settled);
  }

  /**
   * The background run a described settle notice without a run id speaks
   * of: the run that carries the task id. Nothing looser: a run picked by
   * name or by start time can be another agent's, whose own end would then
   * never be reported.
   */
  function runOfUnknownTask(conversationId, { taskId }) {
    if (!listRuns) return '';
    let rows = [];
    try {
      rows = listRuns.all(conversationId, new Date(now() - RECENT_TASK_TTL_MS).toISOString());
    } catch {
      return '';
    }
    const match = rows.find((row) => Number(row.background) === 1 && toText(row.task_id) === taskId);
    return match ? toText(match.id) : '';
  }

  function noteSubagentRun(run) {
    const id = toText(run?.conversation_id || run?.conversationId);
    const runId = toText(run?.id || run?.subagentRunId);
    if (!id || !runId) return;
    const entry = session(id);
    entry.lastActivityAt = now();
    const status = normalizeSubagentRunStatus(run?.status);
    if (!isTerminalSubagentRunStatus(status)) return;
    const runTaskId = toText(run?.task_id || run?.taskId);
    const task = [...entry.live.values()].find((candidate) => candidate.toolUseId === runId)
      || (runTaskId && entry.live.get(runTaskId))
      || null;
    if (task) {
      task.toolUseId = task.toolUseId || runId;
    } else {
      // The run of a task that was taken for ended by its absence: its end
      // is real now, and final.
      const ended = entry.recent.find((candidate) => candidate.toolUseId === runId || (runTaskId && candidate.taskId === runTaskId));
      if (ended && endedByAbsence.delete(`${id}:${ended.taskId}`)) {
        ended.status = normalizeTaskStatus(status);
        ended.statusReported = true;
      }
    }
    if (task) {
      // The run's end is the task's: finish it once it has left the set,
      // which the grace timer is waiting for; a task still listed keeps
      // waiting for its own departure.
      if (task.leftAtMs) finishTask(id, task, { status });
      else task.settled = task.settled || { status };
      return;
    }
    const background = Number(run?.background) === 1 || run?.background === true;
    if (!background || toText(run?.parent_subagent_id || run?.parentSubagentId)) return;
    const synthetic = {
      taskId: `run:${runId}`,
      toolUseId: runId,
      taskType: toText(run?.subagent_type) || 'agent',
      kind: 'subagent',
      description: toText(run?.display_name || run?.displayName) || 'sub-agent',
      startedAtMs: msOf(run?.started_at) || now(),
      lastActivityAtMs: now(),
      summary: null,
      model: toText(run?.model) || null,
      status: 'running',
    };
    if (wasEnded(id, synthetic)) return;
    finishTask(id, synthetic, { status });
  }

  function touch(conversationId) {
    const id = toText(conversationId);
    if (!id) return;
    session(id).lastActivityAt = now();
  }

  function forget(conversationId) {
    const id = toText(conversationId);
    const entry = sessions.get(id);
    if (!entry) return;
    for (const task of entry.live.values()) {
      if (task.graceTimer) clearTimer(task.graceTimer);
    }
    sessions.delete(id);
  }

  /** The worker died: its tasks went with it, with no edge (the error says it). */
  function noteWorkerDied(conversationId) {
    const id = toText(conversationId);
    const entry = sessions.get(id);
    if (!entry) return;
    for (const task of [...entry.live.values()]) {
      if (task.graceTimer) clearTimer(task.graceTimer);
      entry.live.delete(task.taskId);
      task.status = 'stopped';
      task.statusReported = false;
      task.endedAtMs = now();
      markEnded(id, task);
      entry.recent.unshift(task);
    }
    entry.recent.length = Math.min(entry.recent.length, RECENT_TASKS_MAX);
  }

  function turnState(conversationId) {
    if (!getQueueRows) return { running: false, sinceMs: 0 };
    let rows = [];
    try {
      rows = getQueueRows.all(conversationId);
    } catch {
      return { running: false, sinceMs: 0 };
    }
    const at = now();
    let running = false;
    let sinceMs = 0;
    for (const row of rows) {
      const held = row.usage_limit_pause && msOf(row.next_attempt_at) > at;
      if (held) continue;
      running = true;
      const since = msOf(row.processing_at) || msOf(row.timestamp);
      sinceMs = Math.max(sinceMs, since);
    }
    return { running, sinceMs };
  }

  function runTasks(conversationId, coveredRunIds) {
    if (!listRuns) return [];
    let rows = [];
    try {
      rows = listRuns.all(conversationId, new Date(now() - RECENT_TASK_TTL_MS).toISOString());
    } catch {
      return [];
    }
    const staleBefore = now() - STALE_RUNNING_RUN_MAX_AGE_MS;
    const quietBefore = now() - UNLISTED_RUNNING_RUN_MAX_QUIET_MS;
    const unlisted = (row) => {
      if (Number(row.background) !== 1 || msOf(row.updated_at || row.started_at) >= quietBefore) return false;
      try { return runListedByWorker(conversationId, row) === false; } catch { return false; }
    };
    const staleRunning = (row) => normalizeTaskStatus(row.status) === 'running'
      && (msOf(row.updated_at || row.started_at) < staleBefore || unlisted(row));
    return rows
      .filter((row) => !coveredRunIds.has(toText(row.id)) && !staleRunning(row))
      .map((row) => {
        const status = normalizeTaskStatus(row.status);
        return {
          id: toText(row.task_id) || toText(row.id),
          kind: 'subagent',
          type: toText(row.subagent_type) || null,
          description: toText(row.display_name) || 'sub-agent',
          startedAt: row.started_at || null,
          lastActivityAt: row.updated_at || row.started_at || null,
          status,
          ...(status !== 'running' && row.completed_at ? { endedAt: row.completed_at } : {}),
          runId: toText(row.id),
          ...(row.model ? { model: row.model } : {}),
          ...(Number(row.background) === 1 ? {} : { inTurn: true }),
        };
      });
  }

  /**
   * `{ state, tasks, lastActivityAt, turnSince }` of one conversation.
   * `tasks` lists the running ones, then up to five that ended within the
   * hour, newest first.
   */
  function describe(conversationId) {
    const id = toText(conversationId);
    const entry = sessions.get(id) || null;
    const at = now();
    const live = entry ? [...entry.live.values()].filter((task) => !task.leftAtMs) : [];
    const recent = entry
      ? entry.recent.filter((task) => at - (task.endedAtMs || 0) <= RECENT_TASK_TTL_MS)
      : [];
    const covered = new Set([...live, ...recent, ...(entry ? [...entry.live.values()] : [])]
      .map((task) => toText(task.toolUseId))
      .filter(Boolean));
    const fromRuns = runTasks(id, covered);
    const runningRuns = fromRuns.filter((task) => task.status === 'running' && !task.inTurn);
    let unreported = false;
    if (!live.length && !runningRuns.length) {
      try { unreported = hasUnreportedBackgroundWork(id) === true; } catch {}
    }
    const tasks = [
      ...live.map(publicTask),
      ...(unreported ? [{
        id: UNREPORTED_BACKGROUND_TASK_ID,
        kind: 'unknown',
        type: null,
        description: UNREPORTED_BACKGROUND_TASK_DESCRIPTION,
        startedAt: null,
        lastActivityAt: null,
        status: 'running',
        placeholder: true,
      }] : []),
      ...fromRuns.filter((task) => task.status === 'running'),
      ...[...recent.map(publicTask), ...fromRuns.filter((task) => task.status !== 'running')]
        .sort((a, b) => msOf(b.endedAt) - msOf(a.endedAt))
        .slice(0, RECENT_TASKS_MAX),
    ];
    const turn = turnState(id);
    const runningTasks = tasks.filter((task) => task.status === 'running');
    const state = turn.running ? 'running_turn' : (runningTasks.length ? 'background_only' : 'idle');
    const taskActivity = Math.max(0, ...runningTasks.map((task) => msOf(task.lastActivityAt)));
    const lastActivityMs = Math.max(entry?.lastActivityAt || 0, taskActivity, turn.sinceMs, startedAtMs);
    return {
      state,
      tasks,
      runningTaskCount: runningTasks.length,
      lastActivityAt: isoOf(lastActivityMs),
      turnSince: isoOf(turn.sinceMs),
    };
  }

  function knownConversationIds() {
    const ids = new Set(sessions.keys());
    try {
      for (const id of listUnreportedBackgroundWork() || []) if (toText(id)) ids.add(toText(id));
    } catch {}
    return [...ids];
  }

  /**
   * `{ active, ageMs, remainingMs }`: whether this runtime is young enough
   * that workers which outlived the one before it may not have reported yet.
   */
  function bootReporting() {
    const ageMs = Math.max(0, now() - startedAtMs);
    const remainingMs = Math.max(0, bootReportingWindowMs - ageMs);
    return { active: remainingMs > 0, ageMs, remainingMs };
  }

  return {
    noteTaskSet,
    noteTaskSettled,
    noteSubagentRun,
    noteWorkerDied,
    touch,
    forget,
    describe,
    knownConversationIds,
    bootReporting,
  };
}
