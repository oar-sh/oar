// node:test reporter for `npm test` (`npm run test:verbose` uses spec): silent on success. It prints
// each failing test (file, line, name path and error), the stderr of every
// test file that failed, and one summary line. Use it where the output is
// read by a tool or a log rather than a person watching the run.

import path from 'node:path';
import { inspect } from 'node:util';

const MAX_ERROR_LINES = 40;
const MAX_STDERR_CHARS = 4000;

function rel(file) {
  if (!file) return '?';
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') ? file : relative;
}

function clip(text, maxLines) {
  const lines = String(text).split('\n');
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`];
}

function formatError(error) {
  const shown = error?.failureType === 'testCodeFailure' && error.cause ? error.cause : error;
  const text = inspect(shown, { depth: 4, colors: false })
    .split('\n')
    .filter((line) => !/^\s+at (?:.*\()?node:(?:internal|async_hooks)/.test(line))
    .join('\n');
  return clip(text, MAX_ERROR_LINES);
}

// The progress line, so a long run does not look hung: on a terminal one
// line rewritten in place at most every second; in a log or a pipe a line
// every 30 seconds. OAR_TEST_PROGRESS=0 turns it off.
const TTY_PROGRESS_MS = 1_000;
const LOG_PROGRESS_MS = 30_000;
const CLEAR_LINE = '\r\x1b[K';

export function createFailuresReporter({
  isTTY = Boolean(process.stdout.isTTY),
  progress = process.env.OAR_TEST_PROGRESS !== '0',
  now = Date.now,
} = {}) {
  return (source) => failuresOnly(source, { isTTY, progress, now });
}

async function* failuresOnly(source, { isTTY, progress, now }) {
  const names = new Map(); // file -> [name at nesting 0, 1, …]
  const stderr = new Map(); // file -> text (tail)
  const failedFiles = new Set();
  let failures = 0;
  let summary = null;
  const startedAt = now();
  let done = 0;
  let lastProgressAt = startedAt;
  let lineShown = false;
  const progressLine = () => `… ${done} tests done, ${failures} failed (${Math.round((now() - startedAt) / 1000)}s)`;
  // Takes the in-place line away before other output.
  const clear = () => {
    if (!lineShown) return '';
    lineShown = false;
    return CLEAR_LINE;
  };

  for await (const { type, data } of source) {
    if (type === 'test:start') {
      const stack = names.get(data.file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      names.set(data.file, stack);
    } else if (type === 'test:stderr') {
      const text = (stderr.get(data.file) ?? '') + data.message;
      stderr.set(data.file, text.length > MAX_STDERR_CHARS ? text.slice(-MAX_STDERR_CHARS) : text);
    } else if (type === 'test:fail') {
      failedFiles.add(data.file);
      const error = data.details?.error;
      // A suite or file that failed only because a test inside it did is
      // already reported through that test.
      if (error?.failureType !== 'subtestsFailed') {
        failures += 1;
        const stack = (names.get(data.file) ?? []).slice(0, data.nesting);
        const where = data.line ? `${rel(data.file)}:${data.line}` : rel(data.file);
        yield `${clear()}\n✖ ${where}\n  ${[...stack, data.name].join(' › ')}\n`;
        for (const line of formatError(error)) yield `    ${line}\n`;
      }
    } else if (type === 'test:summary' && data.file === undefined) {
      summary = data;
    }
    if (progress && (type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      done += 1;
      const at = now();
      if (at - lastProgressAt >= (isTTY ? TTY_PROGRESS_MS : LOG_PROGRESS_MS)) {
        lastProgressAt = at;
        if (isTTY) {
          lineShown = true;
          yield `${CLEAR_LINE}${progressLine()}`;
        } else {
          yield `${progressLine()}\n`;
        }
      }
    }
  }

  const cleared = clear();
  if (cleared) yield cleared;
  for (const file of failedFiles) {
    const text = stderr.get(file)?.trim();
    if (!text) continue;
    yield `\n── stderr of ${rel(file)} (tail) ──\n${text}\n`;
  }

  if (summary) {
    const c = summary.counts;
    const status = summary.success ? 'ok' : 'FAILED';
    yield `\n${status}: ${c.passed} passed, ${c.failed} failed, ${c.cancelled} cancelled, ${c.skipped} skipped, ${c.todo} todo`
      + ` (${c.tests} tests, ${Math.round(summary.duration_ms / 1000)}s)\n`;
  } else {
    yield `\n${failures ? 'FAILED' : 'ok'}: ${failures} failing test(s)\n`;
  }
}

export default createFailuresReporter();
