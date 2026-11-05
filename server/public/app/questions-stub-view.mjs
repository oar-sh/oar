// 📓 The one-line stub an ask leaves in the bubble of the turn that asked
// it (questions-panel-ui.js places it). Pure: no DOM.

function toText(value) {
  return String(value ?? '').trim();
}

const ANSWER_PREVIEW_MAX = 80;

/** The answer as one short line: the choice, else the answer's first 80 characters. */
export function askStubAnswerText(ask) {
  const choice = toText(ask?.choice);
  if (choice) return choice;
  const answer = toText(String(ask?.answer || '').replace(/\s+/g, ' '));
  return answer.length > ANSWER_PREVIEW_MAX ? `${answer.slice(0, ANSWER_PREVIEW_MAX - 1)}…` : answer;
}

/**
 * The stub's text, or '' for an ask that leaves none (cancelled: its session
 * ended, nobody waits on it; it shows in 📓 only).
 */
export function askStubText(ask) {
  switch (ask?.status) {
    case 'pending': return ask.urgency === 'now' ? '📓 Question for you · urgent' : '📓 Question for you';
    case 'answered': return `📓 Answered: ${askStubAnswerText(ask)}`;
    case 'dismissed': return '📓 Dismissed';
    case 'withdrawn': return '📓 Withdrawn';
    default: return '';
  }
}

/** The queue row of the turn that asked, or null (the stub then stands alone, pending asks only). */
export function askStubHostKey(ask) {
  return toText(ask?.queueId) || null;
}

/** What a drawn stub shows; a stub is drawn anew only when this changes. */
export function askStubKey(ask) {
  return JSON.stringify([toText(ask?.status), ask?.urgency === 'now' ? 'now' : 'normal', toText(ask?.choice), askStubAnswerText(ask)]);
}
