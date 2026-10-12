'use strict';

// Sub-agent runs left `running` for good. A run's end is written by its
// worker (or by the worker-death and terminal-turn reconciliations); a run
// whose worker is gone without either leaves its row `running` forever, and
// such rows count as running work everywhere: the activity tracker, stalled
// and all_idle for a subscription to all sessions, the suspend-when-idle
// watchdog (live: rows two months old still `running`).
//
// The sweep closes them: a `running` row older than `minAgeMs` whose
// conversation has no live worker becomes `cancelled`. The age bound keeps a
// run that just started, with its worker still registering, out of it; the
// liveness check keeps a long background agent of a live worker in. It runs
// shortly after boot (the workers of the previous runtime have reconnected
// by then) and periodically.

export const STALE_SUBAGENT_RUN_MIN_AGE_MS = 10 * 60_000;
export const STALE_SUBAGENT_RUN_SWEEP_INTERVAL_MS = 10 * 60_000;
export const STALE_SUBAGENT_RUN_BOOT_DELAY_MS = 60_000;

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * `isConversationWorkerAlive(conversationId)` says whether a live worker owns
 * the conversation. `now()` is injectable for tests.
 */
export function createStaleSubagentRunSweep({
  db,
  isConversationWorkerAlive,
  now = () => Date.now(),
  minAgeMs = STALE_SUBAGENT_RUN_MIN_AGE_MS,
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
} = {}) {
  if (!db) throw new Error('createStaleSubagentRunSweep requires db');
  if (typeof isConversationWorkerAlive !== 'function') throw new Error('createStaleSubagentRunSweep requires isConversationWorkerAlive');

  let statements = null;
  function prepare() {
    if (statements) return statements;
    try {
      statements = {
        listOld: db.prepare(`
          SELECT id, conversation_id, started_at, updated_at
          FROM subagent_runs
          WHERE status = 'running' AND COALESCE(updated_at, started_at) < ?
          ORDER BY conversation_id, started_at
        `),
        close: db.prepare(`
          UPDATE subagent_runs
          SET status = 'cancelled', updated_at = ?, completed_at = COALESCE(completed_at, ?)
          WHERE id = ? AND status = 'running'
        `),
      };
    } catch {
      statements = null;
    }
    return statements;
  }

  /** One pass. Returns `{ checked, closed, conversations }`. */
  function sweep() {
    const prepared = prepare();
    if (!prepared) return { checked: 0, closed: 0, conversations: 0, skipped: 'unsupported' };
    const at = now();
    const cutoff = new Date(at - minAgeMs).toISOString();
    let rows = [];
    try {
      rows = prepared.listOld.all(cutoff);
    } catch (error) {
      warn(`STALE SUBAGENT RUNS sweep failed: ${error?.message || error}`);
      return { checked: 0, closed: 0, conversations: 0, error: String(error?.message || error) };
    }
    if (!rows.length) return { checked: 0, closed: 0, conversations: 0 };
    const aliveByConversation = new Map();
    const alive = (conversationId) => {
      if (!aliveByConversation.has(conversationId)) {
        let live = false;
        try { live = isConversationWorkerAlive(conversationId) === true; } catch { live = false; }
        aliveByConversation.set(conversationId, live);
      }
      return aliveByConversation.get(conversationId);
    };
    const nowIso = new Date(at).toISOString();
    const closedConversations = new Set();
    let closed = 0;
    let oldest = null;
    db.transaction(() => {
      for (const row of rows) {
        const conversationId = toText(row.conversation_id);
        if (alive(conversationId)) continue;
        if (prepared.close.run(nowIso, nowIso, row.id).changes > 0) {
          closed += 1;
          closedConversations.add(conversationId);
          const since = toText(row.updated_at) || toText(row.started_at);
          if (since && (!oldest || since < oldest)) oldest = since;
        }
      }
    })();
    if (closed) {
      log(`STALE SUBAGENT RUNS closed ${closed} run${closed === 1 ? '' : 's'} still marked running in ${closedConversations.size} conversation${closedConversations.size === 1 ? '' : 's'} without a live worker (oldest ${oldest})`);
    }
    return { checked: rows.length, closed, conversations: closedConversations.size };
  }

  return { sweep };
}
