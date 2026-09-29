// What a runtime leaves behind when it goes, and how that is stopped.
//
// A session worker starts its agent runtime as a child process, and the
// runtime starts the agent's commands as ITS children. A runtime that ends in
// good order ends them too. One that is killed does not: the command runs on
// with nobody left to read its result. Measured on Linux with the Copilot
// runtime 1.0.89 (2026-09-29, a scripted provider, the command
// `python3 -c 'import time; time.sleep(170)'`):
//
//  - `session.disconnect()` + `client.stop()`: the runtime ended its commands
//    itself, none was left (a command started with `detach: true` is the
//    exception, it is meant to outlive the session and did);
//  - SIGKILL, and the SDK's `forceStop()` which is a SIGKILL: every command
//    ran on, re-parented to pid 1. From that moment nothing in the process
//    table says whose it was;
//  - the runtime is no group leader (it shares the worker's process group),
//    and it starts every command in a session of its own (`setsid`), so there
//    is no process group that holds the runtime and its commands and could be
//    signalled as one;
//  - a command is in the process table 20 to 60 ms after its
//    `tool.execution_start`.
//
// So the tree is read while the runtime lives and kept: every process with the
// time it was started, which is what tells a process from a later one that was
// given the same pid. Stopping walks that list, checks each entry against the
// process table of the moment, and signals only what is still the same
// process.
//
// Windows keeps the pid of a parent in its children after the parent has
// ended, so there the tree can still be read afterwards (`orphansKeepParent`).
// It also hands the pid of an ended process out again, which is why a child
// older than its parent is no child of it (`isChildProcessOf`).
//
// Nothing here reads the platform or the process table itself: the lister and
// the signal function are passed in.

export const DEFAULT_TREE_POLL_MS = 2_000;
/**
 * When the tree is read after a command's start event: once as soon as the
 * command can be there, and once more for one that took its time. A runtime
 * that is killed before the first look leaves a command nobody knows of.
 */
export const DEFAULT_TREE_COMMAND_LOOKS_MS = Object.freeze([80, 400]);
/** How long a process is given to end on SIGTERM before it is killed. */
export const DEFAULT_TREE_STOP_GRACE_MS = 3_000;
/** How long the result waits for a killed process to be gone. */
export const DEFAULT_TREE_KILL_WAIT_MS = 1_000;
export const DEFAULT_TREE_EXIT_POLL_MS = 100;

function toPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function normalizeProcess(proc) {
  const processId = toPid(proc?.processId);
  if (!processId) return null;
  return {
    ...proc,
    processId,
    parentProcessId: toPid(proc?.parentProcessId),
    createdAt: Number(proc?.createdAt) > 0 ? Number(proc.createdAt) : 0,
  };
}

/**
 * Is `child` a process `parent` started? Windows keeps the parent's pid in a
 * process for good and hands the pid of an ended process out again: a process
 * whose creator is long gone can so appear as the child of a process that has
 * nothing to do with it. A process older than its parent is no child of it.
 * Where a start time is not known, the pid decides.
 */
export function isChildProcessOf(child, parent) {
  if (!child || !parent) return false;
  if (!(child.createdAt > 0) || !(parent.createdAt > 0)) return true;
  return child.createdAt >= parent.createdAt;
}

/**
 * The processes below `root` in a process list, a parent before its children.
 * `root` is an entry of its own (`processId`, `createdAt`) and need not be in
 * the list: an ended parent can still be walked from where its children kept
 * its pid. `accept(child, parent)` leaves a process, and with it everything it
 * started, out.
 */
