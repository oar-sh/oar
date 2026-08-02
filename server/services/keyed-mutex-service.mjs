// ---------------------------------------------------------------------------
// Keyed async mutex
//
// Node is single-threaded but not single-tasked: any handler that awaits can be
// interleaved by another request. Anything that reads state, mutates processes
// and writes state back needs to hold a lock across those awaits.
//
// Generic and dependency-free so it can be unit-tested and reused.
// ---------------------------------------------------------------------------

const DEFAULT_STALE_AFTER_MS = 120_000;

export function createKeyedMutex({
  nowMs = Date.now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  warn = console.warn,
} = {}) {
  /** @type {Map<string, { tail: Promise<unknown>, depth: number, acquiredAtMs: number }>} */
  const entries = new Map();

  function warnIfStale(key, entry) {
    if (!entry || !staleAfterMs) return;
    const heldForMs = nowMs() - entry.acquiredAtMs;
    if (heldForMs > staleAfterMs) {
      warn(`[keyed-mutex] "${key}" has been held for ${heldForMs}ms`);
    }
  }

  function acquire(key) {
    const existing = entries.get(key);
    if (existing) {
      warnIfStale(key, existing);
      existing.depth += 1;
      return existing;
    }
    const created = { tail: Promise.resolve(), depth: 1, acquiredAtMs: nowMs() };
    entries.set(key, created);
    return created;
  }

  function release(key, entry) {
    entry.depth -= 1;
    if (entry.depth <= 0 && entries.get(key) === entry) entries.delete(key);
  }

  async function runExclusive(key, fn) {
    const lockKey = String(key || '');
    const entry = acquire(lockKey);
    const previous = entry.tail;
    let releaseTurn;
    entry.tail = new Promise((resolve) => { releaseTurn = resolve; });
    try {
      await previous;
      entry.acquiredAtMs = nowMs();
      return await fn();
    } finally {
      releaseTurn();
      release(lockKey, entry);
    }
  }

  async function tryRunExclusive(key, fn) {
    const lockKey = String(key || '');
    if (entries.has(lockKey)) {
      warnIfStale(lockKey, entries.get(lockKey));
      return { ok: false, busy: true, result: undefined };
    }
    const result = await runExclusive(lockKey, fn);
    return { ok: true, busy: false, result };
  }

  return {
    runExclusive,
    tryRunExclusive,
    isLocked: (key) => entries.has(String(key || '')),
    size: () => entries.size,
    stats: () => ({
      held: entries.size,
      waiting: [...entries.values()].reduce((total, entry) => total + Math.max(0, entry.depth - 1), 0),
    }),
  };
}
