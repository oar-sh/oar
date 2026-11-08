import fs from 'node:fs';

import { createMediaRepository } from '../repositories/media-repository.mjs';
import { extractMediaFromMessage } from './media-extract.mjs';

// Fills the media gallery index (migration 0039) from its queue. The
// triggers on `messages` only queue ids; this service reads each queued
// message, extracts its media and replaces the message's rows, a batch per
// transaction.
//
// Draining is synchronous (better-sqlite3), so a batch never interleaves with
// a turn's writes; a message written after it was read is re-queued (its seq
// grows) and indexed by a later batch.
//
// Scheduling: a background loop runs only while the queue has rows (the
// backfill after the migration, or what piled up since the last gallery
// request) and stops when it is empty, so an idle relay runs no timer for
// the gallery. Every gallery request first drains a bounded number of
// messages itself (`drainForRequest`) so new pictures show at once, and
// restarts the loop when rows are left.

export const MEDIA_INDEX_BATCH_SIZE = 10;
export const MEDIA_INDEX_REQUEST_DRAIN = 200;
// Time budgets per drain, so indexing never holds the event loop for long:
// the background loop indexes for ~20 ms every 500 ms in batches of ten
// messages (a slice ends with its batch's commit), a gallery request up to
// 100 ms; the rest waits for the loop.
export const MEDIA_INDEX_LOOP_BUDGET_MS = 20;
export const MEDIA_INDEX_REQUEST_BUDGET_MS = 100;
export const MEDIA_INDEX_INTERVAL_MS = 500;
// A message body above this is read in a slice of its own.
export const MEDIA_INDEX_LARGE_BODY_BYTES = 1024 * 1024;

export function createMediaIndexService({
  db,
  repository = createMediaRepository(db),
  extract = extractMediaFromMessage,
  platform = process.platform,
  batchSize = MEDIA_INDEX_BATCH_SIZE,
  intervalMs = MEDIA_INDEX_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
  now = () => performance.now(),
} = {}) {
  let timer = null;
  let stopped = true;
  let warnedExtractError = false;

  function indexRow(row) {
    let items = [];
    try {
      items = extract({
        role: row.role,
        text: row.text,
        attachments: row.attachments,
        conversationId: row.conversationId,
        messageId: row.messageId,
        workspaceRoot: row.workspaceRoot || '',
        platform,
      });
    } catch (error) {
      // A message the extractor cannot read gets no media; its queue row
      // still goes, so it cannot block the queue.
      if (!warnedExtractError) {
        warnedExtractError = true;
        logger?.warn?.(`[media-index] could not read a message; it gets no media: ${error?.message || error}`);
      }
      items = [];
    }
    return repository.replaceMessageItems(row, items);
  }

  /** Indexes up to `maxMessages` queued messages now, within `budgetMs`; says how many are left. */
  function drain(options = {}) {
    const result = drainSlice(options);
    return { ...result, pending: repository.hasPending() ? repository.pendingCount() : 0 };
  }

  function drainSlice({ maxMessages = batchSize, budgetMs = Infinity } = {}) {
    let indexed = 0;
    let items = 0;
    if (!repository.available) return { indexed, items };
    const started = now();
    let outOfTime = false;
    while (indexed < maxMessages && !outOfTime) {
      const rows = repository.nextQueueBatch(Math.min(batchSize, maxMessages - indexed));
      if (!rows.length) break;
      // One commit per batch: a commit per message costs more than the indexing.
      repository.inTransaction(() => {
        for (const entry of rows) {
          // A large body (a pasted data image) is read only at the start of a
          // slice, so reading it never adds to work already done in the slice.
          if (indexed > 0 && Number(entry.bytes) > MEDIA_INDEX_LARGE_BODY_BYTES) {
            outOfTime = true;
            break;
          }
          const row = repository.loadQueuedMessage(entry);
          if (row) items += indexRow(row);
          indexed += 1;
          if (now() - started >= budgetMs) {
            outOfTime = true;
            break;
          }
        }
      });
      if (rows.length < batchSize) break;
    }
    return { indexed, items };
  }

  function schedule() {
    if (stopped || timer || !repository.available) return;
    timer = setTimer(tick, intervalMs);
    timer?.unref?.();
  }

  function tick() {
    timer = null;
    if (stopped) return;
    let more = false;
    try {
      drainSlice({ maxMessages: Infinity, budgetMs: MEDIA_INDEX_LOOP_BUDGET_MS });
      more = repository.hasPending();
    } catch (error) {
      logger?.warn?.(`[media-index] indexing failed; retrying later: ${error?.message || error}`);
      more = true;
    }
    if (more) schedule();
  }

  return {
    get available() {
      return repository.available;
    },
    drain,
    /** Before answering a gallery request: index what is new, keep the rest for the loop. */
    drainForRequest() {
      const result = drain({ maxMessages: MEDIA_INDEX_REQUEST_DRAIN, budgetMs: MEDIA_INDEX_REQUEST_BUDGET_MS });
      if (result.pending > 0) schedule();
      return result;
    },
    start() {
      if (!repository.available) return;
      stopped = false;
      try {
        repository.removeOrphanQueueRows();
      } catch (error) {
        logger?.warn?.(`[media-index] could not clean the queue: ${error?.message || error}`);
      }
      if (repository.hasPending()) schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    pendingCount: () => repository.pendingCount(),
    isScheduled: () => timer !== null,
  };
}

// --- whether a file is still there -------------------------------------------

export const FILE_PRESENCE_TTL_MS = 60_000;
export const FILE_PRESENCE_MAX_ENTRIES = 5000;
export const FILE_PRESENCE_TIMEOUT_MS = 1500;

/**
 * A short-lived cache of "is this a regular file" answers, for hiding gallery
 * items whose file was deleted or moved. Async stat with a timeout: a mapped
 * network drive that is offline must not hold a gallery page. A stat that
 * times out counts as missing for this page and is not cached.
 */
export function createFilePresenceCache({
  stat = (filePath) => fs.promises.stat(filePath),
  ttlMs = FILE_PRESENCE_TTL_MS,
  maxEntries = FILE_PRESENCE_MAX_ENTRIES,
  timeoutMs = FILE_PRESENCE_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function remember(filePath, present) {
    entries.delete(filePath);
    entries.set(filePath, { present, at: now() });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  async function isFile(filePath) {
    const key = String(filePath || '');
    if (!key) return false;
    const cached = entries.get(key);
    if (cached && now() - cached.at < ttlMs) return cached.present;
    let timeoutHandle = null;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
      timeoutHandle?.unref?.();
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => stat(key)).then((info) => info.isFile(), () => false),
        timeout,
      ]);
      if (result === 'timeout') return false;
      remember(key, result === true);
      return result === true;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  return {
    isFile,
    forget: (filePath) => entries.delete(String(filePath || '')),
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}
