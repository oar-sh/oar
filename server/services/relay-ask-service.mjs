'use strict';

/**
 * Questions that don't block: relay_tool's `ask` (shared/relay-asks.mjs).
 * An agent asks the owner something and goes on working; the question shows
 * as a card in its session and in the Inbox, and when the owner answers or
 * dismisses it the relay tells the session the ask is in and the
 * conversation that asked (a lead asking for its implementer) with a relay
 * event, question_answered (relay-event-service.mjs noteQuestionAnswered).
 *
 * Kept in `relay_asks` (migrations/0023-relay-asks.mjs), never in
 * `relay_questions`: those cards belong to a turn that waits on them, and the
 * queue, the stall check and the expiry treat them so.
 *
 * Across paired relays an ask lives where its session lives:
 *
 * - Asked here by a paired relay's agent (`creator`): stored like any, with
 *   that relay's id and conversation; that relay looks for the outcome
 *   (statusForRelay) and tells its own conversation. The session here is
 *   told by this relay.
 * - Asked by this relay's agent about a session on a paired relay: stored
 *   there; here a mirror row (`relay_id` = the pairing's registry id,
 *   `remote_id` = its id there) that the link (relay-ask-link-service.mjs)
 *   brings up to date until it is closed, then the conversation that asked
 *   is told (applyRemoteStatus).
 *
 * A pending ask ends when its session is archived or deleted (cancelled,
 * nobody told) and moves with a compaction. Closed asks are kept a week.
 */

import { randomBytes } from 'node:crypto';

import {
  RELAY_ASK_CLOSED_STATUSES,
  RELAY_ASK_ID_PREFIX,
  RELAY_ASK_KIND,
  RELAY_ASK_LIMITS,
  RELAY_ASK_SOCKET_EVENT,
  normalizeRelayAskAnswer,
  normalizeRelayAskInput,
} from '../../shared/relay-asks.mjs';
import { relayAsksTableProblem } from '../migrations/0023-relay-asks.mjs';

const LOG_PREFIX = '[relay-asks]';
const SELF = 'self';
const PRUNE_INTERVAL_MS = 60 * 60_000;

function toText(value) {
  return String(value ?? '').trim();
}

