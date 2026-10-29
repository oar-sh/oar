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
// SDK-free and side-effect free: imported by the server, the relay_tool
// contract and the browser (which renders the event rows).

import { RELAY_SCHEDULE_MESSAGE_KIND } from './relay-schedules.mjs';

export const RELAY_EVENT_VERSION = 1;

// `messages.kind` of the message the relay writes into the watcher's
// conversation. The browser renders such a row as an event, never as a
// message of the user's.
export const RELAY_EVENT_MESSAGE_KIND = 'relay-event';

export const RELAY_EVENT_TYPES = Object.freeze([
  'question_asked',
  // The owner answered or dismissed a question that does not block (relay_tool
  // `ask`). The asking session is always told, without a subscription; a
  // subscription that takes question_asked takes it too.
  'question_answered',
  'error',
  'turn_end',
  'task_started',
  'task_finished',
  'task_failed',
  'stalled',
  'all_idle',
  // The user settled a plan card (board) of the session: its action, and the
  // message it queued (none for exit_only).
  'board_settled',
]);

// Not one a subscription names in `events`: `heartbeat_minutes` turns it on.
export const RELAY_EVENT_HEARTBEAT_TYPE = 'heartbeat';
// Not subscribable either: every watcher with subscriptions on a paired relay
// gets them in the one row that replays what that relay kept while the link
// to it was down.
export const RELAY_EVENT_LINK_LOST_TYPE = 'link_lost';
export const RELAY_EVENT_LINK_RESTORED_TYPE = 'link_restored';
const LINK_EVENT_TYPES = Object.freeze([RELAY_EVENT_LINK_LOST_TYPE, RELAY_EVENT_LINK_RESTORED_TYPE]);
// An event of this relay, not of a session: its runtime started again. Only
// a subscription that names it gets it (never the default), and one that
// names nothing else needs no sessions.
export const RELAY_EVENT_RELAY_RESTARTED_TYPE = 'relay_restarted';
export const RELAY_EVENT_RELAY_LEVEL_TYPES = Object.freeze([RELAY_EVENT_RELAY_RESTARTED_TYPE]);
const ALL_EVENT_TYPES = Object.freeze([...RELAY_EVENT_TYPES, RELAY_EVENT_HEARTBEAT_TYPE, ...LINK_EVENT_TYPES, ...RELAY_EVENT_RELAY_LEVEL_TYPES]);

// Not an event of its own but a narrower task_finished a subscription can
// name: the end of a task other than a shell command (a sub-agent's). Its
// events are task_finished lines. A busy worker ends shell commands every
// minute or so, and each was a wake-up of the watcher, a model turn on its
// whole context; a failed one is still a task_failed.
export const RELAY_EVENT_SUBAGENT_FINISHED_TYPE = 'subagent_finished';

// Not named in `events`: question_asked takes it (relayEventTypesTake).
export const RELAY_EVENT_QUESTION_ANSWERED_TYPE = 'question_answered';
const NAMED_EVENT_TYPES = RELAY_EVENT_TYPES.filter((type) => type !== RELAY_EVENT_QUESTION_ANSWERED_TYPE);

// What `events` may name: the event types, the narrower subagent_finished
// and the relay's own relay_restarted.
export const RELAY_EVENT_SUBSCRIBABLE_TYPES = Object.freeze([
  ...NAMED_EVENT_TYPES.slice(0, NAMED_EVENT_TYPES.indexOf('task_finished') + 1),
  RELAY_EVENT_SUBAGENT_FINISHED_TYPE,
  ...NAMED_EVENT_TYPES.slice(NAMED_EVENT_TYPES.indexOf('task_finished') + 1),
  ...RELAY_EVENT_RELAY_LEVEL_TYPES,
]);

// What a subscription gets when it names no events: everything but the
// start of a task, and of the task ends that went well only a sub-agent's
// (subagent_finished, not task_finished): the start of a task and every
// shell command's end a watcher asks for explicitly. relay_restarted is
// never a default: a wake-up after each restart is asked for by name.
export const RELAY_EVENT_DEFAULT_TYPES = Object.freeze(RELAY_EVENT_SUBSCRIBABLE_TYPES
  .filter((type) => type !== 'task_started' && type !== 'task_finished' && !RELAY_EVENT_RELAY_LEVEL_TYPES.includes(type)));

