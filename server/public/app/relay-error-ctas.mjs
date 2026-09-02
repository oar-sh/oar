// Turns a terminal turn failure in the transcript into a button that fixes it.
//
// `buildTerminalFailureTextForChat()` (messages-routes.mjs) renders every
// terminal failure as plain chat text ending in `Error code: relay.<code>.`,
// so the code is the only stable handle a client has. The dead end this exists
// for: a Grok turn fails with relay.grok-cli-missing and the printed advice is
// "install it on the relay host" — i.e. open a shell, the exact thing the relay
// exists to avoid.
//
// Pure and DOM-free on purpose: the table is the contract, the caller owns the
// markup and the escaping.

// Codes are matched post-normalisation: normalizeTerminalErrorCode() lowercases
// and rewrites every non-alphanumeric run to a dash, so `grok.cli_missing`
// reaches the transcript as `relay.grok-cli-missing`.
const RELAY_ERROR_CTAS = Object.freeze({
  'grok-cli-missing': Object.freeze([
    Object.freeze({ action: 'install-grok-cli', label: 'Install Grok CLI' }),
    Object.freeze({ action: 'open-grok-settings', label: 'Grok settings' }),
  ]),
  'grok-authentication-failed': Object.freeze([
    Object.freeze({ action: 'sign-in-to-grok', label: 'Sign in to Grok' }),
    Object.freeze({ action: 'open-grok-settings', label: 'Grok settings' }),
  ]),
  // Shipped with the Claude relogin plan (§4.3 there) as the deep link its
  // reworded message points at.
  'claude-authentication-failed': Object.freeze([
    Object.freeze({ action: 'open-claude-settings', label: 'Claude settings' }),
  ]),
});

const STABLE_CODE_PATTERN = /error code:\s*relay\.([a-z0-9-]+)/i;

export function relayErrorCodeFromText(text) {
  const match = String(text || '').match(STABLE_CODE_PATTERN);
  return match ? match[1].toLowerCase() : '';
}

/**
 * The actions a terminal failure offers, or an empty array. Never throws and
 * never guesses: an unknown code simply has no CTA, which is the current
 * behaviour for every failure that is not in the table.
 */
export function relayErrorCtaActions(text) {
  const code = relayErrorCodeFromText(text);
  return code && RELAY_ERROR_CTAS[code] ? RELAY_ERROR_CTAS[code] : [];
}

export function relayErrorCtaActionsForCode(code) {
  const normalized = String(code || '').trim().toLowerCase().replace(/^relay\./, '');
  return RELAY_ERROR_CTAS[normalized] || [];
}
