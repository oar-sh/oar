// The subscription side of the Claude billing check (plan decision 4).
//
// A Claude chat on the host's subscription must never run on an API key
// without being asked: the key's owner would pay. The worker strips every
// Anthropic credential from the CLI's environment (WP0), but a settings
// file's `env.ANTHROPIC_API_KEY`, an `apiKeyHelper` or a Console `/login`
// can still hand Claude Code a key. Its `system/init` names where the
// credential came from (`apiKeySource`); a turn that comes up on an API key
// is stopped there, as the Claude API worker stops one that comes up on
// anything but its key (claude-api-backend.mjs, checkClaudeApiInit). At most
// the one request that may beat the init has gone out (decision 24).

export const CLAUDE_SUBSCRIPTION_KEY_SOURCE_CODE = 'subscription-key-source';

// The sources that bill an API key, not the subscription: a key in the
// environment (a settings file's env block), a helper that prints one, and
// the key a Console login keeps. Every other source (`none`, `oauth`, ...)
// lets the turn go on; one the relay does not know is logged.
export const API_BILLED_KEY_SOURCES = Object.freeze(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key']);

const KNOWN_KEY_SOURCES = Object.freeze([
  ...API_BILLED_KEY_SOURCES,
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
]);

const GUIDANCE = 'Remove ANTHROPIC_API_KEY from the env of the host\'s Claude Code settings (~/.claude/settings.json, '
  + 'or the folder\'s .claude/settings*.json), remove an apiKeyHelper, or sign the Console login out, then send the '
  + 'message again. To run this chat on the API key saved in Settings, switch its billing to API key.';

/** Whether a source the CLI named is one the relay knows. */
export function isKnownApiKeySource(value) {
  return KNOWN_KEY_SOURCES.includes(String(value ?? ''));
}

/**
 * Null when the CLI's `system/init` came up without an API key, else the
 * Error that stops the turn. `afterTraffic`: the turn had already talked to
 * the API, so one request may have gone out on that key.
 */
export function checkClaudeSubscriptionInit(sdkMessage, { afterTraffic = false } = {}) {
  if (!sdkMessage || sdkMessage.type !== 'system' || sdkMessage.subtype !== 'init') return null;
  const source = typeof sdkMessage.apiKeySource === 'string' ? sdkMessage.apiKeySource : '';
  if (!API_BILLED_KEY_SOURCES.includes(source)) return null;
  const error = new Error(
    `Claude Code took an API key for this subscription turn (source "${source}"), so the turn was stopped: `
    + 'it would have been billed to that key, not the subscription.'
    + (afterTraffic ? ' At most one request may have gone out on that key.' : ''),
  );
  error.code = CLAUDE_SUBSCRIPTION_KEY_SOURCE_CODE;
  error.apiKeySource = source;
  error.guidance = GUIDANCE;
  return error;
}

/** `{ code, guidance }` for a turn the check stopped, else null (the publisher's describeFailure). */
export function describeClaudeSubscriptionFailure(_errorText, { error = null } = {}) {
  if (error?.code !== CLAUDE_SUBSCRIPTION_KEY_SOURCE_CODE) return null;
  return { code: CLAUDE_SUBSCRIPTION_KEY_SOURCE_CODE, guidance: error.guidance || GUIDANCE };
}
