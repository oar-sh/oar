// A plan board inside the reply it belongs to.
//
// A board used to be a card of its own at the end of the transcript, below
// whatever was said after it, and it vanished once an action was chosen. It
// belongs to one turn: its content reads as part of that turn's reply, and its
// buttons are what the reply asks for. So it is shown inside the reply's
// bubble (inside the live bubble while the turn still runs), it stays there
// after the choice, and it says what was chosen.
//
// The reply often IS the plan: the worker posts the reply's own text as the
// board when the agent wrote its plan as the answer. Then the text is shown
// once, as the reply, and the board adds only its buttons.

function plain(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether the reply already says what the board says. Both are compared as
 * the text a reader sees (rendered, whitespace collapsed), so markdown that
 * renders the same counts as the same.
 */
export function boardBodyShownInReply(bodyText, replyText) {
  const body = plain(bodyText);
  if (!body) return true;
  return plain(replyText).includes(body);
}

/** The label of the action that was chosen, as the button said it. */
export function chosenActionLabel(board) {
  const chosen = String(board?.selectedAction || '').trim().toLowerCase();
  if (!chosen) return '';
  const actions = Array.isArray(board?.actions) ? board.actions : [];
  const action = actions.find((item) => String(item?.id || '').trim().toLowerCase() === chosen);
  return String(action?.label || '').trim() || chosen.replace(/[_-]+/g, ' ');
}

/** The line that replaces the buttons once the board is settled; '' while it is pending. */
export function boardOutcomeLine(board) {
  const status = String(board?.status || 'pending').trim().toLowerCase();
  if (status === 'pending') return '';
  const label = chosenActionLabel(board);
  if (label) return `Chosen: ${label}`;
  return status === 'dismissed' ? 'Dismissed' : 'Closed';
}

/** The boards of one conversation, oldest first, each id once. */
export function boardsOfConversation(boards, conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return [];
  const seen = new Set();
  return Array.from(boards || [])
    .filter((board) => board && board.id && board.conversationId === id)
    .filter((board) => (seen.has(board.id) ? false : seen.add(board.id)))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

/** What a rendered board depends on: a change in any of it redraws the board. */
export function boardRenderKey(board, { duplicate = false } = {}) {
  return JSON.stringify([
    board?.id || '',
    board?.status || '',
    board?.selectedAction || '',
    board?.title || '',
    board?.body || '',
    (Array.isArray(board?.actions) ? board.actions : []).map((action) => `${action?.id || ''}:${action?.label || ''}`),
    board?.recommendedAction || '',
    duplicate,
  ]);
}
