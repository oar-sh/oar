'use strict';

import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';

import { previewsTableProblem } from '../migrations/0013-previews.mjs';

// Persistence for the preview registry: the `previews` table (migration 0013)
// behind a small store, so the registry can restore its links after a
// restart and stays testable with a plain in-memory store.
//
// Also the host boot id, which decides whether a port preview may come back:
// only within the boot it was registered in.
//
// Both are exported for a one-off carry-over script as well: open the relay's
// database, `createSqlitePreviewStore(db).insert({ ...preview, hostBootId:
// readHostBootId() })` for every preview from `GET /api/previews`, and the next
// runtime restores them.

const PREVIEW_MODES = new Set(['port', 'static']);
const TOKEN_RE = /^[0-9a-f]{32}$/;

function toText(value) {
  return String(value ?? '').trim();
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(num)) return Math.trunc(num);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toPort(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 && num <= 65535 ? num : null;
}

/**
 * A registry record (the shape `GET /api/previews` lists, plus `hostBootId`)
 * as a row. Returns null for a record no restore could use, a token not in
 * its canonical form (32 lower-case hex) included.
 */
export function previewRecordToRow(record = {}) {
  const token = typeof record.token === 'string' ? record.token : '';
  const mode = toText(record.mode);
  if (!TOKEN_RE.test(token) || !PREVIEW_MODES.has(mode)) return null;
  const createdAt = toEpochMs(record.createdAt);
  return {
    token,
    mode,
    conversation_id: toText(record.conversationId) || null,
    label: toText(record.label).slice(0, 120) || (mode === 'static' ? 'static preview' : 'preview'),
    target_host: mode === 'port' ? (toText(record.targetHost) || null) : null,
    target_port: mode === 'port' ? toPort(record.targetPort) : null,
    root_dir: mode === 'static' ? (toText(record.rootDir) || null) : null,
    created_at: createdAt ?? Date.now(),
    last_hit_at: toEpochMs(record.lastHitAt),
    host_boot_id: toText(record.hostBootId) || null,
  };
}

// The token as stored, not normalised: a row the relay did not write itself
// may hold one in another form, and only the stored value deletes it.
export function previewRowToRecord(row = {}) {
  return {
    token: String(row.token ?? ''),
    mode: toText(row.mode),
    conversationId: toText(row.conversation_id) || null,
    label: toText(row.label),
    targetHost: toText(row.target_host) || null,
    targetPort: toPort(row.target_port),
    rootDir: toText(row.root_dir) || null,
    createdAt: toEpochMs(row.created_at),
    lastHitAt: toEpochMs(row.last_hit_at),
    hostBootId: toText(row.host_boot_id) || null,
  };
}

function unavailableStore(reason) {
  return {
    available: false,
    reason,
    list: () => [],
    insert: () => false,
    remove: () => false,
    removeForConversation: () => 0,
    touch: () => false,
    withBusyTimeout: (_ms, run) => run(),
  };
}

/**
 * The store on the relay's database. Without a usable table (migration 0013
 * failed and is retried next boot, or a `previews` table of other columns)
 * every call is a no-op and the registry keeps its previews in memory only,
 * as before. A table that is there but unusable is logged once; it never
 * stops the relay.
 */
export function createSqlitePreviewStore(db, { logger = console } = {}) {
  let hasTable = false;
  try {
    hasTable = !!db
      ?.prepare?.(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'previews'`)
      .get();
  } catch {}
  if (!hasTable) return unavailableStore('no previews table');
  let stmts;
  try {
    const problem = previewsTableProblem(db);
    if (problem) throw new Error(problem);
    stmts = createStatements(db);
  } catch (error) {
    const reason = error?.message || String(error);
    logger?.warn?.(`[preview] previews are not persisted: ${reason}`);
    return unavailableStore(reason);
  }
  return {
    available: true,
    list: () => stmts.list.all().map(previewRowToRecord),
    insert(record) {
      const row = previewRecordToRow(record);
      if (!row) return false;
      stmts.insert.run(row);
      return true;
    },
    remove: (token) => stmts.remove.run(String(token ?? '')).changes > 0,
    // `exceptTokens`: rows to leave, for a delete that is carried out late and
    // must not take a preview registered since.
    removeForConversation(conversationId, { exceptTokens = [] } = {}) {
      if (exceptTokens.length === 0) return stmts.removeForConversation.run(toText(conversationId)).changes;
      return stmts.removeForConversationExcept
        .run(toText(conversationId), JSON.stringify(exceptTokens.map(String))).changes;
    },
    touch: (token, at) => stmts.touch.run(toEpochMs(at), toText(token)).changes > 0,
    // Runs `run` with another wait on a locked database, then puts the
    // connection's own back.
    withBusyTimeout(ms, run) {
      let previous = null;
      try {
        previous = Number(db.pragma('busy_timeout', { simple: true }));
        db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(Number(ms) || 0))}`);
      } catch {}
      try {
        return run();
      } finally {
        if (Number.isFinite(previous)) {
          try { db.pragma(`busy_timeout = ${previous}`); } catch {}
        }
      }
    },
  };
}

