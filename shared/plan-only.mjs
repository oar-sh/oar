/**
 * Plan-only sessions: a conversation flagged `plan_only` stays in
 * plan mode as far as agents go. A relay_tool send or update_session that
 * names another mode is refused with 409 and this code; the owner's own
 * controls still change the mode, and clearing the flag frees the session.
 * The lock protects against mistakes, not against an agent that clears it.
 */

import { planBoardFollowupMode, planBoardFollowupText } from './plan-board-actions.mjs';

export const PLAN_ONLY_ERROR_CODE = 'plan_only';

export const PLAN_ONLY_REFUSAL_TEXT = 'This session is plan-only; agents can\'t change its mode. Clear planOnly first, or ask the user.';

export const PLAN_ONLY_REFUSAL = Object.freeze({ ok: false, code: PLAN_ONLY_ERROR_CODE, error: PLAN_ONLY_REFUSAL_TEXT });

/**
 * Whether naming `mode` is refused on a plan-only session: any mode but plan,
 * one the relay does not know included (it must not fall back to a writing
 * mode). No mode named refuses nothing.
 */
export function planOnlyRefusesMode(mode) {
  const text = String(mode ?? '').trim().toLowerCase();
  return !!text && text !== 'plan';
}

/**
 * The mode a turn cut off (a usage limit, a relay restart) goes on in. As it
 * ran, except on a plan-only session: there only the "Approve plan" turn
 * finishes in the agent mode it ran in (the same single turn); any other
 * goes on in plan. The session's saved mode is not touched either way.
 * The board does not store the message it queued, so that turn is known by
 * both its exact line and its agent mode; anything else goes on in plan.
 */
export function resumeRelayMode({ relayMode = '', text = '', planOnly = false } = {}) {
  const stored = String(relayMode || '').trim().toLowerCase();
  const mode = stored || 'agent';
  if (!planOnly || mode === 'plan') return mode;
  // The mode as stored: the board stores agent, never an empty one.
  const approveTurn = stored === planBoardFollowupMode('approve_only')
    && String(text || '').trim() === planBoardFollowupText('approve_only');
  return approveTurn ? mode : 'plan';
}