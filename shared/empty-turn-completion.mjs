/**
 * What a worker publishes when a turn ends terminally, without error, and
 * without any assistant prose.
 *
 * That is a *completed* turn, not a failed delivery: the model can legitimately
 * end a turn on tool activity alone ("do nothing else than spawn a subagent
 * that returns OK" — conv `1e497a75`, where the Cursor SDK recorded
 * `status: FINISHED, result: null`). Requeuing such a turn re-runs work that
 * deterministically produces the same empty text, so every attempt re-bills the
 * provider and re-spawns its subagents until the queue's retry cap fails the
 * message with a "Relay timeout" that misreports a turn which actually
 * succeeded.
 *
 * A note rather than an empty string because `/api/response` rejects an empty
 * body (`shouldAcceptAssistantResponsePayload`), so publishing '' would leave
 * the queue row stuck in `processing` — swapping one stall for another. Kept
 * deliberately free of inference about *why* the model stayed silent; the
 * activity and subagent bubbles already show what ran.
 */
export const EMPTY_TURN_COMPLETION_NOTE = 'System note: the turn completed without a text reply.';