function createStatements(db) {
  return {
    list: db.prepare(`SELECT * FROM previews ORDER BY created_at ASC, token ASC`),
    insert: db.prepare(`
      INSERT OR REPLACE INTO previews (
        token, mode, conversation_id, label, target_host, target_port, root_dir,
        created_at, last_hit_at, host_boot_id
      ) VALUES (
        @token, @mode, @conversation_id, @label, @target_host, @target_port, @root_dir,
        @created_at, @last_hit_at, @host_boot_id
      )
    `),
    remove: db.prepare(`DELETE FROM previews WHERE token = ?`),
    removeForConversation: db.prepare(`DELETE FROM previews WHERE conversation_id = ?`),
    removeForConversationExcept: db.prepare(`
      DELETE FROM previews
      WHERE conversation_id = ? AND token NOT IN (SELECT value FROM json_each(?))
    `),
    touch: db.prepare(`UPDATE previews SET last_hit_at = ? WHERE token = ?`),
  };
}

/** Same calls, kept in a Map: for tests and for a relay without a database. */
export function createMemoryPreviewStore(initialRecords = []) {
  const rows = new Map();
  const store = {
    available: true,
    rows,
    list: () => [...rows.values()]
      .sort((a, b) => (a.created_at - b.created_at) || a.token.localeCompare(b.token))
      .map(previewRowToRecord),
    insert(record) {
      const row = previewRecordToRow(record);
      if (!row) return false;
      rows.set(row.token, row);
      return true;
    },
    remove: (token) => rows.delete(String(token ?? '')),
    removeForConversation(conversationId, { exceptTokens = [] } = {}) {
      const id = toText(conversationId);
      let removed = 0;
      for (const [token, row] of rows) {
        if (row.conversation_id !== id || exceptTokens.includes(token)) continue;
        rows.delete(token);
        removed += 1;
      }
      return removed;
    },
    touch(token, at) {
      const row = rows.get(toText(token));
      if (!row) return false;
      row.last_hit_at = toEpochMs(at);
      return true;
    },
  };
  for (const record of initialRecords) store.insert(record);
  return store;
}

// ─── Host boot id ────────────────────────────────────────────────────────────
//
// An opaque string that changes when the host boots again:
// - Linux: the kernel's random boot id (/proc/sys/kernel/random/boot_id).
// - macOS: `sysctl -n kern.bootsessionuuid`, a UUID minted per boot.
// - Anything else (Windows) or a failed read: the boot time, derived from the
//   uptime, as `boot-time:<epoch seconds>`. That form is compared with a
//   tolerance, because it moves a little with clock adjustments. On Windows
//   "fast startup" a shutdown hibernates the kernel and keeps the uptime, so
//   such a shutdown and power-on counts as the same boot there.
// An empty id never matches anything, so port previews are then not restored.

const BOOT_TIME_PREFIX = 'boot-time:';
const BOOT_TIME_TOLERANCE_S = 120;

export function readHostBootId({
  platform = process.platform,
  readFileSync = fs.readFileSync,
  execFileSync = childProcess.execFileSync,
  uptime = os.uptime,
  now = Date.now,
} = {}) {
  if (platform === 'linux') {
    try {
      const id = toText(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
      if (id) return `linux:${id}`;
    } catch {}
  }
  if (platform === 'darwin') {
    try {
      const id = toText(execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
      if (id) return `darwin:${id}`;
    } catch {}
  }
  try {
    const seconds = Number(uptime());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return `${BOOT_TIME_PREFIX}${Math.round(now() / 1000 - seconds)}`;
    }
  } catch {}
  return '';
}

export function isSameHostBoot(storedId, currentId) {
  const stored = toText(storedId);
  const current = toText(currentId);
  if (!stored || !current) return false;
  if (stored === current) return true;
  if (stored.startsWith(BOOT_TIME_PREFIX) && current.startsWith(BOOT_TIME_PREFIX)) {
    const a = Number(stored.slice(BOOT_TIME_PREFIX.length));
    const b = Number(current.slice(BOOT_TIME_PREFIX.length));
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= BOOT_TIME_TOLERANCE_S;
  }
  return false;
}
