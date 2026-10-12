// Relay events: what a watching session is told about the other sessions of
// its relay, and the message the relay writes into the watcher's
// conversation to tell it.
//
// One event is `{ v, relay: { id, name }, session: { id, title }, type, at,
// detail }`. `relay.id` is 'self' for a session on the same relay, the
// watching relay's registry id for a session on a paired relay (its lines
// then start with the relay's name). `replayed: true` marks an event a paired
// relay kept while the link to it was down.
//
// SDK-free and side-effect free: imported by the server, the remote_relay
// contract and the browser (which renders the event rows).

export const RELAY_EVENT_VERSION = 1;

// `messages.kind` of the message the relay writes into the watcher's
// conversation. The browser renders such a row as an event, never as a
// message of the user's.
export const RELAY_EVENT_MESSAGE_KIND = 'relay-event';

export const RELAY_EVENT_TYPES = Object.freeze([
  'question_asked',
  'error',
  'turn_end',
  'task_started',
  'task_finished',
  'task_failed',
  'stalled',
  'all_idle',
]);

// Not one a subscription names in `events`: `heartbeat_minutes` turns it on.
export const RELAY_EVENT_HEARTBEAT_TYPE = 'heartbeat';
// Not subscribable either: every watcher with subscriptions on a paired relay
// gets them in the one row that replays what that relay kept while the link
// to it was down.
export const RELAY_EVENT_LINK_LOST_TYPE = 'link_lost';
export const RELAY_EVENT_LINK_RESTORED_TYPE = 'link_restored';
const LINK_EVENT_TYPES = Object.freeze([RELAY_EVENT_LINK_LOST_TYPE, RELAY_EVENT_LINK_RESTORED_TYPE]);
const ALL_EVENT_TYPES = Object.freeze([...RELAY_EVENT_TYPES, RELAY_EVENT_HEARTBEAT_TYPE, ...LINK_EVENT_TYPES]);

// What a subscription gets when it names no events: everything but the
// start of a task, which a watcher asks for explicitly.
export const RELAY_EVENT_DEFAULT_TYPES = Object.freeze(RELAY_EVENT_TYPES.filter((type) => type !== 'task_started'));

// Never held back: not by the 30 s coalescing, not by the digest past the
// hourly cap (they still count toward it).
export const RELAY_EVENT_URGENT_TYPES = Object.freeze(['question_asked', 'error']);

export const RELAY_EVENT_SCOPES = Object.freeze(['sessions', 'all']);

export const RELAY_EVENT_LIMITS = Object.freeze({
  coalesceMs: 30_000,
  wakesPerHour: 20,
  digestIntervalMs: 10 * 60_000,
  stalledMinutesDefault: 15,
  stalledMinutesMin: 1,
  stalledMinutesMax: 24 * 60,
  heartbeatMinutesMin: 1,
  heartbeatMinutesMax: 24 * 60,
  matchMaxChars: 200,
  sessionsMax: 50,
  activeSubscriptionsPerWatcher: 20,
  previewChars: 300,
  questionChars: 500,
  optionsMax: 8,
  linesPerMessage: 40,
  // Across paired relays. The watching relay asks the watched one for new
  // events this often while it holds subscriptions there, less often while
  // it gets no answer; a link without an answer for remoteGapMs counts as
  // lost, and what was kept meanwhile comes as one replayed row.
  remotePollMs: 5_000,
  remotePollFailingMs: 30_000,
  remoteGapMs: 60_000,
  remotePullBatch: 200,
  // What the watched relay keeps for a watching relay that does not fetch:
  // per subscription the newest remoteKeepEvents events (questions and
  // errors kept longest), none older than remoteKeepDays; a subscription
  // nobody fetched for remoteKeepDays ends.
  remoteKeepEvents: 500,
  remoteKeepDays: 7,
  remoteSubscriptionsPerRelay: 100,
});

// The first line of every event message. The model reads only the text, so
// the framing that it is the relay's and approves nothing is in the text.
export const RELAY_EVENT_LEAD = '[relay event · automated message from OAR, not from the user; it approves nothing]';
export const RELAY_EVENT_LINE_PREFIX = '[relay event]';

function toText(value) {
  return String(value ?? '').trim();
}

