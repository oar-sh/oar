// A conversation record's turn fields (`activeTurn`, `sessionState`,
// `backgroundTaskCount`) kept in step with the live events, for every row
// and not only the open one. The list fetch sets them; between fetches the
// `message_status` and `background_tasks` events are the only word on what
// a session is doing, and the sidebar's dots, a group head's pill and its
// fold read these fields. DOM-free.

const TERMINAL_STATUSES = new Set(['done', 'failed', 'dropped', 'cancelled']);
const QUEUED_STATUSES = new Set(['pending', 'parked']);

function runningTaskCount(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const status = String(task?.status || 'running').trim().toLowerCase();
    return !status || status === 'running';
  }).length;
}

function settleState(conversation) {
  conversation.sessionState = Number(conversation.backgroundTaskCount || 0) > 0 ? 'background_only' : 'idle';
}

/**
 * A `message_status` for the conversation. Processing: a turn runs. Pending
 * or parked: a turn is queued (the relay counts it as active). A terminal
 * status: the turn is over; background work, if any was reported, carries
 * the state. Another message still queued is learnt from its own status or
 * the next list fetch. Returns true when a field changed.
 */
export function applyTurnStatusToConversation(conversation, status) {
  if (!conversation || typeof conversation !== 'object') return false;
  const normalized = String(status || '').trim().toLowerCase();
  const before = `${conversation.activeTurn}|${conversation.sessionState}`;
  if (normalized === 'processing') {
    conversation.activeTurn = true;
    conversation.sessionState = 'running_turn';
  } else if (QUEUED_STATUSES.has(normalized)) {
    conversation.activeTurn = true;
    if (conversation.sessionState !== 'running_turn') settleState(conversation);
  } else if (TERMINAL_STATUSES.has(normalized)) {
    conversation.activeTurn = false;
    settleState(conversation);
  } else {
    return false;
  }
  return before !== `${conversation.activeTurn}|${conversation.sessionState}`;
}

/**
 * What a fetched payload says (a list row, or the single conversation): the
 * relay's own view of the session is the truth whenever one arrives; the
 * events only move it forward until the next. `sessionState` names the
 * state, `sessionTasks` (list) or `backgroundTasks` (single) the live set;
 * a `background_only` state without a set still counts as one task.
 * Returns true when a field changed.
 */
export function applyFetchedTurnStateToConversation(conversation, payload) {
  if (!conversation || typeof conversation !== 'object' || !payload || typeof payload !== 'object') return false;
  const before = `${conversation.activeTurn}|${conversation.sessionState}|${conversation.backgroundTaskCount}`;
  if (typeof payload.activeTurn === 'boolean') conversation.activeTurn = payload.activeTurn;
  const state = String(payload.sessionState || '').trim().toLowerCase();
  if (state) {
    conversation.sessionState = state;
    const tasks = Array.isArray(payload.sessionTasks) ? payload.sessionTasks
      : (Array.isArray(payload.backgroundTasks) ? payload.backgroundTasks : null);
    conversation.backgroundTaskCount = tasks ? runningTaskCount(tasks) : (state === 'background_only' ? 1 : 0);
  } else if (Array.isArray(payload.backgroundTasks)) {
    conversation.backgroundTaskCount = runningTaskCount(payload.backgroundTasks);
    if (conversation.sessionState !== 'running_turn' && conversation.activeTurn !== true) settleState(conversation);
  }
  return before !== `${conversation.activeTurn}|${conversation.sessionState}|${conversation.backgroundTaskCount}`;
}

/** A `background_tasks` set for the conversation (replace semantics). Returns true when a field changed. */
export function applyBackgroundTasksToConversation(conversation, tasks) {
  if (!conversation || typeof conversation !== 'object') return false;
  const before = `${conversation.backgroundTaskCount}|${conversation.sessionState}`;
  conversation.backgroundTaskCount = runningTaskCount(tasks);
  if (conversation.sessionState !== 'running_turn' && conversation.activeTurn !== true) settleState(conversation);
  else if (conversation.sessionState !== 'running_turn') settleState(conversation);
  return before !== `${conversation.backgroundTaskCount}|${conversation.sessionState}`;
}
