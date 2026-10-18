/**
 * The Grok worker's background-tasks publisher: every ACP terminal the agent
 * opens (acp-host-services.mjs) is a shell row in the composer's
 * background-tasks panel, with a console the relay reads from the session's
 * spool file (shared/worker-runtime/task-output-spool.mjs), a Stop that kills
 * the terminal, and a settle notice with the exit code when it ends.
 *
 * Same relay contract as the Claude and Copilot workers: the set is posted
 * whole (REPLACE semantics) with its place in this worker's order
 * (`{ epoch, seq }`); the heartbeat carries the live ids and the relay asks
 * for the set again when its own differs; a settle notice the relay was not
 * there to take is kept and sent again after the next answered heartbeat.
 */
import { createKeptPosts } from '../../shared/worker-runtime/kept-posts.mjs';
import { createTaskOutputSpool } from '../../shared/worker-runtime/task-output-spool.mjs';

const MAX_DESCRIPTION_CHARS = 500;
const SPOOL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Ended terminals remembered for a late exit after their release.
const MAX_TRACKED_TERMINALS = 200;
// ACP runs every shell command through a terminal, most of them over in a
// moment; only one that lives this long becomes a row (and later a settle
// notice), so a `ls` never crowds the panel's ended rows.
export const GROK_TERMINAL_PUBLISH_AFTER_MS = 2_000;

