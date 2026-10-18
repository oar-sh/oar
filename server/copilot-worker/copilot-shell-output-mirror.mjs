// An attached Copilot shell keeps its output in the runtime only: the worker
// sees it as `tasks.getProgress().recentOutput`, a sliding window of the last
// lines, on every registry refresh. The task console needs a file, so each
// window's new part is appended to the session's spool
// (shared/worker-runtime/task-output-spool.mjs).
//
// Consecutive windows overlap: the new part is what follows the longest
// suffix of the previous window that is also a prefix of the new one. With no
// overlap at all (more output between two refreshes than the window holds)
// the lines in between are lost; the new window is appended whole after a
// line break, and the modal says the output is mirrored from a window.

/** The runtime's placeholder for a shell that has printed nothing yet. */
const NO_OUTPUT_PLACEHOLDER = '(no output yet)';

/**
 * Length of the longest suffix of `previous` that is a prefix of `next`
 * (prefix function over `next + sep + previous`, linear time: windows are
 * kilobytes and are compared on every refresh).
 */
export function overlapLength(previous, next) {
  const a = String(next || '');
  const b = String(previous || '');
  if (!a || !b) return 0;
  const n = a.length;
  const fail = new Int32Array(n);
  for (let i = 1, k = 0; i < n; i += 1) {
    while (k > 0 && a[i] !== a[k]) k = fail[k - 1];
    if (a[i] === a[k]) k += 1;
    fail[i] = k;
  }
  let k = 0;
  for (let i = 0; i < b.length; i += 1) {
    while (k > 0 && (k === n || b[i] !== a[k])) k = fail[k - 1];
    if (b[i] === a[k]) k += 1;
  }
  return k;
}

/**
 * What to append when the window moves from `previous` to `next`:
 * `{ text, gap }`, `gap` true when the windows share nothing.
 */
export function newOutputSuffix(previous, next) {
  const before = String(previous || '');
  const after = String(next || '');
  if (!after || after === before) return { text: '', gap: false };
  if (!before) return { text: after, gap: false };
  if (after.startsWith(before)) return { text: after.slice(before.length), gap: false };
  const overlap = overlapLength(before, after);
  if (overlap > 0) return { text: after.slice(overlap), gap: false };
  return { text: after, gap: true };
}

export function createShellOutputMirror({ spool, dbg = () => {} } = {}) {
  // taskId → { window, endsWithNewline }
  const mirrors = new Map();

  /** Feed one `recentOutput` window; returns the text appended. */
  function mirror(taskId, recentOutput) {
    const id = String(taskId || '').trim();
    if (!id || !spool) return '';
    const state = mirrors.get(id) || { window: '', endsWithNewline: true };
    mirrors.set(id, state);
    const window = typeof recentOutput === 'string' ? recentOutput : '';
    if (!window || window.trim() === NO_OUTPUT_PLACEHOLDER) return '';
    const { text, gap } = newOutputSuffix(state.window, window);
    state.window = window;
    if (!text) return '';
    const written = gap && !state.endsWithNewline ? `\n${text}` : text;
    const result = spool.append(id, written);
    if (result && result.ok === false) dbg('task output spool append failed', id);
    state.endsWithNewline = written.endsWith('\n');
    return written;
  }

  /** Whether a window of this task was ever fed (its spool file is named). */
  function has(taskId) {
    return mirrors.has(String(taskId || '').trim());
  }

  /** The task ended: no more windows; the file stays for the relay. */
  function forget(taskId) {
    const id = String(taskId || '').trim();
    if (!mirrors.delete(id)) return;
    try { spool?.end?.(id); } catch {}
  }

  function ids() {
    return [...mirrors.keys()];
  }

  return { mirror, has, forget, ids };
}
