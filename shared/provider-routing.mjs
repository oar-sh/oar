/**
 * The single source of truth for which providers run on a dedicated session
 * worker of their own kind.
 */

// `claude-cloud` is its own provider, never an alias of `claude`: its worker
// drives a session in Anthropic's cloud and spawns no CLI. `claude-api` is
// its own too: the Claude worker on a Console API key instead of the host's
// subscription login.
export const SESSION_WORKER_PROVIDER_TYPES = Object.freeze(['claude', 'cursor', 'grok', 'claude-cloud', 'deepseek', 'claude-api']);

export function isSessionWorkerProviderType(value) {
  return SESSION_WORKER_PROVIDER_TYPES.includes(String(value || '').trim().toLowerCase());
}

/** `'claude', 'cursor', 'grok', 'claude-cloud', 'deepseek', 'claude-api'` — for interpolation into SQL NOT IN (...) lists. */
export function sessionWorkerProviderSqlList() {
  return SESSION_WORKER_PROVIDER_TYPES.map((provider) => `'${provider}'`).join(', ');
}
