// Whether archiving a conversation asks first. Archiving stops the chat's
// worker, so a chat whose worker is live (the sidebar's green state, idle or
// not) or whose turn is running asks before it goes; an offline chat archives
// at once. DOM-free so the decision is unit-testable.

/**
 * The confirmation an archive needs, or null when it goes through at once.
 * `visualState` is the sidebar row's state (resolveConversationUiState), and
 * `running` whether a turn of the chat is running as far as the page knows.
 */
export function archiveConfirmationFor({ archived = false, visualState = '', running = false } = {}) {
  if (archived === true) return null;
  if (running === true) {
    return {
      reason: 'running',
      message: 'Archive this session? It is still working on a reply.',
      detail: 'The relay archives it only once the turn has stopped.',
    };
  }
  if (String(visualState || '').trim().toLowerCase() === 'ready') {
    return {
      reason: 'active',
      message: 'Archive this session? Its process is still active.',
      detail: 'Archiving stops the idle process. The chat stays in the Archived view.',
    };
  }
  return null;
}