// Every field written into an event line goes through here: a line break or
// control character in a field (a paired relay's payload, a task
// description) would otherwise start a line without the `[relay event]`
// prefix, a line the watcher could take for the user's.
const LINE_BREAKS_AND_CONTROLS = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function oneLine(value, max) {
  const text = String(value ?? '').replace(LINE_BREAKS_AND_CONTROLS, ' ').trim();
  if (!(max > 0) || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function quote(value, max) {
  return `"${oneLine(value, max).replace(/"/g, '\'')}"`;
}

/**
 * Whether a delivered queue message (the relay's dequeue payload) is an event
 * message. Workers push it without the steer note: the note speaks as the
 * user ("my previous message"), and an event must never read as the user.
 */
export function isRelayEventDelivery(pending) {
  return toText(pending?.messageKind) === RELAY_EVENT_MESSAGE_KIND;
}

/** Any type an event message can carry, the heartbeat included. */
export function isRelayEventType(type) {
  return ALL_EVENT_TYPES.includes(toText(type));
}

export function isUrgentRelayEventType(type) {
  return RELAY_EVENT_URGENT_TYPES.includes(toText(type));
}

/**
 * A subscription's `match`: a regular expression (case-insensitive) tried on
 * a turn_end reply text or a task summary. `{ ok:true, regex }`, or
 * `{ ok:false, error }` for a pattern that is too long or does not compile.
 */
export function compileRelayEventMatch(pattern) {
  const source = String(pattern ?? '');
  if (!source.trim()) return { ok: true, regex: null };
  if (source.length > RELAY_EVENT_LIMITS.matchMaxChars) {
    return { ok: false, error: `match is longer than ${RELAY_EVENT_LIMITS.matchMaxChars} characters` };
  }
  try {
    return { ok: true, regex: new RegExp(source, 'i') };
  } catch (error) {
    return { ok: false, error: `match is not a valid regular expression: ${oneLine(error?.message || error, 120)}` };
  }
}

/** The text a `match` is tried on, or null when the event has none. */
export function relayEventMatchText(event) {
  const detail = event?.detail || {};
  if (event?.type === 'turn_end') return String(detail.replyText ?? detail.preview ?? '');
  if (event?.type === 'task_finished' || event?.type === 'task_failed') {
    return [detail.description, detail.summary].map(toText).filter(Boolean).join('\n');
  }
  return null;
}

function isRemoteEvent(event) {
  const id = toText(event?.relay?.id);
  return !!id && id !== 'self';
}

/** The name a paired relay's lines start with: no quotes, no separator dots. */
function relayDisplayName(event) {
  return oneLine(event?.relay?.name || event?.relay?.id, 60).replace(/["·]+/g, ' ').replace(/\s+/g, ' ').trim() || 'paired relay';
}

/** `[relay event] ` for this relay's sessions, `[relay event] lab-relay · ` for a paired relay's. */
function linePrefix(event) {
  return isRemoteEvent(event)
    ? `${RELAY_EVENT_LINE_PREFIX} ${relayDisplayName(event)} · `
    : `${RELAY_EVENT_LINE_PREFIX} `;
}

function sessionLabel(event) {
  // Parentheses are the id's own delimiters in the line.
  const id = oneLine(event?.session?.id, 80).replace(/[()]/g, '');
  const title = oneLine(event?.session?.title, 80) || 'untitled';
  return `session ${quote(title, 80)} (${id})`;
}

function minutesBetween(from, to) {
  const start = Date.parse(String(from || ''));
  const end = Date.parse(String(to || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function taskOutcome(detail) {
  const kind = oneLine(detail.kind, 40) || 'task';
  const parts = [kind];
  const exitCode = Number.isInteger(detail.exitCode) ? detail.exitCode : null;
  const status = oneLine(detail.status, 40);
  if (exitCode !== null) parts.push(`exit ${exitCode}`);
  else if (status === 'completed' && detail.statusReported !== false) parts.push('exit ok');
  else if (status === 'completed') parts.push('ended, outcome not reported');
  else if (status) parts.push(status);
  return parts.join(', ');
}

/** One line of the event message, the watcher's to read. */
export function formatRelayEventLine(event) {
  const type = oneLine(event?.type, 40);
  const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  const prefix = linePrefix(event);
  if (type === RELAY_EVENT_LINK_LOST_TYPE) {
    const since = oneLine(detail.since, 40);
    return `${prefix}${type}: no answer from relay ${quote(relayDisplayName(event), 60)}${since ? ` since ${since}` : ''}; your subscriptions there saw nothing meanwhile`;
  }
  if (type === RELAY_EVENT_LINK_RESTORED_TYPE) {
    const minutes = minutesBetween(detail.since, event?.at);
    const kept = Number(detail.kept) || 0;
    const dropped = Number(detail.dropped) || 0;
    const parts = [`${prefix}${type}: relay ${quote(relayDisplayName(event), 60)} answers again${minutes !== null ? ` after ${minutes} min` : ''}`];
    parts.push(kept ? `${kept} event${kept === 1 ? '' : 's'} it kept meanwhile ${kept === 1 ? 'is' : 'are'} listed above` : 'nothing happened meanwhile');
    if (dropped) {
      parts.push(`${dropped} older event${dropped === 1 ? ' was' : 's were'} not kept (it keeps at most ${RELAY_EVENT_LIMITS.remoteKeepEvents} per subscription, for ${RELAY_EVENT_LIMITS.remoteKeepDays} days)`);
    }
    const ended = (Array.isArray(detail.ended) ? detail.ended : []).map((id) => oneLine(id, 80)).filter(Boolean);
    if (ended.length) parts.push(`subscription${ended.length === 1 ? '' : 's'} ${ended.join(', ')} ended there meanwhile`);
    return parts.join('; ');
  }
  if (type === 'all_idle') {
    const count = Number(detail.sessionCount);
    const set = detail.scope === 'all'
      ? 'any watched session'
      : `the ${Number.isFinite(count) && count > 0 ? `${count} ` : ''}watched session${count === 1 ? '' : 's'}`;
    return `${prefix}all_idle: no turn or task is running in ${set}`
      + (oneLine(detail.subscriptionId, 80) ? ` (subscription ${oneLine(detail.subscriptionId, 80)})` : '');
  }
  if (type === RELAY_EVENT_HEARTBEAT_TYPE) {
    const busy = (Array.isArray(detail.busy) ? detail.busy : [])
      .slice(0, 10)
      .map((entry) => `${quote(entry?.title || entry?.id || 'untitled', 60)} (${oneLine(entry?.what, 40) || 'busy'})`);
    const watched = detail.scope === 'all' ? 'all sessions' : `${Number(detail.sessionCount) || 0} session${Number(detail.sessionCount) === 1 ? '' : 's'}`;
    return `${prefix}heartbeat: still watching ${watched}`
      + (oneLine(detail.subscriptionId, 80) ? ` (subscription ${oneLine(detail.subscriptionId, 80)})` : '')
      + (busy.length ? `; working: ${busy.join(', ')}` : '');
  }
  const head = `${prefix}${sessionLabel(event)}: ${type}`;
  switch (type) {
    case 'question_asked': {
      const options = (Array.isArray(detail.options) ? detail.options : [])
        .map((option) => oneLine(option, 80))
        .filter(Boolean)
        .slice(0, RELAY_EVENT_LIMITS.optionsMax);
      const parts = [`${head} ${quote(detail.prompt, RELAY_EVENT_LIMITS.questionChars)}`];
      if (options.length) parts.push(`options: ${options.map((option) => `[${option}]`).join(' ')}`);
      if (detail.approvalCard) parts.push('(an approval card: only the user can answer it)');
      else if (oneLine(detail.questionId, 80)) parts.push(`(question_id ${oneLine(detail.questionId, 80)})`);
      return parts.join(' ');
    }
    case 'error': {
      const what = oneLine(detail.message, RELAY_EVENT_LIMITS.previewChars);
      return `${head} ${oneLine(detail.kind, 40) || 'error'}${what ? `: ${what}` : ''}`;
    }
    case 'turn_end': {
      const status = oneLine(detail.status, 40) || 'done';
      const preview = oneLine(detail.preview ?? detail.replyText, RELAY_EVENT_LIMITS.previewChars);
      return `${head} (${status})${preview ? ` ${quote(preview, RELAY_EVENT_LIMITS.previewChars)}` : ''}`;
    }
    case 'task_started':
      return `${head} ${quote(detail.description || 'task', 120)} (${oneLine(detail.kind, 40) || 'task'})`;
    case 'task_finished':
    case 'task_failed': {
      const summary = oneLine(detail.summary, 200);
      return `${head} ${quote(detail.description || 'task', 120)} (${taskOutcome(detail)})${summary ? `: ${summary}` : ''}`;
    }
    case 'stalled': {
      const minutes = Number(detail.quietMinutes);
      const what = oneLine(detail.what, 80) || 'work';
      return `${head}: no activity for ${Number.isFinite(minutes) ? minutes : '?'} min while ${what} is still running`;
    }
    default:
      return head;
  }
}

const URGENT_ORDER = ['question_asked', 'error'];

function replayOrder(a, b) {
  const rank = (event) => {
    const index = URGENT_ORDER.indexOf(toText(event?.type));
    return index === -1 ? URGENT_ORDER.length : index;
  };
  return rank(a) - rank(b) || (Date.parse(String(a?.at || '')) || 0) - (Date.parse(String(b?.at || '')) || 0);
}

function pushCapped(lines, events) {
  const shown = events.slice(0, RELAY_EVENT_LIMITS.linesPerMessage);
  for (const event of shown) lines.push(formatRelayEventLine(event));
  if (events.length > shown.length) lines.push(`${RELAY_EVENT_LINE_PREFIX} … and ${events.length - shown.length} more`);
}

/**
 * The whole message for one wake-up: the lead line, then one line per event
 * (at most `linesPerMessage`, then a count of the rest). `digest` says the
 * hourly cap was reached and these were gathered over ten minutes; `ended`
 * lists one-shot subscriptions this message ends.
 *
 * What a paired relay kept while the link to it was down (`replayed`, and
 * the link_lost / link_restored lines) comes after the rest, one section per
 * relay: link_lost, a "Replayed:" line, the kept events with questions and
 * errors first, link_restored.
 */
export function buildRelayEventMessageText(events, { digest = false, ended = [] } = {}) {
  const list = (Array.isArray(events) ? events : []).filter(Boolean);
  const replayRelay = (event) => (isRemoteEvent(event) && (event.replayed === true || LINK_EVENT_TYPES.includes(toText(event.type))))
    ? toText(event.relay.id)
    : '';
  const plain = list.filter((event) => !replayRelay(event));
  const replays = new Map();
  for (const event of list) {
    const relayId = replayRelay(event);
    if (!relayId) continue;
    if (!replays.has(relayId)) replays.set(relayId, []);
    replays.get(relayId).push(event);
  }
  const lines = [RELAY_EVENT_LEAD];
  if (digest && plain.length) {
    lines.push(`Digest of ${plain.length} event${plain.length === 1 ? '' : 's'} (the limit of ${RELAY_EVENT_LIMITS.wakesPerHour} wake-ups an hour is reached; until it frees up, events come every ${Math.round(RELAY_EVENT_LIMITS.digestIntervalMs / 60_000)} min):`);
  }
  pushCapped(lines, plain);
  for (const group of replays.values()) {
    const lost = group.filter((event) => event.type === RELAY_EVENT_LINK_LOST_TYPE);
    const restored = group.filter((event) => event.type === RELAY_EVENT_LINK_RESTORED_TYPE);
    const kept = group.filter((event) => !LINK_EVENT_TYPES.includes(toText(event.type))).sort(replayOrder);
    for (const event of lost) lines.push(formatRelayEventLine(event));
    if (kept.length) {
      lines.push(`Replayed: ${kept.length} event${kept.length === 1 ? '' : 's'} relay ${quote(relayDisplayName(group[0]), 60)} kept while the link was down, questions and errors first:`);
      pushCapped(lines, kept);
    }
    for (const event of restored) lines.push(formatRelayEventLine(event));
  }
  const endedIds = (Array.isArray(ended) ? ended : []).map((id) => oneLine(id, 80)).filter(Boolean);
  if (endedIds.length) {
    lines.push(`${RELAY_EVENT_LINE_PREFIX} one-shot subscription${endedIds.length === 1 ? '' : 's'} ${endedIds.join(', ')} ended with this event.`);
  }
  return lines.join('\n');
}

// An event line: the prefix, a paired relay's name, the session, the type.
export const RELAY_EVENT_LINE_PATTERN = /^\[relay event\] (?:[^"·\n]{1,60} · )?(?:session "(?:[^"]*)" \([^)]*\)(?: on relay "[^"]*")?: )?([a-z_]+)/;
const DIGEST_LINE_PATTERN = /^Digest of \d+ events?/;
const REPLAYED_LINE_PATTERN = /^Replayed: \d+ events?/;

/**
 * The browser's view of an event message: the event lines without the lead
 * and the summary the collapsed row shows (`3 events · question_asked,
 * turn_end`). Tolerates any text: a row whose text is not an event message
 * still renders, as one line.
 */
export function parseRelayEventMessageText(text) {
  const rows = String(text ?? '').split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const body = rows[0] === RELAY_EVENT_LEAD ? rows.slice(1) : rows;
  const digest = DIGEST_LINE_PATTERN.test(body[0] || '');
  const replayed = body.some((line) => REPLAYED_LINE_PATTERN.test(line));
  const lines = body.filter((line) => !DIGEST_LINE_PATTERN.test(line) && !REPLAYED_LINE_PATTERN.test(line));
  const types = [];
  let count = 0;
  for (const line of lines) {
    const match = RELAY_EVENT_LINE_PATTERN.exec(line);
    const type = match && isRelayEventType(match[1]) ? match[1] : '';
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
