// The two things every session worker's entry point needs before it can do
// anything: which relay session it was spawned for, and a debug channel that
// timestamps and tags its own lines.
//
// Used by the Copilot SDK worker today. The Claude/Cursor/Grok workers still
// carry their own copies of both; folding them in is a mechanical follow-up
// (tracked in docs/plans/copilot-sdk-worker.md) that is deliberately not part
// of the dormant worker's review pass — those three are live.

/**
 * The relay session id, from `--session-id <id>`, `--session-id=<id>`, or the
 * `SESSION_ID` environment variable, in that order. Returns '' when none is
 * present so the caller can fail with its own message.
 */
export function parseSessionIdArg(argv = process.argv, env = process.env) {
  const index = argv.indexOf('--session-id');
  if (index !== -1 && argv[index + 1]) return String(argv[index + 1]).trim();
  const inline = argv.find((arg) => String(arg || '').startsWith('--session-id='));
  if (inline) return String(inline.split('=')[1] || '').trim();
  return String(env.SESSION_ID || '').trim();
}

/**
 * A `dbg(...parts)` that prefixes every line with the worker name and an ISO
 * timestamp, so interleaved worker logs stay attributable in a shared journal.
 */
export function createWorkerDebug(workerName, { log = console.log } = {}) {
  const name = String(workerName || 'worker').trim() || 'worker';
  return (...parts) => {
    log(`[${name} ${new Date().toISOString()}]`, ...parts);
  };
}

/**
 * A numeric env override that honours 0 as a real value (the project's
 * "0 = no limit / disabled" convention), returning undefined when unset or
 * unparseable so an option default can take over.
 */
export function readOptionalMs(name, env = process.env) {
  const raw = String(env[name] || '').trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
