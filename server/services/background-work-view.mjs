'use strict';

/**
 * What the relay can say about background work whose details it may not
 * hold, because its task store and activity tracker live in memory and
 * start empty at every runtime start while the workers keep running:
 *
 *  - the placeholder: a live worker that says it has background work (the
 *    Claude worker's `autoCompactWindow.backgroundWork` on its heartbeat)
 *    while this runtime was never told its task set. Workers that answer a
 *    resync request fill the real set in within one heartbeat; this is for
 *    the ones still running older code. It is read, never stored: it goes
 *    when the set arrives, when the flag goes false and when the worker is
 *    gone, and it raises no start or end event.
 *  - the suspend blockers for background work, from the store and from the
 *    activity tracker (which also reads running sub-agent runs from the
 *    database), and the blocker for a runtime that only just started.
 */

import {
  UNREPORTED_BACKGROUND_TASK_DESCRIPTION,
  UNREPORTED_BACKGROUND_TASK_ID,
} from './session-activity-tracker.mjs';

// Providers whose worker lists every running background sub-agent in its
// task set, by the run's id. Others may run background agents no set lists
// (their run rows are their only trace), so a set says nothing about a row.
const RUN_LISTING_PROVIDERS = new Set(['claude']);

function toText(value) {
  return String(value ?? '').trim();
}

/** The placeholder as a row of the task panel: no details, no Stop button. */
export function unreportedBackgroundTaskCard() {
  return {
    taskId: UNREPORTED_BACKGROUND_TASK_ID,
    taskType: 'unreported',
    description: UNREPORTED_BACKGROUND_TASK_DESCRIPTION,
    startedAt: null,
    stoppable: false,
    placeholder: true,
  };
}

