'use strict';

/**
 * Reading a background task's output for the console: the file the worker
 * names as the task's `outputPath` (the Claude CLI's task file, a Copilot
 * shell log, the worker's own spool), read by the relay itself.
 *
 *  - readTail / readBefore / readRange: byte windows of the file, cut on line
 *    and character boundaries, returned cleaned (control codes out, colours
 *    kept, credentials scrubbed) with the processed line model.
 *  - the path guard: an absolute path of at most 1,024 characters, a regular
 *    file that is not a symlink (opened with O_NOFOLLOW where the platform has
 *    it), reads capped per request.
 *  - snapshots: the 8 KiB a worker posts for a task with no file (Claude's
 *    getTaskOutput), cached per task.
 *  - the health poller: every 10 s, for live tasks with an output file (and
 *    ended ones, read once more after the end), the time of the last output
 *    and the test runner's counts from the last 64 KB, sent to the pages as
 *    `background_tasks_health` when they change.
 *
 * The worker is trusted (it runs on this host as this user); the guard stops
 * accidents, not an attacker.
 */

import fs from 'node:fs';

import {
  TASK_OUTPUT_LIMITS,
  cleanTaskOutput,
  foldTaskOutput,
  normalizeTaskOutputKind,
  normalizeTaskOutputPath,
  parseRunnerSummary,
  stripControlKeepSgr,
} from '../../shared/task-output-text.mjs';

const NEWLINE = 0x0a;

function clampInt(value, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** The file kinds the relay reads itself. */
export function isFileOutputKind(kind) {
  return kind === 'file' || kind === 'spool';
}

/** A task row's output as `{ kind, path }` (`path` '' when there is no readable one). */
export function taskOutputSource(task) {
  const path = normalizeTaskOutputPath(task?.outputPath);
  const kind = normalizeTaskOutputKind(task?.outputKind, path);
  return { kind, path: isFileOutputKind(kind) ? path : '' };
}

/**
 * What the file at `filePath` is: `{ ok: true, size, mtimeMs }`, or
 * `{ ok: false, code }` with code `invalid-path`, `missing`, `symlink`,
 * `not-file` or `unreadable`.
 */
export async function inspectOutputFile(filePath, { fsImpl = fs } = {}) {
  const path = normalizeTaskOutputPath(filePath);
  if (!path) return { ok: false, code: 'invalid-path' };
  let stats;
  try {
    stats = await fsImpl.promises.lstat(path);
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (stats.isSymbolicLink()) return { ok: false, code: 'symlink' };
  if (!stats.isFile()) return { ok: false, code: 'not-file' };
  return { ok: true, size: stats.size, mtimeMs: stats.mtimeMs };
}

// Reads [start, end) of the file. Opened without following a symlink where
// the platform can, and checked again on the open handle: a path swapped
// between the lstat and the open is refused.
async function readBytes(path, start, end, { fsImpl = fs } = {}) {
  // O_NONBLOCK: a FIFO swapped in after the lstat must not hold a pool
  // thread until a writer appears (no effect on a regular file).
  const flags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0) | (fsImpl.constants.O_NONBLOCK || 0);
  let handle;
  try {
    handle = await fsImpl.promises.open(path, flags);
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'missing' : (error?.code === 'ELOOP' ? 'symlink' : 'unreadable') };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, code: 'not-file' };
    const size = stats.size;
    const from = Math.max(0, Math.min(start, size));
    const to = Math.max(from, Math.min(end, size));
    const buffer = Buffer.alloc(to - from);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, from + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { ok: true, buffer: buffer.subarray(0, read), start: from, size, mtimeMs: stats.mtimeMs };
  } catch {
    return { ok: false, code: 'unreadable' };
  } finally {
    try { await handle.close(); } catch {}
  }
}

/**
 * How many bytes of `buffer` can be decoded and cleaned now without cutting
 * a UTF-8 character or an escape sequence in two: the rest waits for the
 * next read (the writer is mid-write).
 */
