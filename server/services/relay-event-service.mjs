'use strict';

/**
 * Relay event subscriptions: a session (the watcher) asks to be told what
 * happens in other sessions of this relay, and the relay tells it by writing
 * a short event message into the watcher's conversation.
 *
 * Delivery is an ordinary queued message of the relay's (`messages.kind =
 * 'relay-event'`, a pending queue row), so the worker decides what it
 * becomes: a new turn when the watcher is idle, a steer into the running turn
 * where the provider steers (Claude, Copilot SDK), the next turn where it
 * cannot (Cursor, Grok, Claude Cloud, the Copilot extension). Events that
 * arrive while the watcher's event row is still pending are written into
 * that row, so a busy watcher gets one follow-up, never one per batch.
 *
 * Cost: events within 30 s are one wake-up; past 20 wake-ups an hour (the
 * event messages of the last hour that carried more than a heartbeat) the
 * rest comes as a digest every ten minutes. question_asked and error go out
 * at once and count; a heartbeat is coalesced like any event, never held
 * for the digest and never counted.
 *
 * A subscription with `heartbeat_minutes` gets a heartbeat event at that
 * interval while its watched set has a turn or task running, none while it
 * is idle: the watcher's sign that its watching still works.
 *
 * `transferSubscriptions` moves every subscription of one watcher, with its
 * undelivered events, to another: a watcher is replaced without a moment
 * where events go nowhere.
 *
 * Subscriptions and undelivered events live in the database
 * (migrations/0011-relay-event-subscriptions.mjs); timers are rebuilt at
 * boot. A subscription ends on unsubscribe, when its watcher is archived or
 * deleted, when its last listed session is, or after firing (`once`).
 *
 * Across paired relays (migrations/0012-cross-relay-event-subscriptions.mjs)
 * this service plays both sides:
 *
 * - Watched ("served"): a paired relay's agent subscribes here through
 *   subscribeServed. The row is an ordinary subscription whose watcher is
 *   the key `remote:<that relay's id>`, which names no conversation: its
 *   events are recorded like any, never written into a conversation, and
 *   wait until that relay fetches them (pullServed), at most
 *   remoteKeepEvents per subscription and remoteKeepDays old.
 * - Watching ("mirror"): a row with `relay_id` = the paired relay's registry
 *   id and `remote_subscription_id` = its id there. Mirrors record nothing
 *   and are skipped by the sweeps; applyRemotePull writes what the link
 *   service fetched into the watcher's undelivered events, from where it is
 *   delivered like the events of this relay's sessions.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import {
  RELAY_EVENT_DEFAULT_TYPES,
  RELAY_EVENT_HEARTBEAT_TYPE,
  RELAY_EVENT_LIMITS,
  RELAY_EVENT_LINK_LOST_TYPE,
  RELAY_EVENT_LINK_RESTORED_TYPE,
  RELAY_EVENT_MESSAGE_KIND,
  RELAY_EVENT_TYPES,
  RELAY_EVENT_VERSION,
  buildRelayEventMessageText,
  compileRelayEventMatch,
  isRelayEventType,
  isUrgentRelayEventType,
  relayEventMatchText,
} from '../../shared/relay-events.mjs';

export const RELAY_EVENT_SUBSCRIPTIONS_SOCKET_EVENT = 'relay_event_subscriptions';
export const RELAY_EVENT_SELF_RELAY_ID = 'self';
// The watcher key of a paired relay's subscriptions here: never a
// conversation id, so nothing a paired relay asks for is ever written into
// one of this relay's conversations.
export const RELAY_EVENT_SERVED_WATCHER_PREFIX = 'remote:';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const SWEEP_INTERVAL_MS = 30_000;
// Delivered events are read for wake counting (the last hour) and to rebuild
// a still-pending event row's text; past this they are of no use and go.
export const RELAY_EVENT_DELIVERED_KEEP_MS = 2 * HOUR_MS;
// An ended subscription is listed for an hour and, for a paired relay, its
// end is sent for remoteKeepDays; past that it is history nobody reads.
export const RELAY_EVENT_ENDED_SUBSCRIPTION_KEEP_MS = RELAY_EVENT_LIMITS.remoteKeepDays * DAY_MS;
const PRUNE_INTERVAL_MS = 10 * 60_000;

// Retention of what paired relays have not fetched. A served event is never
// marked delivered (its fetch deletes it), and `delivered_at IS NULL` is the
// partial index's condition: without it SQLite scanned the whole table on
// every sweep. The watcher range is the served keys ('remote:' up to the
// next character); LIKE could not use the index.
const SERVED_RANGE = `watcher_conversation_id >= 'remote:' AND watcher_conversation_id < 'remote;' AND delivered_at IS NULL`;
export const RELAY_EVENT_SERVED_RETENTION_SQL = Object.freeze({
  listServedOverfull: `
    SELECT subscription_id, COUNT(*) AS n FROM relay_events
    WHERE ${SERVED_RANGE} GROUP BY subscription_id HAVING n > ?
  `,
  // Oldest first, questions and errors last.
  deleteServedOldest: `
    DELETE FROM relay_events WHERE id IN (
      SELECT id FROM relay_events WHERE ${SERVED_RANGE} AND subscription_id = ?
      ORDER BY urgent ASC, id ASC LIMIT ?
    )
  `,
  countServedExpired: `
    SELECT subscription_id, COUNT(*) AS n FROM relay_events
    WHERE ${SERVED_RANGE} AND created_at < ? GROUP BY subscription_id
  `,
  deleteServedExpired: `DELETE FROM relay_events WHERE ${SERVED_RANGE} AND created_at < ?`,
});
// Delivered events past their keep, unless their event row is still pending
// (its text is rebuilt from them when more events are appended).
export const RELAY_EVENT_PRUNE_SQL = Object.freeze({
  deleteDeliveredBefore: `
    DELETE FROM relay_events
    WHERE delivered_at IS NOT NULL AND delivered_at < ?
      AND NOT EXISTS (SELECT 1 FROM queue WHERE queue.id = relay_events.message_id AND queue.status IN ('pending', 'parked'))
  `,
  // An ended mirror whose end the paired relay has not confirmed waits.
  deleteEndedSubscriptionsBefore: `
    DELETE FROM relay_event_subscriptions WHERE ended_at IS NOT NULL AND ended_at < ? AND remote_sync IS NULL
  `,
  deleteEndedSubscriptionsBeforeNoSync: `
    DELETE FROM relay_event_subscriptions WHERE ended_at IS NOT NULL AND ended_at < ?
  `,
});
// A watched set must look idle twice, this far apart, before all_idle fires:
// a task's end and the continuation turn it opens are seconds apart.
const ALL_IDLE_SETTLE_MS = 10_000;
const LOG_PREFIX = '[relay-events]';

function toText(value) {
  return String(value ?? '').trim();
}

function shortId(value) {
  return toText(value).slice(0, 8);
}

/** A paired relay's own id as it states it: kept to a safe, short shape. */
export function cleanSubscriberRelayId(value) {
  const text = toText(value);
  return /^[A-Za-z0-9._:-]{1,100}$/.test(text) ? text : '';
}

export function servedWatcherKey(subscriberRelayId) {
  return `${RELAY_EVENT_SERVED_WATCHER_PREFIX}${subscriberRelayId}`;
}

function isServedKey(watcher) {
  return toText(watcher).startsWith(RELAY_EVENT_SERVED_WATCHER_PREFIX);
}