export function createBackgroundWorkView({
  store,
  db = null,
  getRegistry = () => null,
  getTracker = () => null,
  isWorkerAlive = () => false,
  // A conversation's id and its worker's session id are two ids, usually
  // equal and not always. The tracker and the database speak of
  // conversations; the registry, the store and the workers' own headers of
  // sessions. These two map between them through the runtime session.
  sessionIdOf = () => '',
  conversationIdOf = () => '',
  // conversationId → its provider ('claude', 'github', …).
  providerOf = () => '',
  titleOf = (conversationId) => toText(conversationId).slice(0, 8),
} = {}) {
  let listRunningRuns = null;
  if (db) {
    try {
      listRunningRuns = db.prepare(`
        SELECT DISTINCT conversation_id FROM subagent_runs
        WHERE status = 'running' AND background = 1 AND parent_subagent_id IS NULL
      `);
    } catch {}
  }

  function mapped(resolve, id) {
    try { return toText(resolve(id)); } catch { return ''; }
  }

  /** The worker of a session id or of a conversation id. */
  function workerOf(key) {
    const registry = getRegistry();
    const id = toText(key);
    if (!registry || !id) return null;
    // The registry's own indexes first; the mapping is a database read.
    const direct = registry.getWorker?.(id) || registry.getWorkerByConversationId?.(id) || null;
    if (direct) return direct;
    const sessionId = mapped(sessionIdOf, id);
    return (sessionId && sessionId !== id && registry.getWorker?.(sessionId)) || null;
  }

  /** The conversation a worker serves; the registry's own field may hold its session id. */
  function conversationOf(worker, fallback = '') {
    return mapped(conversationIdOf, worker?.sdkSessionId) || toText(worker?.conversationId) || toText(fallback);
  }

  function workerAlive(key) {
    const worker = workerOf(key);
    return !!worker && isWorkerAlive(worker.sdkSessionId) === true;
  }

  /** Whether the placeholder stands for this worker (by session or conversation id). */
  function hasUnreportedWork(key) {
    const worker = workerOf(key);
    if (!worker || worker.steering?.autoCompactWindow?.backgroundWork !== true) return false;
    const keys = [worker.sdkSessionId, worker.conversationId, conversationOf(worker), key];
    if (store.hasReport(...keys)) return false;
    if (keys.some((entry) => store.get(entry).length > 0)) return false;
    return isWorkerAlive(worker.sdkSessionId) === true;
  }

  function listUnreportedConversationIds() {
    const workers = getRegistry()?.listWorkers?.() || [];
    return workers
      .filter((worker) => worker?.steering?.autoCompactWindow?.backgroundWork === true && hasUnreportedWork(worker.sdkSessionId))
      .map((worker) => conversationOf(worker, worker.sdkSessionId))
      .filter(Boolean);
  }

  /**
   * Whether the task set of a conversation's worker lists a sub-agent run
   * (by the run's id or its task id): true or false, and null where the set
   * cannot answer, because the worker has reported none in this runtime
   * or its provider's sets do not list every background run. The tracker
   * drops a `running` row that is not listed and has long been quiet.
   */
  function runListed(conversationId, row) {
    const conversation = toText(conversationId);
    if (!RUN_LISTING_PROVIDERS.has(mapped(providerOf, conversation).toLowerCase())) return null;
    const keys = [...new Set([conversation, mapped(sessionIdOf, conversation), toText(workerOf(conversation)?.sdkSessionId)].filter(Boolean))];
    if (!store.hasReport(...keys)) return null;
    const runId = toText(row?.id);
    const taskId = toText(row?.task_id);
    return keys.some((key) => store.get(key).some((task) => (runId && toText(task?.toolUseId) === runId)
      || (taskId && toText(task?.taskId) === taskId)));
  }

  /** The task panel's rows for a conversation: its set, else the placeholder. */
  function panelTasks(...keys) {
    for (const key of keys) {
      const tasks = store.get(key);
      if (tasks.length) return tasks;
    }
    return keys.some((key) => toText(key) && hasUnreportedWork(key)) ? [unreportedBackgroundTaskCard()] : [];
  }

  /**
   * One `background` blocker per conversation with running background work
   * of a live worker: the tasks of its published set, the running tasks the
   * tracker knows (a background sub-agent run in the database, the
   * placeholder), each task once.
   */
  function backgroundBlockers() {
    const byConversation = new Map();
    const add = (conversationId, id, description) => {
      const conversation = toText(conversationId);
      if (!conversation) return;
      let tasks = byConversation.get(conversation);
      if (!tasks) byConversation.set(conversation, tasks = new Map());
      const taskId = toText(id) || `task-${tasks.size + 1}`;
      if (!tasks.has(taskId)) tasks.set(taskId, toText(description) || 'task');
    };
    for (const [key, entry] of store.sets) {
      const tasks = Array.isArray(entry?.tasks) ? entry.tasks : [];
      if (!tasks.length || !workerAlive(key)) continue;
      const conversationId = conversationOf(workerOf(key), mapped(conversationIdOf, key) || key);
      for (const task of tasks) add(conversationId, task?.taskId, task?.description || task?.taskType);
    }
    const tracker = getTracker();
    if (tracker) {
      const candidates = new Set();
      try { for (const id of tracker.knownConversationIds?.() || []) candidates.add(toText(id)); } catch {}
      try { for (const row of listRunningRuns?.all() || []) candidates.add(toText(row.conversation_id)); } catch {}
      for (const conversationId of candidates) {
        if (!conversationId || !workerAlive(conversationId)) continue;
        let view = null;
        try { view = tracker.describe(conversationId); } catch {}
        for (const task of view?.tasks || []) {
          // A run inside a turn is the turn's work; the turn is the blocker.
          if (task.status !== 'running' || task.inTurn) continue;
          add(conversationId, task.id, task.description || task.type);
        }
      }
    }
    return [...byConversation].map(([conversationId, tasks]) => {
      // The placeholder's text names the way out; it is not cut short.
      const what = [...tasks].slice(0, 3)
        .map(([id, text]) => (id === UNREPORTED_BACKGROUND_TASK_ID ? text : text.slice(0, 80)))
        .join('; ');
      return {
        kind: 'background',
        conversationId,
        title: titleOf(conversationId),
        count: tasks.size,
        detail: `${tasks.size} background agent${tasks.size === 1 ? '' : 's'}: ${what}`,
      };
    });
  }

  /**
   * The blocker of a runtime that only just started: workers that outlived
   * the one before it may not have reported their background work yet, so
   * "nothing runs" is not known. Null once the window is over. Its text
   * does not change while it stands: every change of a blocker goes out to
   * every page.
   */
  function bootBlocker() {
    let boot = null;
    try { boot = getTracker()?.bootReporting?.() || null; } catch {}
    if (!boot?.active) return null;
    return {
      kind: 'boot',
      detail: 'the relay just started, sessions are still reporting',
    };
  }

  /** What holds a host suspend back for background work: the two above. */
  function blockers() {
    const boot = bootBlocker();
    return [...backgroundBlockers(), ...(boot ? [boot] : [])];
  }

  return {
    hasUnreportedWork,
    listUnreportedConversationIds,
    runListed,
    panelTasks,
    backgroundBlockers,
    bootBlocker,
    blockers,
  };
}