export function safeChunkLength(buffer) {
  let end = buffer.length;
  // An incomplete UTF-8 sequence at the end.
  let lead = end - 1;
  let continuation = 0;
  while (lead >= 0 && continuation < 3 && (buffer[lead] & 0xc0) === 0x80) {
    lead -= 1;
    continuation += 1;
  }
  if (lead >= 0) {
    const byte = buffer[lead];
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > 1 && continuation + 1 < width) end = lead;
  }
  // An escape sequence still open at the end (ESC, ESC [ 3 1, ESC ] title…).
  const tailStart = Math.max(0, end - 256);
  const tail = buffer.subarray(tailStart, end).toString('latin1');
  const esc = tail.lastIndexOf('\x1b');
  if (esc !== -1) {
    const rest = tail.slice(esc);
    const complete = /^\x1b\[[0-?]*[ -/]*[@-~]/.test(rest)
      || /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.test(rest)
      || /^\x1b[^[\]]/.test(rest);
    // An OSC that never ends within 256 bytes is garbage; let it through.
    const hopelessOsc = rest.startsWith('\x1b]') && rest.length >= 256;
    if (!complete && !hopelessOsc) end = tailStart + esc;
  }
  return end;
}

// The byte offset just after the first newline at or after `from`, or -1.
function afterNewline(buffer, from = 0) {
  const at = buffer.indexOf(NEWLINE, from);
  return at === -1 ? -1 : at + 1;
}

// The start of the last `count` lines of `buffer` (a line ends with "\n";
// an unterminated last line counts as one).
function startOfLastLines(buffer, count) {
  let lines = 0;
  let position = buffer.length;
  if (position > 0 && buffer[position - 1] === NEWLINE) position -= 1;
  while (position > 0) {
    const at = buffer.lastIndexOf(NEWLINE, position - 1);
    lines += 1;
    if (lines >= count || at === -1) return lines >= count ? at + 1 : 0;
    position = at;
  }
  return 0;
}

function skipContinuationBytes(buffer, from) {
  let start = from;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return start;
}

function shapeWindow(buffer, windowStart, size, mtimeMs) {
  const text = cleanTaskOutput(buffer.toString('utf8'));
  return {
    ok: true,
    text,
    startOffset: windowStart,
    endOffset: windowStart + buffer.length,
    size,
    mtime: mtimeMs,
    hasMoreBefore: windowStart > 0,
    lines: foldTaskOutput(text),
  };
}

// The last `lines` lines of the bytes before `end`, within `maxBytes`.
async function readLinesEndingAt(filePath, end, { lines, maxBytes, trimEnd, fsImpl }) {
  const windowStart = Math.max(0, end - maxBytes);
  const read = await readBytes(filePath, windowStart, end, { fsImpl });
  if (!read.ok) return read;
  let buffer = read.buffer;
  let start = 0;
  // A window that starts mid-file starts on the next line; one long line
  // with no newline at all starts on the next character.
  if (read.start > 0) {
    const next = afterNewline(buffer);
    start = next === -1 || next >= buffer.length ? skipContinuationBytes(buffer, 0) : next;
  }
  buffer = buffer.subarray(start);
  const fromLines = startOfLastLines(buffer, lines);
  buffer = buffer.subarray(fromLines);
  const firstByte = read.start + start + fromLines;
  if (trimEnd) buffer = buffer.subarray(0, safeChunkLength(buffer));
  return shapeWindow(buffer, firstByte, read.size, read.mtimeMs);
}

/**
 * The end of a task's output: the last `lines` lines (default 2,000, at most
 * 5,000) within `maxBytes` (at most 256 KB). Returns `{ ok, text,
 * startOffset, endOffset, size, mtime, hasMoreBefore, lines }`: `text` the
 * cleaned slice (for a viewer's own folder), `lines` the processed line
 * model, offsets in bytes of the file. The end stops short of a character or
 * escape the writer has not finished; `endOffset` is where the live chunks
 * continue. `{ ok: false, code }` when the file cannot be read.
 */
export async function readTail(filePath, { lines, maxBytes, fsImpl = fs } = {}) {
  const info = await inspectOutputFile(filePath, { fsImpl });
  if (!info.ok) return info;
  return readLinesEndingAt(normalizeTaskOutputPath(filePath), info.size, {
    lines: clampInt(lines, { min: 1, max: TASK_OUTPUT_LIMITS.tailLinesMax, fallback: TASK_OUTPUT_LIMITS.tailLinesDefault }),
    maxBytes: clampInt(maxBytes, { min: 1, max: TASK_OUTPUT_LIMITS.requestBytesMax, fallback: TASK_OUTPUT_LIMITS.requestBytesMax }),
    trimEnd: true,
    fsImpl,
  });
}

