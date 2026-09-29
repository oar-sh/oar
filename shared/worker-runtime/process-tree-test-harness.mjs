// A process table for tests: no process is started, read or signalled.
//
// Deliberately NOT named `*.test.mjs` so `node --test`'s glob skips it.

/**
 * `processes` are `{ processId, parentProcessId, createdAt, ... }`.
 *
 * `posix` is how orphans behave: on Linux a process whose parent ends is handed
 * to pid 1, on Windows it keeps the pid of the parent that is gone. A Windows
 * table is read as a whole and asynchronously (`list()` returns a promise, and
 * there is no `read`), as the PowerShell list is.
 *
 * `ignoresTerm` are the pids that only a SIGKILL ends.
 */
export function makeFakeProcessTable(processes = [], { posix = true, ignoresTerm = [] } = {}) {
  const table = new Map(processes.map((proc) => [proc.processId, { ...proc }]));
  const stubborn = new Set(ignoresTerm);
  const signals = [];
  let lists = 0;

  function end(pid) {
    if (!table.delete(pid)) return;
    if (!posix) return;
    for (const proc of table.values()) {
      if (proc.parentProcessId === pid) proc.parentProcessId = 1;
    }
  }

  function signal(pid, name) {
    if (!table.has(pid)) throw Object.assign(new Error(`kill ESRCH (pid ${pid})`), { code: 'ESRCH' });
    // Signal 0 only asks whether the process is there.
    if (name === 0) return true;
    signals.push({ pid, name });
    if (name === 'SIGKILL' || !stubborn.has(pid)) end(pid);
    return true;
  }

  const copy = () => [...table.values()].map((proc) => ({ ...proc }));
  const lister = posix
    ? {
      orphansKeepParent: false,
      list: () => { lists += 1; return copy(); },
      read: (pid) => (table.has(Number(pid)) ? { ...table.get(Number(pid)) } : null),
    }
    : {
      orphansKeepParent: true,
      list: async () => { lists += 1; return copy(); },
    };

  return {
    lister,
    signal,
    signals,
    end,
    add: (proc) => { table.set(proc.processId, { ...proc }); },
    has: (pid) => table.has(pid),
    pids: () => [...table.keys()].sort((left, right) => left - right),
    listCount: () => lists,
    signalled: (name) => signals.filter((entry) => entry.name === name).map((entry) => entry.pid),
  };
}

/** A clock that only moves when somebody sleeps: no test waits on a real timer. */
export function makeFakeClock() {
  let at = 1_000_000;
  const sleeps = [];
  return {
    now: () => at,
    sleep: async (ms) => { sleeps.push(ms); at += ms; },
    sleeps,
    slept: () => sleeps.reduce((sum, ms) => sum + ms, 0),
  };
}
