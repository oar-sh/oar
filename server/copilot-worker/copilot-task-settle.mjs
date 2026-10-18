// How a Copilot background task ended, for the relay's settle post
// (`/api/background-task-settled`), with no I/O so it can be tested against
// the runtime's payloads.
//
// What the runtime gives (SDK 1.0.17, generated/rpc.d.ts and
// generated/session-events.d.ts):
//
//  - `tasks.list()` keeps a finished task with `status` completed, failed or
//    cancelled (`TaskStatus`); an agent adds `result` (its result text) or
//    `error`. A shell entry (`TaskShellInfo`) carries no exit code.
//  - `system.notification` of kind `shell_completed` (an attached shell) has
//    an optional `exitCode`; `shell_detached_completed` has none, and its
//    text only says to read the shell with `read_bash`.
//  - a `read_bash` (or `bash`) result ends with
//    `<detached command with shellId: 1 completed with exit code 0>` once
//    the shell is done: the detached shell's exit code, when the model reads
//    it.
//
// A progress line (`tasks.getProgress`: the agent's latest intent, its last
// activity line) is how the task is doing, not how it ended: a spinner or
// status line such as "⟳ Thinking…" is never a summary.

// Spinner and progress glyphs a status line starts with.
const SPINNER_PREFIX_RE = /^[\s⟳↻↺⏳⌛◌◐◓◑◒○●◴◷◶◵⠁-⣿·•…]+/u;
const STATUS_WORD_RE = /^(?:thinking|working|waiting|running|loading|processing|starting|reasoning|planning)(?:\s*(?:\.{2,}|…))?$/i;
// `<detached command with shellId: 1 completed with exit code 0>`,
// `<shellId: 0 completed with exit code 0>`.
const SHELL_EXIT_TEXT_RE = /shellId:\s*([^\s>,]+)[^<>]*?completed with exit code\s+(-?\d+)/i;

const SUMMARY_MAX = 500;

function text(value) {
  return String(value ?? '').trim();
}

/** Whether a progress line is a transient status ("⟳ Thinking…") rather than content. */
export function isTransientProgressText(value) {
  const line = text(value);
  if (!line) return true;
  const glyphs = SPINNER_PREFIX_RE.exec(line)?.[0] || '';
  const rest = line.slice(glyphs.length).trim();
  if (!rest) return true;
  // A status word alone, with or without a spinner in front.
  return STATUS_WORD_RE.test(rest);
}

/**
 * The exit code an event reports for a shell: `{ shellId, exitCode }` or
 * null. From a `shell_completed` notification that has one, or from a shell
 * tool's result text.
 */
export function shellExitFromEvent(event) {
  const type = text(event?.type);
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  if (type === 'system.notification') {
    const kind = data.kind && typeof data.kind === 'object' ? data.kind : {};
    const shellId = text(kind.shellId);
    if (kind.type === 'shell_completed' && shellId && Number.isInteger(kind.exitCode)) {
      return { shellId, exitCode: kind.exitCode };
    }
    return null;
  }
  if (type === 'tool.execution_complete') {
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    const match = SHELL_EXIT_TEXT_RE.exec(`${text(result.content)}\n${text(result.detailedContent)}`);
    if (!match) return null;
    const exitCode = Number(match[2]);
    return Number.isInteger(exitCode) ? { shellId: match[1], exitCode } : null;
  }
  return null;
}

/**
 * How a task that left the live set ended: `{ status, exitCode, summary }`.
 * `task` is the runtime's entry as `tasks.list()` gives it now (finished),
 * or the last running one when the list no longer has it; `exitCode` what
 * the events said for a shell (null when nothing did).
 */
export function settleForTask(task, { exitCode = null } = {}) {
  const status = text(task?.status).toLowerCase();
  const code = Number.isInteger(exitCode) ? exitCode : null;
  let settled;
  if (status === 'cancelled') settled = 'stopped';
  else if (status === 'failed') settled = 'failed';
  else if (code !== null) settled = code === 0 ? 'completed' : 'failed';
  else if (status === 'completed') settled = 'completed';
  else settled = 'unknown';
  let summary = null;
  if (task?.type === 'agent') {
    const result = text(settled === 'failed' ? (task.error || task.result) : (task.result || task.latestResponse));
    if (result && !isTransientProgressText(result)) summary = result.slice(0, SUMMARY_MAX);
  } else if (code !== null) {
    summary = `exit code ${code}`;
  }
  return { status: settled, exitCode: code, summary };
}