/** A subscription of this relay's watcher on a paired relay's sessions. */
function isMirror(row) {
  return !!row && !!toText(row.remote_subscription_id) && toText(row.relay_id) !== RELAY_EVENT_SELF_RELAY_ID;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export class RelayEventError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function createRelayEventService({
  db,
  stmts,
  tracker = null,
  emit = () => {},
  wakeWatcher = () => {},
  relayName = () => '',
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  logger = console,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  // A mirror changed in a way the paired relay must learn (an end, a new
  // watcher): the link service fetches from that relay now.
  onRemoteChange = () => {},
} = {}) {
  if (!db) throw new Error('db is required');
  if (!stmts) throw new Error('stmts is required');

  const tableExists = (name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  const available = tableExists('relay_event_subscriptions') && tableExists('relay_events');
  // Migration 0012: without it subscriptions keep to this relay's sessions.
  const crossAvailable = available && tableExists('relay_event_links') && db
    .prepare(`PRAGMA table_info(relay_event_subscriptions)`).all().some((column) => column.name === 'subscriber_relay_id');

  const sql = available ? {
    insertSubscription: db.prepare(`
      INSERT INTO relay_event_subscriptions
        (id, watcher_conversation_id, relay_id, scope, session_ids_json, events_json, once, match, stalled_minutes, heartbeat_minutes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getSubscription: db.prepare(`SELECT * FROM relay_event_subscriptions WHERE id = ?`),
    listActive: db.prepare(`SELECT * FROM relay_event_subscriptions WHERE ended_at IS NULL ORDER BY created_at ASC`),
    listForWatcher: db.prepare(`
      SELECT * FROM relay_event_subscriptions
      WHERE watcher_conversation_id = ? AND (ended_at IS NULL OR ended_at >= ?)
      ORDER BY created_at ASC
    `),
    endSubscription: db.prepare(`UPDATE relay_event_subscriptions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`),
    setSessions: db.prepare(`UPDATE relay_event_subscriptions SET session_ids_json = ? WHERE id = ? AND ended_at IS NULL`),
    markFired: db.prepare(`UPDATE relay_event_subscriptions SET fired_count = fired_count + 1, last_event_at = ? WHERE id = ?`),
    markHeartbeat: db.prepare(`UPDATE relay_event_subscriptions SET last_heartbeat_at = ? WHERE id = ?`),
    moveSubscriptions: db.prepare(`
      UPDATE relay_event_subscriptions SET watcher_conversation_id = ? WHERE watcher_conversation_id = ? AND ended_at IS NULL
    `),
    moveUndelivered: db.prepare(`
      UPDATE relay_events SET watcher_conversation_id = ? WHERE watcher_conversation_id = ? AND delivered_at IS NULL
    `),
    dropUndeliveredAbout: db.prepare(`
      DELETE FROM relay_events WHERE watcher_conversation_id = ? AND session_id = ? AND delivered_at IS NULL
    `),
    insertEvent: db.prepare(`
      INSERT INTO relay_events (subscription_id, watcher_conversation_id, relay_id, session_id, type, urgent, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listUndelivered: db.prepare(`
      SELECT * FROM relay_events WHERE watcher_conversation_id = ? AND delivered_at IS NULL ORDER BY id ASC
    `),
    listWatchersWithUndelivered: db.prepare(`
      SELECT DISTINCT watcher_conversation_id FROM relay_events WHERE delivered_at IS NULL
    `),
    listEventsOfMessage: db.prepare(`SELECT * FROM relay_events WHERE message_id = ? ORDER BY id ASC`),
    markDelivered: db.prepare(`UPDATE relay_events SET delivered_at = ?, message_id = ? WHERE id = ?`),
    dropUndelivered: db.prepare(`DELETE FROM relay_events WHERE watcher_conversation_id = ? AND delivered_at IS NULL`),
    // Wake-ups: the event messages that carried more than a heartbeat.
    countWakes: db.prepare(`
      SELECT COUNT(DISTINCT message_id) AS n FROM relay_events
      WHERE watcher_conversation_id = ? AND delivered_at > ? AND type <> ? AND message_id IS NOT NULL
    `),
    lastWake: db.prepare(`
      SELECT MAX(delivered_at) AS at FROM relay_events
      WHERE watcher_conversation_id = ? AND type <> ? AND delivered_at IS NOT NULL
    `),
    findPendingEventRow: db.prepare(`
      SELECT q.id, q.text FROM queue q JOIN messages m ON m.id = q.id
      WHERE q.conversation_id = ? AND q.status = 'pending' AND m.kind = ?
      ORDER BY q.timestamp DESC LIMIT 1
    `),
    updateQueueText: db.prepare(`UPDATE queue SET text = ? WHERE id = ? AND status = 'pending'`),
    updateMessageText: db.prepare(`UPDATE messages SET text = ? WHERE id = ?`),
    getMessageTimestamp: db.prepare(`SELECT timestamp FROM messages WHERE id = ?`),
    getConversation: db.prepare(`
      SELECT id, title, archived, status, preferred_relay_mode, preferred_reasoning_effort
      FROM conversations WHERE id = ?
    `),
    getQueueMessageKind: db.prepare(`SELECT kind FROM messages WHERE id = ?`),
    // A session waiting on a question is not stalled: question_asked said it.
    hasPendingQuestion: (() => {
      try {
        return db.prepare(`SELECT 1 AS found FROM relay_questions WHERE conversation_id = ? AND status = 'pending' LIMIT 1`);
      } catch {
        return null;
      }
    })(),
    // Sessions with a turn queued or running, for `all` subscriptions.
    listBusyConversations: db.prepare(`
      SELECT DISTINCT conversation_id FROM queue WHERE status IN ('pending', 'processing', 'parked')
    `),
    listRunningRunConversations: db.prepare(`
      SELECT DISTINCT conversation_id FROM subagent_runs WHERE status = 'running'
    `),
    // Turns other than ones answering relay events: a watcher woken by an
    // event is not "work" for another watcher's all_idle.
    countNonEventTurns: db.prepare(`
      SELECT COUNT(*) AS n FROM queue q LEFT JOIN messages m ON m.id = q.id
      WHERE q.conversation_id = ? AND q.status IN ('pending', 'processing', 'parked')
        AND COALESCE(m.kind, '') <> ?
    `),
    deleteDeliveredBefore: db.prepare(RELAY_EVENT_PRUNE_SQL.deleteDeliveredBefore),
  } : null;
  // Without migration 0012 the table has no remote_sync column.
  const deleteEndedSubscriptionsBefore = available
    ? db.prepare(crossAvailable ? RELAY_EVENT_PRUNE_SQL.deleteEndedSubscriptionsBefore : RELAY_EVENT_PRUNE_SQL.deleteEndedSubscriptionsBeforeNoSync)
    : null;

  const remoteSql = crossAvailable ? {
    insertServed: db.prepare(`
      INSERT INTO relay_event_subscriptions
        (id, watcher_conversation_id, relay_id, scope, session_ids_json, events_json, once, match, stalled_minutes, heartbeat_minutes, created_at,
         subscriber_relay_id, subscriber_relay_name, subscriber_watcher_id, subscriber_watcher_title, last_pull_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertMirror: db.prepare(`
      INSERT INTO relay_event_subscriptions
        (id, watcher_conversation_id, relay_id, scope, session_ids_json, events_json, once, match, stalled_minutes, heartbeat_minutes, created_at,
         remote_subscription_id, remote_meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listServed: db.prepare(`SELECT * FROM relay_event_subscriptions WHERE subscriber_relay_id = ?`),
    countServedActive: db.prepare(`SELECT COUNT(*) AS n FROM relay_event_subscriptions WHERE subscriber_relay_id = ? AND ended_at IS NULL`),
    countServedOfWatcher: db.prepare(`
      SELECT COUNT(*) AS n FROM relay_event_subscriptions WHERE subscriber_relay_id = ? AND subscriber_watcher_id = ? AND ended_at IS NULL
    `),
    touchServed: db.prepare(`UPDATE relay_event_subscriptions SET last_pull_at = ? WHERE subscriber_relay_id = ? AND ended_at IS NULL`),
    setServedWatcher: db.prepare(`UPDATE relay_event_subscriptions SET subscriber_watcher_id = ?, subscriber_watcher_title = ? WHERE id = ?`),
    takeDropped: db.prepare(`UPDATE relay_event_subscriptions SET dropped_count = 0 WHERE id = ?`),
    addDropped: db.prepare(`UPDATE relay_event_subscriptions SET dropped_count = dropped_count + ? WHERE id = ?`),
    deleteServedThrough: db.prepare(`DELETE FROM relay_events WHERE watcher_conversation_id = ? AND id <= ?`),
    listServedEvents: db.prepare(`SELECT * FROM relay_events WHERE watcher_conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?`),
    // Retention: what is past the bound, per subscription (the row's first).
    listServedOverfull: db.prepare(RELAY_EVENT_SERVED_RETENTION_SQL.listServedOverfull),
    deleteServedOldest: db.prepare(RELAY_EVENT_SERVED_RETENTION_SQL.deleteServedOldest),
    countServedExpired: db.prepare(RELAY_EVENT_SERVED_RETENTION_SQL.countServedExpired),
    deleteServedExpired: db.prepare(RELAY_EVENT_SERVED_RETENTION_SQL.deleteServedExpired),
    listServedStale: db.prepare(`
      SELECT id FROM relay_event_subscriptions
      WHERE subscriber_relay_id IS NOT NULL AND ended_at IS NULL AND COALESCE(last_pull_at, created_at) < ?
    `),
    // Mirrors of one paired relay: active ones, and ended ones whose end has
    // not reached it yet.
    listMirrorsOfRelay: db.prepare(`
      SELECT * FROM relay_event_subscriptions
      WHERE relay_id = ? AND remote_subscription_id IS NOT NULL AND (ended_at IS NULL OR remote_sync IS NOT NULL)
      ORDER BY created_at ASC
    `),
    listRelaysToPoll: db.prepare(`
      SELECT DISTINCT relay_id FROM relay_event_subscriptions
      WHERE remote_subscription_id IS NOT NULL AND (ended_at IS NULL OR remote_sync IS NOT NULL)
    `),
    setRemoteSync: db.prepare(`UPDATE relay_event_subscriptions SET remote_sync = ? WHERE id = ?`),
    setMirrorSessions: db.prepare(`UPDATE relay_event_subscriptions SET session_ids_json = ?, remote_meta_json = ? WHERE id = ?`),
    clearRelaySync: db.prepare(`UPDATE relay_event_subscriptions SET remote_sync = NULL WHERE relay_id = ? AND remote_subscription_id IS NOT NULL`),
    // An end the paired relay never confirmed: past remoteKeepDays it ended
    // the subscription itself (nobody fetched).
    clearStaleSync: db.prepare(`UPDATE relay_event_subscriptions SET remote_sync = NULL WHERE remote_sync IS NOT NULL AND ended_at < ?`),
    getLink: db.prepare(`SELECT * FROM relay_event_links WHERE relay_id = ?`),
    linkOk: db.prepare(`
      INSERT INTO relay_event_links (relay_id, cursor, last_ok_at) VALUES (?, ?, ?)
      ON CONFLICT(relay_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), last_ok_at = excluded.last_ok_at,
        first_fail_at = NULL, lost_at = NULL, last_error = NULL
    `),
    linkFailed: db.prepare(`
      INSERT INTO relay_event_links (relay_id, first_fail_at, last_error) VALUES (?, ?, ?)
      ON CONFLICT(relay_id) DO UPDATE SET first_fail_at = COALESCE(first_fail_at, excluded.first_fail_at), last_error = excluded.last_error
    `),
    linkLost: db.prepare(`UPDATE relay_event_links SET lost_at = ? WHERE relay_id = ? AND lost_at IS NULL`),
    deleteLink: db.prepare(`DELETE FROM relay_event_links WHERE relay_id = ?`),
    moveSubscriptionsOfRelay: db.prepare(`
      UPDATE relay_event_subscriptions SET watcher_conversation_id = ? WHERE watcher_conversation_id = ? AND ended_at IS NULL AND relay_id = ?
    `),
    moveUndeliveredOfRelay: db.prepare(`
      UPDATE relay_events SET watcher_conversation_id = ? WHERE watcher_conversation_id = ? AND delivered_at IS NULL AND relay_id = ?
    `),
  } : null;

  // watcher conversation id → { timer, dueAt }
  const flushTimers = new Map();
  // `${subscriptionId}:${sessionId}` → the activity time a stall was reported at
  const stallReported = new Map();
  // all_idle: subscription id → whether its watched set was busy at the last
  // look, and since when it has looked idle after being busy.
  const busyBySubscription = new Map();
  const idleSinceBySubscription = new Map();
  // heartbeat: subscription id → since when its watched set has been busy
  const busySinceBySubscription = new Map();
  let allIdleTimer = null;
  let sweepTimer = null;
  let started = false;
  let lastPruneAt = 0;

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function log(line) {
    try { logger?.log?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function warn(line) {
    try { logger?.warn?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function conversation(id) {
    const key = toText(id);
    if (!key) return null;
    try {
      return sql.getConversation.get(key) || null;
    } catch {
      return null;
    }
  }

  function isLive(row) {
    return !!row && Number(row.archived || 0) !== 1 && toText(row.status) !== 'deleted';
  }

  function shapeSubscription(row) {
    if (!row) return null;
    const scope = toText(row.scope) === 'all' ? 'all' : 'sessions';
    const sessionIds = scope === 'all' ? [] : parseJson(row.session_ids_json, []).map(toText).filter(Boolean);
    const mirror = isMirror(row);
    const meta = mirror ? parseJson(row.remote_meta_json, {}) : null;
    const remoteTitles = new Map((Array.isArray(meta?.sessions) ? meta.sessions : []).map((session) => [toText(session?.id), toText(session?.title) || null]));
    return {
      id: row.id,
      watcher: row.watcher_conversation_id,
      relay: toText(row.relay_id) || RELAY_EVENT_SELF_RELAY_ID,
      ...(mirror ? {
        relayName: toText(meta?.relayName) || null,
        remoteId: row.remote_subscription_id,
        ...(toText(row.remote_sync) ? { pendingSync: toText(row.remote_sync) } : {}),
      } : {}),
      ...(toText(row.subscriber_relay_id) ? {
        subscriber: {
          relayId: row.subscriber_relay_id,
          name: toText(row.subscriber_relay_name) || null,
          watcherId: toText(row.subscriber_watcher_id) || null,
          watcherTitle: toText(row.subscriber_watcher_title) || null,
        },
      } : {}),
      scope,
      sessions: scope === 'all'
        ? 'all'
        : sessionIds.map((id) => ({ id, title: mirror ? (remoteTitles.get(id) || null) : (toText(conversation(id)?.title) || null) })),
      events: parseJson(row.events_json, []).filter((type) => RELAY_EVENT_TYPES.includes(type)),
      once: Number(row.once || 0) === 1,
      ...(toText(row.match) ? { match: row.match } : {}),
      stalledMinutes: Number(row.stalled_minutes) || RELAY_EVENT_LIMITS.stalledMinutesDefault,
      ...(Number(row.heartbeat_minutes) > 0 ? { heartbeatMinutes: Number(row.heartbeat_minutes) } : {}),
      createdAt: row.created_at,
      ...(row.ended_at ? { endedAt: row.ended_at, endReason: row.end_reason || null } : {}),
      firedCount: Number(row.fired_count || 0),
      lastEventAt: row.last_event_at || null,
    };
  }

  function activeRows() {
    if (!available) return [];
    try {
      return sql.listActive.all();
    } catch {
      return [];
    }
  }

  function broadcast() {
    try {
      emit(RELAY_EVENT_SUBSCRIPTIONS_SOCKET_EVENT, { subscriptions: listActive() });
    } catch {}
  }

  function listActive() {
    return activeRows().map(shapeSubscription);
  }

  /** The subscriptions whose sessions live here: this relay's watchers' and paired relays'. */
  function localWatchRows() {
    return activeRows().filter((row) => !isMirror(row));
  }

  function checkWatcherCapacity(watcherConversationId, adding = 1) {
    const watcher = toText(watcherConversationId);
    const count = activeRows().filter((row) => row.watcher_conversation_id === watcher).length;
    if (count + adding > RELAY_EVENT_LIMITS.activeSubscriptionsPerWatcher) {
      throw new RelayEventError('limit', `This conversation already has ${count} subscriptions; unsubscribe one first.`);
    }
  }

  /** A watcher's subscriptions: the active ones and those that ended within the hour. */
  function listSubscriptions({ watcherConversationId, includeEndedSinceMs = HOUR_MS } = {}) {
    if (!available) return [];
    const since = new Date(now() - includeEndedSinceMs).toISOString();
    return sql.listForWatcher.all(toText(watcherConversationId), since).map(shapeSubscription);
  }

  // ─── Subscribe / unsubscribe ───────────────────────────────────────────────

  /**
   * What a subscribe asks for, checked: `{ all, ids, types, matchText,
   * stalled, heartbeat }`. Throws RelayEventError (`invalid`, `notFound`).
   * `exclude` is the watcher, never watched by itself.
   */
  function prepareSubscription({ scope, sessionIds, events, match, stalledMinutes, heartbeatMinutes, exclude = '' }) {
    const all = scope === 'all';
    const ids = all ? [] : [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map(toText).filter(Boolean))];
    if (!all && !ids.length) throw new RelayEventError('invalid', 'subscribe needs sessions (ids from list_sessions) or "all".');
    if (ids.length > RELAY_EVENT_LIMITS.sessionsMax) {
      throw new RelayEventError('invalid', `subscribe takes at most ${RELAY_EVENT_LIMITS.sessionsMax} sessions; use "all" for more.`);
    }
    if (exclude && ids.includes(exclude)) {
      throw new RelayEventError('ownSession', `Session ${exclude} is the conversation you are running in: it is never watched, events of your own turns would wake you up.`);
    }
    const missing = ids.filter((id) => !isLive(conversation(id)));
    if (missing.length) {
      throw new RelayEventError('notFound', `No live session with id ${missing.join(', ')} on this relay (archived sessions cannot be watched).`, { sessions: missing });
    }
    const types = Array.isArray(events) && events.length
      ? [...new Set(events.map(toText).filter((type) => RELAY_EVENT_TYPES.includes(type)))]
      : [...RELAY_EVENT_DEFAULT_TYPES];
    if (!types.length) throw new RelayEventError('invalid', `events must name some of: ${RELAY_EVENT_TYPES.join(', ')}`);
    const compiled = compileRelayEventMatch(match);
    if (!compiled.ok) throw new RelayEventError('invalid', compiled.error);
    const stalled = Number.isFinite(Number(stalledMinutes)) && stalledMinutes !== null && stalledMinutes !== ''
      ? Math.min(RELAY_EVENT_LIMITS.stalledMinutesMax, Math.max(RELAY_EVENT_LIMITS.stalledMinutesMin, Math.trunc(Number(stalledMinutes))))
      : RELAY_EVENT_LIMITS.stalledMinutesDefault;
    const heartbeat = heartbeatMinutes === null || heartbeatMinutes === undefined || heartbeatMinutes === ''
      ? null
      : Math.min(RELAY_EVENT_LIMITS.heartbeatMinutesMax, Math.max(RELAY_EVENT_LIMITS.heartbeatMinutesMin, Math.trunc(Number(heartbeatMinutes))));
    if (heartbeat !== null && !Number.isFinite(heartbeat)) throw new RelayEventError('invalid', 'heartbeat_minutes must be a number of minutes');
    return { all, ids, types, matchText: toText(match) ? String(match) : null, stalled, heartbeat };
  }

  /**
   * A new subscription of `watcherConversationId`. `sessionIds` lists the
   * watched sessions, or `scope: 'all'` watches every session of the relay,
   * later ones included. Throws RelayEventError (code `invalid`, `notFound`,
   * `ownSession`, `limit`, `unavailable`).
   */
  function subscribe({
    watcherConversationId,
    scope = 'sessions',
    sessionIds = [],
    events = null,
    once = false,
    match = '',
    stalledMinutes = null,
    heartbeatMinutes = null,
  } = {}) {
    if (!available) throw new RelayEventError('unavailable', 'Event subscriptions are not available on this relay right now (its storage is missing; see the server log).');
    const watcher = toText(watcherConversationId);
    if (!isLive(conversation(watcher))) throw new RelayEventError('notFound', 'The watching conversation was not found or is archived.');
    const prepared = prepareSubscription({ scope, sessionIds, events, match, stalledMinutes, heartbeatMinutes, exclude: watcher });
    const { all, ids, types } = prepared;
    checkWatcherCapacity(watcher);
    const id = `sub_${randomBytes(5).toString('hex')}`;
    const at = isoNow();
    sql.insertSubscription.run(
      id,
      watcher,
      RELAY_EVENT_SELF_RELAY_ID,
      all ? 'all' : 'sessions',
      all ? null : JSON.stringify(ids),
      JSON.stringify(types),
      once ? 1 : 0,
      prepared.matchText,
      prepared.stalled,
      prepared.heartbeat,
      at,
    );
    const subscription = shapeSubscription(sql.getSubscription.get(id));
    // The watched set starts from what it is doing now: all_idle fires when
    // work that is running now (or starts later) has ended.
    noteBusy(sql.getSubscription.get(id));
    log(`conv=${shortId(watcher)} subscribed ${id} to ${all ? 'all sessions' : `${ids.length} session${ids.length === 1 ? '' : 's'}`} (${types.join(',')})${once ? ' once' : ''}`);
    broadcast();
    return subscription;
  }

  function endSubscription(id, reason) {
    const changed = sql.endSubscription.run(isoNow(), reason, id).changes > 0;
    busyBySubscription.delete(id);
    idleSinceBySubscription.delete(id);
    busySinceBySubscription.delete(id);
    for (const key of [...stallReported.keys()]) {
      if (key.startsWith(`${id}:`)) stallReported.delete(key);
    }
    return changed;
  }

  /**
   * Ends one subscription of the watcher (`subscriptionId`), or all of them
   * (`'all'`). Without a watcher (the browser), any active subscription.
   * Returns the ended subscriptions.
   */
  /**
   * Ends a mirror here and leaves its end for the paired relay to learn on
   * the next fetch (at once when it answers, later when it does not).
   */
  function endMirror(row, reason) {
    if (!endSubscription(row.id, reason)) return false;
    try { remoteSql?.setRemoteSync.run('unsubscribe', row.id); } catch {}
    return true;
  }

  function notifyRemoteChange(relayIds) {
    for (const relayId of new Set(relayIds)) {
      try { onRemoteChange(relayId); } catch {}
    }
  }

  /**
   * Ends one subscription of the watcher (`subscriptionId`: its id, or for
   * one on a paired relay also that relay's id for it), or all of them
   * (`'all'`; with `relayId` only those watching that relay). Without a
   * watcher (the browser), any active subscription. Returns the ended ones.
   */
  function unsubscribe({ watcherConversationId = '', subscriptionId, reason = 'unsubscribed', relayId = null } = {}) {
    if (!available) throw new RelayEventError('unavailable', 'Event subscriptions are not available on this relay right now.');
    const watcher = toText(watcherConversationId);
    const target = toText(subscriptionId);
    if (!target) throw new RelayEventError('invalid', 'unsubscribe needs subscription_id (from subscribe or list_subscriptions), or "all".');
    const relay = relayId === null ? null : toText(relayId);
    const rows = activeRows().filter((row) => (!watcher || row.watcher_conversation_id === watcher)
      && (target === 'all'
        ? !!watcher && (relay === null || toText(row.relay_id) === relay)
        : row.id === target || (isMirror(row) && row.remote_subscription_id === target)));
    if (!rows.length) {
      throw new RelayEventError('notFound', target === 'all'
        ? `This conversation has no active subscriptions${relay && relay !== RELAY_EVENT_SELF_RELAY_ID ? ' on that relay' : ''}.`
        : `No active subscription ${target}${watcher ? ' of this conversation' : ''}.`);
    }
    const ended = [];
    const remoteRelays = [];
    for (const row of rows) {
      const done = isMirror(row) ? endMirror(row, reason) : endSubscription(row.id, reason);
      if (!done) continue;
      if (isMirror(row)) remoteRelays.push(toText(row.relay_id));
      ended.push(shapeSubscription(sql.getSubscription.get(row.id)));
    }
    if (ended.length) {
      log(`${ended.map((sub) => sub.id).join(', ')} ended (${reason})`);
      dropOrphanedEvents(new Set(ended.map((sub) => sub.watcher)));
      broadcast();
      notifyRemoteChange(remoteRelays);
    }
    return ended;
  }

  /**
   * What a transfer from `fromConversationId` to `toConversationId` would
   * move, for the approval card: `{ from: { id, title }, count, includesAll,
   * subscriptions }`. Throws RelayEventError like transferSubscriptions.
   */
  function previewTransfer({ fromConversationId, toConversationId, relayId = null } = {}) {
    if (!available) throw new RelayEventError('unavailable', 'Event subscriptions are not available on this relay right now.');
    const from = toText(fromConversationId);
    const to = toText(toConversationId);
    const relay = relayId === null ? null : toText(relayId);
    if (!from) throw new RelayEventError('invalid', 'transfer_subscriptions needs from (the id of the conversation that watches now).');
    if (from === to) throw new RelayEventError('invalid', 'from is this conversation: its subscriptions are already here.');
    if (!isLive(conversation(to))) throw new RelayEventError('notFound', 'The watching conversation was not found or is archived.');
    const fromRow = conversation(from);
    const rows = activeRows().filter((row) => row.watcher_conversation_id === from && (relay === null || toText(row.relay_id) === relay));
    if (!rows.length) {
      throw new RelayEventError('notFound', fromRow
        ? `Session ${from} has no active subscriptions${relay !== null ? ' on that relay' : ''} to transfer${isLive(fromRow) ? '' : ' (it is archived, which ended them)'}.`
        : `No session with id ${from} on this relay.`);
    }
    const mine = activeRows().filter((row) => row.watcher_conversation_id === to).length;
    if (mine + rows.length > RELAY_EVENT_LIMITS.activeSubscriptionsPerWatcher) {
      throw new RelayEventError('limit', `This conversation has ${mine} subscriptions; with ${rows.length} more it would pass the limit of ${RELAY_EVENT_LIMITS.activeSubscriptionsPerWatcher}.`);
    }
    const subscriptions = rows.map(shapeSubscription);
    return {
      from: { id: from, title: toText(fromRow?.title) || null },
      count: rows.length,
      includesAll: rows.some((row) => toText(row.scope) === 'all'),
      // The paired relays among them, by name, for the card.
      relays: [...new Set(subscriptions.filter((sub) => sub.remoteId).map((sub) => sub.relayName || sub.relay))],
      subscriptions,
    };
  }

  /**
   * Moves every active subscription of `fromConversationId`, its settings
   * kept, and its undelivered events to `toConversationId`. The new watcher
   * is dropped from the moved session lists (it is never watched); a list
   * left empty ends. Returns `{ moved, ended }`.
   */
  function transferSubscriptions({ fromConversationId, toConversationId, relayId = null } = {}) {
    const preview = previewTransfer({ fromConversationId, toConversationId, relayId });
    const from = preview.from.id;
    const to = toText(toConversationId);
    const relay = relayId === null ? null : toText(relayId);
    const ended = [];
    const move = db.transaction(() => {
      if (relay === null) sql.moveSubscriptions.run(to, from);
      else remoteSql.moveSubscriptionsOfRelay.run(to, from, relay);
      for (const subscription of preview.subscriptions) {
        // A paired relay's session ids are never this relay's conversations.
        if (subscription.scope === 'all' || subscription.remoteId) continue;
        const ids = subscription.sessions.map((session) => session.id);
        if (!ids.includes(to)) continue;
        const rest = ids.filter((id) => id !== to);
        if (rest.length) sql.setSessions.run(JSON.stringify(rest), subscription.id);
        else if (endSubscription(subscription.id, 'transferred-empty')) ended.push(subscription.id);
      }
      if (relay === null) sql.moveUndelivered.run(to, from);
      else remoteSql.moveUndeliveredOfRelay.run(to, from, relay);
      sql.dropUndeliveredAbout.run(to, to);
    });
    move();
    const pending = flushTimers.get(from);
    if (pending) clearTimer(pending.timer);
    flushTimers.delete(from);
    for (const subscription of preview.subscriptions) {
      busySinceBySubscription.delete(subscription.id);
      if (!subscription.remoteId) noteBusy(sql.getSubscription.get(subscription.id));
    }
    scheduleFlush(to);
    log(`conv=${shortId(from)} → conv=${shortId(to)}: ${preview.count} subscription${preview.count === 1 ? '' : 's'} transferred`);
    broadcast();
    // The paired relays learn the new watcher's name with the next fetch.
    notifyRemoteChange(preview.subscriptions.filter((sub) => sub.remoteId).map((sub) => sub.relay));
    const moved = preview.subscriptions
      .filter((subscription) => !ended.includes(subscription.id))
      .map((subscription) => shapeSubscription(sql.getSubscription.get(subscription.id)));
    return { from: preview.from, moved, ended };
  }

  /** Undelivered events of a watcher with no active subscription left go. */
  function dropOrphanedEvents(watchers) {
    const stillWatching = new Set(activeRows().map((row) => row.watcher_conversation_id));
    for (const watcher of watchers) {
      // A paired relay's events wait for its fetch (and the retention bound):
      // its subscription's last events and its end must still reach it.
      if (stillWatching.has(watcher) || isServedKey(watcher)) continue;
      try { sql.dropUndelivered.run(watcher); } catch {}
      const pending = flushTimers.get(watcher);
      if (pending) clearTimer(pending.timer);
      flushTimers.delete(watcher);
    }
  }

  /** A conversation was archived or deleted: its subscriptions and its place in others end. */
  function noteConversationGone(conversationId, { deleted = false } = {}) {
    if (!available) return;
    const id = toText(conversationId);
    if (!id) return;
    const touched = new Set();
    const remoteRelays = [];
    for (const row of activeRows()) {
      if (row.watcher_conversation_id === id) {
        const reason = deleted ? 'watcher-deleted' : 'watcher-archived';
        if (isMirror(row) ? endMirror(row, reason) : endSubscription(row.id, reason)) touched.add(row.watcher_conversation_id);
        if (isMirror(row)) remoteRelays.push(toText(row.relay_id));
        continue;
      }
      // A mirror lists a paired relay's sessions, never this one's.
      if (toText(row.scope) === 'all' || isMirror(row)) continue;
      const ids = parseJson(row.session_ids_json, []).map(toText);
      if (!ids.includes(id)) continue;
      const rest = ids.filter((sessionId) => sessionId !== id);
      if (rest.length) sql.setSessions.run(JSON.stringify(rest), row.id);
      else endSubscription(row.id, deleted ? 'deleted' : 'archived');
      touched.add(row.watcher_conversation_id);
    }
    tracker?.forget?.(id);
    if (touched.size) {
      log(`conv=${shortId(id)} ${deleted ? 'deleted' : 'archived'}: subscriptions updated`);
      dropOrphanedEvents(touched);
      broadcast();
      notifyRemoteChange(remoteRelays);
    }
  }

  // ─── Recording ─────────────────────────────────────────────────────────────

  function subscriptionCovers(row, sessionId) {
    if (row.watcher_conversation_id === sessionId) return false;
    if (toText(row.scope) === 'all') return true;
    return parseJson(row.session_ids_json, []).map(toText).includes(sessionId);
  }

  function wants(row, type) {
    return parseJson(row.events_json, []).includes(type);
  }

  /** `match` filters the events it can be tried on; the others pass. */
  function passesMatch(row, event) {
    const pattern = toText(row.match) ? row.match : '';
    if (!pattern) return { pass: true, hit: false };
    const text = relayEventMatchText(event);
    if (text === null) return { pass: true, hit: false };
    const compiled = compileRelayEventMatch(pattern);
    if (!compiled.ok || !compiled.regex) return { pass: true, hit: false };
    const hit = compiled.regex.test(text);
    return { pass: hit, hit };
  }

  function buildEvent(type, sessionId, detail) {
    const session = sessionId ? conversation(sessionId) : null;
    return {
      v: RELAY_EVENT_VERSION,
      relay: { id: RELAY_EVENT_SELF_RELAY_ID, name: toText(relayName()) || null },
      session: sessionId ? { id: sessionId, title: toText(session?.title) || null } : null,
      type,
      at: isoNow(),
      detail: detail && typeof detail === 'object' ? detail : {},
    };
  }

  /**
   * One event of a session. Every active subscription that covers the
   * session and wants the type gets it, one row per watcher.
   */
  function record(type, sessionId, detail = {}) {
    if (!available || !RELAY_EVENT_TYPES.includes(type)) return 0;
    const id = toText(sessionId);
    if (!id) return 0;
    const rows = localWatchRows().filter((row) => wants(row, type) && subscriptionCovers(row, id));
    if (!rows.length) return 0;
    const event = buildEvent(type, id, detail);
    return enqueueForRows(rows, event, id);
  }

  function enqueueForRows(rows, event, sessionId) {
    const byWatcher = new Map();
    for (const row of rows) {
      const verdict = passesMatch(row, event);
      if (!verdict.pass) continue;
      const list = byWatcher.get(row.watcher_conversation_id) || [];
      list.push({ row, hit: verdict.hit });
      byWatcher.set(row.watcher_conversation_id, list);
    }
    const urgent = isUrgentRelayEventType(event.type);
    // The stored copy keeps the full reply for a match tried later; the
    // message shows the preview only.
    const stored = { ...event, detail: { ...event.detail } };
    delete stored.detail.replyText;
    let recorded = 0;
    for (const [watcher, matches] of byWatcher) {
      const first = matches[0].row;
      // A one-shot subscription ends with this event; with a match, only
      // with an event that matched.
      const heartbeat = event.type === RELAY_EVENT_HEARTBEAT_TYPE;
      const ending = heartbeat ? [] : matches
        .filter(({ row, hit }) => Number(row.once || 0) === 1 && (!toText(row.match) || hit))
        .map(({ row }) => row.id);
      const payload = { ...stored, subscriptionIds: matches.map(({ row }) => row.id), ...(ending.length ? { ends: ending } : {}) };
      sql.insertEvent.run(first.id, watcher, RELAY_EVENT_SELF_RELAY_ID, sessionId || '', event.type, urgent ? 1 : 0, JSON.stringify(payload), event.at);
      if (!heartbeat) for (const { row } of matches) sql.markFired.run(event.at, row.id);
      for (const subscriptionId of ending) endSubscription(subscriptionId, 'fired');
      if (ending.length) broadcast();
      scheduleFlush(watcher, { urgent });
      recorded += 1;
    }
    return recorded;
  }

  // ─── Flushing ──────────────────────────────────────────────────────────────

  function wakesInLastHour(watcher) {
    try {
      return Number(sql.countWakes.get(watcher, new Date(now() - HOUR_MS).toISOString(), RELAY_EVENT_HEARTBEAT_TYPE)?.n || 0);
    } catch {
      return 0;
    }
  }

  function overCap(watcher) {
    return wakesInLastHour(watcher) >= RELAY_EVENT_LIMITS.wakesPerHour;
  }

  const isHeartbeatRow = (row) => toText(row.type) === RELAY_EVENT_HEARTBEAT_TYPE;

  function coalescedDue(rows) {
    const first = Math.min(...rows.map((row) => Date.parse(String(row.created_at)) || now()));
    return Math.max(now(), first + RELAY_EVENT_LIMITS.coalesceMs);
  }

  function digestDue(watcher) {
    const last = Date.parse(String(sql.lastWake.get(watcher, RELAY_EVENT_HEARTBEAT_TYPE)?.at || '')) || now();
    return Math.max(now(), last + RELAY_EVENT_LIMITS.digestIntervalMs);
  }

  function dueAtFor(watcher, undelivered) {
    if (undelivered.some((row) => Number(row.urgent) === 1)) return now();
    if (overCap(watcher)) {
      // Heartbeats are not held for the digest: they go after the usual
      // coalescing, alone.
      const heartbeats = undelivered.filter(isHeartbeatRow);
      const others = undelivered.filter((row) => !isHeartbeatRow(row));
      const dues = [];
      if (heartbeats.length) dues.push(coalescedDue(heartbeats));
      if (others.length) dues.push(digestDue(watcher));
      return Math.min(...dues);
    }
    return coalescedDue(undelivered);
  }

  function scheduleFlush(watcher, { urgent = false } = {}) {
    // A paired relay's events wait for its fetch.
    if (isServedKey(watcher)) return;
    let undelivered = [];
    try {
      undelivered = sql.listUndelivered.all(watcher);
    } catch {
      return;
    }
    if (!undelivered.length) return;
    const dueAt = urgent ? now() : dueAtFor(watcher, undelivered);
    const current = flushTimers.get(watcher);
    if (current && current.dueAt <= dueAt) return;
    if (current) clearTimer(current.timer);
    const delay = Math.max(0, dueAt - now());
    const timer = setTimer(() => {
      flushTimers.delete(watcher);
      try {
        flush(watcher);
      } catch (error) {
        warn(`flush failed conv=${shortId(watcher)}: ${toText(error?.message || error).slice(0, 200)}`);
      }
    }, delay);
    flushTimers.set(watcher, { timer, dueAt });
  }

  /**
   * Writes the watcher's undelivered events into its conversation now:
   * appended to its event row that is still pending, else as a new message.
   * Returns `{ messageId, merged, digest, count }` or null.
   */
  function flush(watcher) {
    if (!available || isServedKey(watcher)) return null;
    let rows = sql.listUndelivered.all(watcher);
    if (!rows.length) return null;
    const target = conversation(watcher);
    if (!isLive(target)) {
      sql.dropUndelivered.run(watcher);
      return null;
    }
    const urgent = rows.some((row) => Number(row.urgent) === 1);
    const capped = overCap(watcher);
    let digest = false;
    // Past the cap only an urgent event or the digest's time sends all;
    // before that, heartbeats go alone.
    if (capped && !urgent) {
      if (digestDue(watcher) > now()) {
        const heartbeats = rows.filter(isHeartbeatRow);
        if (!heartbeats.length || coalescedDue(heartbeats) > now()) {
          scheduleFlush(watcher);
          return null;
        }
        rows = heartbeats;
      } else {
        digest = rows.some((row) => !isHeartbeatRow(row));
      }
    }
    const events = rows.map((row) => parseJson(row.payload_json, null)).filter(Boolean);
    const ended = [...new Set(events.flatMap((event) => (Array.isArray(event.ends) ? event.ends : [])))];
    const at = isoNow();
    let result = null;
    const write = db.transaction(() => {
      const pending = sql.findPendingEventRow.get(watcher, RELAY_EVENT_MESSAGE_KIND) || null;
      if (pending) {
        const earlier = sql.listEventsOfMessage.all(pending.id).map((row) => parseJson(row.payload_json, null)).filter(Boolean);
        const all = [...earlier, ...events];
        const allEnded = [...new Set(all.flatMap((event) => (Array.isArray(event.ends) ? event.ends : [])))];
        const text = buildRelayEventMessageText(all, { digest, ended: allEnded });
        sql.updateQueueText.run(text, pending.id);
        sql.updateMessageText.run(text, pending.id);
        for (const row of rows) sql.markDelivered.run(at, pending.id, row.id);
        const timestamp = sql.getMessageTimestamp.get(pending.id)?.timestamp || at;
        result = { messageId: String(pending.id), merged: true, digest, count: rows.length, text, timestamp };
        return;
      }
      const messageId = randomUUID();
      const text = buildRelayEventMessageText(events, { digest, ended });
      const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(watcher) || null;
      const latestModel = stmts.getLatestConversationModel?.get?.(watcher)?.model || null;
      // The model the conversation last ran on, as the usage-limit follow-up
      // picks it.
      const model = toText(latestModel) || toText(runtimeSession?.provider_model) || toText(runtimeSession?.model) || null;
      const modelVariant = model;
      const relayMode = toText(target.preferred_relay_mode) || 'agent';
      const owner = toText(runtimeSession?.sdk_session_id) || null;
      stmts.insertMsg.run(
        messageId,
        watcher,
        'user',
        text,
        modelVariant || null,
        relayMode,
        null,
        at,
        modelVariant || null,
        null,
        toText(modelVariant).toLowerCase() === 'auto' ? 'auto' : 'manual',
      );
      stmts.setMessageKind?.run?.(RELAY_EVENT_MESSAGE_KIND, messageId);
      stmts.updateConvTime?.run?.(at, watcher);
      const queueArgs = [
        messageId,
        watcher,
        runtimeSession?.id || null,
        0,
        model,
        modelVariant || null,
        toText(target.preferred_reasoning_effort) || null,
        null,
        relayMode,
        text,
        null,
        at,
        owner,
        owner ? at : null,
        null,
        null,
      ];
      if (stmts.queueHasImageOperationId || stmts.insertQ?.source?.includes?.('image_operation_id')) queueArgs.push(null);
      stmts.insertQ.run(...queueArgs);
      for (const row of rows) sql.markDelivered.run(at, messageId, row.id);
      result = { messageId, merged: false, digest, count: rows.length, text, model: modelVariant, relayMode, owner, timestamp: at };
    });
    write();
    if (!result) return null;
    // Whatever stayed behind (held for the digest) gets its own timer.
    scheduleFlush(watcher);
    if (result.merged) {
      try {
        emit('message_updated', {
          conversationId: watcher,
          messageId: result.messageId,
          message: { role: 'user', text: result.text, kind: RELAY_EVENT_MESSAGE_KIND, attachments: [], timestamp: result.timestamp },
        });
      } catch {}
    } else {
      try {
        emit('user_message', {
          conversationId: watcher,
          messageId: result.messageId,
          senderClientId: null,
          message: {
            role: 'user',
            text: result.text,
            model: result.model,
            mode: result.relayMode,
            attachments: [],
            timestamp: result.timestamp,
            kind: RELAY_EVENT_MESSAGE_KIND,
          },
        });
      } catch {}
      try { emit('message_status', { messageId: result.messageId, conversationId: watcher, status: 'pending' }); } catch {}
      try { wakeWatcher({ conversationId: watcher, ownerSessionId: result.owner, messageId: result.messageId }); } catch {}
    }
    log(`conv=${shortId(watcher)} ${result.merged ? 'appended' : 'woken with'} ${result.count} event${result.count === 1 ? '' : 's'}${result.digest ? ' (digest)' : ''}`);
    return result;
  }

  // ─── Paired relays: the watched side ───────────────────────────────────────

  function requireCross() {
    if (!crossAvailable) {
      throw new RelayEventError('unavailable', 'Event subscriptions across relays are not available on this relay right now (its storage is missing; see the server log).');
    }
  }

  function subscriberOf(value) {
    const subscriber = cleanSubscriberRelayId(value);
    if (!subscriber) throw new RelayEventError('invalid', 'The calling relay sent no relay id (X-OAR-Remote-Origin).');
    return subscriber;
  }

  /**
   * A paired relay's agent subscribes to sessions here. `subscriberRelayId`
   * is that relay's own id as its request states it; the watcher is a
   * conversation there (`watcherId`, `watcherTitle`, for display only).
   * Same rules as subscribe; at most activeSubscriptionsPerWatcher per
   * watcher and remoteSubscriptionsPerRelay per relay. `dryRun` checks all
   * of it and stores nothing: the other relay asks its user only then.
   */
  function subscribeServed({
    subscriberRelayId,
    subscriberRelayName = '',
    watcherId = '',
    watcherTitle = '',
    scope = 'sessions',
    sessionIds = [],
    events = null,
    once = false,
    match = '',
    stalledMinutes = null,
    heartbeatMinutes = null,
    dryRun = false,
  } = {}) {
    if (!available) throw new RelayEventError('unavailable', 'Event subscriptions are not available on this relay right now (its storage is missing; see the server log).');
    requireCross();
    const subscriber = subscriberOf(subscriberRelayId);
    const watcher = toText(watcherId).slice(0, 200);
    const prepared = prepareSubscription({ scope, sessionIds, events, match, stalledMinutes, heartbeatMinutes });
    const { all, ids, types } = prepared;
    if (Number(remoteSql.countServedOfWatcher.get(subscriber, watcher)?.n || 0) >= RELAY_EVENT_LIMITS.activeSubscriptionsPerWatcher) {
      throw new RelayEventError('limit', `That conversation already has ${RELAY_EVENT_LIMITS.activeSubscriptionsPerWatcher} subscriptions on this relay; unsubscribe one first.`);
    }
    if (Number(remoteSql.countServedActive.get(subscriber)?.n || 0) >= RELAY_EVENT_LIMITS.remoteSubscriptionsPerRelay) {
      throw new RelayEventError('limit', `Your relay already has ${RELAY_EVENT_LIMITS.remoteSubscriptionsPerRelay} subscriptions on this relay; end some first.`);
    }
    if (dryRun) {
      return {
        id: null,
        scope: all ? 'all' : 'sessions',
        sessions: all ? 'all' : ids.map((sessionId) => ({ id: sessionId, title: toText(conversation(sessionId)?.title) || null })),
        events: types,
        once: once === true,
        ...(prepared.matchText ? { match: prepared.matchText } : {}),
        stalledMinutes: prepared.stalled,
        ...(prepared.heartbeat ? { heartbeatMinutes: prepared.heartbeat } : {}),
      };
    }
    const id = `sub_${randomBytes(5).toString('hex')}`;
    const at = isoNow();
    remoteSql.insertServed.run(
      id,
      servedWatcherKey(subscriber),
      RELAY_EVENT_SELF_RELAY_ID,
      all ? 'all' : 'sessions',
      all ? null : JSON.stringify(ids),
      JSON.stringify(types),
      once ? 1 : 0,
      prepared.matchText,
      prepared.stalled,
      prepared.heartbeat,
      at,
      subscriber,
      toText(subscriberRelayName).slice(0, 60) || null,
      watcher || null,
      toText(watcherTitle).slice(0, 200) || null,
      at,
    );
    const row = sql.getSubscription.get(id);
    noteBusy(row);
    log(`relay ${shortId(subscriber)} subscribed ${id} to ${all ? 'all sessions' : `${ids.length} session${ids.length === 1 ? '' : 's'}`} (${types.join(',')})${once ? ' once' : ''}`);
    broadcast();
    return shapeSubscription(row);
  }

  /** What a paired relay is told about one of its subscriptions here. */
  function servedState(row, subscriber, id) {
    if (!row || toText(row.subscriber_relay_id) !== subscriber) return { id, active: false, endReason: 'unknown' };
    const shaped = shapeSubscription(row);
    return {
      id,
      active: !row.ended_at,
      ...(row.ended_at ? { endedAt: row.ended_at, endReason: row.end_reason || null } : {}),
      scope: shaped.scope,
      sessions: shaped.sessions,
    };
  }

  /**
   * A paired relay fetches its events. Everything up to `after` (the last
   * event id it stored) is acknowledged and deleted here; `ended` are
   * subscriptions it ended (unsubscribe, its watcher archived), applied now;
   * `subscriptions` lists the ones it still holds, with their watcher, and
   * gets their state back. Returns `{ events, cursor, more, subscriptions,
   * ended, dropped }`: at most remotePullBatch events after `after`, oldest
   * first; `dropped` counts per subscription what was not kept since the
   * last fetch.
   */
  function pullServed({ subscriberRelayId, after = 0, subscriptions = [], ended = [] } = {}) {
    if (!available) throw new RelayEventError('unavailable', 'Event subscriptions are not available on this relay right now.');
    requireCross();
    const subscriber = subscriberOf(subscriberRelayId);
    const key = servedWatcherKey(subscriber);
    const ack = Math.max(0, Math.trunc(Number(after) || 0));
    const listed = (Array.isArray(subscriptions) ? subscriptions : [])
      .filter((entry) => entry && typeof entry === 'object')
      .slice(0, RELAY_EVENT_LIMITS.remoteSubscriptionsPerRelay)
      .map((entry) => ({ id: toText(entry.id), watcher: entry.watcher && typeof entry.watcher === 'object' ? entry.watcher : null }))
      .filter((entry) => entry.id);
    const endedIds = [...new Set((Array.isArray(ended) ? ended : []).map(toText).filter(Boolean))].slice(0, RELAY_EVENT_LIMITS.remoteSubscriptionsPerRelay);
    const at = isoNow();
    let result = null;
    let changed = false;
    db.transaction(() => {
      if (ack > 0) remoteSql.deleteServedThrough.run(key, ack);
      const acked = [];
      for (const id of endedIds) {
        const row = sql.getSubscription.get(id);
        if (row && toText(row.subscriber_relay_id) === subscriber && !row.ended_at && endSubscription(id, 'unsubscribed')) changed = true;
        // Unknown or someone else's: nothing to end here either.
        acked.push(id);
      }
      for (const entry of listed) {
        const row = sql.getSubscription.get(entry.id);
        if (!row || toText(row.subscriber_relay_id) !== subscriber || row.ended_at || !entry.watcher) continue;
        const watcherId = toText(entry.watcher.conversationId).slice(0, 200) || null;
        const watcherTitle = toText(entry.watcher.title).slice(0, 200) || null;
        if (watcherId !== (row.subscriber_watcher_id || null) || watcherTitle !== (row.subscriber_watcher_title || null)) {
          remoteSql.setServedWatcher.run(watcherId, watcherTitle, entry.id);
          changed = true;
        }
      }
      remoteSql.touchServed.run(at, subscriber);
      const batch = RELAY_EVENT_LIMITS.remotePullBatch;
      const rows = remoteSql.listServedEvents.all(key, ack, batch + 1);
      const page = rows.slice(0, batch);
      const dropped = {};
      for (const entry of listed) {
        const row = sql.getSubscription.get(entry.id);
        if (!row || toText(row.subscriber_relay_id) !== subscriber || !(Number(row.dropped_count) > 0)) continue;
        dropped[entry.id] = Number(row.dropped_count);
        remoteSql.takeDropped.run(entry.id);
      }
      result = {
        events: page.map((row) => ({
          id: Number(row.id),
          type: row.type,
          urgent: Number(row.urgent) === 1,
          createdAt: row.created_at,
          payload: parseJson(row.payload_json, null),
        })),
        cursor: page.length ? Number(page.at(-1).id) : ack,
        more: rows.length > batch,
        subscriptions: listed.map((entry) => servedState(sql.getSubscription.get(entry.id), subscriber, entry.id)),
        ended: acked,
        dropped,
      };
    })();
    if (changed) broadcast();
    return result;
  }

  /**
   * The retention bound of what paired relays have not fetched: per
   * subscription the newest remoteKeepEvents (questions and errors kept
   * longest), nothing older than remoteKeepDays; a subscription not fetched
   * for remoteKeepDays ends ('subscriber-gone'). On the watching side an end
   * not confirmed for as long is no longer sent: that relay ended it.
   */
  function pruneServed() {
    if (!crossAvailable) return;
    const cutoff = new Date(now() - RELAY_EVENT_LIMITS.remoteKeepDays * DAY_MS).toISOString();
    let ended = 0;
    db.transaction(() => {
      for (const row of remoteSql.countServedExpired.all(cutoff)) remoteSql.addDropped.run(Number(row.n) || 0, row.subscription_id);
      remoteSql.deleteServedExpired.run(cutoff);
      for (const row of remoteSql.listServedOverfull.all(RELAY_EVENT_LIMITS.remoteKeepEvents)) {
        const extra = Number(row.n) - RELAY_EVENT_LIMITS.remoteKeepEvents;
        remoteSql.deleteServedOldest.run(row.subscription_id, extra);
        remoteSql.addDropped.run(extra, row.subscription_id);
      }
      for (const row of remoteSql.listServedStale.all(cutoff)) {
        if (endSubscription(row.id, 'subscriber-gone')) ended += 1;
      }
      remoteSql.clearStaleSync.run(cutoff);
    })();
    if (ended) {
      log(`${ended} subscription${ended === 1 ? '' : 's'} of paired relays ended: not fetched for ${RELAY_EVENT_LIMITS.remoteKeepDays} days`);
      broadcast();
    }
  }

  // ─── Paired relays: the watching side ──────────────────────────────────────

  /**
   * Stores this relay's side of a subscription a paired relay accepted:
   * `remote` is that relay's subscription (id, scope, sessions with titles,
   * events, …). Returns the subscription as list_subscriptions shows it.
   */
  function addMirror({ watcherConversationId, relayId, relayName = '', remote } = {}) {
    if (!available) throw new RelayEventError('unavailable', 'Event subscriptions are not available on this relay right now.');
    requireCross();
    const watcher = toText(watcherConversationId);
    const relay = toText(relayId);
    const remoteId = toText(remote?.id);
    if (!relay || relay === RELAY_EVENT_SELF_RELAY_ID || !remoteId) throw new RelayEventError('invalid', 'The paired relay did not return a subscription.');
    if (!isLive(conversation(watcher))) throw new RelayEventError('notFound', 'The watching conversation was not found or is archived.');
    checkWatcherCapacity(watcher);
    const all = remote.scope === 'all';
    const sessions = all ? [] : (Array.isArray(remote.sessions) ? remote.sessions : [])
      .map((session) => ({ id: toText(session?.id), title: toText(session?.title) || null }))
      .filter((session) => session.id);
    const types = (Array.isArray(remote.events) ? remote.events : []).filter((type) => RELAY_EVENT_TYPES.includes(type));
    const id = `sub_${randomBytes(5).toString('hex')}`;
    const at = isoNow();
    remoteSql.insertMirror.run(
      id,
      watcher,
      relay,
      all ? 'all' : 'sessions',
      all ? null : JSON.stringify(sessions.map((session) => session.id)),
      JSON.stringify(types.length ? types : [...RELAY_EVENT_DEFAULT_TYPES]),
      remote.once === true ? 1 : 0,
      toText(remote.match) ? String(remote.match) : null,
      Number(remote.stalledMinutes) || RELAY_EVENT_LIMITS.stalledMinutesDefault,
      Number(remote.heartbeatMinutes) > 0 ? Number(remote.heartbeatMinutes) : null,
      at,
      remoteId,
      JSON.stringify({ relayName: toText(relayName) || null, sessions }),
    );
    noteRemoteLinkOk(relay);
    log(`conv=${shortId(watcher)} subscribed ${id} on a paired relay (${remoteId} there)`);
    broadcast();
    return shapeSubscription(sql.getSubscription.get(id));
  }

  function mirrorsOf(relayId) {
    if (!crossAvailable) return [];
    try {
      return remoteSql.listMirrorsOfRelay.all(toText(relayId));
    } catch {
      return [];
    }
  }

  /** The paired relays to fetch from: active mirrors, or ends not delivered yet. */
  function remoteRelaysToPoll() {
    if (!crossAvailable) return [];
    try {
      return remoteSql.listRelaysToPoll.all().map((row) => toText(row.relay_id)).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** The watchers with active subscriptions on a paired relay, with one of them each. */
  function remoteWatchers(relayId) {
    const watchers = new Map();
    for (const row of mirrorsOf(relayId)) {
      if (row.ended_at || watchers.has(row.watcher_conversation_id)) continue;
      watchers.set(row.watcher_conversation_id, row.id);
    }
    return watchers;
  }

  /** The body of the next fetch from a paired relay. */
  function buildRemotePull(relayId) {
    const rows = mirrorsOf(relayId);
    return {
      after: Number(getRemoteLink(relayId).cursor) || 0,
      subscriptions: rows.filter((row) => !row.ended_at).map((row) => ({
        id: row.remote_subscription_id,
        watcher: { conversationId: row.watcher_conversation_id, title: toText(conversation(row.watcher_conversation_id)?.title) || null },
      })),
      ended: rows.filter((row) => row.ended_at && toText(row.remote_sync) === 'unsubscribe').map((row) => row.remote_subscription_id),
    };
  }

  // What of a paired relay's event detail is stored here, by field: nothing
  // else of its payload is. The formatter one-lines every field; the
  // allow-list keeps a payload from carrying anything the formatter never
  // saw (an unknown key, a nested object).
  const REMOTE_DETAIL_FIELDS = Object.freeze({
    kind: 'text',
    message: 'text',
    messageId: 'text',
    status: 'text',
    preview: 'text',
    prompt: 'text',
    questionId: 'text',
    approvalCard: 'bool',
    description: 'text',
    summary: 'text',
    taskId: 'text',
    exitCode: 'int',
    statusReported: 'bool',
    quietMinutes: 'int',
    what: 'text',
    since: 'text',
    scope: 'text',
    sessionCount: 'int',
    subscriptionId: 'text',
    options: 'textList',
    busy: 'busyList',
  });
  const REMOTE_TEXT_MAX = 2000;

  function remoteText(value, max = REMOTE_TEXT_MAX) {
    return value === null || value === undefined ? '' : String(value).slice(0, max);
  }

  function cleanRemoteDetail(detail) {
    const source = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
    const clean = {};
    for (const [key, shape] of Object.entries(REMOTE_DETAIL_FIELDS)) {
      if (!(key in source)) continue;
      const value = source[key];
      if (value === null || value === undefined) continue;
      if (shape === 'text') {
        if (typeof value === 'string' || typeof value === 'number') clean[key] = remoteText(value);
      } else if (shape === 'bool') {
        if (typeof value === 'boolean') clean[key] = value;
      } else if (shape === 'int') {
        if (Number.isInteger(value)) clean[key] = value;
      } else if (shape === 'textList') {
        if (Array.isArray(value)) clean[key] = value.slice(0, 50).filter((item) => typeof item === 'string' || typeof item === 'number').map((item) => remoteText(item, 200));
      } else if (shape === 'busyList') {
        if (Array.isArray(value)) {
          clean[key] = value.slice(0, 10)
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => ({ id: remoteText(entry.id, 200), title: remoteText(entry.title, 200) || null, what: remoteText(entry.what, 40) }));
        }
      }
    }
    return clean;
  }

  function remoteIso(value) {
    const parsed = Date.parse(remoteText(value, 40));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  // How an end on the paired relay reads here.
  const REMOTE_END_REASONS = Object.freeze({
    'unsubscribed-by-user': 'ended-on-relay',
    unknown: 'gone-on-relay',
    'subscriber-gone': 'expired-on-relay',
  });

  /**
   * Writes what a fetch from a paired relay brought: its events become this
   * relay's undelivered events of the watchers whose mirrors they name (an
   * event for a subscription this relay does not hold is dropped), ends and
   * session changes there end or update the mirrors, confirmed ends clear
   * their sync mark, and the cursor moves, all in one transaction. With
   * `replay` (the first fetch after a gap) events are marked replayed and
   * urgent and nothing is flushed yet: noteRemoteLinkRestored does that.
   * Returns per watcher `{ kept, urgent, dropped, ended }`.
   */
  function applyRemotePull(relayId, { relayName = '', response = {}, replay = false } = {}) {
    requireCross();
    const relay = toText(relayId);
    const name = toText(relayName) || relay;
    const rows = mirrorsOf(relay);
    const byRemote = new Map(rows.map((row) => [row.remote_subscription_id, row]));
    const at = isoNow();
    const touched = new Map();
    const tally = (watcher) => {
      if (!touched.has(watcher)) touched.set(watcher, { kept: 0, urgent: false, dropped: 0, ended: [] });
      return touched.get(watcher);
    };
    let changed = false;
    db.transaction(() => {
      for (const item of Array.isArray(response.events) ? response.events : []) {
        const payload = item?.payload && typeof item.payload === 'object' ? item.payload : null;
        if (!payload || !isRelayEventType(payload.type)) continue;
        const named = (Array.isArray(payload.subscriptionIds) ? payload.subscriptionIds : []).map(toText);
        const groups = new Map();
        for (const remoteId of named) {
          const row = byRemote.get(remoteId);
          if (!row || row.ended_at) continue;
          if (!groups.has(row.watcher_conversation_id)) groups.set(row.watcher_conversation_id, []);
          groups.get(row.watcher_conversation_id).push(row);
        }
        for (const [watcher, mine] of groups) {
          const endingRemote = new Set((Array.isArray(payload.ends) ? payload.ends : []).map(toText));
          const ends = mine.filter((row) => endingRemote.has(row.remote_subscription_id)).map((row) => row.id);
          // The stored event is built from the allow-listed fields of the
          // payload, never from the payload itself.
          const detail = cleanRemoteDetail(payload.detail);
          // all_idle and heartbeat name their subscription: this relay's id for it.
          const named = mine.find((row) => row.remote_subscription_id === toText(detail.subscriptionId));
          if (named) detail.subscriptionId = named.id;
          else delete detail.subscriptionId;
          const sessionId = payload.session && typeof payload.session === 'object' ? remoteText(payload.session.id, 200) : '';
          const event = {
            v: RELAY_EVENT_VERSION,
            relay: { id: relay, name },
            session: sessionId ? { id: sessionId, title: remoteText(payload.session.title, 200) || null } : null,
            type: toText(payload.type),
            at: remoteIso(payload.at) || at,
            detail,
            subscriptionIds: mine.map((row) => row.id),
            ...(ends.length ? { ends } : {}),
            ...(replay ? { replayed: true } : {}),
          };
          const urgent = replay || item.urgent === true || isUrgentRelayEventType(event.type);
          sql.insertEvent.run(mine[0].id, watcher, relay, toText(event.session?.id), event.type, urgent ? 1 : 0, JSON.stringify(event), at);
          if (event.type !== RELAY_EVENT_HEARTBEAT_TYPE) for (const row of mine) sql.markFired.run(at, row.id);
          for (const id of ends) {
            if (endSubscription(id, 'fired')) changed = true;
          }
          const entry = tally(watcher);
          entry.kept += 1;
          entry.urgent = entry.urgent || urgent;
        }
      }
      for (const state of Array.isArray(response.subscriptions) ? response.subscriptions : []) {
        const row = byRemote.get(toText(state?.id));
        if (!row || row.ended_at) continue;
        if (state.active === false) {
          const reason = REMOTE_END_REASONS[toText(state.endReason)] || toText(state.endReason) || 'gone-on-relay';
          if (endSubscription(row.id, reason)) {
            tally(row.watcher_conversation_id).ended.push(row.id);
            changed = true;
          }
          continue;
        }
        if (state.scope === 'sessions' && Array.isArray(state.sessions)) {
          const sessions = state.sessions.map((session) => ({ id: toText(session?.id), title: toText(session?.title) || null })).filter((session) => session.id);
          const meta = { ...parseJson(row.remote_meta_json, {}), relayName: name, sessions };
          const ids = JSON.stringify(sessions.map((session) => session.id));
          if (ids !== row.session_ids_json || JSON.stringify(meta) !== row.remote_meta_json) {
            remoteSql.setMirrorSessions.run(ids, JSON.stringify(meta), row.id);
            changed = true;
          }
        }
      }
      for (const remoteId of Array.isArray(response.ended) ? response.ended : []) {
        const row = byRemote.get(toText(remoteId));
        if (row && row.remote_sync) remoteSql.setRemoteSync.run(null, row.id);
      }
      for (const [remoteId, count] of Object.entries(response.dropped && typeof response.dropped === 'object' ? response.dropped : {})) {
        const row = byRemote.get(toText(remoteId));
        if (row && Number(count) > 0) tally(row.watcher_conversation_id).dropped += Number(count);
      }
      remoteSql.linkOk.run(relay, Math.max(0, Math.trunc(Number(response.cursor) || 0)), at);
    })();
    if (!replay) {
      for (const [watcher, entry] of touched) if (entry.kept) scheduleFlush(watcher, { urgent: entry.urgent });
    }
    if (changed) broadcast();
    return touched;
  }

  /**
   * The first fetch after a gap is done (every page of it): each watcher with
   * subscriptions on that relay gets link_lost and link_restored around what
   * was kept, and its events go out at once, as one row.
   * `perWatcher`: watcher → `{ subscriptionId, kept, dropped, ended }`.
   */
  function noteRemoteLinkRestored(relayId, { relayName = '', since = null, perWatcher = new Map() } = {}) {
    requireCross();
    const relay = toText(relayId);
    const at = isoNow();
    const sinceText = toText(since) || null;
    db.transaction(() => {
      for (const [watcher, info] of perWatcher) {
        if (!isLive(conversation(watcher))) continue;
        const base = { v: RELAY_EVENT_VERSION, relay: { id: relay, name: toText(relayName) || relay }, session: null, at, subscriptionIds: [info.subscriptionId] };
        const lost = { ...base, type: RELAY_EVENT_LINK_LOST_TYPE, detail: { since: sinceText } };
        const restored = {
          ...base,
          type: RELAY_EVENT_LINK_RESTORED_TYPE,
          detail: { since: sinceText, kept: Number(info.kept) || 0, dropped: Number(info.dropped) || 0, ended: info.ended || [] },
        };
        sql.insertEvent.run(info.subscriptionId, watcher, relay, '', lost.type, 1, JSON.stringify(lost), at);
        sql.insertEvent.run(info.subscriptionId, watcher, relay, '', restored.type, 1, JSON.stringify(restored), at);
      }
    })();
    for (const watcher of perWatcher.keys()) scheduleFlush(watcher, { urgent: true });
    const kept = [...perWatcher.values()].reduce((sum, info) => sum + (Number(info.kept) || 0), 0);
    log(`link to paired relay ${shortId(relay)} restored (no answer since ${sinceText || '?'}): ${kept} kept event${kept === 1 ? '' : 's'} replayed to ${perWatcher.size} watcher${perWatcher.size === 1 ? '' : 's'}`);
  }

  /** The link to a paired relay: `{ cursor, last_ok_at, first_fail_at, lost_at, last_error }`. */
  function getRemoteLink(relayId) {
    const empty = { relay_id: toText(relayId), cursor: 0, last_ok_at: null, first_fail_at: null, lost_at: null, last_error: null };
    if (!crossAvailable) return empty;
    try {
      return remoteSql.getLink.get(toText(relayId)) || empty;
    } catch {
      return empty;
    }
  }

  /** A call to the paired relay succeeded (subscribe): the link is up. */
  function noteRemoteLinkOk(relayId) {
    if (!crossAvailable) return;
    try { remoteSql.linkOk.run(toText(relayId), 0, isoNow()); } catch {}
  }

  /**
   * A fetch failed. Once nothing answered for remoteGapMs since the last
   * success, the link counts as lost from that success on.
   */
  function noteRemoteLinkFailure(relayId, error = '') {
    if (!crossAvailable) return getRemoteLink(relayId);
    const relay = toText(relayId);
    try {
      remoteSql.linkFailed.run(relay, isoNow(), toText(error).slice(0, 300) || null);
      const link = getRemoteLink(relay);
      const lastOk = Date.parse(String(link.last_ok_at || ''));
      if (!link.lost_at && Number.isFinite(lastOk) && now() - lastOk >= RELAY_EVENT_LIMITS.remoteGapMs) {
        remoteSql.linkLost.run(link.last_ok_at, relay);
        log(`link to paired relay ${shortId(relay)} lost (no answer since ${link.last_ok_at})`);
      }
    } catch {}
    return getRemoteLink(relay);
  }

  /** The pairing with a paired relay is gone: its mirrors end, nothing is left to deliver. */
  function noteRelayRemoved(relayId) {
    if (!crossAvailable) return [];
    const relay = toText(relayId);
    const ended = [];
    db.transaction(() => {
      for (const row of mirrorsOf(relay)) {
        if (!row.ended_at && endSubscription(row.id, 'pairing-removed')) ended.push(row.id);
      }
      remoteSql.clearRelaySync.run(relay);
      remoteSql.deleteLink.run(relay);
    })();
    if (ended.length) {
      log(`pairing removed: ${ended.length} subscription${ended.length === 1 ? '' : 's'} on it ended`);
      broadcast();
    }
    return ended;
  }

  // ─── Hooks ─────────────────────────────────────────────────────────────────

  function isRelayEventTurn(queueMessageId) {
    const id = toText(queueMessageId);
    if (!id) return false;
    try {
      return toText(sql.getQueueMessageKind.get(id)?.kind) === RELAY_EVENT_MESSAGE_KIND;
    } catch {
      return false;
    }
  }

  /** Looks at all_idle again in a moment (one timer for every subscription). */
  function scheduleAllIdleCheck(delayMs = 1_000) {
    if (!available || !started || allIdleTimer) return;
    allIdleTimer = setTimer(() => {
      allIdleTimer = null;
      try { evaluateAllIdle(); } catch (error) { warn(`all_idle check failed: ${toText(error?.message || error).slice(0, 200)}`); }
    }, delayMs);
  }

  /** A watched session's turn or tasks changed. */
  function afterStateChange(conversationId) {
    void conversationId;
    scheduleAllIdleCheck();
  }

  /** A turn ended with a reply (`status` done or stopped). */
  function noteTurnEnd({ conversationId, queueMessageId = '', replyText = '', status = 'done' } = {}) {
    if (!available) return;
    // A turn that answered relay events tells no other watcher: two
    // watchers of each other would otherwise wake each other for good.
    if (!isRelayEventTurn(queueMessageId)) {
      const text = String(replyText || '');
      record('turn_end', conversationId, {
        status,
        preview: text.slice(0, RELAY_EVENT_LIMITS.previewChars * 2),
        replyText: text.slice(0, 20_000),
        ...(queueMessageId ? { messageId: toText(queueMessageId) } : {}),
      });
    }
    afterStateChange(conversationId);
  }

  /** A turn or the session failed: `kind` turn_failed, usage_limit, worker_died. */
  function noteError({ conversationId, kind = 'turn_failed', message = '', queueMessageId = '' } = {}) {
    if (!available) return;
    record('error', conversationId, {
      kind,
      message: String(message || '').slice(0, 1000),
      ...(queueMessageId ? { messageId: toText(queueMessageId) } : {}),
    });
    afterStateChange(conversationId);
  }

  /** A question card was put on a session's turn (formatted question row). */
  function noteQuestion(question) {
    if (!available || !question) return;
    const conversationId = toText(question.conversationId || question.conversation_id);
    let choices = question.choices;
    if (typeof choices === 'string') choices = parseJson(choices, []);
    const options = (Array.isArray(choices) ? choices : [])
      .map((choice) => (choice && typeof choice === 'object' ? toText(choice.label || choice.value) : toText(choice)))
      .filter(Boolean);
    const context = question.context && typeof question.context === 'object'
      ? question.context
      : (parseJson(question.request, {})?.context || {});
    record('question_asked', conversationId, {
      prompt: String(question.prompt || question.question || '').slice(0, 2000),
      options,
      questionId: toText(question.id),
      ...(toText(context?.source) === 'remote_relay' ? { approvalCard: true } : {}),
    });
  }

  /** The tracker's edge: a background task started or ended. */
  function noteTaskEdge({ type, conversationId, task } = {}) {
    if (!available || !task) return;
    if (type === 'task_started' || type === 'task_finished' || type === 'task_failed') {
      record(type, conversationId, {
        kind: task.kind,
        description: task.description,
        status: task.status,
        ...(Number.isInteger(task.exitCode) ? { exitCode: task.exitCode } : {}),
        ...(task.statusReported === false ? { statusReported: false } : {}),
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.id ? { taskId: task.id } : {}),
      });
    }
    afterStateChange(conversationId);
  }

  // ─── Sweeps: stalled and all_idle ──────────────────────────────────────────

  function describe(conversationId) {
    try {
      return tracker?.describe?.(conversationId) || { state: 'idle', tasks: [], runningTaskCount: 0, lastActivityAt: null };
    } catch {
      return { state: 'idle', tasks: [], runningTaskCount: 0, lastActivityAt: null };
    }
  }

  function bootReporting() {
    try {
      return tracker?.bootReporting?.() || { active: false, remainingMs: 0 };
    } catch {
      return { active: false, remainingMs: 0 };
    }
  }

  /** Busy for events: a turn other than one answering events, or a running task. */
  function isSessionBusy(conversationId) {
    const view = describe(conversationId);
    if (view.runningTaskCount > 0) return true;
    if (view.state !== 'running_turn') return false;
    try {
      return Number(sql.countNonEventTurns.get(conversationId, RELAY_EVENT_MESSAGE_KIND)?.n || 0) > 0;
    } catch {
      return true;
    }
  }

  function candidateSessions(row) {
    if (toText(row.scope) !== 'all') {
      return parseJson(row.session_ids_json, []).map(toText).filter((id) => id && id !== row.watcher_conversation_id);
    }
    const ids = new Set();
    try { for (const r of sql.listBusyConversations.all()) ids.add(toText(r.conversation_id)); } catch {}
    try { for (const r of sql.listRunningRunConversations.all()) ids.add(toText(r.conversation_id)); } catch {}
    for (const id of tracker?.knownConversationIds?.() || []) ids.add(toText(id));
    ids.delete(row.watcher_conversation_id);
    return [...ids].filter((id) => id && isLive(conversation(id)));
  }

  function isWatchedSetBusy(row) {
    if (!row) return false;
    return candidateSessions(row).some(isSessionBusy);
  }

  /** Where a subscription starts from (subscribe, transfer, boot): busy now or not. */
  function noteBusy(row, busy = isWatchedSetBusy(row)) {
    if (!row) return false;
    busyBySubscription.set(row.id, busy);
    idleSinceBySubscription.delete(row.id);
    noteHeartbeatBusy(row, busy);
    return busy;
  }

  function noteHeartbeatBusy(row, busy) {
    if (busy && !busySinceBySubscription.has(row.id)) busySinceBySubscription.set(row.id, now());
    if (!busy) busySinceBySubscription.delete(row.id);
  }

  function busyEntries(row) {
    return candidateSessions(row).filter(isSessionBusy).map((sessionId) => {
      const view = describe(sessionId);
      const what = view.state === 'running_turn'
        ? 'turn'
        : `${view.runningTaskCount} task${view.runningTaskCount === 1 ? '' : 's'}`;
      return { id: sessionId, title: toText(conversation(sessionId)?.title) || null, what };
    });
  }

  function evaluateHeartbeats() {
    const at = now();
    for (const row of localWatchRows()) {
      const minutes = Number(row.heartbeat_minutes);
      if (!(minutes > 0)) continue;
      const busy = busyEntries(row);
      noteHeartbeatBusy(row, busy.length > 0);
      if (!busy.length) continue;
      const since = Math.max(busySinceBySubscription.get(row.id) || at, Date.parse(String(row.last_heartbeat_at || '')) || 0);
      if (at - since < minutes * 60_000) continue;
      sql.markHeartbeat.run(new Date(at).toISOString(), row.id);
      const count = toText(row.scope) === 'all' ? null : parseJson(row.session_ids_json, []).length;
      const event = buildEvent(RELAY_EVENT_HEARTBEAT_TYPE, '', { scope: toText(row.scope), sessionCount: count, subscriptionId: row.id, busy });
      enqueueForRows([row], event, '');
    }
  }

  /**
   * all_idle: a watched set that was busy and now looks idle twice, at least
   * ALL_IDLE_SETTLE_MS apart, fires once; work in between starts over.
   */
  function evaluateAllIdle() {
    const at = now();
    for (const row of localWatchRows()) {
      const busy = isWatchedSetBusy(row);
      if (busy) {
        busyBySubscription.set(row.id, true);
        idleSinceBySubscription.delete(row.id);
        continue;
      }
      if (busyBySubscription.get(row.id) !== true) continue;
      // A runtime that only just started may not have heard yet from the
      // workers that outlived the one before it: a set that looks idle now
      // is not known to be idle, so the look does not count.
      const boot = bootReporting();
      if (boot.active) {
        idleSinceBySubscription.delete(row.id);
        scheduleAllIdleCheck(Math.max(1_000, boot.remainingMs));
        continue;
      }
      const since = idleSinceBySubscription.get(row.id);
      if (!since) {
        idleSinceBySubscription.set(row.id, at);
        scheduleAllIdleCheck(ALL_IDLE_SETTLE_MS);
        continue;
      }
      if (at - since < ALL_IDLE_SETTLE_MS) {
        scheduleAllIdleCheck(Math.max(1_000, since + ALL_IDLE_SETTLE_MS - at));
        continue;
      }
      busyBySubscription.set(row.id, false);
      idleSinceBySubscription.delete(row.id);
      if (!wants(row, 'all_idle')) continue;
      const count = toText(row.scope) === 'all' ? null : parseJson(row.session_ids_json, []).length;
      const event = buildEvent('all_idle', '', { scope: toText(row.scope), sessionCount: count, subscriptionId: row.id });
      enqueueForRows([row], event, '');
    }
  }

  function waitsOnQuestion(sessionId) {
    try {
      return !!sql.hasPendingQuestion?.get(sessionId);
    } catch {
      return false;
    }
  }

  function evaluateStalled() {
    const at = now();
    for (const row of localWatchRows()) {
      if (!wants(row, 'stalled')) continue;
      const limitMs = (Number(row.stalled_minutes) || RELAY_EVENT_LIMITS.stalledMinutesDefault) * 60_000;
      for (const sessionId of candidateSessions(row)) {
        const view = describe(sessionId);
        const key = `${row.id}:${sessionId}`;
        if (view.state === 'idle' || waitsOnQuestion(sessionId)) {
          stallReported.delete(key);
          continue;
        }
        const last = Date.parse(String(view.lastActivityAt || '')) || at;
        if (at - last < limitMs) {
          stallReported.delete(key);
          continue;
        }
        if (stallReported.get(key) === last) continue;
        stallReported.set(key, last);
        const what = view.state === 'running_turn'
          ? 'a turn'
          : `${view.runningTaskCount} background task${view.runningTaskCount === 1 ? '' : 's'}`;
        const event = buildEvent('stalled', sessionId, { quietMinutes: Math.floor((at - last) / 60_000), what, since: view.lastActivityAt });
        enqueueForRows([row], event, sessionId);
      }
    }
  }

  /**
   * Delivered events past RELAY_EVENT_DELIVERED_KEEP_MS and subscriptions
   * ended more than RELAY_EVENT_ENDED_SUBSCRIPTION_KEEP_MS ago go; without
   * this both tables only ever grew. Returns `{ events, subscriptions }`.
   */
  function pruneDelivered() {
    if (!available) return { events: 0, subscriptions: 0 };
    const at = now();
    const events = sql.deleteDeliveredBefore.run(new Date(at - RELAY_EVENT_DELIVERED_KEEP_MS).toISOString()).changes;
    const subscriptions = deleteEndedSubscriptionsBefore.run(new Date(at - RELAY_EVENT_ENDED_SUBSCRIPTION_KEEP_MS).toISOString()).changes;
    if (events || subscriptions) {
      log(`pruned ${events} delivered event${events === 1 ? '' : 's'} and ${subscriptions} ended subscription${subscriptions === 1 ? '' : 's'}`);
    }
    return { events, subscriptions };
  }

  function sweep() {
    if (!available) return;
    try { evaluateStalled(); } catch (error) { warn(`stalled check failed: ${toText(error?.message || error).slice(0, 200)}`); }
    try { evaluateHeartbeats(); } catch (error) { warn(`heartbeat check failed: ${toText(error?.message || error).slice(0, 200)}`); }
    try { evaluateAllIdle(); } catch (error) { warn(`all_idle check failed: ${toText(error?.message || error).slice(0, 200)}`); }
    try { pruneServed(); } catch (error) { warn(`retention for paired relays failed: ${toText(error?.message || error).slice(0, 200)}`); }
    if (now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now();
      try { pruneDelivered(); } catch (error) { warn(`pruning delivered events failed: ${toText(error?.message || error).slice(0, 200)}`); }
    }
  }

  /** Boot: the flush timers of undelivered events, the busy marks, the sweep. */
  function start() {
    if (!available || started) return;
    started = true;
    for (const row of localWatchRows()) noteBusy(row);
    try {
      for (const row of sql.listWatchersWithUndelivered.all()) scheduleFlush(toText(row.watcher_conversation_id));
    } catch {}
    const tick = () => {
      sweepTimer = setTimer(() => {
        sweep();
        if (started) tick();
      }, sweepIntervalMs);
    };
    tick();
  }

  function stop() {
    started = false;
    if (sweepTimer) clearTimer(sweepTimer);
    sweepTimer = null;
    if (allIdleTimer) clearTimer(allIdleTimer);
    allIdleTimer = null;
    for (const { timer } of flushTimers.values()) clearTimer(timer);
    flushTimers.clear();
  }

  return {
    isAvailable: () => available,
    isCrossRelayAvailable: () => crossAvailable,
    subscribe,
    subscribeServed,
    pullServed,
    pruneServed,
    pruneDelivered,
    addMirror,
    mirrorsOf,
    remoteRelaysToPoll,
    remoteWatchers,
    buildRemotePull,
    applyRemotePull,
    noteRemoteLinkRestored,
    getRemoteLink,
    noteRemoteLinkOk,
    noteRemoteLinkFailure,
    noteRelayRemoved,
    checkWatcherCapacity,
    unsubscribe,
    previewTransfer,
    transferSubscriptions,
    listSubscriptions,
    listActive,
    record,
    flush,
    noteTurnEnd,
    noteError,
    noteQuestion,
    noteTaskEdge,
    noteConversationGone,
    afterStateChange,
    sweep,
    start,
    stop,
  };
}
