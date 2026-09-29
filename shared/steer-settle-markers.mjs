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

/**
 * A steer folded into a turn that then failed: never answered, and the
 * failure itself is told once, on the reply of the turn. Stamped
 * kind='stopped' like the steer of a stopped turn, so the client offers the
 * same Resend.
 */
export const STEER_TURN_FAILED_TEXT = '_(Steered into the turn above, which failed — not answered.)_';

/**
 * Not a steer: a message delivered between turns whose answer the worker
 * published on a background-continuation row, because it took the turn for one
 * the CLI had opened by itself. Stamped with a kind of its own: it is a
 * marker, not a reply (no completion push, muted in the transcript, never
 * handed to a calling relay as the answer), and not a steer marker either,
 * which would label the message "steered mid-turn".
 *
 * The wording names the reply by its badge, not by its position: a live
 * append puts the marker below that reply, a reload anchors it under its own
 * message and so above it. The worker infers all this from silence, hence the
 * way out at the end.
 */
export const ANSWERED_ELSEWHERE_KIND = 'answered-elsewhere';
export const DELIVERY_ANSWERED_ELSEWHERE_TEXT = '_(Answered in the reply marked “background continuation” next to this message. Resend the message if that reply does not answer it.)_';
