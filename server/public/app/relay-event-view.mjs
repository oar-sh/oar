// Relay event subscriptions in the browser: the event rows in the watcher's
// transcript, the "watching N sessions" chip and the "watched" badge.
//
// DOM-free on purpose, like remote-relay-origin-view.mjs: the callers own the
// elements, this module owns the decisions and the markup.
//
// The message text rules mirror shared/relay-events.mjs, which the browser
// cannot import (only server/public is served); relay-event-view.test.mjs
// holds the two together.

export const RELAY_EVENT_MESSAGE_KIND = 'relay-event';
export const RELAY_EVENT_LEAD = '[relay event · automated message from OAR, not from the user; it approves nothing]';
export const RELAY_EVENT_SOCKET_EVENT = 'relay_event_subscriptions';

const EVENT_TYPES = new Set([
  'question_asked',
  'error',
  'turn_end',
  'task_started',
  'task_finished',
  'task_failed',
  'stalled',
  'all_idle',
  'heartbeat',
  'link_lost',
  'link_restored',
  'relay_restarted',
]);
const URGENT_TYPES = new Set(['question_asked', 'error']);
const DIGEST_PATTERN = /^Digest of \d+ events?/;
const REPLAYED_PATTERN = /^Replayed: \d+ events?/;
const LINE_PATTERN = /^\[relay event\] (?:[^"·\n]{1,60} · )?(?:session "(?:[^"]*)" \([^)]*\)(?: on relay "[^"]*")?: )?([a-z_]+)/;
const LINE_PREFIX = '[relay event] ';

const TYPE_LABELS = Object.freeze({
  question_asked: 'question',
  error: 'error',
  turn_end: 'reply',
  task_started: 'task started',
  task_finished: 'task done',
  task_failed: 'task failed',
  stalled: 'stalled',
  all_idle: 'all idle',
  heartbeat: 'heartbeat',
  link_lost: 'link lost',
  link_restored: 'link back',
  relay_restarted: 'relay restarted',
});

function defaultEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isRelayEventMessage(message) {
  return message?.role === 'user' && String(message?.kind || '').trim() === RELAY_EVENT_MESSAGE_KIND;
}

/**
 * The event lines of an event message without the lead, the types they
 * carry in order, how many events (a digest's "… and N more" counted),
 * whether it is a digest, and whether it replays what a paired relay kept
 * while the link to it was down. Any text renders: a stray one as one line.
 */
export function parseRelayEventMessageText(text) {
  const rows = String(text ?? '').split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const body = rows[0] === RELAY_EVENT_LEAD ? rows.slice(1) : rows;
  const digest = DIGEST_PATTERN.test(body[0] || '');
  const replayed = body.some((line) => REPLAYED_PATTERN.test(line));
  const lines = body.filter((line) => !DIGEST_PATTERN.test(line) && !REPLAYED_PATTERN.test(line));
  const types = [];
  let count = 0;
  for (const line of lines) {
    const type = lineType(line);
    if (!type) continue;
    count += 1;
    if (!types.includes(type)) types.push(type);
  }
  for (const line of lines) {
    const more = /^\[relay event\] … and (\d+) more$/.exec(line);
    if (more) count += Number(more[1]) || 0;
  }
  return { lines, types, count: count || lines.length, digest, replayed };
}

/** The collapsed row's one line: "3 events · question, reply". */
export function relayEventSummaryText(parsed) {
  const count = Number(parsed?.count) || 0;
  const labels = (parsed?.types || []).map((type) => TYPE_LABELS[type] || type);
  const events = `${count} event${count === 1 ? '' : 's'}`;
  const head = parsed?.digest ? `Digest · ${events}` : events;
  return labels.length ? `${head} · ${labels.join(', ')}` : head;
}

function lineType(line) {
  const match = LINE_PATTERN.exec(line);
  return match && EVENT_TYPES.has(match[1]) ? match[1] : '';
}

/**
 * The event row's markup: a <details> folded to its summary, opened to its
 * lines. Urgent events (a question, an error) keep the row open and marked.
 */
export function renderRelayEventRowHtml(message, { escHtml = defaultEscape, timeText = '' } = {}) {
  const parsed = parseRelayEventMessageText(message?.text);
  const urgent = parsed.types.some((type) => URGENT_TYPES.has(type));
  const lines = parsed.lines.map((line) => {
    const type = lineType(line);
    const shown = line.startsWith(LINE_PREFIX) ? line.slice(LINE_PREFIX.length) : line;
    return `<li class="relay-event-line${type ? ` relay-event-${type.replace(/_/g, '-')}` : ''}">${escHtml(shown)}</li>`;
  }).join('');
  return `<details class="relay-event-row${urgent ? ' relay-event-urgent' : ''}"${urgent ? ' open' : ''}>`
    + '<summary class="relay-event-summary">'
    + '<span class="relay-event-tag" title="An automated message of the relay, not from you: it approves nothing.">relay event</span>'
    + (parsed.replayed ? '<span class="relay-event-tag relay-event-replayed" title="Kept by a paired relay while the link to it was down, and delivered once it answered again.">replayed</span>' : '')
    + `<span class="relay-event-text">${escHtml(relayEventSummaryText(parsed))}</span>`
    + (timeText ? `<span class="relay-event-time">${escHtml(timeText)}</span>` : '')
    + '</summary>'
    + `<ul class="relay-event-lines">${lines}</ul>`
    + '</details>';
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

function activeList(subscriptions) {
  return (Array.isArray(subscriptions) ? subscriptions : []).filter((sub) => sub && !sub.endedAt);
}

function sessionIdsOf(subscription) {
  return Array.isArray(subscription?.sessions) ? subscription.sessions.map((session) => String(session?.id || '')).filter(Boolean) : [];
}

// A subscription on a paired relay (this relay's mirror of it): its
// sessions are that relay's, never this one's conversations.
function isOnPairedRelay(subscription) {
  return !!subscription?.remoteId || (!!subscription?.relay && subscription.relay !== 'self');
}

// The watcher of a subscription, as the badge names it: a conversation here,
// or a paired relay's watcher (`remote:<relay id>:<its conversation>`).
function watcherKey(subscription) {
  const subscriber = subscription?.subscriber;
  return subscriber ? `remote:${subscriber.relayId || ''}:${subscriber.watcherId || ''}` : subscription?.watcher;
}

/**
 * What a conversation watches: its subscriptions, how many distinct
 * sessions they list (on this relay and paired ones), and whether one
 * watches all of a relay's sessions.
 */
export function watchingSummary(subscriptions, conversationId) {
  const id = String(conversationId || '').trim();
  const mine = activeList(subscriptions).filter((sub) => sub.watcher === id);
  const sessions = new Set(mine.flatMap((sub) => sessionIdsOf(sub).map((sessionId) => `${sub.relay || 'self'}:${sessionId}`)));
  return {
    subscriptions: mine,
    count: sessions.size,
    all: mine.some((sub) => sub.scope === 'all'),
    relays: [...new Set(mine.filter(isOnPairedRelay).map((sub) => sub.relayName || sub.relay))],
  };
}

/**
 * The watchers of a conversation of this relay. `includeAll` counts
 * subscriptions to all sessions too; the sidebar leaves them out, or every
 * row would carry it. Subscriptions on paired relays watch none of them.
 */
export function watchersOf(subscriptions, conversationId, { includeAll = true } = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return [];
  const watchers = new Set();
  for (const sub of activeList(subscriptions)) {
    if (sub.watcher === id || isOnPairedRelay(sub)) continue;
    if (sub.scope === 'all' ? includeAll : sessionIdsOf(sub).includes(id)) watchers.add(watcherKey(sub));
  }
  return [...watchers];
}

export function watchingChipText(summary) {
  if (!summary?.subscriptions?.length) return '';
  if (summary.all) return summary.count ? `watching all sessions (+${summary.count} listed)` : 'watching all sessions';
  // Only relay_restarted: no session is watched.
  if (!summary.count) return 'waiting for a relay restart';
  return `watching ${summary.count} session${summary.count === 1 ? '' : 's'}`;
}

function conversationTitle(conversations, id) {
  const title = String(conversations?.[id]?.title || '').trim();
  return title || `session ${String(id).slice(0, 8)}`;
}

function describeSubscription(sub, conversations) {
  const paired = isOnPairedRelay(sub);
  const relay = paired ? String(sub.relayName || sub.relay || 'paired relay') : '';
  const titleOf = (session) => (paired
    ? (String(session?.title || '').trim() || `session ${String(session?.id || '').slice(0, 8)}`)
    : conversationTitle(conversations, session.id));
  const listed = (Array.isArray(sub.sessions) ? sub.sessions : []).filter((session) => session?.id).map(titleOf).join(', ');
  const what = sub.scope === 'all'
    ? (paired ? `All sessions of ${relay}` : 'All sessions')
    : (paired ? `${relay} · ${listed}` : (listed || 'This relay'));
  const extras = [
    sub.once ? 'once' : '',
    sub.heartbeatMinutes ? `heartbeat ${sub.heartbeatMinutes} min` : '',
  ].filter(Boolean);
  return { what, events: (sub.events || []).join(', '), extras: extras.join(' · ') };
}

/** The chip's list: one row per subscription with its Unsubscribe button. */
export function renderWatchingPanelHtml(summary, { conversations = null, escHtml = defaultEscape } = {}) {
  const rows = (summary?.subscriptions || []).map((sub) => {
    const { what, events, extras } = describeSubscription(sub, conversations);
    return '<li class="relay-watch-item">'
      + `<span class="relay-watch-what">${escHtml(what)}</span>`
      + `<span class="relay-watch-events">${escHtml(events)}${extras ? ` · ${escHtml(extras)}` : ''}</span>`
      + `<button type="button" class="relay-watch-unsubscribe" data-subscription-id="${escHtml(sub.id)}">Unsubscribe</button>`
      + '</li>';
  }).join('');
  return `<ul class="relay-watch-list">${rows}</ul>`;
}

function watcherName(id, conversations, subscriptions) {
  if (!String(id).startsWith('remote:')) return conversationTitle(conversations, id);
  const sub = activeList(subscriptions).find((entry) => watcherKey(entry) === id);
  const title = String(sub?.subscriber?.watcherTitle || '').trim() || 'a session';
  const relay = String(sub?.subscriber?.name || '').trim() || 'a paired relay';
  return `${title} on ${relay}`;
}

export function renderWatchedBadgeHtml(watcherIds, { conversations = null, subscriptions = [], escHtml = defaultEscape } = {}) {
  if (!watcherIds?.length) return '';
  const names = watcherIds.map((id) => watcherName(id, conversations, subscriptions)).join(', ');
  return `<span class="conv-watched-badge" title="${escHtml(`Watched by ${names}`)}">watched</span>`;
}