function shortId(value) {
  return toText(value).slice(0, 8);
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function clip(value, max) {
  return toText(value).replace(/[\r\n]+/g, ' ').slice(0, max);
}

export class RelayAskError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/** A paired relay's asker as stored: capped one-line texts, nothing else. */
export function normalizeRelayAskCreator(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const creator = {
    relayId: clip(raw.relayId, 100),
    relayName: clip(raw.relayName, 60),
    conversationId: clip(raw.conversationId, 200),
    conversationTitle: clip(raw.conversationTitle, 200),
  };
  return creator.relayId ? creator : null;
}

export function createRelayAskService({
  db,
  emit = () => {},
  // relay-event-service.mjs: question_asked for watchers, question_answered
  // for the askers.
  relayEvents = null,
  // push-dispatch-service.mjs notifyQuestion, for urgency "now".
  pushQuestion = () => {},
  now = () => Date.now(),
  newId = () => `${RELAY_ASK_ID_PREFIX}${randomBytes(6).toString('hex')}`,
  logger = console,
} = {}) {
  if (!db) throw new Error('db is required');

  const problem = (() => {
    try {
      return relayAsksTableProblem(db);
    } catch (error) {
      return toText(error?.message || error) || 'unreadable';
    }
  })();
  const available = !problem;

  const sql = available ? {
    insert: db.prepare(`
      INSERT INTO relay_asks
        (id, relay_id, remote_id, conversation_id, conversation_title, created_by, creator_json,
         question, options_json, recommendation, detail, urgency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `),
    get: db.prepare(`SELECT * FROM relay_asks WHERE id = ?`),
    getMirror: db.prepare(`SELECT * FROM relay_asks WHERE relay_id = ? AND remote_id = ?`),
    // The Inbox: this relay's asks, pending and closed since.
    listHere: db.prepare(`
      SELECT * FROM relay_asks
      WHERE relay_id = 'self' AND (status = 'pending' OR (status IN ('answered', 'dismissed') AND answered_at >= ?))
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `),
    // list_questions: the asks in a session or asked by it, mirrors included.
    listOf: db.prepare(`
      SELECT * FROM relay_asks
      WHERE (conversation_id = ? OR created_by = ?)
        AND (status = 'pending' OR (status <> 'pending' AND updated_at >= ?))
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `),
    countPendingHere: db.prepare(`SELECT COUNT(*) AS n FROM relay_asks WHERE relay_id = 'self' AND status = 'pending'`),
    countPendingIn: db.prepare(`SELECT COUNT(*) AS n FROM relay_asks WHERE relay_id = 'self' AND conversation_id = ? AND status = 'pending'`),
    countPendingBy: db.prepare(`SELECT COUNT(*) AS n FROM relay_asks WHERE created_by = ? AND status = 'pending'`),
    close: db.prepare(`
      UPDATE relay_asks SET status = ?, answer = ?, choice = ?, answered_at = ?, answered_via = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `),
    markNotified: db.prepare(`UPDATE relay_asks SET notified_at = ? WHERE id = ?`),
    listPendingIn: db.prepare(`SELECT * FROM relay_asks WHERE relay_id = 'self' AND conversation_id = ? AND status = 'pending'`),
    cancelIn: db.prepare(`
      UPDATE relay_asks SET status = 'cancelled', updated_at = ? WHERE relay_id = 'self' AND conversation_id = ? AND status = 'pending'
    `),
    cancelMirrorsBy: db.prepare(`
      UPDATE relay_asks SET status = 'cancelled', updated_at = ? WHERE relay_id <> 'self' AND created_by = ? AND status = 'pending'
    `),
    carryIn: db.prepare(`UPDATE relay_asks SET conversation_id = ? WHERE relay_id = 'self' AND conversation_id = ? AND status = 'pending'`),
    carryBy: db.prepare(`UPDATE relay_asks SET created_by = ? WHERE created_by = ? AND status = 'pending'`),
    // Mirrors: the paired relays with asks of this relay's agents still open there.
    listMirrorRelays: db.prepare(`SELECT DISTINCT relay_id FROM relay_asks WHERE relay_id <> 'self' AND status = 'pending'`),
    listPendingMirrors: db.prepare(`SELECT * FROM relay_asks WHERE relay_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?`),
    // Mirrors of a removed pairing: nobody answers them any more.
    cancelMirrorsOf: db.prepare(`UPDATE relay_asks SET status = 'cancelled', updated_at = ? WHERE relay_id = ? AND status = 'pending'`),
    pruneClosed: db.prepare(`DELETE FROM relay_asks WHERE status <> 'pending' AND updated_at < ?`),
    getConversation: db.prepare(`SELECT id, title, archived, status, origin_json FROM conversations WHERE id = ?`),
  } : null;

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

  function requireAvailable() {
    if (!available) {
      throw new RelayAskError('unavailable', 'Questions that don\'t block are not available on this relay right now (see its server log).');
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

  /** An ask as agents, the session's card and the Inbox see it. */
  function shape(row) {
    if (!row) return null;
    const mirror = toText(row.relay_id) !== SELF;
    const session = mirror ? null : conversation(row.conversation_id);
    const creator = normalizeRelayAskCreator(parseJson(row.creator_json, null));
    const asker = conversation(row.created_by);
    const options = parseJson(row.options_json, []);
    const closed = toText(row.status) !== 'pending';
    return {
      id: mirror ? toText(row.remote_id) : row.id,
      kind: RELAY_ASK_KIND,
      ...(mirror ? { relayId: row.relay_id } : {}),
      session: {
        id: row.conversation_id,
        title: (mirror ? toText(row.conversation_title) : toText(session?.title)) || null,
        // Who started the session: the owner, or an agent (the Inbox's filter).
        ...(mirror ? {} : { startedBy: toText(session?.origin_json) ? 'agent' : 'owner' }),
      },
      // The card views of relay questions read these names.
      conversationId: row.conversation_id,
      prompt: row.question,
      choices: Array.isArray(options) ? options : [],
      question: row.question,
      options: Array.isArray(options) ? options : [],
      recommendation: toText(row.recommendation) || null,
      detail: String(row.detail || '') || null,
      urgency: row.urgency === 'now' ? 'now' : 'normal',
      status: row.status,
      ...(row.status === 'answered' ? { answer: row.answer || '', choice: toText(row.choice) || null } : {}),
      ...(closed && row.answered_at ? { answeredAt: row.answered_at } : {}),
      ...(closed && toText(row.answered_via) ? { answeredVia: toText(row.answered_via) } : {}),
      // Who asked: a conversation here, or a paired relay's agent.
      askedBy: creator
        ? { relay: creator.relayName || null, conversationId: creator.conversationId || null, title: creator.conversationTitle || null }
        : (toText(row.created_by) ? { conversationId: row.created_by, title: toText(asker?.title) || null } : null),
      onBehalf: creator ? true : (!!toText(row.created_by) && row.created_by !== row.conversation_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function pendingCount() {
    if (!available) return 0;
    try {
      return Number(sql.countPendingHere.get()?.n || 0);
    } catch {
      return 0;
    }
  }

  function changed(row) {
    try { emit(RELAY_ASK_SOCKET_EVENT, { ask: shape(row), pending: pendingCount() }); } catch {}
  }

  function prune() {
    if (!available || now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now();
    try {
      sql.pruneClosed.run(new Date(now() - RELAY_ASK_LIMITS.closedKeepMs).toISOString());
    } catch (error) {
      warn(`prune failed: ${toText(error?.message || error).slice(0, 200)}`);
    }
  }

  /**
   * Stores an ask about `conversationId` (a session of this relay). The asker
   * is `createdBy` (a conversation here: the same one, or a lead asking for
   * another) or `creator` (a paired relay's agent). Returns the ask.
   */
  function create({ conversationId, createdBy = null, creator = null, ...input } = {}) {
    requireAvailable();
    const session = conversation(conversationId);
    if (!isLive(session)) {
      throw new RelayAskError('notFound', `No live session ${toText(conversationId)} on this relay; use an id from list_sessions.`, { session: toText(conversationId) });
    }
    const checked = normalizeRelayAskInput(input);
    if (!checked.ok) throw new RelayAskError('invalid', checked.error);
    const asker = toText(createdBy) || null;
    const remoteCreator = asker ? null : normalizeRelayAskCreator(creator);
    const limit = RELAY_ASK_LIMITS.pendingPerConversation;
    if (asker && Number(sql.countPendingBy.get(asker)?.n || 0) >= limit) {
      throw new RelayAskError('limit', `This conversation already has ${limit} questions pending; withdraw one (list_questions shows them) or wait for an answer.`);
    }
    if (Number(sql.countPendingIn.get(session.id)?.n || 0) >= limit) {
      throw new RelayAskError('limit', `Session ${session.id} already has ${limit} questions pending for the user; wait for an answer.`);
    }
    const { question, options, recommendation, detail, urgency } = checked.value;
    const id = newId();
    const at = isoNow();
    sql.insert.run(
      id,
      SELF,
      null,
      session.id,
      null,
      asker,
      remoteCreator ? JSON.stringify(remoteCreator) : null,
      question,
      options.length ? JSON.stringify(options) : null,
      recommendation || null,
      detail || null,
      urgency,
      at,
      at,
    );
    const row = sql.get.get(id);
    const ask = shape(row);
    log(`${id} in ${shortId(session.id)} by ${remoteCreator ? `relay ${shortId(remoteCreator.relayId)}` : shortId(asker)}${urgency === 'now' ? ' (now)' : ''}`);
    changed(row);
    try { relayEvents?.noteQuestion?.({ id, conversationId: session.id, prompt: question, choices: options, kind: RELAY_ASK_KIND }); } catch {}
    if (urgency === 'now') {
      try { void pushQuestion({ id, conversationId: session.id, prompt: question, choices: options }); } catch {}
    }
    prune();
    return ask;
  }

  function get(id) {
    if (!available) return null;
    const row = sql.get.get(toText(id));
    return row && row.relay_id === SELF ? shape(row) : null;
  }

  /** The Inbox's asks of this relay: pending, and those closed in the last answeredKeepMs. */
  function listHere() {
    if (!available) return [];
    const since = new Date(now() - RELAY_ASK_LIMITS.answeredKeepMs).toISOString();
    return sql.listHere.all(since, RELAY_ASK_LIMITS.listMax).map(shape);
  }

  /**
   * list_questions: the asks in a conversation or asked by it (mirrors on
   * paired relays included), pending first, then those closed in the last
   * answeredKeepMs.
   */
  function listOf(conversationId) {
    if (!available) return [];
    const id = toText(conversationId);
    const since = new Date(now() - RELAY_ASK_LIMITS.answeredKeepMs).toISOString();
    const rows = sql.listOf.all(id, id, since, RELAY_ASK_LIMITS.listMax);
    return [...rows.filter((row) => row.status === 'pending'), ...rows.filter((row) => row.status !== 'pending')].map(shape);
  }

  /** Who is told the outcome of a row here: its session and the conversation that asked. */
  function tell(row) {
    const ask = shape(row);
    // `via`: the paired relay whose Inbox it came from; none for this relay's
    // own UI (the event service names this relay then).
    const via = toText(row.answered_via) ? { via: toText(row.answered_via) } : {};
    const detail = row.status === 'answered'
      ? { questionId: row.id, prompt: row.question, answer: row.answer || '', choice: toText(row.choice), ...via }
      : { questionId: row.id, prompt: row.question, dismissed: true, ...via };
    try {
      const notify = [...new Set([row.conversation_id, row.created_by].filter(Boolean))];
      relayEvents?.noteQuestionAnswered?.({ sessionId: row.conversation_id, notify, detail });
      sql.markNotified.run(isoNow(), row.id);
    } catch (error) {
      warn(`${row.id} outcome not told: ${toText(error?.message || error).slice(0, 200)}`);
    }
    return ask;
  }

  function closeHere(id, status, { answer = null, choice = null, via = null } = {}) {
    requireAvailable();
    const row = sql.get.get(toText(id));
    if (!row || row.relay_id !== SELF) throw new RelayAskError('notFound', `No question ${toText(id)} on this relay.`);
    if (row.status !== 'pending') throw new RelayAskError('closed', `Question ${row.id} is already ${row.status}.`, { status: row.status });
    const at = isoNow();
    const result = sql.close.run(status, answer, choice || null, at, clip(via, 60) || null, at, row.id);
    if (!result.changes) throw new RelayAskError('closed', `Question ${row.id} was closed meanwhile.`);
    return sql.get.get(row.id);
  }

  /**
   * The owner's answer: `choice` (an option) and/or `answer` (text). `via`
   * names the paired relay whose Inbox it came from (null: this relay's own
   * UI). Tells the session and the asker. Returns the ask.
   */
  function answer(id, { answer: text = '', choice = '', via = null } = {}) {
    requireAvailable();
    const current = sql.get.get(toText(id));
    if (!current || current.relay_id !== SELF) throw new RelayAskError('notFound', `No question ${toText(id)} on this relay.`);
    const checked = normalizeRelayAskAnswer(shape(current), { answer: text, choice });
    if (!checked.ok) throw new RelayAskError('invalid', checked.error);
    const row = closeHere(id, 'answered', { answer: checked.value.answer, choice: checked.value.choice, via });
    log(`${row.id} answered${via ? ` from relay ${clip(via, 30)}` : ''}`);
    changed(row);
    return tell(row);
  }

  /** The owner dismissed it: the asker is told there will be no answer. */
  function dismiss(id, { via = null } = {}) {
    const row = closeHere(id, 'dismissed', { via });
    log(`${row.id} dismissed${via ? ` from relay ${clip(via, 30)}` : ''}`);
    changed(row);
    return tell(row);
  }

  /**
   * The agent that asked takes it back: `byConversationId` (a conversation
   * here) or `byRelayId` (a paired relay's id, for its agents' asks). Nobody
   * is told: the asker knows.
   */
  function withdraw(id, { byConversationId = null, byRelayId = null } = {}) {
    requireAvailable();
    const row = sql.get.get(toText(id));
    if (!row || row.relay_id !== SELF) throw new RelayAskError('notFound', `No question ${toText(id)} on this relay.`);
    const creator = normalizeRelayAskCreator(parseJson(row.creator_json, null));
    const mine = byRelayId
      ? !!creator && creator.relayId === toText(byRelayId)
      : !!toText(byConversationId) && row.created_by === toText(byConversationId);
    if (!mine) throw new RelayAskError('forbidden', `Question ${row.id} was asked by another conversation; only the one that asked may withdraw it.`);
    const closed = closeHere(row.id, 'withdrawn');
    log(`${row.id} withdrawn`);
    changed(closed);
    return shape(closed);
  }

  /** Its session was archived or deleted: its pending asks end, and so do the mirrors it asked. */
  function noteConversationGone(conversationId) {
    if (!available) return 0;
    const id = toText(conversationId);
    if (!id) return 0;
    const pending = sql.listPendingIn.all(id);
    const at = isoNow();
    const cancelled = sql.cancelIn.run(at, id).changes + sql.cancelMirrorsBy.run(at, id).changes;
    for (const row of pending) changed(sql.get.get(row.id));
    if (cancelled) log(`conv=${shortId(id)} gone: ${cancelled} pending question${cancelled === 1 ? '' : 's'} cancelled`);
    return cancelled;
  }

  /** A compaction: the successor takes over the asks in and by the conversation. */
  function carryToCompacted(sourceId, targetId) {
    if (!available) return 0;
    const from = toText(sourceId);
    const to = toText(targetId);
    if (!from || !to || from === to) return 0;
    const moved = db.transaction(() => sql.carryIn.run(to, from).changes + sql.carryBy.run(to, from).changes)();
    if (moved) log(`conv=${shortId(from)} compacted into ${shortId(to)}: ${moved} question${moved === 1 ? '' : 's'} moved`);
    return moved;
  }

  // ─── Paired relays: the side where the session lives ───────────────────────

  /**
   * What a paired relay may learn of the asks its agents asked here: per id,
   * the status and the outcome, for the asks its relay id created only (any
   * other id reads as unknown).
   */
  function statusForRelay({ relayId, ids = [] } = {}) {
    requireAvailable();
    const subscriber = toText(relayId);
    return (Array.isArray(ids) ? ids : []).slice(0, RELAY_ASK_LIMITS.listMax).map((raw) => {
      const id = toText(raw);
      const row = id ? sql.get.get(id) : null;
      const creator = row && row.relay_id === SELF ? normalizeRelayAskCreator(parseJson(row.creator_json, null)) : null;
      if (!creator || creator.relayId !== subscriber) return { id, status: 'unknown' };
      return {
        id,
        status: row.status,
        ...(row.status === 'answered' ? { answer: row.answer || '', choice: toText(row.choice) || null } : {}),
        ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
        // A paired relay's Inbox it was answered from (none: this relay's UI).
        ...(toText(row.answered_via) ? { answeredVia: toText(row.answered_via) } : {}),
        session: { id: row.conversation_id, title: toText(conversation(row.conversation_id)?.title) || null },
      };
    });
  }

  // ─── Paired relays: the side whose agent asked ─────────────────────────────

  /**
   * This relay's copy of an ask its agent (`createdBy`) put on the paired
   * relay `relayId`; `remote` is the ask as that relay returned it.
   */
  function addMirror({ relayId, createdBy, remote } = {}) {
    requireAvailable();
    const relay = toText(relayId);
    const remoteId = toText(remote?.id);
    if (!relay || relay === SELF || !remoteId) throw new RelayAskError('invalid', 'The paired relay did not return the question.');
    const checked = normalizeRelayAskInput(remote);
    if (!checked.ok) throw new RelayAskError('invalid', `The paired relay returned a question this relay does not take: ${checked.error}`);
    const { question, options, recommendation, detail, urgency } = checked.value;
    const at = isoNow();
    const id = newId();
    sql.insert.run(
      id,
      relay,
      remoteId,
      clip(remote?.session?.id || remote?.conversationId, 200),
      clip(remote?.session?.title, 200) || null,
      toText(createdBy) || null,
      null,
      question,
      options.length ? JSON.stringify(options) : null,
      recommendation || null,
      detail || null,
      urgency,
      at,
      at,
    );
    log(`${remoteId} asked on relay ${shortId(relay)} by ${shortId(createdBy)}`);
    return shape(sql.get.get(id));
  }

  function getMirror(relayId, remoteId) {
    if (!available) return null;
    return shape(sql.getMirror.get(toText(relayId), toText(remoteId)));
  }

  /** The paired relays with asks of this relay's agents still open there. */
  function mirrorRelays() {
    if (!available) return [];
    try {
      return sql.listMirrorRelays.all().map((row) => toText(row.relay_id)).filter(Boolean);
    } catch {
      return [];
    }
  }

  function pendingMirrorIds(relayId) {
    if (!available) return [];
    return sql.listPendingMirrors.all(toText(relayId), RELAY_ASK_LIMITS.listMax).map((row) => toText(row.remote_id));
  }

  /**
   * What the paired relay said of this relay's asks there: each one closed
   * there is closed here, and its asker told (answered or dismissed; a
   * withdrawn or vanished one quietly). Returns how many closed.
   */
  function applyRemoteStatus(relayId, { relayName = '', statuses = [] } = {}) {
    if (!available) return 0;
    const relay = toText(relayId);
    let closed = 0;
    for (const state of Array.isArray(statuses) ? statuses : []) {
      const row = sql.getMirror.get(relay, toText(state?.id));
      if (!row || row.status !== 'pending') continue;
      const status = toText(state.status);
      if (status === 'pending') continue;
      const final = ['answered', 'dismissed', 'withdrawn', 'cancelled'].includes(status) ? status : 'cancelled';
      const at = isoNow();
      const text = final === 'answered' ? String(state.answer ?? '').slice(0, RELAY_ASK_LIMITS.detailMax) : null;
      const choice = final === 'answered' ? clip(state.choice, RELAY_ASK_LIMITS.optionMax) : null;
      // The Inbox of a relay paired with that one it came from (this one,
      // say); none: that relay's own UI, named by the event service.
      const via = clip(state.answeredVia, 60);
      if (!sql.close.run(final, text, choice || null, at, via || null, at, row.id).changes) continue;
      closed += 1;
      if (RELAY_ASK_CLOSED_STATUSES.includes(final) && toText(row.created_by)) {
        try {
          relayEvents?.noteQuestionAnswered?.({
            sessionId: row.conversation_id,
            sessionTitle: clip(state?.session?.title, 200) || row.conversation_title,
            relay: { id: relay, name: toText(relayName) || relay },
            notify: [row.created_by],
            detail: final === 'answered'
              ? { questionId: row.remote_id, prompt: row.question, answer: text || '', choice: choice || '', ...(via ? { via } : {}) }
              : { questionId: row.remote_id, prompt: row.question, dismissed: true, ...(via ? { via } : {}) },
          });
          sql.markNotified.run(isoNow(), row.id);
        } catch (error) {
          warn(`${row.remote_id} outcome not told: ${toText(error?.message || error).slice(0, 200)}`);
        }
      }
      log(`${row.remote_id} on relay ${shortId(relay)} ${final}`);
    }
    return closed;
  }

  /** The pairing was removed: its open mirrors end. */
  function noteRelayRemoved(relayId) {
    if (!available) return 0;
    return sql.cancelMirrorsOf.run(isoNow(), toText(relayId)).changes;
  }

  /** The agent withdrew a mirror's ask there: closed here too. */
  function closeMirror(relayId, remoteId, status = 'withdrawn') {
    if (!available) return null;
    const row = sql.getMirror.get(toText(relayId), toText(remoteId));
    if (!row) return null;
    if (row.status === 'pending') {
      const at = isoNow();
      sql.close.run(status, null, null, at, null, at, row.id);
    }
    return shape(sql.get.get(row.id));
  }

  return {
    isAvailable: () => available,
    problem: () => problem,
    create,
    get,
    listHere,
    listOf,
    pendingCount,
    answer,
    dismiss,
    withdraw,
    noteConversationGone,
    carryToCompacted,
    statusForRelay,
    addMirror,
    getMirror,
    mirrorRelays,
    pendingMirrorIds,
    applyRemoteStatus,
    closeMirror,
    noteRelayRemoved,
  };
}
