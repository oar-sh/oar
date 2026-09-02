'use strict';

/**
 * Mechanical helpers for driving a provider CLI as a child process.
 *
 * Lifted verbatim out of claude-auth-service.mjs, which held the only copy:
 * the CLI install service and the Grok auth service need the same escape
 * stripping, secret scrubbing, process-group kill and run-to-completion
 * wrapper, and a second hand-rolled copy of any of them is exactly how two
 * spawn paths drift apart.
 *
 * Only the pieces with no state of their own moved. The Claude auth state
 * machine is live-verified and stayed where it is; claude-auth-service.mjs
 * re-exports the helpers it used to export, so every importer and test of it
 * is untouched.
 */

/** Refusal used by every spawn path when the relay runs with CLI spawns off. */
export const CLI_SPAWN_DISABLED_ERROR = 'cli spawns disabled';

/** Retained-output ceiling shared by every capture path (auth, install). */
export const MAX_CAPTURED_OUTPUT_CHARS = 16_000;
const MAX_ERROR_TAIL_CHARS = 600;

// Any OSC sequence (hyperlinks, window-title sets, clipboard writes): ESC ]
// <payload> (BEL | ST). Stripped whole so no `0;title` residue reaches the
// prompt/JSON/error parsers.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Any CSI sequence (SGR colours, cursor moves, erases).
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Remaining single-character / other escape sequences.
const OTHER_ESCAPE_PATTERN = /\x1b[@-Z\\-_]/g;
// `script` gives a CLI an 80-column PTY, and CLIs hard-wrap their own output at
// that width. Only a line that is *exactly* that wide is treated as continued:
// a line that merely ends in a long token ended because the CLI printed a
// newline, and gluing the next line onto it would corrupt the match. On a
// differently-sized terminal this degrades to the pre-wrap behaviour.
const PTY_WRAP_COLUMNS = 80;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Removes OSC sequences (including OSC-8 hyperlink wrappers), ANSI CSI
 * sequences and the CR the PTY adds to every line, leaving the human-visible
 * text.
 */
export function stripTerminalEscapes(value) {
  return String(value == null ? '' : value)
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(OTHER_ESCAPE_PATTERN, '')
    .replace(/\r/g, '');
}

/**
 * Rejoins lines the PTY hard-wrapped mid-token: a wrap fills the terminal width
 * and leaves no trailing space, so a full-width line is stitched onto the line
 * that follows it (repeatedly, for a URL spanning three or more rows).
 */
export function joinWrappedLines(value) {
  const lines = String(value == null ? '' : value).split('\n');
  const joined = [];
  let previousWrapped = false;
  for (const line of lines) {
    if (previousWrapped && joined.length && /^\S/.test(line)) {
      joined[joined.length - 1] = `${joined[joined.length - 1]}${line}`;
    } else {
      joined.push(line);
    }
    previousWrapped = line.length === PTY_WRAP_COLUMNS && /\S$/.test(line);
  }
  return joined.join('\n');
}

/**
 * Redacts anything token-shaped plus an exact secret the caller knows it
 * handed over (the pasted Claude login code), so an error tail can be surfaced
 * to the UI without leaking a credential. Long PKCE segments in an authorize
 * URL get caught by the generic rule too, which is fine: the URL is already
 * carried in the login payload.
 */
export function scrubSecrets(text, submittedCode = '') {
  let output = String(text == null ? '' : text);
  const code = normalizeText(submittedCode);
  if (code.length >= 4) {
    output = output.split(code).join('[redacted]');
  }
  return output
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

/** Collapses captured output into one short single-line tail for an error. */
export function tailOf(text, limit = MAX_ERROR_TAIL_CHARS) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const joined = lines.join(' · ');
  return joined.length > limit ? `…${joined.slice(-limit)}` : joined;
}

/**
 * Signals the child's whole process group where the platform has one, so a
 * `script`/`bash -lc` wrapper cannot leave the real CLI running behind it.
 * A child that has already exited is left alone.
 */
export function killTree(child, signal, {
  platform = process.platform,
  processKillImpl = process.kill.bind(process),
} = {}) {
  if (!child || child.exitCode !== null) return;
  const pid = Number(child.pid);
  if (platform !== 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      processKillImpl(-pid, signal);
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}

/**
 * Runs one already-configured child to completion and resolves (never rejects)
 * with `{ok, code, output, error}`.
 *
 * `spawnChild` is a thunk so the caller keeps ownership of how the process is
 * built — PTY or not, which stdio, which environment — and so a refused spawn
 * (the CLI kill switch) surfaces as a result rather than a throw. `onChild`
 * hands the live handle back for cancellation, and `onOutput` sees each raw
 * chunk for callers that stream a log while it runs.
 */
export function runToCompletion(spawnChild, {
  timeoutMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  killChild = (child, signal) => killTree(child, signal),
  maxOutputChars = MAX_CAPTURED_OUTPUT_CHARS,
  onChild = null,
  onOutput = null,
} = {}) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawnChild();
    } catch (error) {
      resolve({ ok: false, code: null, output: '', error: error?.message || String(error) });
      return;
    }
    try { onChild?.(child); } catch {}
    let output = '';
    let settled = false;
    const append = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-maxOutputChars);
      try { onOutput?.(text); } catch {}
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeoutImpl(timer);
      resolve(result);
    };
    const timer = setTimeoutImpl(() => {
      killChild(child, 'SIGTERM');
      finish({ ok: false, code: null, output, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer?.unref?.();
    child.stdout?.on?.('data', append);
    child.stderr?.on?.('data', append);
    child.stdin?.end?.();
    child.on('error', (error) => finish({
      ok: false, code: null, output, error: error?.message || String(error),
    }));
    child.on('close', (code) => finish({
      ok: code === 0, code, output, error: null,
    }));
  });
}
