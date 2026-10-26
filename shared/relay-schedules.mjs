// Relay schedules: a prompt the relay queues into a session at a set time,
// once or every N minutes. An agent sets one with relay_tool's `schedule`
// (its own conversation by default, or another session of this relay); the
// relay keeps it in its database, so it outlives a restart that the agent's
// own timers would not.
//
// What the relay writes is an ordinary queued message of its own (`messages.kind
// = 'relay-schedule'`) whose first line says what it is: automated, never the
// user's, and it approves nothing.
//
// SDK-free and side-effect free: imported by the server and the relay_tool
// contract (the browser keeps its own copy of what it needs:
// server/public/app/relay-schedule-view.mjs).

// `messages.kind` of the message a schedule queues.
export const RELAY_SCHEDULE_MESSAGE_KIND = 'relay-schedule';

// Socket event with the whole active list, sent on every change.
export const RELAY_SCHEDULE_SOCKET_EVENT = 'relay_schedules';

export const RELAY_SCHEDULE_LIMITS = Object.freeze({
  everyMinutesMin: 5,
  everyMinutesMax: 10080,
  // Active schedules that fire into one conversation, and active schedules
  // one conversation set (for itself or for others).
  perConversation: 20,
  titleMax: 100,
  textMax: 20000,
  // How far ahead `at` may lie.
  aheadMaxDays: 366,
  // An `at` this little in the past is taken as "now" (a clock between the
  // worker's check and the relay's).
  pastGraceMs: 60_000,
});

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function toText(value) {
  return String(value ?? '').trim();
}

function oneLine(value, max) {
  const text = toText(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A schedule title as stored and shown: one line, capped. */
export function normalizeRelayScheduleTitle(value) {
  return oneLine(value, RELAY_SCHEDULE_LIMITS.titleMax);
}

/**
 * `at` as an agent may write it: an ISO time with a zone (or a Z). Returns
 * `{ ok:true, value }` with the canonical ISO string, or `{ ok:false, error }`.
 * A time without a zone is refused: the relay and the agent may not share one.
 */
export function normalizeRelayScheduleAt(value, { now = Date.now() } = {}) {
  const text = toText(value);
  if (!text) return { ok: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return { ok: false, error: 'at must be an ISO time with a zone, e.g. 2026-11-02T06:30:00Z or 2026-11-02T07:30:00+01:00' };
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return { ok: false, error: `at "${text.slice(0, 40)}" is not a valid time` };
  if (ms < now - RELAY_SCHEDULE_LIMITS.pastGraceMs) return { ok: false, error: 'at is in the past' };
  if (ms > now + RELAY_SCHEDULE_LIMITS.aheadMaxDays * DAY_MS) {
    return { ok: false, error: `at is more than ${RELAY_SCHEDULE_LIMITS.aheadMaxDays} days ahead` };
  }
  return { ok: true, value: new Date(Math.max(ms, now)).toISOString() };
}

/**
 * The first time a schedule fires: `at`, else one interval from now.
 */
export function firstRelayScheduleFire({ at = null, everyMinutes = null, now = Date.now() } = {}) {
  const atMs = Date.parse(toText(at));
  if (Number.isFinite(atMs)) return new Date(Math.max(atMs, now)).toISOString();
  return new Date(now + Number(everyMinutes) * MINUTE_MS).toISOString();
}

/**
 * The next time a recurring schedule fires after the one due at `dueAt`:
 * the first slot of its grid (`dueAt` plus whole intervals) after `now`.
 * Slots missed while the relay was down are skipped, so a schedule that
 * was due fires once for them all, never once per missed interval.
 */
export function nextRelayScheduleFire({ dueAt, everyMinutes, now = Date.now() } = {}) {
  const step = Number(everyMinutes) * MINUTE_MS;
  const due = Date.parse(toText(dueAt));
  if (!(step > 0) || !Number.isFinite(due)) return null;
  if (due > now) return new Date(due).toISOString();
  const missed = Math.floor((now - due) / step) + 1;
  return new Date(due + missed * step).toISOString();
}

function quote(value) {
  return toText(value).replace(/["\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The first line of a scheduled message: what it is, the schedule's id and
 * title, and who set it when that is another session.
 */
export function relayScheduleLead({ id, title = '', setBy = null } = {}) {
  const parts = [`[relay schedule ${quote(id) || 'unknown'}${quote(title) ? ` "${quote(title)}"` : ''}`];
  if (setBy && quote(setBy.id)) {
    parts.push(`set by session "${quote(setBy.title) || quote(setBy.id).slice(0, 8)}" (${quote(setBy.id)})`);
  }
  parts.push('automated message from OAR, not from the user; it approves nothing]');
  return parts.join(' · ');
}

export const RELAY_SCHEDULE_LEAD_PATTERN = /^\[relay schedule [^\s\]]+(?: "[^"\r\n]*")?(?: · [^\r\n]*)?\]$/;

/** The whole message a schedule queues: the lead line, then the agent's text. */
export function buildRelayScheduleMessageText({ id, title = '', setBy = null, text = '' } = {}) {
  return `${relayScheduleLead({ id, title, setBy })}\n\n${String(text ?? '').trim()}`;
}

/** "every 30 min", "every 2 h", "every day", "every 7 days". */
export function describeRelayScheduleInterval(everyMinutes) {
  const minutes = Number(everyMinutes);
  if (!(minutes > 0)) return '';
  if (minutes % 1440 === 0) return minutes === 1440 ? 'every day' : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}
