// Pure pieces of the task console and the task rows: the pass/fail chip, the
// stall hint, the ✓/✘ of an ended task, the console's line rows, the search
// for the first failure, the "output stops here" marker of a command piped
// into tail, and the texts for a task without output (the relay's answer
// uses them too). DOM nodes are built with createElement and textContent
// only: every string here comes from a worker's output.

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

/**
 * ✓, ✘, ■ or ? for an ended task, from its status and exit code. `unknown`
 * (a task whose worker did not come back after a relay restart) is neither a
 * success nor a failure: a neutral ?, not a green ✓.
 */
export function endedOutcome(task) {
  const status = String(task?.status || '').trim().toLowerCase();
  const exitCode = task?.exitCode;
  const hasExit = exitCode !== null && exitCode !== undefined && exitCode !== '' && Number.isFinite(Number(exitCode));
  const failed = status === 'failed' || (hasExit && Number(exitCode) !== 0);
  const stopped = status === 'stopped' || status === 'killed' || status === 'cancelled';
  const unknown = !failed && !stopped && !hasExit && status === 'unknown';
  const label = failed
    ? (hasExit ? `failed, exit code ${Number(exitCode)}` : 'failed')
    : stopped ? 'stopped'
      : unknown ? 'ended, result unknown'
        : status === 'completed' || (hasExit && Number(exitCode) === 0) ? 'completed' : 'ended';
  return {
    icon: failed ? '✘' : stopped ? '■' : unknown ? '?' : '✓',
    ok: !failed && !stopped && !unknown,
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

/**
 * Why a task has no output to show: the console's `none` answer (the relay's
 * output route imports these) and the row's hover title, in one wording.
 */
export const TASK_OUTPUT_NONE_MESSAGES = Object.freeze({
  provider: 'Output is not available for this provider.',
  subagent: 'Sub-agents have no shell output; open the sub-agent view.',
  noOutputFile: 'This session did not report an output file for this task. Sessions started before the task console need a restart to show output.',
  noPath: 'Output is not available for this task.',
});

// ─── Commands piped into tail ────────────────────────────────────────────────

// A command line as its pipeline stages: `{ words, piped }` per simple
// command, `piped` when a `|` (or `|&`) feeds it. Quotes and backslashes are
// honoured, `||`, `&&`, `;`, `&` and newlines end a stage without a pipe;
// `2>&1` and `&>` are redirections, not separators, and a `#` that starts a
// word comments out the rest of its line. Not a shell: enough to tell where
// a `| tail` sits.
function pipelineStages(command) {
  const text = String(command ?? '');
  const stages = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  let piped = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endStage = (nextPiped) => {
    endWord();
    if (words.length) stages.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && index + 1 < text.length) word += text[++index];
      else word += char;
      continue;
    }
    if (char === '\\') {
      word += text[index + 1] ?? '';
      inWord = true;
      index += 1;
      continue;
    }
    if (char === '#' && !inWord) {
      while (index + 1 < text.length && text[index + 1] !== '\n') index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === '|') {
      if (text[index + 1] === '|') {
        index += 1;
        endStage(false);
        continue;
      }
      if (text[index + 1] === '&') index += 1;
      endStage(true);
      continue;
    }
    if (char === '&') {
      const redirect = text[index - 1] === '>' || text[index - 1] === '<' || text[index + 1] === '>';
      if (!redirect) {
        if (text[index + 1] === '&') index += 1;
        endStage(false);
        continue;
      }
    }
    if (char === ';' || char === '\n' || char === '(' || char === ')') {
      endStage(false);
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
    inWord = true;
  }
  endStage(false);
  return stages;
}

// tail -f / -F / --follow streams; so does tail from a line (`-n +2`, `+2`).
function tailStreams(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (/^--follow\b/.test(arg) || /^-[A-Za-z0-9]*[fF]/.test(arg)) return true;
    if (/^\+\d/.test(arg) || /^-[nc]\+\d/.test(arg) || /^--(?:lines|bytes)=\+/.test(arg)) return true;
    if ((arg === '-n' || arg === '-c' || arg === '--lines' || arg === '--bytes') && /^\+\d/.test(args[index + 1] || '')) return true;
  }
  return false;
}

/**
 * 'tail' when the command line pipes into a tail that holds the output back
 * until the command ends (`npm test 2>&1 | tail -40`), else ''. `tail -f`
 * and `tail -n +N` stream and do not count; neither does a `|` inside quotes
 * or a comment. `head` passes its lines on as they come (and ends the
 * command early), so it holds nothing back.
 */
export function pipeHoldProgram(command) {
  for (const { words, piped } of pipelineStages(command)) {
    if (!piped) continue;
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
    const program = String(words[at] || '').split('/').pop();
    if (program === 'tail' && !tailStreams(words.slice(at + 1))) return 'tail';
  }
  return '';
}

/** 'tail' when a task's command line (its `command`, else its description) pipes into a holding tail. */
export function taskPipeHold(task) {
  return pipeHoldProgram(task?.command) || pipeHoldProgram(task?.description);
}

/** What the console and the quiet row say about a command piped into `program`. */
export function pipeHoldNotice(program) {
  if (!program) return null;
  const hint = 'Logging to a file instead (> run.log 2>&1) and following that file shows it live.';
  return {
    text: `Output stops here: this command pipes into ${program}, so the rest arrives when it ends.`,
    hint,
    title: `This command pipes into ${program}, so its output arrives when it ends. ${hint}`,
  };
}

/**
 * Whether the console shows the "output stops here" marker: a live task
 * whose command pipes into tail, as long as nothing came in since
 * the console opened (`openedAt` the end offset of the first read).
 */
export function showPipeHoldMarker({ program, ended, kind, openedAt, nextOffset }) {
  if (!program || ended || kind === 'none' || !kind) return false;
  return !Number.isFinite(Number(openedAt)) || Number(nextOffset) <= Number(openedAt);
}

// ─── Line rows ───────────────────────────────────────────────────────────────

// Inverse text arrives with its colours swapped (task-output-text.mjs); a
// side left unset takes the console's own colour of the other side.
function segmentClass(segment) {
  const classes = [];
  if (Number.isInteger(segment.fg)) classes.push(`tc-fg-${segment.fg}`);
  else if (segment.inverse) classes.push('tc-fg-inverse');
  if (Number.isInteger(segment.bg)) classes.push(`tc-bg-${segment.bg}`);
  else if (segment.inverse) classes.push('tc-bg-inverse');
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
  // Held since a relay restart until its worker reports.
  else if (status === 'held') parts.push('waiting for its worker after the relay restart');
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
