// 📓 Questions of one conversation: the order the panel lists them in, the
// header icon's count and its labels. Pure: no DOM, no fetch.
//
// An ask (relay-ask-service.mjs shape) is pending, or closed: answered,
// dismissed, withdrawn or cancelled. Pending asks come first, the urgent ones
// (`urgency: 'now'`) ahead of the rest, each group newest first; then those
// closed in the last day, the latest close first.

export const QUESTIONS_CLOSED_KEEP_MS = 24 * 60 * 60_000;

function toText(value) {
  return String(value ?? '').trim();
}

function timeOf(value) {
  const ms = Date.parse(toText(value));
  return Number.isFinite(ms) ? ms : 0;
}

function newestFirst(a, b) {
  return timeOf(b.createdAt) - timeOf(a.createdAt) || toText(b.id).localeCompare(toText(a.id));
}

function closedAt(ask) {
  return timeOf(ask.answeredAt) || timeOf(ask.updatedAt);
}

export function isUrgentAsk(ask) {
  return ask?.urgency === 'now';
}

/**
 * The asks of `conversationId`, split and ordered for the panel:
 * `{ pending, urgent, answered }` where `pending` lists every pending ask
 * (urgent ones first), `urgent` counts them and `answered` holds the asks
 * closed within the last day.
 */
export function questionsOfConversation(asks, conversationId, now = Date.now()) {
  const id = toText(conversationId);
  const mine = (Array.isArray(asks) ? asks : [])
    .filter((ask) => ask && !ask.relayId && id && toText(ask.conversationId || ask.session?.id) === id);
  const pending = mine.filter((ask) => ask.status === 'pending');
  const urgentAsks = pending.filter(isUrgentAsk).sort(newestFirst);
  const normalAsks = pending.filter((ask) => !isUrgentAsk(ask)).sort(newestFirst);
  const since = now - QUESTIONS_CLOSED_KEEP_MS;
  const answered = mine
    .filter((ask) => ask.status !== 'pending' && closedAt(ask) >= since)
    .sort((a, b) => closedAt(b) - closedAt(a) || toText(b.id).localeCompare(toText(a.id)));
  return { pending: [...urgentAsks, ...normalAsks], urgent: urgentAsks.length, answered };
}

/**
 * A count badge: nothing at zero; with an urgent one waiting the urgent
 * count, marked; else the pending count.
 */
export function questionsBadge({ pending = 0, urgent = 0 } = {}) {
  const open = Math.max(0, Number(pending) || 0);
  const hot = Math.max(0, Number(urgent) || 0);
  if (hot > 0) return { text: String(hot), urgent: true };
  if (open > 0) return { text: String(open), urgent: false };
  return { text: '', urgent: false };
}

/** The 📓 button's tooltip and label. */
export function questionsAria({ pending = 0, urgent = 0 } = {}) {
  const open = Math.max(0, Number(pending) || 0);
  const hot = Math.max(0, Number(urgent) || 0);
  if (hot > 0) return `Questions (${hot} urgent of ${open} open)`;
  if (open > 0) return `Questions (${open} open)`;
  return 'Questions';
}

/** The ︙ twin's text: "📓 Questions (2 urgent)" / "(3 open)". */
export function questionsTwinLabel({ pending = 0, urgent = 0 } = {}) {
  const open = Math.max(0, Number(pending) || 0);
  const hot = Math.max(0, Number(urgent) || 0);
  if (hot > 0) return `📓 Questions (${hot} urgent)`;
  if (open > 0) return `📓 Questions (${open} open)`;
  return '📓 Questions';
}

/** The panel's head line: "📓 Questions · 2 urgent · 5 open". */
export function questionsPanelTitle({ pending = 0, urgent = 0 } = {}) {
  const open = Math.max(0, Number(pending) || 0);
  const hot = Math.max(0, Number(urgent) || 0);
  return ['📓 Questions', hot > 0 ? `${hot} urgent` : '', open > 0 ? `${open} open` : 'none open']
    .filter(Boolean)
    .join(' · ');
}
