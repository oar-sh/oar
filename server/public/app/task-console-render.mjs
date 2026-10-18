// Pure pieces of the task console and the task rows: the pass/fail chip, the
// stall hint, the ✓/✘ of an ended task, the console's line rows and the
// search for the first failure. DOM nodes are built with createElement and
// textContent only: every string here comes from a worker's output.

import { ansiToSegments, stallMinutes } from './task-output-text.mjs';

// Mirrors the stall setting's bounds in shared/task-output-text.mjs.
export const DEFAULT_TASK_STALL_MINUTES = 10;
export const TASK_STALL_MINUTES_MIN = 1;
export const TASK_STALL_MINUTES_MAX = 120;

/** The minutes after which a quiet task is marked, from a payload value. */
export function normalizeStallThreshold(value) {
  const minutes = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(minutes)) return DEFAULT_TASK_STALL_MINUTES;
  return Math.min(TASK_STALL_MINUTES_MAX, Math.max(TASK_STALL_MINUTES_MIN, Math.round(minutes)));
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

/**
 * The chip for a test runner's counts: "✓ 412 ✘ 2", "✓ 38". Null when the
 * health names no counts. `failed` marks the red variant.
 */
export function runnerChip(health) {
  const counts = health?.counts;
  if (!counts || typeof counts !== 'object') return null;
  const passed = count(counts.passed);
  const failed = count(counts.failed);
  const skipped = count(counts.skipped);
  if (!passed && !failed && !skipped) return null;
  const text = failed ? `✓ ${passed} ✘ ${failed}` : `✓ ${passed}`;
  const runner = String(health?.runner || '').trim();
  const titleParts = [`${passed} passed`, `${failed} failed`];
  if (skipped) titleParts.push(`${skipped} skipped`);
  return {
    text,
    failed: failed > 0,
    title: `${runner ? `${runner}: ` : ''}${titleParts.join(', ')}`,
  };
}

/**
 * "no output for 12 min" once a live task has been quiet a minute or more;
 * `warn` from the threshold on. Null while output is fresh or unknown.
 */
export function stallHint(lastOutputAt, thresholdMinutes, now = Date.now()) {
  const minutes = stallMinutes(lastOutputAt, now);
  if (minutes == null || minutes < 1) return null;
  return {
    minutes,
    text: `no output for ${minutes} min`,
    warn: minutes >= normalizeStallThreshold(thresholdMinutes),
  };
}

/** ✓ or ✘ for an ended task, from its status and exit code. */
export function endedOutcome(task) {
  const status = String(task?.status || '').trim().toLowerCase();
  const exitCode = task?.exitCode;
  const hasExit = exitCode !== null && exitCode !== undefined && exitCode !== '' && Number.isFinite(Number(exitCode));
  const failed = status === 'failed' || (hasExit && Number(exitCode) !== 0);
  const stopped = status === 'stopped' || status === 'killed' || status === 'cancelled';
  const label = failed
    ? (hasExit ? `failed, exit code ${Number(exitCode)}` : 'failed')
    : stopped ? 'stopped' : status === 'completed' || (hasExit && Number(exitCode) === 0) ? 'completed' : 'ended';
  return {
    icon: failed ? '✘' : stopped ? '■' : '✓',
    ok: !failed && !stopped,
    failed,
    label,
  };
}

/** "22 steps", "1 step", or '' when unknown. */
export function stepsLabel(steps) {
  const number = Number(steps);
  if (!Number.isFinite(number) || number < 0) return '';
  const whole = Math.floor(number);
  return `${whole} step${whole === 1 ? '' : 's'}`;
}

/** Whether a row opens the console: shell and Monitor tasks with output. */
export function taskHasConsole(task) {
  const kind = String(task?.outputKind || '').trim();
  if (kind === 'none') return false;
  if (kind) return true;
  if (String(task?.outputPath || '').trim()) return true;
  const type = String(task?.taskType || '').trim();
  return type === 'local_bash' || type === 'monitor';
}

export function taskOutputUnavailable(task) {
  return String(task?.outputKind || '').trim() === 'none';
}

// ─── Line rows ───────────────────────────────────────────────────────────────

function segmentClass(segment) {
  const classes = [];
  if (Number.isInteger(segment.fg)) classes.push(`tc-fg-${segment.fg}`);
  if (Number.isInteger(segment.bg)) classes.push(`tc-bg-${segment.bg}`);
  if (segment.bold) classes.push('tc-bold');
  if (segment.dim) classes.push('tc-dim');
  if (segment.italic) classes.push('tc-italic');
  if (segment.underline) classes.push('tc-underline');
  return classes.join(' ');
}

function segmentsOf(line) {
  if (Array.isArray(line?.segments)) return line.segments;
  if (Array.isArray(line?.ansi)) return line.ansi;
  return ansiToSegments(String(line?.text ?? ''));
}

/** Plain text of a line, without its colour codes. */
export function lineText(line) {
  return segmentsOf(line).map((segment) => String(segment?.text ?? '')).join('');
}

