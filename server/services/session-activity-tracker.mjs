'use strict';

/**
 * What each session of this relay is doing right now: a turn, background
 * tasks only, or nothing, with the tasks themselves and when anything last
 * moved.
 *
 * `list_sessions` / `read_session` read it as `state` and `tasks[]`; the
 * relay event service reads its edges (a task started or ended) and its quiet
 * time (stalled). Memory only: the background-task set is republished by the
 * workers on every change, sub-agent runs are read from the database, and a
 * restart forgets only the recently finished tasks and the activity clock
 * (which then starts at the restart, so nothing reads as stalled at boot).
 *
 * Sources:
 *  - `noteTaskSet` — every POST /api/background-tasks (REPLACE semantics):
 *    a new task id is a start, a task gone from the set has ended, a changed
 *    task (tool call, summary, tokens) is activity.
 *  - `noteTaskSettled` — how a task ended, where the worker says so (the
 *    Claude worker's task_notification).
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
  logger = console,
} = {}) {
  const startedAtMs = now();
  // conversationId → { live: Map<taskId, entry>, recent: [], lastActivityAt }
  const sessions = new Map();
  // Edges already reported for an end, by `${conversationId}:${key}`.
  const endedKeys = new Map();

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
        if (at - when > RECENT_TASK_TTL_MS) endedKeys.delete(key);
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

  function finishTask(conversationId, task, { status, summary = null, exitCode = null, reported = true } = {}) {
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
      else finishTask(conversationId, task, { status: 'completed', reported: false });
    }, TASK_END_GRACE_MS);
  }

  function noteTaskSet(conversationId, tasks) {
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
      // Settled already (its notice came before the set dropped it).
      if (wasEnded(id, { taskId, toolUseId: toText(raw.toolUseId) })) continue;
      const task = {
        taskId,
        toolUseId: toText(raw.toolUseId) || null,
        taskType: toText(raw.taskType),
        kind: taskKindOf(raw.taskType),
        description: toText(raw.description).slice(0, 500),
        startedAtMs: msOf(raw.startedAt) || at,
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
      emitEdge('task_started', id, task);
    }
    for (const task of [...entry.live.values()]) {
      if (seen.has(task.taskId) || task.leftAtMs) continue;
      taskLeft(id, task);
    }
  }

  function noteTaskSettled(conversationId, { taskId, toolUseId, status, summary, exitCode } = {}) {
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
    if (!task) return;
    task.settled = settled;
    // Gone from the set already, or about to: settle now either way. A task
    // still listed would leave with this status anyway.
    finishTask(id, task, settled);
  }

  function noteSubagentRun(run) {
    const id = toText(run?.conversation_id || run?.conversationId);
    const runId = toText(run?.id || run?.subagentRunId);
    if (!id || !runId) return;
    const entry = session(id);
    entry.lastActivityAt = now();
    const status = normalizeSubagentRunStatus(run?.status);
    if (!isTerminalSubagentRunStatus(status)) return;
    const task = [...entry.live.values()].find((candidate) => candidate.toolUseId === runId) || null;
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
    const staleRunning = (row) => normalizeTaskStatus(row.status) === 'running'
      && msOf(row.updated_at || row.started_at) < staleBefore;
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
    const tasks = [
      ...live.map(publicTask),
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
    return [...sessions.keys()];
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
  };
}