/** The `lines` lines that end at byte offset `before` (a `startOffset` an earlier read returned). */
export async function readBefore(filePath, { before, lines, maxBytes, fsImpl = fs } = {}) {
  const info = await inspectOutputFile(filePath, { fsImpl });
  if (!info.ok) return info;
  const end = clampInt(before, { min: 0, max: info.size, fallback: info.size });
  return readLinesEndingAt(normalizeTaskOutputPath(filePath), end, {
    lines: clampInt(lines, { min: 1, max: TASK_OUTPUT_LIMITS.tailLinesMax, fallback: TASK_OUTPUT_LIMITS.tailLinesDefault }),
    maxBytes: clampInt(maxBytes, { min: 1, max: TASK_OUTPUT_LIMITS.requestBytesMax, fallback: TASK_OUTPUT_LIMITS.requestBytesMax }),
    trimEnd: false,
    fsImpl,
  });
}

/**
 * The bytes from `start` on, at most `maxBytes` (64 KB), for a live chunk:
 * `{ ok, offset, endOffset, text, size, mtime }` with `text` cleaned and the
 * end on a safe boundary. `endOffset === offset` when nothing complete is
 * there yet.
 */
export async function readRange(filePath, {
  start,
  maxBytes = TASK_OUTPUT_LIMITS.chunkBytes,
  // Stop after the last line break (`\n` or `\r`): credentials are scrubbed
  // per piece, so a piece must not end inside one. An open line goes out
  // only when it is `longLineBytes` long, or with a later call without this.
  holdOpenLine = false,
  longLineBytes = TASK_OUTPUT_LIMITS.chunkBytes,
  fsImpl = fs,
} = {}) {
  const path = normalizeTaskOutputPath(filePath);
  if (!path) return { ok: false, code: 'invalid-path' };
  const from = Math.max(0, Math.trunc(Number(start) || 0));
  const read = await readBytes(path, from, from + Math.max(1, maxBytes), { fsImpl });
  if (!read.ok) return read;
  let length = safeChunkLength(read.buffer);
  if (holdOpenLine && length > 0) {
    let cut = -1;
    for (let index = length - 1; index >= 0; index -= 1) {
      const byte = read.buffer[index];
      if (byte === NEWLINE || byte === 0x0d) {
        cut = index + 1;
        break;
      }
    }
    if (cut > 0) length = cut;
    else if (length < longLineBytes) length = 0;
  }
  return {
    ok: true,
    offset: read.start,
    endOffset: read.start + length,
    text: cleanTaskOutput(read.buffer.subarray(0, length).toString('utf8')),
    size: read.size,
    mtime: read.mtimeMs,
  };
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/**
 * The output a worker posted for a task with no file (`output-snapshot`),
 * per store key and task; kept an hour like the ended rows.
 */
export function createTaskOutputSnapshots({ now = () => Date.now(), keepMs = TASK_OUTPUT_LIMITS.endedKeepMs, max = 200 } = {}) {
  const snapshots = new Map();
  const keyOf = (key, taskId) => `${String(key || '').trim()}\u0000${String(taskId || '').trim()}`;

  function prune() {
    const cutoff = now() - keepMs;
    for (const [key, entry] of snapshots) if (entry.at < cutoff) snapshots.delete(key);
    while (snapshots.size > max) snapshots.delete(snapshots.keys().next().value);
  }

  return {
    set(key, taskId, { output, totalBytes, truncated } = {}) {
      const text = String(output ?? '').slice(0, 64 * 1024);
      const bytes = Buffer.byteLength(text, 'utf8');
      const total = Number.isInteger(Number(totalBytes)) && Number(totalBytes) >= bytes ? Number(totalBytes) : bytes;
      const id = keyOf(key, taskId);
      snapshots.delete(id);
      snapshots.set(id, { output: text, totalBytes: total, truncated: truncated === true || total > bytes, at: now() });
      prune();
    },
    get(...args) {
      prune();
      const [keys, taskId] = args;
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const entry = snapshots.get(keyOf(key, taskId));
        if (entry) return entry;
      }
      return null;
    },
    forget(key, taskId) {
      snapshots.delete(keyOf(key, taskId));
    },
  };
}

