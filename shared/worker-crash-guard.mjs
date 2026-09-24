/**
 * Last-resort crash handling for provider session workers.
 *
 * Without these handlers an uncaught exception (or, on modern Node, an
 * unhandled rejection) kills the worker silently mid-turn: no requeue, no
 * terminal response, just a 'processing' row waiting out the server's
 * dead-worker recovery. The guard requeues every queue row the worker owes
 * work for (continuation rows are torn down server-side by the same route),
 * then exits non-zero so the supervisor sees a real failure.
 *
 * The requeue is strictly bounded: a crash handler that hangs is worse than
 * no handler at all.
 */
export function installWorkerCrashGuard({
  api,
  workerName = 'session-worker',
  getActiveQueueMessageIds = () => [],
  onBeforeExit = () => {},
  requeueTimeoutMs = 2_000,
  exit = (code) => process.exit(code),
  processImpl = process,
  logError = (...args) => console.error(...args),
} = {}) {
  let crashing = false;
  const handler = (kind) => (error) => {
    if (crashing) return;
    crashing = true;
    logError(`${workerName} ${kind}:`, error?.stack || error?.message || error);
    (async () => {
      try {
        // Entries are plain ids or { id, attemptId } objects. The attempt id,
        // when known, fences the requeue: a row that has already moved on to
        // another attempt must not be yanked back by a dying predecessor.
        const seen = new Set();
        // An entry may carry a `terminalError`: a row whose prompt the runtime
        // already consumed must fail, not be requeued and run a second time
        // (the requeue route fails a row outright when handed one).
        const entries = (getActiveQueueMessageIds() || [])
          .map((entry) => (entry && typeof entry === 'object'
            ? {
              id: String(entry.id || '').trim(),
              attemptId: String(entry.attemptId || '').trim() || null,
              terminalError: entry.terminalError && typeof entry.terminalError === 'object' ? entry.terminalError : null,
            }
            : { id: String(entry || '').trim(), attemptId: null, terminalError: null }))
          .filter((entry) => {
            if (!entry.id || seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
          });
        if (entries.length && typeof api === 'function') {
          await Promise.race([
            Promise.allSettled(entries.map((entry) => api('POST', '/api/requeue', {
              messageId: entry.id,
              ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
              ...(entry.terminalError ? { terminalError: entry.terminalError } : {}),
            }))),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, Math.max(0, Number(requeueTimeoutMs) || 0));
              timer.unref?.();
            }),
          ]);
        }
      } catch {}
      try { onBeforeExit(); } catch {}
      exit(1);
    })();
  };
  const onException = handler('uncaughtException');
  const onRejection = handler('unhandledRejection');
  processImpl.on('uncaughtException', onException);
  processImpl.on('unhandledRejection', onRejection);
  return {
    uninstall() {
      processImpl.off('uncaughtException', onException);
      processImpl.off('unhandledRejection', onRejection);
    },
  };
}
