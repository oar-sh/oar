// The note the relay writes into a conversation whose turn a relay restart
// cut off ("After a relay restart, tell interrupted sessions to carry on",
// server/services/restart-resume-service.mjs): a compact row in the look of
// the relay event rows, never a bubble of the user's.
//
// DOM-free, like relay-event-view.mjs: the caller owns the element.

export const RESTART_RESUME_KIND = 'relay-restart-resume';
export const RESTART_RESUME_LEAD = 'Automatic message from OAR, not from the user:';

function defaultEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isRestartResumeNote(message) {
  return message?.role === 'user' && String(message?.kind || '').trim() === RESTART_RESUME_KIND;
}

/** The row's markup: folded to one line, opened to the note as the agent got it. */
export function renderRestartResumeNoteHtml(message, { escHtml = defaultEscape, timeText = '' } = {}) {
  const text = String(message?.text ?? '').trim();
  const body = text.startsWith(RESTART_RESUME_LEAD) ? text.slice(RESTART_RESUME_LEAD.length).trim() : text;
  return '<details class="relay-event-row relay-restart-note">'
    + '<summary class="relay-event-summary">'
    + '<span class="relay-event-tag" title="An automated message of the relay, not from you.">relay</span>'
    + '<span class="relay-event-text">Relay restarted · the interrupted turn was asked to carry on</span>'
    + (timeText ? `<span class="relay-event-time">${escHtml(timeText)}</span>` : '')
    + '</summary>'
    + `<div class="relay-event-lines relay-restart-note-text">${escHtml(body)}</div>`
    + '</details>';
}