/** A snapshot as the output route answers it. */
export function shapeSnapshot(snapshot) {
  const text = cleanTaskOutput(snapshot.output);
  const bytes = Buffer.byteLength(snapshot.output, 'utf8');
  return {
    text,
    startOffset: Math.max(0, snapshot.totalBytes - bytes),
    endOffset: snapshot.totalBytes,
    size: snapshot.totalBytes,
    mtime: snapshot.at,
    hasMoreBefore: false,
    truncated: !!snapshot.truncated,
    lines: foldTaskOutput(text),
  };
}

// ─── Health ──────────────────────────────────────────────────────────────────

/**
 * Runner counts of the window `buffer` that starts at byte `windowStart` of
 * the file: `{ counts, runner, final, firstFailureOffset }`, the offset the
 * byte where the first failure's line starts (null when there is none in the
 * window).
 */
export function healthOfWindow(buffer, windowStart) {
  let start = 0;
  if (windowStart > 0) {
    const next = afterNewline(buffer);
    start = next === -1 ? buffer.length : next;
  }
  const texts = [];
  const offsets = [];
  let position = start;
  while (position < buffer.length) {
    const at = buffer.indexOf(NEWLINE, position);
    const end = at === -1 ? buffer.length : at;
    const raw = buffer.subarray(position, end).toString('utf8');
    // A `\r` redraw keeps its last state, as the console shows it.
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    texts.push(stripControlKeepSgr(body.slice(body.lastIndexOf('\r') + 1)));
    offsets.push(windowStart + position);
    position = end + 1;
  }
  const summary = parseRunnerSummary(texts);
  if (!summary) return { counts: null, runner: null, final: false, firstFailureOffset: null };
  return {
    counts: { passed: summary.passed, failed: summary.failed, skipped: summary.skipped, ...(summary.flaky ? { flaky: summary.flaky } : {}) },
    runner: summary.runner,
    final: summary.final,
    firstFailureOffset: Number.isInteger(summary.firstFailureLine) ? offsets[summary.firstFailureLine] : null,
  };
}

function sameHealthFacts(a, b) {
  if (!a || !b) return false;
  return a.runner === b.runner
    && a.final === b.final
    && a.firstFailureOffset === b.firstFailureOffset
    && JSON.stringify(a.counts) === JSON.stringify(b.counts);
}

/**
 * Every `intervalMs` (10 s) over the live tasks with an output file: `stat`,
 * and when the size or time changed, the last 64 KB parsed for runner
 * counts. Readings go into the store (`setHealth`); a key's readings go to
 * the pages as `background_tasks_health { conversationId, health }` when the
 * counts change, and when the last output moved on by a minute or more (the
 * stall hint counts minutes). `conversationId` is the store key, as in
 * `background_tasks`.
 *
 * Ended rows are read too, until a reading finds the file as the last one
 * did: a task that ends between two ticks has its last output (a runner's
 * summary) read after the end, onto the ended row and to the pages. `poke`
 * runs a tick soon, for the moment a task ends.
 */
