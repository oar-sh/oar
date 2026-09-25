// The terminal failure for a message whose prompt the agent already consumed
// but whose outcome could not be recorded. At-most-once: such a row is never
// requeued (a re-delivery would run the prompt a second time), so it fails for
// good with wording that tells the user where the answer went. Shared by the
// session workers (their own settle paths) and the relay (recovery paths that
// meet a row marked consumed).
//
// Provider-neutral: the wording names `agentLabel` ("the agent" unless the
// caller knows better — the Claude worker passes 'Claude').

export const STEER_SETTLE_FAILED_CODE = 'steer-settle-failed';
export const STEER_SETTLE_FAILED_STABLE_CODE = `relay.${STEER_SETTLE_FAILED_CODE}`;
export const DEFAULT_STEER_AGENT_LABEL = 'the agent';

function normalizeAgentLabel(value) {
  const text = String(value || '').trim();
  return text || DEFAULT_STEER_AGENT_LABEL;
}

// "the agent" → "The agent" at the start of a sentence; a proper name is
// left as it is.
function sentenceCase(label) {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const VARIANTS = Object.freeze({
  // Folded into a turn whose reply answered it (or the path is unknown — the
  // relay's recovery paths cannot tell which).
  folded: (label) => ({
    message: `This message was already sent to ${label} — check the reply above.`,
    guidance: 'Resend it only if it went unanswered.',
  }),
  // Handed off mid-reply: its own partial reply stands, and the rest of the
  // answer continued on the next message.
  handoff: (label) => ({
    message: `${sentenceCase(label)} started answering this message, then carried on with your next one — check both replies.`,
    guidance: 'Resend it only if something went unanswered.',
  }),
  // Steered into a turn the user stopped.
  stopped: (label) => ({
    message: `This message was sent to ${label} just before you stopped the turn, so it was not answered.`,
    guidance: 'Resend it if you still want an answer.',
  }),
  // Pulled back out of the runtime's queue by the user (un-steer) — the
  // prompt never ran — but the relay could not be told in time.
  cancelled: (label) => ({
    message: `This message was cancelled before ${label} started on it, so it was not answered.`,
    guidance: 'Resend it if you still want an answer.',
  }),
});

/**
 * The name a provider's runtime goes by in the settle wording, for callers
 * that only know the conversation's provider type (the relay's recovery
 * paths). Workers that know exactly which runtime took the prompt pass the
 * label themselves.
 */
export function steerAgentLabelForProvider(providerType) {
  switch (String(providerType || '').trim().toLowerCase()) {
    case 'claude': return 'Claude';
    case 'github':
    case 'openai': return 'Copilot';
    case 'cursor': return 'Cursor';
    case 'grok': return 'Grok';
    default: return DEFAULT_STEER_AGENT_LABEL;
  }
}

function wordingFor(variant, agentLabel) {
  const build = VARIANTS[variant] || VARIANTS.folded;
  return build(normalizeAgentLabel(agentLabel));
}

export function steerSettleFailureText(variant = 'folded', agentLabel = DEFAULT_STEER_AGENT_LABEL) {
  return wordingFor(variant, agentLabel).message;
}

export function buildSteerSettleFailure(message, { variant = 'folded', agentLabel = DEFAULT_STEER_AGENT_LABEL } = {}) {
  const wording = wordingFor(variant, agentLabel);
  return {
    kind: STEER_SETTLE_FAILED_CODE,
    code: STEER_SETTLE_FAILED_CODE,
    stableCode: STEER_SETTLE_FAILED_STABLE_CODE,
    message: wording.message,
    guidance: wording.guidance,
    failedAt: new Date().toISOString(),
    queueMessageId: String(message?.id || '') || null,
  };
}
