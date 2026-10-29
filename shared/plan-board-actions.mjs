/**
 * The buttons of a `plan_ready` card, one list for every provider: the Claude,
 * Copilot, Cursor and Grok workers post it, the CLI extension adds
 * "Approve plan" to the Copilot CLI's own list, and the relay's action route
 * builds the follow-up message from the same table.
 *
 * - `approve_only` marks the plan approved. Its follow-up runs one turn in
 *   agent mode (plan mode blocks writes, and the plan doc still has to be
 *   committed); the session's saved mode stays plan.
 * - `autopilot` / `autopilot_fleet` and `interactive` leave plan mode: the
 *   session goes on in the mode the follow-up runs in.
 * - `exit_only` only settles the card.
 *
 * No follow-up carries the plan: the session wrote it, and repeating it read
 * as a new instruction to carry it out.
 */

export const PLAN_BOARD_APPROVE_ONLY = 'approve_only';

export const PLAN_BOARD_ACTIONS = Object.freeze([
  Object.freeze({ id: 'approve_only', label: 'Approve plan', mode: 'agent' }),
  Object.freeze({ id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' }),
  Object.freeze({ id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' }),
  Object.freeze({ id: 'exit_only', label: 'Stop here', mode: 'agent' }),
]);

/** The actions that take the session out of plan mode for good. */
export const PLAN_BOARD_LEAVES_PLAN = Object.freeze(['autopilot', 'autopilot_fleet', 'interactive']);

export const PLAN_BOARD_LABELS = Object.freeze({
  approve_only: 'Approve plan',
  autopilot: 'Implement in autopilot',
  autopilot_fleet: 'Implement with autopilot fleet',
  interactive: 'Stop here and prompt myself',
  exit_only: 'Stop here',
});

const FOLLOWUP_TEXTS = Object.freeze({
  approve_only: 'Plan approved by the user. Do not implement. Finish only the plan-only steps you were given, then stop.',
  autopilot: 'Please implement the approved plan now.',
  autopilot_fleet: 'Please implement the approved plan using autopilot_fleet where useful.',
  interactive: 'I approved the plan. Let\'s proceed interactively with implementation.',
});

const FOLLOWUP_MODES = Object.freeze({
  approve_only: 'agent',
  autopilot: 'autopilot',
  autopilot_fleet: 'autopilot',
  interactive: 'agent',
});

function actionId(value) {
  return String(value || '').trim().toLowerCase();
}

/** Whether `id` is one of the actions this table knows. */
export function isKnownPlanBoardAction(id) {
  return Object.prototype.hasOwnProperty.call(PLAN_BOARD_LABELS, actionId(id));
}

/** The button's label; an id the table does not know is spelled out. */
export function planBoardActionLabel(id) {
  const key = actionId(id);
  if (Object.prototype.hasOwnProperty.call(PLAN_BOARD_LABELS, key)) return PLAN_BOARD_LABELS[key];
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) || 'Select';
}

/** The message the action queues, or '' when it queues none. */
export function planBoardFollowupText(id) {
  const key = actionId(id);
  return Object.prototype.hasOwnProperty.call(FOLLOWUP_TEXTS, key) ? FOLLOWUP_TEXTS[key] : '';
}

/** The relay mode the follow-up runs in, or null for an action without one. */
export function planBoardFollowupMode(id) {
  const key = actionId(id);
  return Object.prototype.hasOwnProperty.call(FOLLOWUP_MODES, key) ? FOLLOWUP_MODES[key] : null;
}

/**
 * `actions` with "Approve plan" first when it is missing. The others keep
 * their order and their entries (a CLI's own list, a card stored before the
 * button existed). Entries may be ids or `{ id }` objects.
 */
export function withApproveOnly(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const has = list.some((entry) => actionId(typeof entry === 'string' ? entry : entry?.id) === PLAN_BOARD_APPROVE_ONLY);
  if (has) return list.slice();
  return [{ ...PLAN_BOARD_ACTIONS[0] }, ...list];
}

/** Whether a card is a pending plan card, the one kind "Approve plan" is added to. */
export function isPendingPlanBoard(board) {
  return String(board?.boardType || '').trim().toLowerCase() === 'plan_ready'
    && (String(board?.status || 'pending').trim().toLowerCase() || 'pending') === 'pending';
}

/**
 * The actions a card shows: a pending plan card gets "Approve plan" even when
 * it was stored before the button existed. A settled card shows what it was
 * stored with.
 */
export function planBoardShownActions(board, actions = board?.actions) {
  return isPendingPlanBoard(board) ? withApproveOnly(actions) : (Array.isArray(actions) ? actions : []);
}

/**
 * The card's actions from the Copilot CLI's own `exit_plan_mode` arguments
 * (ids or `{ id | actionId | value }` entries), in the CLI's order, each id
 * once, with "Approve plan" added. Without any, the shared list. An id the
 * table does not know keeps no mode: pressing it only settles the card.
 */
export function planBoardActionsFromCli(rawActions) {
  const ids = Array.isArray(rawActions)
    ? rawActions
      .map((entry) => {
        if (typeof entry === 'string') return actionId(entry);
        if (entry && typeof entry === 'object') return actionId(entry.id || entry.actionId || entry.value);
        return '';
      })
      .filter(Boolean)
    : [];
  if (!ids.length) return PLAN_BOARD_ACTIONS.map((entry) => ({ ...entry }));
  const unique = [...new Set(ids)];
  return withApproveOnly(unique.map((id) => ({
    id,
    label: planBoardActionLabel(id),
    mode: id === 'exit_only' ? 'agent' : planBoardFollowupMode(id),
  })));
}
