/**
 * The single source of truth for which providers execute where.
 *
 * The legacy Copilot relay CLI (server/relay.mjs) may only execute turns for
 * these providers; everything else runs on a dedicated session worker. This
 * used to be encoded twice in inverse shapes — an allowlist in relay.mjs and a
 * NOT IN (...) denylist inside message-repository's SQL — so adding a provider
 * meant editing both and missing one silently reopened cross-provider
 * execution. relay.mjs is a standalone CLI that must not import the express
 * routes, which is exactly why this lives in shared/.
 */
export const LEGACY_RELAY_PROVIDER_TYPES = Object.freeze(['github', 'openai']);

export const SESSION_WORKER_PROVIDER_TYPES = Object.freeze(['claude', 'cursor', 'grok']);

export function isLegacyRelayProviderType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true; // no runtime session = github
  return LEGACY_RELAY_PROVIDER_TYPES.includes(normalized);
}

export function isSessionWorkerProviderType(value) {
  return SESSION_WORKER_PROVIDER_TYPES.includes(String(value || '').trim().toLowerCase());
}

/** `'claude', 'cursor', 'grok'` — for interpolation into SQL NOT IN (...) lists. */
export function sessionWorkerProviderSqlList() {
  return SESSION_WORKER_PROVIDER_TYPES.map((provider) => `'${provider}'`).join(', ');
}
