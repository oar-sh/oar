// The `plan_ready` board: the card that gives the UI its autopilot handoff
// buttons when a plan-mode turn produces a plan.
//
// The payload is byte-compatible with the Claude, Cursor and Grok workers'
// (`PLAN_BOARD_ACTIONS`, `boardType`, `title`, `recommendedAction`, `context`
// shape), because the UI renders whatever `actions` the board carries and the
// relay's action handler maps those ids onto relay modes. Diverging here would
// mean a Copilot plan card whose buttons behave differently from every other
// provider's.
//
// Copilot has something the Cursor and Grok workers do not: a real
// `onExitPlanModeRequest` hook, so the plan text can be taken from the runtime
// at the moment the agent finishes planning rather than only guessed from the
// shape of the final prose. Both paths are wired — the hook is primary, the
// text heuristic is the fallback — which is the Claude worker's arrangement.
import { countPlanLikeLines } from '../../shared/plan-lines.mjs';

/**
 * Kept identical across workers. `exit_only` dismisses; `autopilot` and
 * `interactive` queue a follow-up user message in the mapped relay mode.
 */
export const PLAN_BOARD_ACTIONS = [
  { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
  { id: 'interactive', label: 'Stop here and prompt myself', mode: 'agent' },
  { id: 'exit_only', label: 'Stop here', mode: 'agent' },
];

/**
 * How many list-ish lines a final message needs before it is treated as a plan.
 * Same threshold as the siblings; `countPlanLikeLines` is the shared predicate.
 */
export const PLAN_LINE_THRESHOLD = 2;

/** Returns null when there is nothing worth posting — the caller then skips. */
export function buildCopilotPlanReadyBoardPayload({
  message,
  planText = '',
  source = 'plan-mode-fallback',
} = {}) {
  const summary = String(planText || '').trim();
  if (!summary) return null;
  return {
    queueId: message?.id,
    messageId: message?.id,
    conversationId: message?.conversationId,
    mode: message?.relayMode || 'agent',
    boardType: 'plan_ready',
    title: 'Plan ready for review',
    body: summary,
    actions: PLAN_BOARD_ACTIONS,
    recommendedAction: null,
    context: {
      source,
      queueMessageId: message?.id || null,
      conversationId: message?.conversationId || null,
      relayMode: message?.relayMode || 'agent',
    },
  };
}

/**
 * Should the fallback path post a board for this finished turn?
 *
 * Gated on plan AND ask, which is one mode wider than the Cursor worker (plan
 * only). The board's real precondition is "the work is described but not
 * started", and in plan mode that is guaranteed — mutating tools are denied
 * outright. In ask mode it is NOT: the user can approve a tool, so a turn there
 * can genuinely do the work and then summarise it in bullets. Offering
 * "Implement in autopilot" for work already done would be worse than offering
 * nothing, so ask mode additionally requires that nothing was actually
 * approved (`acted`).
 */
export function shouldPostPlanBoard({
  relayMode,
  finalText,
  alreadyPosted = false,
  acted = false,
} = {}) {
  if (alreadyPosted) return false;
  const mode = String(relayMode || '').trim().toLowerCase();
  if (mode !== 'plan' && mode !== 'ask') return false;
  if (mode === 'ask' && acted) return false;
  return countPlanLikeLines(finalText) >= PLAN_LINE_THRESHOLD;
}

/**
 * The text the runtime handed to `onExitPlanModeRequest`. `planContent` is the
 * full plan when the runtime has it; `summary` is always present.
 */
export function planTextFromExitRequest(request) {
  return String(request?.planContent || request?.summary || '').trim();
}

/**
 * Returned to the runtime after a board is posted.
 *
 * `approved: false` deliberately — approving exit-plan-mode tells the runtime
 * the user accepted the plan, and the SAME turn then rolls straight into
 * implementing it while the board is still sitting unanswered in the UI. The
 * feedback explains the situation so the agent closes out instead of treating
 * the refusal as an obstacle to route around. Mirrors the Claude worker's
 * `EXIT_PLAN_DENY_MESSAGE`.
 */
export const EXIT_PLAN_BOARD_POSTED_FEEDBACK =
  'Plan received — it is shown to the user in the relay for review. End the turn now with a short '
  + 'closing message and do not start implementing; the user\'s decision will arrive as a new message.';

export const EXIT_PLAN_NO_BOARD_FEEDBACK =
  'Plan received, but it could not be shown for review. Restate the complete plan as your final '
  + 'message, then end the turn without implementing; the user\'s decision will arrive as a new message.';