export function collectProcessDescendants(processes, root, { accept = () => true } = {}) {
  const rootPid = toPid(root?.processId);
  if (!rootPid) return [];
  const childrenByParent = new Map();
  for (const proc of Array.isArray(processes) ? processes : []) {
    const parentPid = toPid(proc?.parentProcessId);
    if (!parentPid || !toPid(proc?.processId)) continue;
    const children = childrenByParent.get(parentPid) || [];
    children.push(proc);
    childrenByParent.set(parentPid, children);
  }
  const seen = new Set([rootPid]);
  const found = [];
  const walk = (parent) => {
    for (const child of childrenByParent.get(toPid(parent.processId)) || []) {
      const pid = toPid(child.processId);
      if (seen.has(pid)) continue;
      if (!isChildProcessOf(child, parent)) continue;
      if (!accept(child, parent)) continue;
      seen.add(pid);
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** The same process, not a later one with its pid. An unknown start time proves nothing. */
function isSameProcess(known, live) {
  if (!known || !live) return false;
  if (toPid(known.processId) !== toPid(live.processId)) return false;
  return known.createdAt > 0 && known.createdAt === live.createdAt;
}

function isThenable(value) {
  return !!value && typeof value.then === 'function';
}

/**
 * The process tree of one runtime.
 *
 * `lister` reads the process table: `list()` returns every process as
 * `{ processId, parentProcessId, createdAt, ... }` (or a promise of that),
 * `read(pid)` one of them where that is cheap, `describe(pid)` its command
 * line where the list does not carry it. `signal(pid, name)` is
 * `process.kill`. `protectedPids` are never signalled whatever the list says:
 * the worker itself and the relay above it.
 *
 * `keepSubtree(process)` names a child of the runtime that is left alone with
 * everything it started (a command the user asked to outlive the session).
 *
 * `isBusy()` says whether the runtime can have commands at all right now; an
 * idle runtime is not read.
 */
export function createProcessTreeWatch({
  rootPid,
  lister,
  signal,
  protectedPids = [],
  keepSubtree = () => false,
  isBusy = () => true,
  pollMs = DEFAULT_TREE_POLL_MS,
  commandLooksMs = DEFAULT_TREE_COMMAND_LOOKS_MS,
  stopGraceMs = DEFAULT_TREE_STOP_GRACE_MS,
  killWaitMs = DEFAULT_TREE_KILL_WAIT_MS,
  exitPollMs = DEFAULT_TREE_EXIT_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  label = 'runtime',
  dbg = () => {},
} = {}) {
  const runtimePid = toPid(rootPid);
  const orphansKeepParent = lister?.orphansKeepParent === true;
  const guarded = new Set([1, runtimePid, ...protectedPids.map(toPid)].filter(Boolean));
  // The runtime as it was first seen. Its start time is what tells it from a
  // later process with its pid.
  let root = null;
  // Whether the last list read still had it.
  let rootEnded = false;
  // The last tree read: pid → process, a parent before its children.
  let members = new Map();
  let kept = 0;
  let lastLoggedCount = -1;
  let pollTimer = null;
  const lookTimers = new Set();
  let closed = false;
  let stopping = null;
  let latest = Promise.resolve({ count: 0, commands: 0 });

  function commandLineOf(proc) {
    if (typeof proc?.commandLine === 'string') return proc.commandLine;
    if (typeof lister.describe !== 'function') return '';
    try { return String(lister.describe(proc.processId) || ''); } catch { return ''; }
  }

  /** The children of the runtime that are commands, as far as the list can tell. */
  function commandCount() {
    let count = 0;
    for (const proc of members.values()) {
      if (proc.parentProcessId !== runtimePid) continue;
      // The runtime starts a command in a session of its own; what it starts
      // inside its own session is a helper of the runtime. Where the list
      // does not know sessions, every child counts.
      if (proc.sessionLeader === false) continue;
      count += 1;
    }
    return count;
  }

  function summary() {
    return { count: members.size, commands: commandCount() };
  }

  /** Take a process list in. Keeps the last tree where this one cannot tell. */
  function apply(list) {
    const entries = (Array.isArray(list) ? list : []).map(normalizeProcess).filter(Boolean);
    const live = entries.find((proc) => proc.processId === runtimePid) || null;
    let walkFrom = null;
    let replacedAt = 0;
    if (live && !root) {
      if (live.createdAt > 0) root = { processId: runtimePid, createdAt: live.createdAt };
      walkFrom = root;
    } else if (live && isSameProcess(root, live)) {
      walkFrom = root;
    } else if (root && orphansKeepParent) {
      // The runtime has ended and its children still name it. A process that
      // was given its pid since has children of its own: they are younger
      // than it.
      walkFrom = root;
      replacedAt = live?.createdAt || 0;
    }
    rootEnded = !!root && !isSameProcess(root, live);
    if (!walkFrom) {
      // The runtime has ended and nothing names it any more. What is known
      // is the last tree; what has ended since is no longer part of it.
      for (const [pid, known] of members) {
        if (!isSameProcess(known, entries.find((proc) => proc.processId === pid))) members.delete(pid);
      }
      return entries;
    }
    kept = 0;
    const found = collectProcessDescendants(entries, walkFrom, {
      accept: (child, parent) => {
        if (parent !== walkFrom) return true;
        if (replacedAt > 0 && !(child.createdAt > 0 && child.createdAt < replacedAt)) return false;
        if (!keepSubtree({ ...child, commandLine: commandLineOf(child) })) return true;
        kept += 1;
        return false;
      },
    });
    members = new Map(found.map((proc) => [proc.processId, proc]));
    if (members.size !== lastLoggedCount) {
      lastLoggedCount = members.size;
      dbg(
        `${label} process tree read: ${members.size} process${members.size === 1 ? '' : 'es'} below pid ${runtimePid}`
        + `${kept ? ` (${kept} detached command${kept === 1 ? '' : 's'} left out)` : ''}`,
      );
    }
    return entries;
  }

  /** The process list as a promise, whatever the lister does. */
  async function readList() {
    return lister.list();
  }

  /**
   * Read the tree now. With a lister that answers at once (Linux reads
   * `/proc`) the tree is current when this returns, which the caller relies on
   * when the runtime is about to be stopped. Never throws, never rejects.
   */
  function snapshot() {
    if (!runtimePid || closed || stopping) return Promise.resolve(summary());
    const failed = (error) => {
      dbg(`${label} process tree could not be read`, error?.message || String(error));
      return summary();
    };
    try {
      const listed = lister.list();
      if (isThenable(listed)) {
        latest = Promise.resolve(listed)
          .then((list) => { if (!closed) apply(list); return summary(); })
          .catch(failed);
      } else {
        apply(listed);
        latest = Promise.resolve(summary());
      }
    } catch (error) {
      latest = Promise.resolve(failed(error));
    }
    return latest;
  }

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    for (const timer of lookTimers) clearTimeout(timer);
    pollTimer = null;
    lookTimers.clear();
  }

  /** A command is starting: look once it is there. */
  function commandStarting() {
    if (closed || stopping || orphansKeepParent || lookTimers.size || !runtimePid) return;
    for (const waitMs of commandLooksMs) {
      const timer = setTimeout(() => {
        lookTimers.delete(timer);
        void snapshot();
      }, waitMs);
      timer.unref?.();
      lookTimers.add(timer);
    }
  }

  function readOne(pid, entries) {
    if (typeof lister.read === 'function') {
      try { return normalizeProcess(lister.read(pid)); } catch { return null; }
    }
    return entries.find((proc) => proc.processId === pid) || null;
  }

  function send(target, name) {
    try {
      signal(target.processId, name);
      return true;
    } catch (error) {
      // ESRCH: it ended by itself meanwhile, which is what was wanted.
      if (error?.code !== 'ESRCH') dbg(`${label} process ${target.processId} could not be signalled (${name})`, error?.message || String(error));
      return false;
    }
  }

  function isGone(target) {
    if (typeof lister.read === 'function') {
      let live = null;
      try { live = normalizeProcess(lister.read(target.processId)); } catch { live = null; }
      return !isSameProcess(target, live);
    }
    // No cheap read: ask whether the pid exists. A pid that was handed out
    // again reads as alive here and is refused before the kill.
    try {
      signal(target.processId, 0);
      return false;
    } catch (error) {
      return error?.code !== 'EPERM';
    }
  }

  async function waitUntilGone(targets, waitMs) {
    const deadline = now() + Math.max(0, waitMs);
    const step = Math.max(1, exitPollMs);
    // Bounded by the number of looks as well: a clock that stands still must
    // not keep the teardown waiting for ever.
    let looks = Math.ceil(Math.max(0, waitMs) / step);
    let left = targets.filter((target) => !isGone(target));
    while (left.length && looks > 0 && now() < deadline) {
      looks -= 1;
      await sleep(Math.min(step, Math.max(1, deadline - now())));
      left = left.filter((target) => !isGone(target));
    }
    return left;
  }

  async function stopTree(reason) {
    const result = { reason, found: 0, ended: [], killed: [], left: [], refused: [] };
    // The tree as it was last read, and below what this read adds to it.
    const known = [...members.values()];
    let entries = [];
    try {
      entries = apply(await readList());
    } catch (error) {
      // Without a process list nothing can be checked, so nothing is signalled.
      dbg(`${label} process tree not stopped (${reason}): the process list could not be read`, error?.message || String(error));
      return result;
    }
    const targets = new Map();
    const consider = (proc) => {
      const pid = proc.processId;
      if (targets.has(pid) || guarded.has(pid)) return false;
      const live = readOne(pid, entries);
      if (!live) return false;
      if (!isSameProcess(proc, live)) {
        if (!result.refused.includes(pid)) result.refused.push(pid);
        return false;
      }
      targets.set(pid, proc);
      return true;
    };
    for (const proc of [...known, ...members.values()]) {
      if (!consider(proc)) continue;
      // What it has started since the tree was last read.
      for (const child of collectProcessDescendants(entries, proc)) consider(child);
    }
    result.found = targets.size;
    if (result.refused.length) {
      dbg(`${label} process tree (${reason}): pid ${result.refused.join(', ')} now belongs to another process; left alone`);
    }
    if (!targets.size) {
      dbg(`${label} process tree (${reason}): nothing left to stop`);
      return result;
    }
    const list = [...targets.values()];
    dbg(`stopping what the ${label} left running (${reason}): pid ${list.map((target) => target.processId).join(', ')}`);
    // A parent before its children: a shell that is told first does not go on
    // to its next command when the one it waits for ends.
    for (const target of list) send(target, 'SIGTERM');
    const stubborn = await waitUntilGone(list, stopGraceMs);
    const stubbornPids = new Set(stubborn.map((target) => target.processId));
    result.ended = list.filter((target) => !stubbornPids.has(target.processId)).map((target) => target.processId);
    if (stubborn.length) {
      let fresh = [];
      try {
        fresh = (await readList()).map(normalizeProcess).filter(Boolean);
      } catch (error) {
        dbg(`${label} process list could not be read before the kill`, error?.message || String(error));
      }
      const toKill = new Map();
      for (const target of stubborn) {
        if (!isSameProcess(target, readOne(target.processId, fresh))) {
          result.ended.push(target.processId);
          continue;
        }
        toKill.set(target.processId, target);
        // A process that ignores SIGTERM goes on starting others.
        for (const child of collectProcessDescendants(fresh, target)) {
          if (!toKill.has(child.processId) && !guarded.has(child.processId) && child.createdAt > 0) {
            toKill.set(child.processId, child);
          }
        }
      }
      const kills = [...toKill.values()];
      for (const target of kills) send(target, 'SIGKILL');
      const left = await waitUntilGone(kills, killWaitMs);
      const leftPids = new Set(left.map((target) => target.processId));
      result.killed = kills.filter((target) => !leftPids.has(target.processId)).map((target) => target.processId);
      result.left = [...leftPids];
    }
    dbg(
      `${label} process tree stopped (${reason}): ${result.ended.length} ended on SIGTERM, `
      + `${result.killed.length} killed, ${result.left.length} still running`
      + `${result.left.length ? ` (pid ${result.left.join(', ')})` : ''}`,
    );
    return result;
  }

  /**
   * Stop what is left of the tree: SIGTERM, a bounded wait, SIGKILL for what
   * is still there. One stop per tree; the watch is over afterwards. Never
   * rejects.
   */
  function stop(reason = 'stop') {
    if (stopping) return stopping;
    stopTimers();
    if (!runtimePid) return Promise.resolve({ reason, found: 0, ended: [], killed: [], left: [], refused: [] });
    stopping = stopTree(reason)
      .catch((error) => {
        dbg(`${label} process tree stop failed (${reason})`, error?.message || String(error));
        return { reason, found: 0, ended: [], killed: [], left: [], refused: [] };
      })
      .finally(() => { closed = true; });
    return stopping;
  }

  /** The runtime ended in good order, or its commands are none of our business. */
  function close() {
    closed = true;
    stopTimers();
  }

  if (runtimePid) {
    void snapshot();
    // Where the children keep the pid of an ended parent the tree is read
    // when it is needed, and reading it costs a process there.
    if (!orphansKeepParent && pollMs > 0) {
      pollTimer = setInterval(() => {
        if (isBusy()) void snapshot();
      }, pollMs);
      pollTimer.unref?.();
    }
  }

  return {
    rootPid: runtimePid,
    snapshot,
    /** The read in flight, or the last one. */
    latest: () => latest,
    /**
     * Whether the runtime had ended when the list was last read. False where
     * that is not known: a runtime that was never seen is not taken for dead.
     */
    runtimeEnded: () => latest.then(() => rootEnded, () => false),
    commandStarting,
    members: () => [...members.values()],
    commandCount,
    stop,
    close,
  };
}
