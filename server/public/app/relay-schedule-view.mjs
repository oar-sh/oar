// Relay schedules in the browser: the "scheduled" marker on a conversation's
// sidebar row and the header's "N scheduled" chip with its list and Cancel
// buttons.
//
// DOM-free on purpose, like relay-event-view.mjs: the callers own the
// elements, this module owns the decisions and the markup.
//
// The interval words mirror shared/relay-schedules.mjs, which the browser
// cannot import (only server/public is served); relay-schedule-view.test.mjs
// holds the two together.

export const RELAY_SCHEDULE_SOCKET_EVENT = 'relay_schedules';
export const RELAY_SCHEDULE_MESSAGE_KIND = 'relay-schedule';

function defaultEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function defaultFormatTime(iso) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const sameDay = new Date().toDateString() === at.toDateString();
  return at.toLocaleString([], sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function activeList(schedules) {
  return (Array.isArray(schedules) ? schedules : []).filter((schedule) => schedule && schedule.id && !schedule.endedAt);
}

/** "every 30 min", "every 2 h", "every day", "every 7 days". */
export function describeScheduleInterval(everyMinutes) {
  const minutes = Number(everyMinutes);
  if (!(minutes > 0)) return '';
  if (minutes % 1440 === 0) return minutes === 1440 ? 'every day' : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

/** The schedules that fire into a conversation. */
export function schedulesInto(schedules, conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return [];
  return activeList(schedules).filter((schedule) => schedule.session?.id === id);
}

/** The schedules that fire into a conversation or that it set for another. */
export function schedulesOf(schedules, conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return [];
  return activeList(schedules).filter((schedule) => schedule.session?.id === id || schedule.setBy?.id === id);
}

/** "every 30 min · next 10:30", or "once · 06:30". */
export function describeScheduleWhen(schedule, { formatTime = defaultFormatTime } = {}) {
  const next = schedule?.nextFireAt ? formatTime(schedule.nextFireAt) : '';
  const every = schedule?.once ? '' : describeScheduleInterval(schedule?.everyMinutes);
  if (every) return next ? `${every} · next ${next}` : every;
  return next ? `once · ${next}` : 'once';
}

/** The earliest next time among the schedules, or null. */
export function nextScheduledAt(schedules) {
  const times = activeList(schedules).map((schedule) => Date.parse(schedule.nextFireAt || '')).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export function scheduleChipText(schedules) {
  const count = activeList(schedules).length;
  return count ? `${count} scheduled` : '';
}

function conversationTitle(conversations, id, fallback = '') {
  const title = String(conversations?.[id]?.title || fallback || '').trim();
  return title || `session ${String(id).slice(0, 8)}`;
}

/** The sidebar's marker for a conversation a schedule fires into, or ''. */
export function renderScheduledBadgeHtml(schedules, conversationId, { escHtml = defaultEscape, formatTime = defaultFormatTime } = {}) {
  const into = schedulesInto(schedules, conversationId);
  if (!into.length) return '';
  const next = nextScheduledAt(into);
  const hint = `${into.length} schedule${into.length === 1 ? '' : 's'}${next ? ` · next ${formatTime(next)}` : ''}`;
  return `<span class="conv-scheduled-badge" title="${escHtml(hint)}">scheduled</span>`;
}

/**
 * The chip's list for the conversation on screen: one row per schedule, what
 * it is called and sends, where it goes or who set it, when it fires next,
 * and its Cancel button.
 */
export function renderSchedulePanelHtml(schedules, conversationId, { conversations = null, escHtml = defaultEscape, formatTime = defaultFormatTime } = {}) {
  const id = String(conversationId || '').trim();
  const rows = schedulesOf(schedules, id).map((schedule) => {
    const name = String(schedule.title || '').trim() || String(schedule.text || '').trim().split(/\r?\n/)[0] || schedule.id;
    const where = schedule.session?.id !== id
      ? `for ${conversationTitle(conversations, schedule.session?.id, schedule.session?.title)}`
      : (schedule.setBy?.id ? `set by ${conversationTitle(conversations, schedule.setBy.id, schedule.setBy.title)}` : '');
    // Held: its setter's agent has prompted other agents as often as it may
    // before you write in that conversation.
    const held = schedule.heldForApproval
      ? `waiting until you write in ${conversationTitle(conversations, schedule.setBy?.id, schedule.setBy?.title)}`
      : '';
    const details = [held || describeScheduleWhen(schedule, { formatTime }), where, schedule.skippedCount ? `${schedule.skippedCount} skipped` : '']
      .filter(Boolean).join(' · ');
    return '<li class="relay-watch-item relay-schedule-item">'
      + `<span class="relay-watch-what" title="${escHtml(schedule.text || '')}">${escHtml(name)}</span>`
      + `<span class="relay-watch-events">${escHtml(details)}</span>`
      + `<button type="button" class="relay-schedule-cancel" data-schedule-id="${escHtml(schedule.id)}">Cancel</button>`
      + '</li>';
  }).join('');
  return `<ul class="relay-watch-list">${rows}</ul>`;
}
