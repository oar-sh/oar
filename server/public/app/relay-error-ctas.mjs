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
const CLAUDE_SETTINGS_CTA = Object.freeze([
  Object.freeze({ action: 'open-claude-settings', label: 'Claude settings' }),
]);

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
  'claude-authentication-failed': CLAUDE_SETTINGS_CTA,
  // A turn the Claude account refused (claude-turn-failure.mjs): the panel
  // shows the account and signs in to another one.
  'claude-billing-error': CLAUDE_SETTINGS_CTA,
  'claude-oauth-org-not-allowed': CLAUDE_SETTINGS_CTA,
  'claude-account-on-hold': CLAUDE_SETTINGS_CTA,
  'claude-verification-required': CLAUDE_SETTINGS_CTA,
  'claude-account-access': CLAUDE_SETTINGS_CTA,
});

const STABLE_CODE_PATTERN = /error code:\s*relay\.([a-z0-9-]+)/i;
// The shape of a failure note, mirrored from shared/failure-note-text.mjs
// (the browser cannot import it; failure-note-text.test.mjs keeps the two in
// step): one paragraph of at most this length leading up to the code, not a
// quotation, a code span, a table cell, a list item or a heading. A reply
// that talks about a code gets no button.
const FAILURE_NOTE_LEAD_MAX = 600;
const QUOTED_LEAD = /["“”'`|>]\s*$/;
const MARKUP_LEAD = /^\s*(?:#+|[>|*-]|\d+\.)\s/;

/** The code of a text that is a failure note of the relay, else ''. */
export function relayErrorCodeFromText(text) {
  const raw = String(text || '').trim();
  const match = raw.match(STABLE_CODE_PATTERN);
  if (!match) return '';
  const lead = raw.slice(0, match.index);
  if (lead.length > FAILURE_NOTE_LEAD_MAX || /[\r\n]/.test(lead)) return '';
  if (QUOTED_LEAD.test(lead) || MARKUP_LEAD.test(lead)) return '';
  return match[1].toLowerCase();
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
