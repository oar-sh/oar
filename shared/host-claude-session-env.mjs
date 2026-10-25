// The variables of a Claude Code session the relay was started from.
//
// A relay started from inside a Claude Code session (an agent's shell, a
// `claude` run that starts it, a test relay an agent starts from a relay
// worker) carries that session's variables, and so would every worker: the
// Claude and DeepSeek workers' CLI would take itself for a child of the host's
// session (messaging socket and token, session id, entrypoint, effort), and a
// Copilot or Cursor worker has no use for them either. The launcher drops
// them for every kind and on every path (session-worker-launch-service.mjs),
// and the DeepSeek backend drops them again from its CLI's environment.
//
// A fixed list misses what the next CLI version adds, so the session's
// variables are matched by family as well:
// - the names Claude Code gives its child shells and MCP servers, those it
//   sets on its own process (entrypoint, executable path), the markers an
//   SDK host sets (its version and its app's name, which the CLI sends as
//   `x-client-app`), and the per-spawn Bash cap a relay's Claude worker
//   gives its CLI (HOST_CLAUDE_SESSION_ENV_VARS);
// - every `CLAUDE_CODE_SESSION_*` (id, attended, access token, kind, name,
//   origin, ...), every `CLAUDE_CODE_*_SESSION_ID` (host, remote, bridge,
//   cloud) and every `CLAUDE_CODE_MESSAGING_*`
//   (HOST_CLAUDE_SESSION_ENV_PATTERNS).
// What stays is configuration: the relay's own (`CLAUDE_CONFIG_DIR`,
// `CLAUDE_CODE_EXECUTABLE`, a login token, which the launcher hands only to
// the Claude kinds) and the user's settings: `CLAUDE_CODE_*` ones (a
// provider such as `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_GIT_BASH_PATH` on
// Windows, the `DISABLE_*`/`ENABLE_*` switches) and the SDK's
// `CLAUDE_AGENT_SDK_*` switches (`DISABLE_BUILTIN_AGENTS`, `MCP_NO_PREFIX`,
// `DISABLE_MCP_MANIFESTS`), which no family reaches. The settings that fall
// in a family stay through HOST_CLAUDE_SESSION_KEEP_ENV_VARS. Every
// `CLAUDE_AGENT_SDK_*` and family name the bundled CLI and SDK read was
// sorted this way (2026-10-25).

export const HOST_CLAUDE_SESSION_ENV_VARS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE',
]);

// Shell `case` patterns, matched against the upper-cased name in JavaScript.
export const HOST_CLAUDE_SESSION_ENV_PATTERNS = Object.freeze([
  'CLAUDE_CODE_SESSION_*',
  'CLAUDE_CODE_*_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_*',
]);

// Settings inside a family: a behaviour switch and a debug log switch.
export const HOST_CLAUDE_SESSION_KEEP_ENV_VARS = Object.freeze([
  'CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT',
  'CLAUDE_CODE_SESSION_LOG',
]);

const EXACT = new Set(HOST_CLAUDE_SESSION_ENV_VARS);
const KEEP = new Set(HOST_CLAUDE_SESSION_KEEP_ENV_VARS);
const PATTERNS = HOST_CLAUDE_SESSION_ENV_PATTERNS.map((pattern) => new RegExp(
  `^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
));

/**
 * Whether a variable is the host Claude Code session's. Upper-cased first:
 * Windows names are case-insensitive.
 */
export function isHostClaudeSessionVariable(name) {
  const key = String(name ?? '').toUpperCase();
  if (!key || KEEP.has(key)) return false;
  return EXACT.has(key) || PATTERNS.some((pattern) => pattern.test(key));
}

/** The environment without the host Claude Code session's variables. */
export function withoutHostClaudeSessionVariables(env = {}) {
  const next = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!isHostClaudeSessionVariable(key)) next[key] = value;
  }
  return next;
}

/**
 * A POSIX sh statement that unsets, in the shell it runs in, every variable
 * of the host session the environment holds: the families as well as the
 * names, for an environment the launcher never saw (a tmux server's). Names
 * only; a value is never read.
 */
export function hostClaudeSessionUnsetStatement() {
  const keep = HOST_CLAUDE_SESSION_KEEP_ENV_VARS.length ? `${HOST_CLAUDE_SESSION_KEEP_ENV_VARS.join('|')}) ;; ` : '';
  const drop = [...HOST_CLAUDE_SESSION_ENV_VARS, ...HOST_CLAUDE_SESSION_ENV_PATTERNS].join('|');
  return `for oar_host_var in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do `
    + `case "$oar_host_var" in ${keep}${drop}) unset "$oar_host_var";; esac; done; unset oar_host_var;`;
}