export function createTaskHealthPoller({
  store,
  io,
  intervalMs = 10_000,
  windowBytes = TASK_OUTPUT_LIMITS.healthBytes,
  fsImpl = fs,
  logger = console,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  pokeDelayMs = 250,
} = {}) {
  let timer = null;
  let running = false;
  let again = false;
  let poked = null;
  // key → taskId → the reading last sent to the pages.
  const sent = new Map();
  // key → taskId → the `endedAt` of the ended row whose file was read after
  // the end and found unchanged: nothing more to read for it.
  const settledEnded = new Map();

  async function readHealth(task, previous) {
    const { path } = taskOutputSource(task);
    if (!path) return null;
    const info = await inspectOutputFile(path, { fsImpl });
    // A file not there yet (a spool is named before its first byte): no
    // output yet, quiet since the task started.
    if (!info.ok && info.code === 'missing' && !previous?.size) {
      const startedAt = Number(task?.startedAt) || null;
      return { lastOutputAt: startedAt, size: 0, counts: null, runner: null, final: false, firstFailureOffset: null };
    }
    if (!info.ok) return previous || null;
    if (previous && previous.size === info.size && previous.lastOutputAt === info.mtimeMs) return previous;
    const windowStart = Math.max(0, info.size - windowBytes);
    const read = await readBytes(path, windowStart, info.size, { fsImpl });
    if (!read.ok) return previous || null;
    return {
      lastOutputAt: info.mtimeMs,
      size: info.size,
      ...healthOfWindow(read.buffer, read.start),
    };
  }

  // The same file as the last reading saw, with the same facts.
  function sameReading(a, b) {
    if (a === b) return true;
    return !!a && !!b && a.size === b.size && a.lastOutputAt === b.lastOutputAt && sameHealthFacts(a, b);
  }

  // The ended rows of `key` read after their end: `{ taskId: reading }` of
  // those whose reading changed.
  async function readEnded(key) {
    const changed = {};
    const rows = store.ended?.(key) || [];
    const done = settledEnded.get(key) || new Map();
    const kept = new Map();
    for (const row of rows) {
      const taskId = String(row?.taskId || '').trim();
      if (!taskId || !taskOutputSource(row).path) continue;
      if (done.get(taskId) === row.endedAt) {
        kept.set(taskId, row.endedAt);
        continue;
      }
      let reading = null;
      try {
        reading = await readHealth(row, row.health || null);
      } catch (error) {
        logger?.warn?.(`[task-output] health read failed for ended task ${taskId.slice(0, 12)}: ${error?.message || error}`);
      }
      if (!reading) continue;
      if (sameReading(row.health, reading)) {
        kept.set(taskId, row.endedAt);
        continue;
      }
      if (store.setEndedHealth?.(key, taskId, reading)) changed[taskId] = reading;
    }
    if (kept.size) settledEnded.set(key, kept);
    else settledEnded.delete(key);
    return changed;
  }

  async function tick({ poked: fromPoke = false } = {}) {
    if (!store?.sets) return;
    if (running) {
      if (fromPoke) again = true;
      return;
    }
    running = true;
    try {
      // Ended rows of conversations nobody opens again expire here.
      store.pruneAll?.();
      const keys = new Set([...store.sets.keys(), ...(store.endedKeys?.() || [])]);
      for (const key of keys) {
        const tasks = Array.isArray(store.sets.get(key)?.tasks) ? store.sets.get(key).tasks : [];
        const changed = {};
        let anyChange = false;
        const current = {};
        for (const task of tasks) {
          const taskId = String(task?.taskId || '').trim();
          if (!taskId || !taskOutputSource(task).path) continue;
          let reading = null;
          try {
            reading = await readHealth(task, store.health(key, taskId));
          } catch (error) {
            logger?.warn?.(`[task-output] health read failed for task ${taskId.slice(0, 12)}: ${error?.message || error}`);
          }
          if (!reading) continue;
          store.setHealth(key, taskId, reading);
          current[taskId] = reading;
          const last = sent.get(key)?.get(taskId);
          if (!last || !sameHealthFacts(last, reading) || reading.lastOutputAt - last.lastOutputAt >= 60_000) {
            changed[taskId] = reading;
            anyChange = true;
          }
        }
        const endedChanged = await readEnded(key);
        if (Object.keys(endedChanged).length) anyChange = true;
        if (!anyChange) continue;
        const record = new Map(sent.get(key) || []);
        for (const [taskId, reading] of Object.entries(changed)) record.set(taskId, reading);
        // Tasks gone from the set leave the record.
        for (const taskId of [...record.keys()]) if (!current[taskId]) record.delete(taskId);
        sent.set(key, record);
        try {
          io?.emit?.('background_tasks_health', { conversationId: key, health: { ...current, ...endedChanged } });
        } catch {}
      }
      for (const key of [...sent.keys()]) if (!store.sets.has(key)) sent.delete(key);
      for (const key of [...settledEnded.keys()]) if (!keys.has(key)) settledEnded.delete(key);
    } finally {
      running = false;
    }
    // A poke during the tick: once more, for what it may have missed.
    if (again) {
      again = false;
      await tick();
    }
  }

  return {
    tick,
    /** A task ended: a tick soon rather than within 10 s. */
    poke() {
      if (poked) return;
      poked = setTimeoutImpl(() => {
        poked = null;
        tick({ poked: true }).catch(() => {});
      }, pokeDelayMs);
      poked?.unref?.();
    },
    start() {
      if (timer) return;
      timer = setIntervalImpl(() => { tick().catch(() => {}); }, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
  };
}
