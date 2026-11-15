import { isRemoteRelayApprovalQuestion } from '../../shared/remote-relay-contract.mjs';
import { TOOL_PERMISSION_QUESTION_SOURCE, isPersonOnlyCard, isRelayAskId } from '../../shared/relay-asks.mjs';

function parseRowJson(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

/**
 * A stored question row that is this relay's Allow / Deny card for one of its
 * own agent's calls to another relay (remote-relay-caller-context.mjs). The
 * context lives in the row's request envelope.
 */
export function isRemoteRelayApprovalRow(row) {
  const envelope = parseRowJson(row?.request);
  return envelope ? isRemoteRelayApprovalQuestion(envelope) : false;
}

/**
 * A card no agent may list, answer or dismiss (shared/relay-asks.mjs
 * isPersonOnlyCard): a relay's approval of its own agent's call, a Safety
 * check, a Claude Cloud permission, any card marked person-only. Takes a
 * stored row or a formatted question (its context read directly).
 */
export function isUserOnlyRow(row) {
  return isRemoteRelayApprovalRow(row) || isPersonOnlyCard(row);
}

// A formatted question's context, or a stored row's (in its request envelope).
function cardContextOf(card) {
  if (card?.context && typeof card.context === 'object') return card.context;
  const envelope = parseRowJson(card?.request);
  return envelope && typeof envelope.context === 'object' ? envelope.context : null;
}

/** A tool permission card (Approve / Deny on an agent's tool call), by its stored source. */
export function isToolPermissionCard(card) {
  return String(cardContextOf(card)?.source || '').trim() === TOOL_PERMISSION_QUESTION_SOURCE;
}

/**
 * Whether a question's push opens the app instead of offering one-tap
 * answers: an approval, a Safety check or a tool permission. An ask
 * (relay_tool `ask`) is the person's too, but a question: it keeps them.
 * Display only; who may answer is the answer route's check.
 */
export function questionPushOpensApp(question) {
  if (!question || typeof question !== 'object') return false;
  return (isUserOnlyRow(question) && !isRelayAskId(question.id)) || isToolPermissionCard(question);
}