/** Whether `events` names relay-level events only (then no sessions are needed). */
export function isRelayLevelOnly(types) {
  const list = (Array.isArray(types) ? types : []).map(toText).filter(Boolean);
  return list.length > 0 && list.every((type) => RELAY_EVENT_RELAY_LEVEL_TYPES.includes(type));
}

// The default before subagent_finished: every type of then but task_started.
// A subscription made without events stored exactly this list. Written out:
// a type added since (question_answered) is not part of it.
export const RELAY_EVENT_LEGACY_DEFAULT_TYPES = Object.freeze([
  'question_asked',
  'error',
  'turn_end',
  'task_finished',
  'task_failed',
  'stalled',
  'all_idle',
]);

// The default from subagent_finished until board_settled (0.9.19): a
// subscription made without events then stored exactly this list, and takes
// today's default as well. Unlike the older one, a watcher who names exactly
// this list now gets it read as the default too (board_settled added): there
// is no type to add beside it that changes nothing.
export const RELAY_EVENT_PRE_BOARD_DEFAULT_TYPES = Object.freeze([
  'question_asked',
  'error',
  'turn_end',
  'subagent_finished',
  'task_failed',
  'stalled',
  'all_idle',
]);

function sameTypeSet(types, reference) {
  const unique = new Set((Array.isArray(types) ? types : []).map(toText).filter(Boolean));
  return unique.size === reference.length && reference.every((type) => unique.has(type));
}

/**
 * The events a stored subscription takes. A list that is exactly the old
 * default (any order, no more, no less) was the default, not a choice, and
 * means today's; any other list is what the watcher named and stays. Read,
 * never written back: applying it twice changes nothing, and the stored row
 * is as it was should an older relay read it again.
 */
export function effectiveRelayEventTypes(types) {
  const list = Array.isArray(types) ? types.map(toText).filter(Boolean) : [];
  return isLegacyDefaultRelayEventTypes(list) || sameTypeSet(list, RELAY_EVENT_PRE_BOARD_DEFAULT_TYPES)
    ? [...RELAY_EVENT_DEFAULT_TYPES]
    : list;
}

/** Whether a list is exactly the old default as a set (any order, repeats ignored). */
export function isLegacyDefaultRelayEventTypes(types) {
  return sameTypeSet(types, RELAY_EVENT_LEGACY_DEFAULT_TYPES);
}

/**
 * Whether a subscription's `events` take this event: its type named, a
 * question_answered under question_asked (the answer to a question it was
 * told of), or a task_finished of anything but a shell command under
 * subagent_finished.
 */
export function relayEventTypesTake(types, event) {
  const list = Array.isArray(types) ? types : [];
  const type = toText(event?.type);
  if (list.includes(type)) return true;
  if (type === RELAY_EVENT_QUESTION_ANSWERED_TYPE) return list.includes('question_asked');
  return type === 'task_finished'
    && list.includes(RELAY_EVENT_SUBAGENT_FINISHED_TYPE)
    && toText(event?.detail?.kind) !== 'shell';
}

// Never held back: not by the 30 s coalescing, not by the digest past the
// hourly cap (they still count toward it). An answer is a decision the
// asking session may be waiting for.
export const RELAY_EVENT_URGENT_TYPES = Object.freeze(['question_asked', 'question_answered', 'error']);

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
  // Per subscription: a digest of its non-urgent events every N minutes,
  // and the session ids an "all" subscription leaves out.
  digestMinutesMin: 1,
  digestMinutesMax: 24 * 60,
  excludeMax: 50,
  matchMaxChars: 200,
  sessionsMax: 50,
  activeSubscriptionsPerWatcher: 20,
  previewChars: 300,
  questionChars: 500,
  answerChars: 2000,
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

// The relay's own automated messages that reach a worker as a turn: event
// messages and scheduled prompts (shared/relay-schedules.mjs). The dequeue
// payload names their kind, and the workers push them without the steer note.
export const RELAY_AUTOMATED_MESSAGE_KINDS = Object.freeze([RELAY_EVENT_MESSAGE_KIND, RELAY_SCHEDULE_MESSAGE_KIND]);

export function isRelayAutomatedMessageKind(kind) {
  return RELAY_AUTOMATED_MESSAGE_KINDS.includes(toText(kind));
}

