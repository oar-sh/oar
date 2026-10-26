// The composer's billing toggle for a Claude chat: Subscription | API key.
// Pure and DOM-free: what the toggle shows, from the chat's provider, what
// the relay said of its billing (`billing`, GET /api/conversation and the
// `conversation_billing` socket event) and the Claude API tab's state.
//
// A switch applies from the chat's next turn; the worker is swapped between
// turns, and while it waits the relay's `billing.pending` says for what.

export const CLAUDE_BILLING_TOGGLE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'claude', label: 'Subscription' }),
  Object.freeze({ value: 'claude-api', label: 'API key' }),
]);

export const CLAUDE_BILLING_CACHE_WARNING = 'The first turn on the API key has no prompt cache and costs more.';
// A subscription chat while Claude API's monthly cap is reached: said on the
// toggle itself, not only when the unavailable side is pressed.
export const CLAUDE_BILLING_CAP_TEXT = "This month's Claude API cap is reached: the chat stays on the subscription.";

function normalizeBilling(value) {
  const billing = String(value || '').trim().toLowerCase();
  return billing === 'claude' || billing === 'claude-api' ? billing : '';
}

/** "the API key" / "the subscription", for running text. */
export function claudeBillingPlace(billing) {
  return normalizeBilling(billing) === 'claude-api' ? 'the API key' : 'the subscription';
}

/** What the toggle says while the worker swap waits (`billing.pending`), or ''. */
export function claudeBillingPendingText(pending) {
  if (!pending || typeof pending !== 'object') return '';
  const place = claudeBillingPlace(pending.to);
  if (pending.swapping === true) return `Restarting on ${place}…`;
  const waitingFor = String(pending.waitingFor || '').trim();
  if (waitingFor === 'turn') return `Moves to ${place} after the running turn.`;
  if (waitingFor === 'question') return `Moves to ${place} once the open question is answered.`;
  if (waitingFor === 'compaction') return `Moves to ${place} after the compaction.`;
  if (waitingFor === 'background') {
    const count = Number(pending.backgroundTaskCount) || 0;
    return count > 0
      ? `Moves to ${place} once ${count} background task${count === 1 ? '' : 's'} finish${count === 1 ? 'es' : ''}.`
      : `Moves to ${place} once the background tasks finish.`;
  }
  if (waitingFor === 'stop') return `Moving to ${place}: the old Claude process has not stopped yet, retrying.`;
  return `Moving to ${place}…`;
}

/**
 * The toggle for one chat:
 * `{ visible, current, options: [{ value, label, pressed, available, reason }],
 *    status, statusKind }`.
 *
 * Shown in a Claude SDK chat (either billing) whose relay said its billing,
 * when Claude API is on with a saved key; a chat on the key keeps it after
 * Claude API is switched off, so it can move back. `inFlight` is a switch
 * this page sent and has no answer for yet; `warnCache` the chat this page
 * just moved to the key.
 */
export function claudeBillingToggleModel({
  providerType = '',
  billing = null,
  claudeApi = null,
  inFlight = false,
  warnCache = false,
} = {}) {
  const hidden = { visible: false, current: '', options: [], status: '', statusKind: '' };
  const chatProvider = normalizeBilling(providerType);
  if (!chatProvider || !billing || typeof billing !== 'object') return hidden;
  const current = normalizeBilling(billing.provider) || chatProvider;
  const claudeApiReady = claudeApi?.configured === true && claudeApi?.enabled === true;
  if (current === 'claude' && !claudeApiReady) return hidden;
  const switchable = billing.switchable && typeof billing.switchable === 'object' ? billing.switchable : {};
  const target = normalizeBilling(switchable.to);
  // The chat's billing was read while Claude API was off; the tab has since
  // switched it on. The relay checks the switch again when it is pressed;
  // a refusal it gave this page since (`refused`) stands.
  const allowed = switchable.allowed === true
    || (target === 'claude-api' && claudeApiReady && switchable.code === 'CLAUDE_API_NOT_CONFIGURED'
      && switchable.refused !== true);
  const options = CLAUDE_BILLING_TOGGLE_OPTIONS.map((option) => {
    const pressed = option.value === current;
    const available = pressed || (option.value === target && allowed && !inFlight);
    const reason = pressed || available
      ? ''
      : (inFlight ? 'A switch is on its way.' : (String(switchable.reason || '').trim() || 'The relay does not allow this switch now.'));
    return { value: option.value, label: option.label, pressed, available, reason };
  });
  let status = '';
  let statusKind = '';
  const pendingText = claudeBillingPendingText(billing.pending);
  if (inFlight) {
    status = 'Switching…';
    statusKind = 'pending';
  } else if (pendingText) {
    status = pendingText;
    statusKind = 'pending';
  } else if (warnCache && current === 'claude-api') {
    status = CLAUDE_BILLING_CACHE_WARNING;
    statusKind = 'warning';
  } else if (current === 'claude' && target === 'claude-api' && !allowed && switchable.code === 'CLAUDE_API_CAP_REACHED') {
    status = CLAUDE_BILLING_CAP_TEXT;
    statusKind = 'warning';
  }
  return { visible: true, current, options, status, statusKind };
}

/** The notice after a switch the relay accepted. */
export function claudeBillingSwitchedText(to) {
  return normalizeBilling(to) === 'claude-api'
    ? `This chat runs on the API key from the next turn. ${CLAUDE_BILLING_CACHE_WARNING}`
    : 'This chat runs on the subscription from the next turn.';
}
