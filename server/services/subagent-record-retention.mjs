'use strict';

// Retention for sub-agent records. After the configured number of days a
// finished run's tool results lose their text and its tool calls keep only
// their one-line summary; both keep their row, marked
// `{ pruned: true, prunedAt, originalChars, retentionDays }` so the viewer
// can say what happened. Thoughts, reply text, notes, child rows and the
// runs stay. The sweep runs at relay start and once a day, a few thousand
// rows per transaction with the event loop free in between, and logs one
// line. No VACUUM: SQLite reuses the freed pages.

import { subagentToolCallSummary } from '../../shared/subagent-timeline.mjs';

export const SUBAGENT_RETENTION_BATCH_SIZE = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const METADATA_MAX_CHARS = 4096;

function parseMetadata(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** What a stripped entry keeps: text and metadata, from its stored row. */
export function prunedTimelineEntry(row, { prunedAt, retentionDays }) {
  const original = String(row?.text ?? '');
  const text = row?.kind === 'tool_call' ? subagentToolCallSummary(original) : '';
  const marker = { pruned: true, prunedAt, originalChars: original.length, retentionDays };
  let metadataJson = JSON.stringify({ ...parseMetadata(row?.metadata_json), ...marker });
  if (metadataJson.length > METADATA_MAX_CHARS) metadataJson = JSON.stringify(marker);
  return { text, metadataJson, freedChars: Math.max(0, original.length - text.length) };
}

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

/**
 * `getRetentionDays()` reads the setting (0 = off). `now()` and
 * `yieldToLoop()` are injectable for tests.
 */
export function createSubagentRecordRetention({
  db,
  getRetentionDays,
  now = () => Date.now(),
  batchSize = SUBAGENT_RETENTION_BATCH_SIZE,
  yieldToLoop = () => new Promise((resolve) => setImmediate(resolve)),
  isStopped = () => false,
  log = (line) => console.log(line),
  warn = (line) => console.warn(line),
} = {}) {
  if (!db) throw new Error('createSubagentRecordRetention requires db');
  if (typeof getRetentionDays !== 'function') throw new Error('createSubagentRecordRetention requires getRetentionDays');

  let statements = null;
  let running = null;
  let scheduled = null;

  function prepare() {
    if (statements) return statements;
    if (!columnExists(db, 'subagent_timeline', 'pruned_at')) return null;
    statements = {
      // The first condition repeats the partial index's WHERE word for word.
      // A run still running keeps its whole record, however old.
      candidates: db.prepare(`
        SELECT t.id, t.kind, t.text, t.metadata_json
        FROM subagent_timeline t
        WHERE t.pruned_at IS NULL AND t.kind IN ('tool_call', 'tool_result')
          AND t.updated_at < @cutoff
          AND NOT EXISTS (
            SELECT 1 FROM subagent_runs r
            WHERE r.id = t.run_id AND r.status IN ('running', 'pending', 'processing')
          )
        ORDER BY t.updated_at
        LIMIT @limit
      `),
      prune: db.prepare(`
        UPDATE subagent_timeline
        SET text = @text, metadata_json = @metadataJson, pruned_at = @prunedAt
        WHERE id = @id AND pruned_at IS NULL
      `),
    };
    return statements;
  }

  function pruneBatch(cutoff, prunedAt, retentionDays) {
    const { candidates, prune } = statements;
    return db.transaction(() => {
      const rows = candidates.all({ cutoff, limit: batchSize });
      let pruned = 0;
      let freedChars = 0;
      for (const row of rows) {
        const next = prunedTimelineEntry(row, { prunedAt, retentionDays });
        pruned += prune.run({ id: row.id, text: next.text, metadataJson: next.metadataJson, prunedAt }).changes;
        freedChars += next.freedChars;
      }
      return { seen: rows.length, pruned, freedChars };
    })();
  }

  async function runSweep() {
    const retentionDays = Number(getRetentionDays()) || 0;
    if (retentionDays <= 0) return { retentionDays: 0, pruned: 0, freedChars: 0, batches: 0, skipped: 'off' };
    if (!prepare()) return { retentionDays, pruned: 0, freedChars: 0, batches: 0, skipped: 'unsupported' };
    const startedAt = now();
    const cutoff = new Date(startedAt - retentionDays * DAY_MS).toISOString();
    const prunedAt = new Date(startedAt).toISOString();
    let pruned = 0;
    let freedChars = 0;
    let batches = 0;
    for (;;) {
      if (isStopped()) break;
      const batch = pruneBatch(cutoff, prunedAt, retentionDays);
      if (!batch.seen) break;
      batches += 1;
      pruned += batch.pruned;
      freedChars += batch.freedChars;
      if (batch.seen < batchSize) break;
      await yieldToLoop();
    }
    const elapsedMs = Math.max(0, now() - startedAt);
    log(pruned
      ? `SUBAGENT RETENTION stripped ${pruned} tool entr${pruned === 1 ? 'y' : 'ies'} (${freedChars} chars) older than ${retentionDays} d in ${batches} batch${batches === 1 ? '' : 'es'}, ${elapsedMs} ms`
      : `SUBAGENT RETENTION nothing older than ${retentionDays} d to strip`);
    return { retentionDays, pruned, freedChars, batches, cutoff };
  }

  /** One sweep at a time; a call while one runs gets that one. */
  function sweep() {
    if (running) return running;
    running = runSweep()
      .catch((error) => {
        warn(`SUBAGENT RETENTION sweep failed: ${error?.message || error}`);
        return { error: String(error?.message || error) };
      })
      .finally(() => { running = null; });
    return running;
  }

  /** A sweep in `delayMs` (the relay's start, a changed setting); later calls move it. */
  function scheduleSweep(delayMs = 0) {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!isStopped()) void sweep();
    }, Math.max(0, delayMs));
    if (typeof scheduled.unref === 'function') scheduled.unref();
  }

  function stop() {
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
  }

  return { sweep, scheduleSweep, stop, DAY_MS };
}