export function createGrokTaskPublisher({
  api,
  sdkSessionId,
  spool = null,
  // The relay dropped the newest set: ask for a heartbeat (the worker wires
  // it to requestPulse), at most once per ten seconds.
  onBackgroundTaskSetStale = () => {},
  publishAfterMs = GROK_TERMINAL_PUBLISH_AFTER_MS,
  now = () => Date.now(),
  dbg = () => {},
} = {}) {
  const taskSpool = spool || (() => {
    try { return createTaskOutputSpool({ sessionId: sdkSessionId }); } catch (error) {
      dbg('task output spool unavailable', error?.message || String(error));
      return null;
    }
  })();
  // terminalId → { taskId, description, startedAt, kill, live, published,
  // publishTimer, exited, stopRequested, killRequested }. `live`: in the set.
  const terminals = new Map();
  const keptSettles = createKeptPosts({ api, dbg: (...args) => dbg('background task settle:', ...args) });
  const epoch = now();
  let seq = 0;
  let staleNotedAt = 0;

  // Ended tasks' files are kept about an hour for the relay; swept at start
  // and hourly.
  const sweep = () => {
    try { taskSpool?.sweep(); } catch (error) { dbg('task output spool sweep failed', error?.message || String(error)); }
  };
  sweep();
  const sweepTimer = setInterval(sweep, SPOOL_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  function outputPathFor(taskId) {
    if (!taskSpool) return '';
    try { return taskSpool.pathFor(taskId); } catch { return ''; }
  }

  function rowOf(entry) {
    const outputPath = outputPathFor(entry.taskId);
    return {
      taskId: entry.taskId,
      taskType: 'local_bash',
      description: entry.description,
      startedAt: entry.startedAt,
      stoppable: true,
      ...(outputPath ? { outputPath, outputKind: 'spool' } : {}),
    };
  }

  function liveEntries() {
    return [...terminals.values()].filter((entry) => entry.live);
  }

  function publish({ resync = false } = {}) {
    const order = { epoch, seq: ++seq };
    return Promise.resolve()
      .then(() => api('POST', '/api/background-tasks', {
        conversationId: sdkSessionId,
        tasks: liveEntries().map(rowOf),
        order,
        ...(resync ? { resync: true } : {}),
      }))
      .then((answer) => {
        // `stale` for the newest post: the relay holds no current set of
        // this worker. An older one was only overtaken.
        if (answer?.stale !== true || order.seq !== seq) return;
        dbg('the relay dropped the newest background task set', answer.reason || '');
        if (now() - staleNotedAt < 10_000) return;
        staleNotedAt = now();
        try { onBackgroundTaskSetStale(); } catch {}
      })
      .catch((error) => {
        dbg('background task publish failed', error?.message || String(error));
      });
  }

  function forgetOldest() {
    while (terminals.size > MAX_TRACKED_TERMINALS) {
      const oldest = [...terminals.entries()].find(([, entry]) => entry.exited || entry.released);
      if (!oldest) break;
      clearTimeout(oldest[1].publishTimer);
      terminals.delete(oldest[0]);
    }
  }

  /** `terminal/create` spawned a process. */
  function started({ terminalId, command = '', startedAt = now(), kill = () => {} } = {}) {
    const taskId = String(terminalId || '').trim();
    if (!taskId) return Promise.resolve();
    const entry = {
      taskId,
      description: String(command || '').trim().slice(0, MAX_DESCRIPTION_CHARS) || 'Terminal',
      startedAt,
      kill,
      live: false,
      published: false,
      publishTimer: null,
      exited: false,
      released: false,
      stopRequested: false,
      killRequested: false,
    };
    terminals.set(taskId, entry);
    forgetOldest();
    // Output is spooled from the first byte (output() below), so the console
    // is complete when the row appears.
    const show = () => {
      entry.publishTimer = null;
      if (entry.exited || entry.released) return Promise.resolve();
      entry.live = true;
      entry.published = true;
      return publish();
    };
    if (!(publishAfterMs > 0)) return show();
    entry.publishTimer = setTimeout(show, publishAfterMs);
    entry.publishTimer.unref?.();
    return Promise.resolve();
  }

  /** A chunk of the terminal's stdout/stderr, as it arrives. */
  function output(terminalId, chunk) {
    const taskId = String(terminalId || '').trim();
    if (!taskId || !taskSpool || !terminals.has(taskId)) return;
    const result = taskSpool.append(taskId, chunk);
    if (result && result.ok === false) dbg('task output spool append failed', taskId);
  }

  /** The agent killed its own terminal (terminal/kill or release): a stop, not a failure. */
  function killed(terminalId) {
    const entry = terminals.get(String(terminalId || '').trim());
    if (entry && !entry.exited) entry.killRequested = true;
  }

  /** `terminal/release`: the agent is done with it; the row goes. */
  function released(terminalId) {
    const entry = terminals.get(String(terminalId || '').trim());
    if (!entry || entry.released) return Promise.resolve();
    entry.released = true;
    clearTimeout(entry.publishTimer);
    entry.publishTimer = null;
    if (!entry.live) return Promise.resolve();
    entry.live = false;
    return publish();
  }

  /** The process exited: say how, then publish the set without it. */
  async function exited(terminalId, exitStatus = {}) {
    const taskId = String(terminalId || '').trim();
    const entry = terminals.get(taskId);
    if (!entry || entry.exited) return;
    entry.exited = true;
    clearTimeout(entry.publishTimer);
    entry.publishTimer = null;
    const wasLive = entry.live;
    entry.live = false;
    try { taskSpool?.end?.(taskId); } catch {}
    // Never shown: nothing to settle (its spool file is swept with the rest).
    if (!entry.published) return;
    const exitCode = Number.isInteger(exitStatus?.exitCode) ? exitStatus.exitCode : null;
    const signal = String(exitStatus?.signal || '').trim();
    const status = entry.stopRequested || entry.killRequested
      ? 'stopped'
      : (exitCode === 0 ? 'completed' : 'failed');
    const outputPath = outputPathFor(taskId);
    await keptSettles.post('/api/background-task-settled', {
      conversationId: sdkSessionId,
      taskId,
      toolUseId: null,
      status,
      summary: exitCode !== null ? `exit code ${exitCode}` : (signal ? `killed by ${signal}` : null),
      description: entry.description,
      taskType: 'local_bash',
      startedAt: entry.startedAt,
      // Absent rather than null: a killed process has no exit code.
      ...(exitCode !== null ? { exitCode } : {}),
      ...(outputPath ? { outputPath, outputKind: 'spool' } : {}),
    });
    if (wasLive) await publish();
  }

  /** The panel's Stop (worker control `stop_background_task`). */
  function stop(taskId) {
    const entry = terminals.get(String(taskId || '').trim());
    if (!entry || !entry.live || entry.exited) return false;
    entry.stopRequested = true;
    try {
      entry.kill();
      return true;
    } catch (error) {
      dbg('terminal stop failed', entry.taskId, error?.message || String(error));
      return false;
    }
  }

  return {
    started,
    output,
    killed,
    released,
    exited,
    stop,
    /** The ids of the live terminals, for the heartbeat's digest. */
    backgroundTaskIds: () => liveEntries().map((entry) => entry.taskId),
    /** The relay asked for the set again (heartbeat answer). */
    resync: () => publish({ resync: true }),
    /** The relay answered a heartbeat: settle notices kept for it go out. */
    flushKeptSettles: () => keptSettles.flush(),
    sweep,
    close() {
      clearInterval(sweepTimer);
      for (const entry of terminals.values()) clearTimeout(entry.publishTimer);
    },
  };
}
