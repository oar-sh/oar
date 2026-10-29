// Browser mirror of the pieces of shared/plan-board-actions.mjs the web UI
// needs. The browser cannot import shared/ (only server/public is served), so
// these are hand-kept copies; plan-board-shared.test.mjs asserts they match.
// Below them, the web UI's own plan-only wording.

/** The actions that take the session out of plan mode for good. */
export const PLAN_BOARD_LEAVES_PLAN = Object.freeze(['autopilot', 'autopilot_fleet', 'interactive']);

export const PLAN_BOARD_LABELS = Object.freeze({
  approve_only: 'Approve plan',
  autopilot: 'Implement in autopilot',
  autopilot_fleet: 'Implement with autopilot fleet',
  interactive: 'Stop here and prompt myself',
  exit_only: 'Stop here',
});

/** The button's label; an id the table does not know is spelled out. */
export function planBoardActionLabel(id) {
  const key = String(id || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PLAN_BOARD_LABELS, key)) return PLAN_BOARD_LABELS[key];
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) || 'Select';
}

/**
 * On a plan-only session the actions that leave plan mode for good ask
 * first; "Approve plan", "Stop here" and an action the relay does not know
 * never do. The question, or '' when there is none.
 */
export function planBoardConfirmText({ planOnly = false, actionId = '', label = '' } = {}) {
  const id = String(actionId || '').trim().toLowerCase();
  if (planOnly !== true || !PLAN_BOARD_LEAVES_PLAN.includes(id)) return '';
  const name = String(label || '').trim() || planBoardActionLabel(id);
  return `This session is plan-only. ${name} leaves plan mode. Go on?`;
}

/** The mode select's hint on a plan-only session (title and the plan option's text). */
export function planOnlyModeHint(planOnly) {
  return planOnly === true
    ? { title: 'Mode · plan-only: agents can\'t take this session out of plan mode', planLabel: 'Plan 🔒' }
    : { title: 'Mode', planLabel: 'Plan' };
}
/**
 * The plan-only flag after a conversation_preferences_updated broadcast: the
 * one it carries, else the one already known (an older relay, or the mode
 * follow-up of a plan card, says nothing about it).
 */
export function planOnlyAfterBroadcast(broadcast, known) {
  return typeof broadcast === 'boolean' ? broadcast : known === true;
}