/** Whether a delivered queue message is one of the relay's automated messages (isRelayEventDelivery's wider sibling). */
export function isRelayAutomatedDelivery(pending) {
  return isRelayAutomatedMessageKind(pending?.messageKind);
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

// ─── Quiet hours ─────────────────────────────────────────────────────────────
//
// A subscription's `quiet_hours` is `{ from: "23:00", to: "06:00", tz }`: a
// window of local wall-clock time in an IANA time zone, which may cross
// midnight. Non-urgent events that fall in it are held until it ends.

const CLOCK_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight of "HH:MM" (or "H:MM"), or null. */
export function relayEventClockMinutes(value) {
  const match = CLOCK_PATTERN.exec(toText(value));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockText(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The canonical name of an IANA time zone this runtime knows, or ''. */
export function canonicalRelayEventTimeZone(value) {
  const tz = toText(value);
  if (!tz || tz.length > 64) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * A `quiet_hours` value checked: `{ ok: true, value }` with `{ from, to, tz }`
 * as "HH:MM" and the zone's canonical name, `{ ok: true, value: null }` when
 * there is none, `{ ok: false, error }` otherwise. Takes the object or its
 * JSON text.
 */
export function normalizeRelayEventQuietHours(input) {
  if (input === undefined || input === null || input === false || (typeof input === 'string' && !input.trim())) return { ok: true, value: null };
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: 'quiet_hours must be an object: {"from":"23:00","to":"06:00","tz":"Europe/Berlin"}' };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'quiet_hours must be an object: {"from":"23:00","to":"06:00","tz":"Europe/Berlin"}' };
  }
  // Some providers send every property of the schema, an unused one empty.
  if (['from', 'to', 'tz'].every((key) => !toText(value[key]))) return { ok: true, value: null };
  const from = relayEventClockMinutes(value.from);
  const to = relayEventClockMinutes(value.to);
  if (from === null || to === null) return { ok: false, error: 'quiet_hours from and to must be times of day as "HH:MM" (00:00 to 23:59)' };
  if (from === to) return { ok: false, error: 'quiet_hours from and to must differ' };
  if (!toText(value.tz)) return { ok: false, error: 'quiet_hours needs tz, an IANA time zone such as "Europe/Berlin"' };
  const tz = canonicalRelayEventTimeZone(value.tz);
  if (!tz) return { ok: false, error: `quiet_hours tz "${oneLine(value.tz, 64)}" is not an IANA time zone (for example "Europe/Berlin", "America/New_York", "UTC")` };
  return { ok: true, value: { from: clockText(from), to: clockText(to), tz } };
}

/** "23:00–06:00 Europe/Berlin" */
export function relayEventQuietHoursText(quiet) {
  return `${oneLine(quiet?.from, 5)}–${oneLine(quiet?.to, 5)} ${oneLine(quiet?.tz, 64)}`.trim();
}

const DAY_MS = 24 * 60 * 60_000;

function minuteFloor(ms) {
  return Math.floor(ms / 60_000) * 60_000;
}

const zoneFormatters = new Map();

function zoneFormatter(tz) {
  let formatter = zoneFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    zoneFormatters.set(tz, formatter);
  }
  return formatter;
}

/** The wall clock in `tz` at instant `ms`, as the UTC timestamp of the same digits. */
function wallClock(ms, tz) {
  const parts = {};
  for (const part of zoneFormatter(tz).formatToParts(new Date(ms))) parts[part.type] = Number(part.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, (parts.hour || 0) % 24, parts.minute || 0);
}

