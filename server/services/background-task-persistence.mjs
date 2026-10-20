'use strict';

import { backgroundTaskRowsTableProblem } from '../migrations/0018-background-task-rows.mjs';

// Persistence for the background-task store's console rows: the
// `background_task_rows` table (migration 0018) behind a small adapter, so
// the store restores its rows after a restart and stays testable without a
// database. Without a usable table every call is a no-op and the store keeps
// its rows in memory only, as before; a problem is logged once and never
// stops the relay.

function unavailable(reason) {
  return {
    available: false,
    reason,
    load: () => [],
    saveLive: () => false,
    saveEnded: () => false,
    remove: () => false,
    forget: () => false,
    pruneEnded: () => 0,
    touchLive: () => false,
  };
}

function parseRow(text) {
  try {
    const row = JSON.parse(String(text || ''));
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

/** A row as stored: no health reading (the poller reads the file again). */
function storedRowJson(row) {
  const { health: _health, ...rest } = row || {};
  return JSON.stringify(rest);
}

export function createSqliteBackgroundTaskPersistence(db, { logger = console, now = () => Date.now() } = {}) {
  let stmts;
  try {
    const problem = backgroundTaskRowsTableProblem(db);
    if (problem) return unavailable(problem);
    stmts = {
      list: db.prepare(`SELECT store_key, task_id, state, row_json, ended_at, updated_at FROM background_task_rows`),
      touchLive: db.prepare(`UPDATE background_task_rows SET updated_at = ? WHERE store_key = ? AND state = 'live'`),
      upsert: db.prepare(`
        INSERT INTO background_task_rows (store_key, task_id, state, row_json, ended_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_key, task_id) DO UPDATE SET
          state = excluded.state, row_json = excluded.row_json, ended_at = excluded.ended_at, updated_at = excluded.updated_at
      `),
      liveOfKey: db.prepare(`SELECT task_id FROM background_task_rows WHERE store_key = ? AND state = 'live'`),
      remove: db.prepare(`DELETE FROM background_task_rows WHERE store_key = ? AND task_id = ?`),
      removeLive: db.prepare(`DELETE FROM background_task_rows WHERE store_key = ? AND task_id = ? AND state = 'live'`),
      forget: db.prepare(`DELETE FROM background_task_rows WHERE store_key = ?`),
      prune: db.prepare(`DELETE FROM background_task_rows WHERE state = 'ended' AND ended_at < ?`),
    };
  } catch (error) {
    const reason = error?.message || String(error);
    logger?.warn?.(`[background-tasks] console rows are not persisted: ${reason}`);
    return unavailable(reason);
  }

  // One warning per kind of failure: a write that fails keeps failing, and
  // the store goes on in memory either way.
  const warned = new Set();
  function guard(what, run, fallback) {
    try {
      return run();
    } catch (error) {
      if (!warned.has(what)) {
        warned.add(what);
        logger?.warn?.(`[background-tasks] could not ${what} a console row: ${error?.message || error}`);
      }
      return fallback;
    }
  }

  const saveLiveTx = db.transaction((key, rows) => {
    const keep = new Set(rows.map((row) => String(row.taskId)));
    for (const { task_id: taskId } of stmts.liveOfKey.all(key)) {
      if (!keep.has(taskId)) stmts.removeLive.run(key, taskId);
    }
    const at = now();
    for (const row of rows) stmts.upsert.run(key, String(row.taskId), 'live', storedRowJson(row), null, at);
  });

  return {
    available: true,
    reason: '',
    /** Every stored row: `{ key, taskId, state, row, endedAt, updatedAt }`. */
    load() {
      return guard('read', () => stmts.list.all().map((entry) => ({
        key: String(entry.store_key),
        taskId: String(entry.task_id),
        state: String(entry.state),
        row: parseRow(entry.row_json),
        endedAt: Number.isFinite(Number(entry.ended_at)) && entry.ended_at !== null ? Number(entry.ended_at) : null,
        updatedAt: Number.isFinite(Number(entry.updated_at)) ? Number(entry.updated_at) : null,
      })).filter((entry) => entry.row), []);
    },
    /** The key's live console rows are exactly these (an ended row of the same task is replaced). */
    saveLive(key, rows) {
      return guard('write', () => { saveLiveTx(String(key), Array.isArray(rows) ? rows : []); return true; }, false);
    },
    saveEnded(key, row) {
      return guard('write', () => {
        stmts.upsert.run(String(key), String(row.taskId), 'ended', storedRowJson(row), Number(row.endedAt) || now(), now());
        return true;
      }, false);
    },
    remove(key, taskId) {
      return guard('delete', () => stmts.remove.run(String(key), String(taskId)).changes > 0, false);
    },
    forget(keys) {
      return guard('delete', () => {
        for (const key of keys) stmts.forget.run(String(key));
        return true;
      }, false);
    },
    /** The key's live rows were confirmed running now (its worker's digest agreed). */
    touchLive(key) {
      return guard('write', () => stmts.touchLive.run(now(), String(key)).changes > 0, false);
    },
    /** Drops the ended rows that ended before `cutoff` (epoch ms). */
    pruneEnded(cutoff) {
      return guard('prune', () => stmts.prune.run(Number(cutoff) || 0).changes, 0);
    },
  };
}
