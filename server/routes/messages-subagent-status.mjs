import { mapSubagentRunHeader } from '../services/subagent-timeline-service.mjs';

// Sub-agent runs: whether a run can be stopped, its live status events, and
// the end of the runs a terminal turn leaves running. Stateless: every read
// goes to the objects it is made with.
export function createSubagentRunStatus({ io, stmts, backgroundTaskStore, sessionActivityTracker }) {
  // The live background task a run belongs to (the panel's row), if any: the
  // task's spawning tool_use id is the run id.
  function liveTaskForSubagentRun(run) {
    const tasks = backgroundTaskStore?.get?.(run?.conversation_id) || [];
    const runId = String(run?.id || '');
    const taskId = String(run?.task_id || '');
    return tasks.find((task) => (task?.toolUseId && task.toolUseId === runId) || (taskId && task?.taskId === taskId)) || null;
  }

  // Stop is offered while a run is running: a background run through its
  // task, a foreground run through the sub-agent cancel route.
  function isSubagentRunStoppable(run) {
    if (String(run?.status || '') !== 'running') return false;
    const task = liveTaskForSubagentRun(run);
    if (task) return task.stoppable !== false;
    return Number(run?.background || 0) !== 1;
  }

  // Every subagent_status event carries the whole header and the run's own
  // turn, so a client can place it without having seen the run before.
  function subagentStatusEvent(run, extra = {}) {
    const header = mapSubagentRunHeader(run, { stoppable: isSubagentRunStoppable(run) });
    if (!header) return null;
    return { ...header, timestamp: new Date().toISOString(), ...extra };
  }

  function emitSubagentStatus(run, extra = {}) {
    const event = subagentStatusEvent(run, extra);
    if (event) io.emit('subagent_status', event);
    try { sessionActivityTracker?.noteSubagentRun?.(run); } catch {}
  }

  function reconcileSubagentRunsForTerminalTurn(messageId, { status = 'failed' } = {}) {
    // A background run outlives the turn that spawned it: its worker reports
    // its end (task_notification), and a dead worker's runs are closed by the
    // worker-death sweep. Closing it here marked live agents failed.
    const running = (stmts.listRunningSubagentRunsByQueueMessage?.all?.(messageId) || [])
      .filter((run) => Number(run.background || 0) !== 1 && !liveTaskForSubagentRun(run));
    if (!running.length) return 0;
    const now = new Date().toISOString();
    for (const run of running) {
      stmts.updateSubagentRunStatus?.run?.(status, now, now, run.id);
      const closed = stmts.getSubagentRun?.get?.(run.id) || { ...run, status, completed_at: now };
      // messageId is the run's own turn: the browser drops a status event it
      // cannot place, which left these runs showing "running" until a reload.
      emitSubagentStatus(closed, { queueMessageId: messageId, reconciled: true });
    }
    return running.length;
  }

  return {
    liveTaskForSubagentRun,
    isSubagentRunStoppable,
    subagentStatusEvent,
    emitSubagentStatus,
    reconcileSubagentRunsForTerminalTurn,
  };
}