function insideWindow(minute, from, to) {
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

function wallMinute(wall) {
  const date = new Date(wall);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/**
 * When the quiet window that instant `ms` falls in ends (epoch ms), or null
 * when `ms` is outside it (or the value is not a valid window). The clock
 * changes: where the clocks go back and `to` comes twice, the window ends
 * the first time and is not entered again in the repeated hour; where `to`
 * falls in the hour the clocks skip, it ends the moment they jump. A known
 * limit: a `from` inside the repeated hour starts the window on the first
 * pass, and on the second pass the minutes before `from` read as outside.
 */
export function relayEventQuietWindowEnd(quiet, ms) {
  const from = relayEventClockMinutes(quiet?.from);
  const to = relayEventClockMinutes(quiet?.to);
  const tz = canonicalRelayEventTimeZone(quiet?.tz);
  if (from === null || to === null || from === to || !tz || !Number.isFinite(ms)) return null;
  const wall = wallClock(ms, tz);
  const minute = wallMinute(wall);
  if (!insideWindow(minute, from, to)) return null;
  const day = Date.UTC(new Date(wall).getUTCFullYear(), new Date(wall).getUTCMonth(), new Date(wall).getUTCDate());
  // Past midnight's side of a window that crosses it ends today, else tomorrow.
  const target = day + (from > to && minute >= from ? DAY_MS : 0) + to * 60_000;
  // The instants whose local time reads `target`, under the offsets in force
  // around it; the earliest is the end. Already past it, `ms` is in the
  // repeated hour after the window ended: outside.
  const offsets = new Set([-DAY_MS, 0, DAY_MS].map((shift) => wallClock(target + shift, tz) - minuteFloor(target + shift)));
  const ends = [...offsets]
    .map((offset) => target - offset)
    .filter((instant) => wallClock(instant, tz) === target)
    .sort((a, b) => a - b);
  if (ends.length) return ends[0] > ms ? ends[0] : null;
  // `to` does not exist that day (the clocks skip it): the first minute
  // outside the window.
  for (let instant = minuteFloor(ms) + 60_000; instant <= ms + 2 * DAY_MS; instant += 60_000) {
    if (!insideWindow(wallMinute(wallClock(instant, tz)), from, to)) return instant;
  }
  return null;
}

/** The text a `match` is tried on, or null when the event has none. */
export function relayEventMatchText(event) {
  const detail = event?.detail || {};
  if (event?.type === 'turn_end') return String(detail.replyText ?? detail.preview ?? '');
  if (event?.type === 'task_finished' || event?.type === 'task_failed') {
    return [detail.description, detail.summary].map(toText).filter(Boolean).join('\n');
  }
  if (event?.type === 'board_settled') {
    return [detail.action, detail.actionLabel, detail.title].map(toText).filter(Boolean).join('\n');
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

/** `2026-10-20 14:05 UTC`, or '' for a time that does not parse. */
function utcMinute(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

// The end of a relay_restarted line: what the agent should do, and the loop
// guard said up front (services/relay-event-service.mjs noteRelayStarted).
export const RELAY_RESTARTED_ADVICE = 'Timers and jobs your CLI scheduled before may be gone: check what you were waiting for and carry on. '
  + 'A restart requested while this turn runs does not wake you again.';

function relayRestartedLine(prefix, detail) {
  const startedAt = utcMinute(detail.startedAt);
  const stoppedAt = utcMinute(detail.stoppedAt);
  const requestedAt = utcMinute(detail.requestedAt);
  const since = `${prefix}${RELAY_EVENT_RELAY_RESTARTED_TYPE}: the relay runs again${startedAt ? ` since ${startedAt}` : ''}`;
  if (detail.stop !== 'requested' && detail.stop !== 'stopped') {
    // No record: a crash, a forced stop (on Windows a supervisor's stop ends
    // the process without its signal handler) or a reboot.
    return `${since}; the relay did not record how it stopped (for example a crash, a forced stop or a reboot). ${RELAY_RESTARTED_ADVICE}`;
  }
  let how;
  if (detail.stop === 'requested') {
    const action = oneLine(detail.action, 20) === 'shutdown' ? 'shutdown' : 'restart';
    const by = oneLine(detail.requestedBy, 80);
    const reason = oneLine(detail.reason, 140);
    how = `after a ${action} requested${by ? ` by ${quote(by, 80)}` : ''}${requestedAt ? ` at ${requestedAt}` : ''}`
      + `${reason ? ` (reason ${quote(reason, 140)})` : ''}`;
  } else {
    const reason = oneLine(detail.reason, 140);
    how = `after it was stopped${reason ? ` (${reason.replace(/[()]/g, '')})` : ''}${stoppedAt ? ` at ${stoppedAt}` : ''}`;
  }
  return `${since}, ${how}. ${RELAY_RESTARTED_ADVICE}`;
}

/** One line of the event message, the watcher's to read. */
export function formatRelayEventLine(event) {
  const type = oneLine(event?.type, 40);
  const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  const prefix = linePrefix(event);
  if (type === RELAY_EVENT_RELAY_RESTARTED_TYPE) return relayRestartedLine(prefix, detail);
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
      if (detail.kind === 'ask') parts.push('(asked with ask: it does not block that session)');
      return parts.join(' ');
    }
    case 'question_answered': {
      const id = oneLine(detail.questionId, 80);
      const parts = [`${head}${id ? ` (question_id ${id})` : ''} ${quote(detail.prompt, RELAY_EVENT_LIMITS.questionChars)}`];
      if (detail.dismissed === true) {
        parts.push('→ the user dismissed it without an answer; decide yourself or ask again later');
      } else {
        const choice = oneLine(detail.choice, 120);
        const answer = oneLine(detail.answer, RELAY_EVENT_LIMITS.answerChars);
        parts.push(`→ the user answered ${quote(answer || choice, RELAY_EVENT_LIMITS.answerChars)}`);
        if (choice && choice !== answer) parts.push(`(option [${choice}])`);
      }
      // The relay whose UI it came from: the one the ask is kept on, or a
      // paired relay's Inbox.
      const via = oneLine(detail.via, 60);
      if (via) parts.push(`(via relay ${quote(via, 60)})`);
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
    case 'board_settled': {
      const action = oneLine(detail.action, 80);
      const label = oneLine(detail.actionLabel, 120) || action || 'settled';
      const ids = [action ? `action ${action}` : '', oneLine(detail.boardId, 80) ? `board_id ${oneLine(detail.boardId, 80)}` : ''].filter(Boolean);
      // exit_only queues nothing: the session stops there.
      ids.push(oneLine(detail.queuedMessageId, 80) ? `queued message ${oneLine(detail.queuedMessageId, 80)}` : 'nothing queued');
      return `${head} ${quote(detail.title || 'plan card', 200)} → ${quote(label, 120)} (${ids.join(', ')})`;
    }
    default:
      return head;
  }
}

const URGENT_ORDER = ['question_asked', 'question_answered', 'error'];

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

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * The lines in front of the events: one "Digest of" line for the hourly
 * cap's digest (`digest`) and a subscription's digest together, and one for
 * events quiet hours held. An event's `held` is `{ reason: 'quiet', from,
 * to, tz }` or `{ reason: 'digest', minutes, subscriptionId }`, set when it
 * is delivered. A subscription's digest of a single event reads as that
 * event, without a line of its own.
 */
function headerLines(events, { digest = false, all = events } = {}) {
  const lines = [];
  // The cap's digest is of this relay's events and live ones; what the
  // options held, replayed events included, is counted from all.
  const capped = digest && events.length > 0;
  const gathered = all.filter((event) => event?.held?.reason === 'digest');
  const parts = [];
  if (capped) {
    parts.push(`the limit of ${RELAY_EVENT_LIMITS.wakesPerHour} wake-ups an hour is reached; until it frees up, events come every ${Math.round(RELAY_EVENT_LIMITS.digestIntervalMs / 60_000)} min`);
  }
  if (gathered.length > 1 || (capped && gathered.length)) {
    parts.push(distinct(gathered.map((event) => {
      const minutes = Number(event.held.minutes) || 0;
      const id = oneLine(event.held.subscriptionId, 80);
      return `${id ? `subscription ${id}` : 'a subscription'} every ${minutes} min`;
    })).join(', '));
    parts.push('questions and errors come at once');
  }
  if (parts.length) {
    const count = capped ? events.length : gathered.length;
    lines.push(`Digest of ${count} event${count === 1 ? '' : 's'} (${parts.join('; ')}):`);
  }
  const quiet = all.filter((event) => event?.held?.reason === 'quiet');
  if (quiet.length) {
    const windows = distinct(quiet.map((event) => relayEventQuietHoursText(event.held)));
    lines.push(`Held during quiet hours (${windows.join(', ')}): ${quiet.length} event${quiet.length === 1 ? '' : 's'}, delivered now that the window has ended; questions and errors came at once.`);
  }
  return lines;
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
  const lines = [RELAY_EVENT_LEAD, ...headerLines(plain, { digest, all: list })];
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
    for (const event of restored) {
      // Kept events a subscription's digest or quiet hours hold come later.
      const held = (Number(event?.detail?.kept) || 0) - kept.length;
      lines.push(formatRelayEventLine(event)
        + (held > 0 ? `; ${held} of them ${held === 1 ? 'is' : 'are'} held by your subscription's digest or quiet hours and come${held === 1 ? 's' : ''} later` : ''));
    }
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
const QUIET_LINE_PATTERN = /^Held during quiet hours/;
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
  const digest = body.some((line) => DIGEST_LINE_PATTERN.test(line));
  const quiet = body.some((line) => QUIET_LINE_PATTERN.test(line));
  const replayed = body.some((line) => REPLAYED_LINE_PATTERN.test(line));
  const lines = body.filter((line) => !DIGEST_LINE_PATTERN.test(line) && !QUIET_LINE_PATTERN.test(line) && !REPLAYED_LINE_PATTERN.test(line));
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
  return { lines, types, count: count || lines.length, digest, quiet, replayed };
}