/**
 * One `.tc-line` row: SGR spans for the text, then "×N" for a folded repeat.
 * `partial` marks the line still being written.
 */
export function buildLineNode(doc, line, { partial = false } = {}) {
  const row = doc.createElement('div');
  row.className = partial ? 'tc-line tc-line-partial' : 'tc-line';
  const segments = segmentsOf(line);
  if (!segments.length) row.appendChild(doc.createTextNode('​'));
  for (const segment of segments) {
    const text = String(segment?.text ?? '');
    if (!text) continue;
    const className = segmentClass(segment);
    if (!className) {
      row.appendChild(doc.createTextNode(text));
      continue;
    }
    const span = doc.createElement('span');
    span.className = className;
    span.textContent = text;
    row.appendChild(span);
  }
  const repeats = count(line?.count);
  if (repeats > 1) {
    const badge = doc.createElement('span');
    badge.className = 'tc-line-count';
    badge.textContent = `×${repeats}`;
    row.appendChild(badge);
  }
  return row;
}

// The failure lines of the runners the relay parses (vitest, jest, node:test,
// Playwright, pytest, turbo), as shared/task-output-text.mjs finds them: the
// per-test marks and the detailed reports. The jump lands on the earliest.
const FAILURE_LINE_PATTERNS = [
  /^\s*(?:[✗✘×✕✖]|\[FAIL\])\s+(?!failing tests:)/,
  /^\s*FAIL\s/,
  /^\s{2}\d+\) /,
  /^\s*●\s/,
  /^_{3,} .+ _{3,}$/,
  /\s(?:FAILED|ERROR)(?:\s+\[\s*\d+%\])?\s*$/,
  /^not ok \d+ /,
  /command finished with error/i,
];

/** Index of the first line that reads as a failing test, or -1. */
export function findFirstFailureIndex(lines) {
  const list = Array.isArray(lines) ? lines : [];
  for (let index = 0; index < list.length; index += 1) {
    const text = lineText(list[index]);
    if (FAILURE_LINE_PATTERNS.some((pattern) => pattern.test(text))) return index;
  }
  return -1;
}

/**
 * The console header's meta line: "Shell · 4m 12s · failed, exit code 1".
 * The stall hint goes beside it in its own element (it turns amber).
 */
export function consoleMetaParts({ task, elapsed, ended, status, exitCode, kind }) {
  const parts = [];
  const type = String(task?.taskType || '').trim();
  parts.push(type === 'monitor' ? 'Monitor' : type === 'local_bash' ? 'Shell' : (type || 'Task'));
  if (elapsed) parts.push(elapsed);
  if (ended) parts.push(endedOutcome({ status, exitCode }).label);
  else parts.push('running');
  if (kind === 'snapshot') parts.push('last 8 KB, read again every 3 s');
  if (kind === 'spool' && task?.mirrored) parts.push("output mirrored from the runtime's recent window");
  return parts;
}

// ─── Live chunks ─────────────────────────────────────────────────────────────

/** Where the file stands after a chunk: its end offset, else the file size. */
export function chunkEndOffset(chunk) {
  for (const key of ['endOffset', 'nextOffset', 'size']) {
    const value = Number(chunk?.[key]);
    if (chunk?.[key] !== undefined && chunk?.[key] !== null && Number.isFinite(value)) return value;
  }
  return NaN;
}

/**
 * What a `task_output_chunk` does to a view that holds the file up to
 * `nextOffset` (of a file `size` bytes long): 'apply' when it continues
 * exactly there, 'ignore' when it only repeats bytes already shown, and
 * 'refetch' for a gap, an overlap, or a file that got shorter (the relay's
 * `reset`, or a smaller size).
 */
export function chunkAction({ nextOffset, size }, chunk) {
  if (chunk?.reset === true) return 'refetch';
  const offset = Number(chunk?.offset);
  if (!Number.isFinite(offset)) return 'ignore';
  const chunkSize = Number(chunk?.size);
  if (Number.isFinite(chunkSize) && Number.isFinite(Number(size)) && chunkSize < Number(size)) return 'refetch';
  if (offset === Number(nextOffset)) return 'apply';
  const end = chunkEndOffset(chunk);
  if (offset < Number(nextOffset) && Number.isFinite(end) && end <= Number(nextOffset)) return 'ignore';
  return 'refetch';
}

/** Bytes a modal may hold before "Load earlier" stops paging back. */
export const TASK_CONSOLE_MAX_LOADED_BYTES = 5 * 1024 * 1024;

/** The "Load earlier" button's state. */
export function loadEarlierState({ hasMoreBefore, loadedBytes, loading = false }) {
  if (!hasMoreBefore) return { hidden: true, disabled: true, text: '' };
  if (Number(loadedBytes) >= TASK_CONSOLE_MAX_LOADED_BYTES) {
    return { hidden: false, disabled: true, text: 'older output not loaded' };
  }
  return { hidden: false, disabled: !!loading, text: loading ? 'Loading…' : 'Load earlier' };
}
