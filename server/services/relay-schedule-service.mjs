'use strict';

/**
 * Relay schedules: a prompt the relay queues into a session at a set time,
 * once or every N minutes (relay_tool's `schedule`). An agent's own timers
 * die with the relay; these live in the database (migrations/0022-relay-schedules.mjs)
 * and their timers are rebuilt at boot.
 *
 * A firing is an ordinary queued message of the relay's (`messages.kind =
 * 'relay-schedule'`, a pending queue row whose `next_attempt_at` is the time
 * it was due), like the usage-limit follow-up: the worker takes it as it
 * takes any message, a new turn when the session is idle, the next one when
 * it is busy. The row, the schedule's next time and its end are written in
 * one transaction, so a restart neither loses a firing nor repeats it.
 *
 * - A time that passed while the relay was down fires once at boot, not
 *   once per missed interval; a repeating schedule then keeps to its grid
 *   (the first time plus whole intervals).
 * - A repeat is skipped while the message of the firing before it is still
 *   waiting in the queue: a stuck session gets one, not a pile.
 * - A schedule ends after firing when `once`, on unschedule, and when the
 *   session it fires into or the conversation that set it is archived or
 *   deleted (checked again when it comes due). A compaction carries it to
 *   the successor instead, in both directions (carryToCompacted).
 * - A conversation holds at most RELAY_SCHEDULE_LIMITS.perConversation
 *   active schedules firing into it, and may set as many.
 * - A firing into another session is a prompt of the conversation that set
 *   it, counted by the agents' loop guard (`admitFiring`). When that guard
 *   wants the user first, the firing is held (`held_since`) and looked at
 *   again every minute; it goes once the user wrote in that conversation.
 * - Its messages carry the provenance of the turn that set it
 *   (`origin_json`, with that turn's hops): a schedule passes no prompt on
 *   with fewer hops than it came with.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import {
  RELAY_SCHEDULE_LIMITS,
  RELAY_SCHEDULE_MESSAGE_KIND,
  RELAY_SCHEDULE_SOCKET_EVENT,
  buildRelayScheduleMessageText,
  firstRelayScheduleFire,
  nextRelayScheduleFire,
  normalizeRelayScheduleTitle,
} from '../../shared/relay-schedules.mjs';
import { relaySchedulesTableProblem } from '../migrations/0022-relay-schedules.mjs';

const LOG_PREFIX = '[relay-schedules]';
// setTimeout holds at most ~24.8 days; a schedule further out is looked at
// again after this long.
const MAX_TIMER_MS = 6 * 60 * 60_000;
// Ended schedules are kept this long (list_schedules shows the last hour).
const ENDED_KEEP_MS = 7 * 24 * 60 * 60_000;
const ENDED_LISTED_MS = 60 * 60_000;
const TEXT_PREVIEW_CHARS = 200;
// A firing held for the user's approval is looked at again this often.
export const RELAY_SCHEDULE_HOLD_RECHECK_MS = 60_000;

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toText(value) {
  return String(value ?? '').trim();
}

function shortId(value) {
  return toText(value).slice(0, 8);
}

function msOf(value) {
  const ms = Date.parse(toText(value));
  return Number.isFinite(ms) ? ms : null;
}

export class RelayScheduleError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function createRelayScheduleService({
  db,
  stmts,
  emit = () => {},
  // A message was queued: the primer starts a stopped worker, the socket
  // service hands it to a running one.
  wake = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  newId = () => `sch_${randomBytes(6).toString('hex')}`,
  // `({ scheduleId, conversationId, createdBy })` → true when a firing into
  // another session may go: the agents' loop guard of the conversation that
  // set it counts it (remote-relay-dispatcher.mjs admitScheduledFiring).
  admitFiring = () => true,
  logger = console,
} = {}) {
  if (!db) throw new Error('db is required');
  if (!stmts) throw new Error('stmts is required');

  const problem = (() => {
    try {
      return relaySchedulesTableProblem(db);
    } catch (error) {
      return toText(error?.message || error) || 'unreadable';
    }
  })();
  const available = !problem;

  const sql = available ? {
    insert: db.prepare(`
      INSERT INTO relay_schedules
        (id, conversation_id, created_by_conversation_id, title, text, at, every_minutes, once, next_fire_at, created_at, origin_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    get: db.prepare(`SELECT * FROM relay_schedules WHERE id = ?`),
    listActive: db.prepare(`SELECT * FROM relay_schedules WHERE ended_at IS NULL ORDER BY created_at ASC, rowid ASC`),
    listOf: db.prepare(`
      SELECT * FROM relay_schedules
      WHERE (conversation_id = ? OR created_by_conversation_id = ?) AND (ended_at IS NULL OR ended_at >= ?)
      ORDER BY created_at ASC, rowid ASC
    `),
    listActiveOf: db.prepare(`
      SELECT * FROM relay_schedules
      WHERE (conversation_id = ? OR created_by_conversation_id = ?) AND ended_at IS NULL
    `),
    countFiringInto: db.prepare(`SELECT COUNT(*) AS n FROM relay_schedules WHERE conversation_id = ? AND ended_at IS NULL`),
    countSetBy: db.prepare(`SELECT COUNT(*) AS n FROM relay_schedules WHERE created_by_conversation_id = ? AND ended_at IS NULL`),
    end: db.prepare(`UPDATE relay_schedules SET ended_at = ?, end_reason = ?, next_fire_at = NULL WHERE id = ? AND ended_at IS NULL`),
    markFired: db.prepare(`
      UPDATE relay_schedules
      SET last_fired_at = ?, fired_count = fired_count + 1, last_message_id = ?, next_fire_at = ?,
          ended_at = ?, end_reason = ?, held_since = NULL
      WHERE id = ? AND ended_at IS NULL
    `),
    markHeld: db.prepare(`UPDATE relay_schedules SET held_since = COALESCE(held_since, ?) WHERE id = ? AND ended_at IS NULL`),
    // A compaction: the successor takes over both sides.
    carryTarget: db.prepare(`UPDATE relay_schedules SET conversation_id = ? WHERE conversation_id = ? AND ended_at IS NULL`),
    carryCreator: db.prepare(`UPDATE relay_schedules SET created_by_conversation_id = ? WHERE created_by_conversation_id = ? AND ended_at IS NULL`),
    markSkipped: db.prepare(`
      UPDATE relay_schedules SET skipped_count = skipped_count + 1, next_fire_at = ? WHERE id = ? AND ended_at IS NULL
    `),
    pruneEnded: db.prepare(`DELETE FROM relay_schedules WHERE ended_at IS NOT NULL AND ended_at < ?`),
    getConversation: db.prepare(`
      SELECT id, title, archived, status, preferred_relay_mode, preferred_reasoning_effort
      FROM conversations WHERE id = ?
    `),
    queueStatus: db.prepare(`SELECT status FROM queue WHERE id = ?`),
    setNextAttempt: db.prepare(`UPDATE queue SET next_attempt_at = ? WHERE id = ? AND status = 'pending'`),
    // Migration 0005's provenance column; without it a message carries none.
    setMessageOrigin: db.prepare(`PRAGMA table_info(messages)`).all().some((column) => column.name === 'origin_json')
      ? db.prepare(`UPDATE messages SET origin_json = ? WHERE id = ?`)
      : null,
  } : null;

  // schedule id → timer
  const timers = new Map();
  let started = false;

  function isoNow() {
    return new Date(now()).toISOString();
  }

  function log(line) {
    try { logger?.log?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function warn(line) {
    try { logger?.warn?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function requireAvailable() {
    if (!available) {
      throw new RelayScheduleError('unavailable', 'Schedules are not available on this relay right now (see its server log).');
    }
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

  function titleOf(id) {
    return toText(conversation(id)?.title) || null;
  }

  /** A schedule as agents and the browser see it. */
  function shape(row) {
    const own = row.conversation_id === row.created_by_conversation_id;
    const text = String(row.text || '');
    return {
      id: row.id,
      session: { id: row.conversation_id, title: titleOf(row.conversation_id) },
      ...(own ? {} : { setBy: { id: row.created_by_conversation_id, title: titleOf(row.created_by_conversation_id) } }),
      title: toText(row.title) || null,
      text: text.length > TEXT_PREVIEW_CHARS ? `${text.slice(0, TEXT_PREVIEW_CHARS - 1)}…` : text,
      at: row.at || null,
      everyMinutes: row.every_minutes ? Number(row.every_minutes) : null,
      once: Number(row.once) === 1,
      nextFireAt: row.next_fire_at || null,
      lastFiredAt: row.last_fired_at || null,
      firedCount: Number(row.fired_count || 0),
      ...(Number(row.skipped_count || 0) ? { skippedCount: Number(row.skipped_count) } : {}),
      // Due, but held until the user writes in the conversation that set it.
      ...(row.held_since && !row.ended_at ? { heldForApproval: true, heldSince: row.held_since } : {}),
      createdAt: row.created_at,
      ...(row.ended_at ? { endedAt: row.ended_at, endReason: row.end_reason || null } : {}),
    };
  }

  function listActive() {
    if (!available) return [];
    return sql.listActive.all().map(shape);
  }

  function broadcast() {
    try { emit(RELAY_SCHEDULE_SOCKET_EVENT, { schedules: listActive() }); } catch {}
  }

  // ─── Timers ────────────────────────────────────────────────────────────────

  function disarm(id) {
    const timer = timers.get(id);
    if (timer) clearTimer(timer);
    timers.delete(id);
  }

  function arm(row) {
    disarm(row.id);
    if (!started || row.ended_at) return;
    const dueMs = msOf(row.next_fire_at);
    if (dueMs === null) return;
    // A held firing is due already: it is looked at again after a while.
    const delay = row.held_since
      ? RELAY_SCHEDULE_HOLD_RECHECK_MS
      : Math.max(0, Math.min(dueMs - now(), MAX_TIMER_MS));
    timers.set(row.id, setTimer(() => {
      timers.delete(row.id);
      try {
        fireIfDue(row.id);
      } catch (error) {
        warn(`schedule ${row.id} failed to fire: ${toText(error?.message || error).slice(0, 200)}`);
      }
    }, delay));
  }

  // ─── Changes ───────────────────────────────────────────────────────────────

  function checkCapacity(target, creator) {
    const max = RELAY_SCHEDULE_LIMITS.perConversation;
    if (Number(sql.countFiringInto.get(target)?.n || 0) >= max) {
      throw new RelayScheduleError('limit', `Session ${target} already has ${max} schedules; unschedule one first (list_schedules lists them).`, { limit: max });
    }
    if (creator !== target && Number(sql.countSetBy.get(creator)?.n || 0) >= max) {
      throw new RelayScheduleError('limit', `This conversation has set ${max} schedules already; unschedule one first (list_schedules lists them).`, { limit: max });
    }
  }

  /**
   * A new schedule. `conversationId` is the session the prompt goes to,
   * `createdBy` the conversation whose agent set it, `origin` the provenance
   * its messages carry (a remote-relay origin with the setting turn's hops,
   * or null). Returns the schedule.
   */
  function create({ conversationId, createdBy, text, at = null, everyMinutes = null, once = null, title = '', origin = null } = {}) {
    requireAvailable();
    const target = toText(conversationId);
    const creator = toText(createdBy) || target;
    const body = String(text ?? '').trim();
    if (!body) throw new RelayScheduleError('invalid', 'A schedule needs text.');
    if (body.length > RELAY_SCHEDULE_LIMITS.textMax) {
      throw new RelayScheduleError('invalid', `text is longer than ${RELAY_SCHEDULE_LIMITS.textMax} characters`);
    }
    const every = everyMinutes === null || everyMinutes === undefined ? null : Number(everyMinutes);
    if (every !== null && (!Number.isInteger(every) || every < RELAY_SCHEDULE_LIMITS.everyMinutesMin || every > RELAY_SCHEDULE_LIMITS.everyMinutesMax)) {
      throw new RelayScheduleError('invalid', `every_minutes must be ${RELAY_SCHEDULE_LIMITS.everyMinutesMin} to ${RELAY_SCHEDULE_LIMITS.everyMinutesMax}`);
    }
    const atMs = msOf(at);
    if (atMs === null && every === null) throw new RelayScheduleError('invalid', 'A schedule needs at or every_minutes.');
    const isOnce = once === null || once === undefined ? every === null : once === true;
    if (!isOnce && every === null) throw new RelayScheduleError('invalid', 'A schedule that repeats needs every_minutes.');
    if (!isLive(conversation(target))) {
      throw new RelayScheduleError('notFound', `No live session ${target} on this relay; use an id from list_sessions (archived sessions take no schedules).`, { session: target });
    }
    if (creator !== target && !isLive(conversation(creator))) {
      throw new RelayScheduleError('notFound', 'The conversation setting the schedule was not found or is archived.');
    }
    const at0 = atMs === null ? null : new Date(atMs).toISOString();
    const createdAt = isoNow();
    const next = firstRelayScheduleFire({ at: at0, everyMinutes: every, now: now() });
    let id = '';
    db.transaction(() => {
      checkCapacity(target, creator);
      id = newId();
      const originJson = origin && typeof origin === 'object' ? JSON.stringify(origin) : null;
      sql.insert.run(id, target, creator, normalizeRelayScheduleTitle(title) || null, body, at0, every, isOnce ? 1 : 0, next, createdAt, originJson);
    })();
    const row = sql.get.get(id);
    arm(row);
    log(`${id} set for conv=${shortId(target)}${creator !== target ? ` by conv=${shortId(creator)}` : ''}: next ${next}${every ? `, every ${every} min` : ''}${isOnce ? ', once' : ''}`);
    broadcast();
    return shape(row);
  }

  /**
   * The schedules that fire into a conversation or that it set: the active
   * ones and the ones that ended within the last hour.
   */
  function list({ conversationId } = {}) {
    requireAvailable();
    const id = toText(conversationId);
    return sql.listOf.all(id, id, new Date(now() - ENDED_LISTED_MS).toISOString()).map(shape);
  }

  function get(scheduleId) {
    if (!available) return null;
    const row = sql.get.get(toText(scheduleId));
    return row ? shape(row) : null;
  }

  function endRow(row, reason) {
    const changed = sql.end.run(isoNow(), reason, row.id).changes > 0;
    disarm(row.id);
    return changed;
  }

  /**
   * End a schedule. `byConversationId` (an agent's call) may end only one
   * that fires into it or that it set; without it (the user) any.
   */
  function unschedule({ scheduleId, byConversationId = null } = {}) {
    requireAvailable();
    const id = toText(scheduleId);
    const row = id ? sql.get.get(id) : null;
    const by = toText(byConversationId);
    if (!row || (by && row.conversation_id !== by && row.created_by_conversation_id !== by)) {
      throw new RelayScheduleError('notFound', `No schedule ${id} of this conversation; list_schedules lists them.`, { schedule_id: id });
    }
    if (row.ended_at) return shape(row);
    endRow(row, 'unscheduled');
    log(`${id} unscheduled${by ? ` by conv=${shortId(by)}` : ' by the user'}`);
    broadcast();
    return shape(sql.get.get(id));
  }

  /** A conversation was archived or deleted: the schedules that fire into it or that it set end. */
  function noteConversationGone(conversationId, { deleted = false } = {}) {
    if (!available) return 0;
    const id = toText(conversationId);
    if (!id) return 0;
    let ended = 0;
    for (const row of sql.listActiveOf.all(id, id)) {
      if (endRow(row, deleted ? 'deleted' : 'archived')) ended += 1;
    }
    if (ended) {
      log(`conv=${shortId(id)} ${deleted ? 'deleted' : 'archived'}: ${ended} schedule${ended === 1 ? '' : 's'} ended`);
      broadcast();
    }
    return ended;
  }

  /**
   * A conversation was compacted into a new one: its schedules go on there,
   * the ones that fire into it and the ones it set (a nightly schedule of its
   * own survives the compaction). Returns how many moved.
   */
  function carryToCompacted(fromConversationId, toConversationId) {
    if (!available) return 0;
    const from = toText(fromConversationId);
    const to = toText(toConversationId);
    if (!from || !to || from === to) return 0;
    const moved = db.transaction(() => sql.carryTarget.run(to, from).changes + sql.carryCreator.run(to, from).changes)();
    if (moved) {
      log(`conv=${shortId(from)} compacted into conv=${shortId(to)}: its schedules moved along`);
      broadcast();
    }
    return moved;
  }

  // ─── Firing ────────────────────────────────────────────────────────────────

  function queueMessage(target, text, dueAt, origin) {
    const messageId = randomUUID();
    const at = isoNow();
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(target.id) || null;
    const latestModel = stmts.getLatestConversationModel?.get?.(target.id)?.model || null;
    // The model the conversation last ran on, as a relay event picks it.
    const model = toText(latestModel) || toText(runtimeSession?.provider_model) || toText(runtimeSession?.model) || null;
    const relayMode = toText(target.preferred_relay_mode) || 'agent';
    const owner = toText(runtimeSession?.sdk_session_id) || null;
    stmts.insertMsg.run(
      messageId,
      target.id,
      'user',
      text,
      model,
      relayMode,
      null,
      at,
      model,
      null,
      toText(model).toLowerCase() === 'auto' ? 'auto' : 'manual',
    );
    stmts.setMessageKind?.run?.(RELAY_SCHEDULE_MESSAGE_KIND, messageId);
    // The provenance of the turn that set the schedule: its hops go on.
    if (origin) sql.setMessageOrigin?.run(JSON.stringify(origin), messageId);
    stmts.updateConvTime?.run?.(at, target.id);
    const queueArgs = [
      messageId,
      target.id,
      runtimeSession?.id || null,
      0,
      model,
      model,
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
    // Due since the schedule's time: the delivery takes it at once.
    sql.setNextAttempt.run(dueAt, messageId);
    return { messageId, model, relayMode, owner, timestamp: at, text, origin };
  }

  function goneReason(row) {
    return toText(row?.status) === 'deleted' || !row ? 'deleted' : 'archived';
  }

  /**
   * Fire a schedule whose time has come; anything else is left (re-armed).
   * Returns `{ fired, skipped, held, ended, messageId }` or null.
   */
  function fireIfDue(scheduleId) {
    if (!available) return null;
    const row = sql.get.get(toText(scheduleId));
    if (!row || row.ended_at) return null;
    const dueMs = msOf(row.next_fire_at);
    if (dueMs === null) return null;
    if (dueMs > now()) {
      arm(row);
      return null;
    }
    const target = conversation(row.conversation_id);
    const forOther = row.created_by_conversation_id !== row.conversation_id;
    // The session it fires into, and the one that set it, must still be
    // there (a compaction carried them over to the successor).
    const creator = forOther ? conversation(row.created_by_conversation_id) : target;
    if (!isLive(target) || !isLive(creator)) {
      endRow(row, goneReason(!isLive(target) ? target : creator));
      broadcast();
      return { fired: false, skipped: false, held: false, ended: true, messageId: null };
    }
    const dueAt = new Date(dueMs).toISOString();
    const every = row.every_minutes ? Number(row.every_minutes) : null;
    const once = Number(row.once) === 1;
    const next = once ? null : nextRelayScheduleFire({ dueAt, everyMinutes: every, now: now() });
    const waiting = row.last_message_id ? toText(sql.queueStatus.get(row.last_message_id)?.status) : '';
    // The firing before still waits for the session: this one is skipped
    // (a once schedule has none before it).
    const skip = !once && (waiting === 'pending' || waiting === 'parked');
    // A firing into another session is a prompt of the conversation that set
    // it: the agents' loop guard counts it, and holds it once it wants the
    // user first (it goes after the user wrote in that conversation).
    let admitted = true;
    if (!skip && forOther) {
      try {
        admitted = admitFiring({ scheduleId: row.id, conversationId: row.conversation_id, createdBy: row.created_by_conversation_id }) !== false;
      } catch (error) {
        warn(`schedule ${row.id}: the loop guard could not be asked (${toText(error?.message || error).slice(0, 200)}); held`);
        admitted = false;
      }
    }
    if (!admitted) {
      const first = !row.held_since;
      sql.markHeld.run(isoNow(), row.id);
      arm(sql.get.get(row.id));
      if (first) {
        log(`${row.id} held for conv=${shortId(row.conversation_id)}: conv=${shortId(row.created_by_conversation_id)} has prompted other agents as often as it may before the user writes`);
        broadcast();
      }
      return { fired: false, skipped: false, held: true, ended: false, messageId: null };
    }
    const origin = parseJson(row.origin_json);
    let queued = null;
    db.transaction(() => {
      if (skip) {
        sql.markSkipped.run(next, row.id);
        return;
      }
      const setBy = row.created_by_conversation_id !== row.conversation_id
        ? { id: row.created_by_conversation_id, title: titleOf(row.created_by_conversation_id) }
        : null;
      const text = buildRelayScheduleMessageText({ id: row.id, title: row.title, setBy, text: row.text });
      queued = queueMessage(target, text, dueAt, origin);
      sql.markFired.run(isoNow(), queued.messageId, next, once ? isoNow() : null, once ? 'fired' : null, row.id);
    })();
    const after = sql.get.get(row.id);
    if (after && !after.ended_at) arm(after);
    else disarm(row.id);
    if (skip) {
      log(`${row.id} skipped for conv=${shortId(row.conversation_id)}: the message before still waits; next ${next}`);
      broadcast();
      return { fired: false, skipped: true, held: false, ended: false, messageId: null };
    }
    try {
      emit('user_message', {
        conversationId: target.id,
        messageId: queued.messageId,
        senderClientId: null,
        message: {
          role: 'user',
          text: queued.text,
          model: queued.model,
          mode: queued.relayMode,
          attachments: [],
          timestamp: queued.timestamp,
          kind: RELAY_SCHEDULE_MESSAGE_KIND,
          ...(queued.origin ? { origin: queued.origin } : {}),
        },
      });
    } catch {}
    try { emit('message_status', { messageId: queued.messageId, conversationId: target.id, status: 'pending' }); } catch {}
    try { wake({ conversationId: target.id, ownerSessionId: queued.owner, messageId: queued.messageId }); } catch {}
    log(`${row.id} fired into conv=${shortId(target.id)}${once ? ' (ended: once)' : `; next ${next}`}`);
    broadcast();
    return { fired: true, skipped: false, held: false, ended: once, messageId: queued.messageId };
  }

  function pruneEnded() {
    if (!available) return 0;
    return sql.pruneEnded.run(new Date(now() - ENDED_KEEP_MS).toISOString()).changes;
  }

  /** Boot: every active schedule gets its timer; one that was due while the relay was down fires now, once. */
  function start() {
    if (!available) {
      if (problem) warn(`schedules are off: ${problem}`);
      return;
    }
    if (started) return;
    started = true;
    try { pruneEnded(); } catch {}
    for (const row of sql.listActive.all()) arm(row);
  }

  function stop() {
    started = false;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }

  return {
    isAvailable: () => available,
    create,
    list,
    listActive,
    get,
    unschedule,
    noteConversationGone,
    carryToCompacted,
    fireIfDue,
    pruneEnded,
    start,
    stop,
  };
}
