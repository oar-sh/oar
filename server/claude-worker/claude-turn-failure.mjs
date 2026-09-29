// Why a Claude turn failed: the code the relay prints, and the advice that
// fits the failure.
//
// A turn the API refused ends with a `result` of subtype 'success' and
// `is_error: true`: the subtype says how the turn ended, not whether it
// worked, so it names nothing. What names the failure, in this order:
//
//   1. the `error` field of the turn's last assistant message (the SDK's
//      SDKAssistantMessageError: 'billing_error', 'oauth_org_not_allowed', …);
//   2. the `api_error_status` of the result;
//   3. the words of the refusal, for an account failure that came with
//      neither;
//   4. a subtype other than 'success' ('error_max_turns', …);
//   5. the `terminal_reason` of the result.
//
// The relay prints `claude.<code>` as `relay.claude-<code>`, dashes for
// underscores.

// The user has to sign in again: a retry cannot succeed before that.
const SIGN_IN_ERRORS = new Set(['authentication_failed']);
// The account itself refuses: billing, or access its organisation withholds.
const ACCOUNT_ERRORS = new Set([
  'billing_error',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'account-access',
]);

const STATUS_CODES = new Map([
  [401, 'authentication_failed'],
  [402, 'billing_error'],
  [429, 'rate_limit'],
  [529, 'overloaded'],
]);

// Checked before the sign-in words: the organisation's refusal mentions an
// API key too.
const ACCOUNT_ACCESS_TEXT = /organi[sz]ation has disabled|subscription access|does not have access to claude/i;
const BILLING_TEXT = /credit balance|billing|payment/i;
const SIGN_IN_TEXT = /failed to authenticate|authentication_error|invalid api key|not logged in|please run \/login/i;

export const CLAUDE_SIGN_IN_GUIDANCE =
  'Sign in to Claude again in Settings → Providers → Claude → Relogin (or run `claude` on the relay host), '
  + 'then send the message again.';
export const CLAUDE_ACCOUNT_GUIDANCE =
  'Check the Claude account the relay host is signed in to: its subscription, its payment method, and whether '
  + 'its organisation allows Claude Code. Settings → Providers → Claude shows the account and signs in to '
  + 'another one. Then send the message again.';
export const CLAUDE_MODEL_GUIDANCE = 'Choose another model for this conversation, then send the message again.';

function codeFromText(text) {
  if (ACCOUNT_ACCESS_TEXT.test(text)) return 'account-access';
  if (BILLING_TEXT.test(text)) return 'billing_error';
  if (SIGN_IN_TEXT.test(text)) return 'authentication_failed';
  return null;
}

/** The advice for a code, or null where the relay's own default fits. */
export function claudeFailureGuidance(code) {
  const token = String(code || '').trim().toLowerCase();
  if (SIGN_IN_ERRORS.has(token)) return CLAUDE_SIGN_IN_GUIDANCE;
  if (ACCOUNT_ERRORS.has(token)) return CLAUDE_ACCOUNT_GUIDANCE;
  if (token === 'model_not_found') return CLAUDE_MODEL_GUIDANCE;
  return null;
}

/**
 * `result` is the normalized result payload of the turn (sdk-message-
 * normalizer): `{ text, subtype, assistantError, apiErrorStatus,
 * terminalReason }`. Returns `{ code, stableCode, guidance }`; `guidance` is
 * null where the relay's default fits.
 */
export function classifyClaudeResultFailure(result = {}) {
  const subtype = String(result?.subtype || '').trim();
  const assistantError = String(result?.assistantError || '').trim().toLowerCase();
  const status = Number(result?.apiErrorStatus);
  const hasStatus = Number.isFinite(status) && status >= 400;
  const terminalReason = String(result?.terminalReason || '').trim().toLowerCase();

  let code = null;
  if (assistantError && assistantError !== 'unknown') code = assistantError;
  else if (hasStatus && STATUS_CODES.has(status)) code = STATUS_CODES.get(status);
  else code = codeFromText(String(result?.text || ''));

  if (!code && subtype && subtype !== 'success') code = subtype;
  if (!code && (hasStatus || assistantError === 'unknown' || terminalReason === 'api_error')) code = 'api-error';
  if (!code && terminalReason && terminalReason !== 'completed') code = terminalReason;
  if (!code) code = 'turn-error';

  return { code, stableCode: `claude.${code}`, guidance: claudeFailureGuidance(code) };
}
