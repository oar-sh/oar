// The settle stubs of steered messages the Claude CLI consumed without opening
// a turn of their own. Each is stamped with its own message kind, which is
// what the client renders from; the texts are shared so the relay's migration
// can recognise stubs saved before the kind existed.

/**
 * A steer folded into the running turn and answered by that turn's reply.
 * Stamped kind='folded' (before 0.9.3: kind='absorbed', which the client read
 * as "the reply continues through the next message" and mis-merged the next
 * ordinary message on reload).
 */
export const STEER_FOLDED_TEXT = '_(Handled together with the previous reply — this message was steered into that turn.)_';

/**
 * A steer pushed into a turn the user then stopped: never answered. Stamped
 * kind='stopped' — the stable handle the client keys its Resend on.
 */
export const STEER_STOPPED_TEXT = '_(Stopped with the turn — not answered.)_';
