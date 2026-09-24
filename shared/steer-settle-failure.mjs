// The terminal failure for a message whose prompt Claude already consumed but
// whose outcome could not be recorded. At-most-once: such a row is never
// requeued (a re-delivery would run the prompt a second time), so it fails for
// good with wording that tells the user where the answer went. Shared by the
// Claude worker (its own settle paths) and the relay (recovery paths that meet
// a row marked consumed).

export const STEER_SETTLE_FAILED_CODE = 'steer-settle-failed';
export const STEER_SETTLE_FAILED_STABLE_CODE = `relay.${STEER_SETTLE_FAILED_CODE}`;

const VARIANTS = Object.freeze({
  // Folded into a turn whose reply answered it (or the path is unknown — the
  // relay's recovery paths cannot tell which).
  folded: {
    message: 'This message was already sent to Claude — check the reply above.',
    guidance: 'Resend it only if it went unanswered.',
  },
  // Handed off mid-reply: its own partial reply stands, and the rest of the
  // answer continued on the next message.
  handoff: {
    message: 'Claude started answering this message, then carried on with your next one — check both replies.',
    guidance: 'Resend it only if something went unanswered.',
  },
  // Steered into a turn the user stopped.
  stopped: {
    message: 'This message was sent to Claude just before you stopped the turn, so it was not answered.',
    guidance: 'Resend it if you still want an answer.',
  },
});

export function steerSettleFailureText(variant = 'folded') {
  return (VARIANTS[variant] || VARIANTS.folded).message;
}

export function buildSteerSettleFailure(message, { variant = 'folded' } = {}) {
  const wording = VARIANTS[variant] || VARIANTS.folded;
  return {
    kind: 'claude-steer-settle-failed',
    code: STEER_SETTLE_FAILED_CODE,
    stableCode: STEER_SETTLE_FAILED_STABLE_CODE,
    message: wording.message,
    guidance: wording.guidance,
    failedAt: new Date().toISOString(),
    queueMessageId: String(message?.id || '') || null,
  };
}
