// The spool a session worker writes a background task's output into when the
// provider keeps none in a file of its own (Copilot's attached shells, Grok's
// terminals): `<os.tmpdir()>/oar-task-output/<sessionId>/<taskId>.log`,
// append-only. The worker names the file as the task row's `outputPath`
// (`outputKind: 'spool'`) and the relay reads it like any other output file,
// so the console works the same for every provider and outlives a worker
// restart.
//
// Bounded: a file stops growing at 50 MB with one "output capped" line, and
// `sweep()` (at worker start and hourly) deletes files that ended more than an
// hour ago. Nothing is deleted at exit: the relay keeps showing an ended
// task's output for about an hour.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TASK_OUTPUT_SPOOL_DIR = 'oar-task-output';
export const TASK_OUTPUT_SPOOL_MAX_BYTES = 50 * 1024 * 1024;
export const TASK_OUTPUT_SPOOL_MAX_AGE_MS = 60 * 60 * 1000;
// A dead worker's session folder is left for its own next start to sweep;
// another session's worker removes it only once it is a day old.
export const TASK_OUTPUT_SPOOL_FOREIGN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CAPPED_LINE = '\n[output capped at 50 MB: later output is not kept]\n';

/** A file-name-safe form of an id: [A-Za-z0-9._-], at most 128 characters, never `.` or `..`. */
export function spoolSafeName(value) {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return /^\.+$/.test(text) ? text.replace(/\./g, '_') : text;
}

/**
 * `createTaskOutputSpool({ sessionId })` →
 * `{ root, pathFor(taskId), append(taskId, text), end(taskId), sweep(maxAgeMs) }`.
 *
 *  - `pathFor(taskId)`: the absolute file path for the task's row.
 *  - `append(taskId, text)`: `{ ok, bytes, capped }`; never throws. The cap
 *    writes one marker line and drops what comes after it.
 *  - `end(taskId)`: the task finished; its file stays for the relay until a
 *    sweep finds it older than the age limit.
 *  - `sweep(maxAgeMs = 1 h)`: deletes this session's files not written to for
 *    that long (a task still appending is never swept), and other sessions'
 *    folders a day old. Returns the number of files removed.
 *
 * `baseDir` (default the OS temp dir) and `now` are for tests.
 */
export function createTaskOutputSpool({
  sessionId,
  now = () => Date.now(),
  baseDir = os.tmpdir(),
  maxBytes = TASK_OUTPUT_SPOOL_MAX_BYTES,
  fsImpl = fs,
} = {}) {
  const sessionName = spoolSafeName(sessionId);
  if (!sessionName) throw new Error('createTaskOutputSpool requires sessionId');
  const top = path.join(path.resolve(baseDir), TASK_OUTPUT_SPOOL_DIR);
  const root = path.join(top, sessionName);
  // taskId → { bytes, capped }; a task listed here is live (still appending).
  const live = new Map();
  let rootReady = false;

  // The shared folder is ours to write and sweep only when it is a real
  // folder (not a symlink someone else put into a shared temp dir) owned by
  // this user where the platform says who owns it.
  function topIsOurs() {
    let stats;
    try { stats = fsImpl.lstatSync(top); } catch { return false; }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    return uid === null || typeof stats.uid !== 'number' || stats.uid === uid;
  }

  function ensureRoot() {
    if (rootReady) return;
    // Owner-only: the temp dir is shared on a multi-user host.
    try { fsImpl.mkdirSync(top, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (!topIsOurs()) throw new Error(`${top} is not a folder of this user`);
    fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
    rootReady = true;
  }

  function pathFor(taskId) {
    const name = spoolSafeName(taskId);
    if (!name) throw new Error('task id is empty');
    return path.join(root, `${name}.log`);
  }

  function stateOf(taskId, file) {
    let state = live.get(taskId);
    if (!state) {
      let bytes = 0;
      try { bytes = fsImpl.statSync(file).size; } catch {}
      state = { bytes, capped: bytes >= maxBytes };
      live.set(taskId, state);
    }
    return state;
  }

  function append(taskId, text) {
    const id = String(taskId ?? '').trim();
    const value = typeof text === 'string' ? text : (Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? ''));
    if (!id) return { ok: false, bytes: 0, capped: false };
    try {
      ensureRoot();
      const file = pathFor(id);
      const state = stateOf(id, file);
      if (state.capped || !value) return { ok: true, bytes: state.bytes, capped: state.capped };
      let data = Buffer.from(value, 'utf8');
      const room = maxBytes - state.bytes;
      if (data.length > room) {
        // Cut on a character boundary, then say so once.
        let end = Math.max(0, room);
        while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
        data = Buffer.concat([data.subarray(0, end), Buffer.from(CAPPED_LINE, 'utf8')]);
        state.capped = true;
      }
      fsImpl.appendFileSync(file, data, { mode: 0o600 });
      state.bytes += data.length;
      return { ok: true, bytes: state.bytes, capped: state.capped };
    } catch {
      return { ok: false, bytes: live.get(id)?.bytes || 0, capped: !!live.get(id)?.capped };
    }
  }

  function end(taskId) {
    live.delete(String(taskId ?? '').trim());
  }

  function liveNames() {
    return new Set([...live.keys()].map((id) => `${spoolSafeName(id)}.log`));
  }

  function sweepDir(dir, maxAge, skip = new Set()) {
    let removed = 0;
    let left = 0;
    let entries = [];
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return { removed, left: 0, missing: true }; }
    const cutoff = now() - maxAge;
    for (const entry of entries) {
      if (!entry.isFile() || skip.has(entry.name)) {
        left += 1;
        continue;
      }
      const file = path.join(dir, entry.name);
      try {
        if (fsImpl.statSync(file).mtimeMs < cutoff) {
          fsImpl.unlinkSync(file);
          removed += 1;
        } else {
          left += 1;
        }
      } catch {
        left += 1;
      }
    }
    return { removed, left, missing: false };
  }

  function sweep(maxAgeMs = TASK_OUTPUT_SPOOL_MAX_AGE_MS) {
    const maxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 ? Number(maxAgeMs) : TASK_OUTPUT_SPOOL_MAX_AGE_MS;
    // Never through a symlinked or foreign shared folder: its "session
    // folders" could be anything.
    if (!topIsOurs()) return 0;
    let removed = sweepDir(root, maxAge, liveNames()).removed;
    let folders = [];
    try { folders = fsImpl.readdirSync(top, { withFileTypes: true }); } catch {}
    for (const folder of folders) {
      if (!folder.isDirectory() || folder.name === sessionName) continue;
      const dir = path.join(top, folder.name);
      const result = sweepDir(dir, Math.max(maxAge, TASK_OUTPUT_SPOOL_FOREIGN_MAX_AGE_MS));
      removed += result.removed;
      if (!result.missing && result.left === 0) {
        try { fsImpl.rmdirSync(dir); } catch {}
      }
    }
    return removed;
  }

  return { root, pathFor, append, end, sweep };
}
