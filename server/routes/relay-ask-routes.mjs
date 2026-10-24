'use strict';

// Questions that don't block (remote_relay `ask`) and the Inbox.
//
// For the browser (this relay's user; a request from another relay's agent,
// or this relay's own through the loopback, is refused):
//
//   GET  /api/relay-asks?conversationId=   the asks a session's card shows
//   GET  /api/inbox                        every pending question here and on
//                                          each paired relay that answers
//   POST /api/inbox/relays/:relayId/asks/:id/answer | /dismiss
//                                          an ask of a paired relay, answered
//                                          from this Inbox (its cards are
//                                          answered there only)
//
// An ask of this relay is answered through the question routes
// (ask-user-routes.mjs), like a card.
//
// For paired relays (only another relay's request, under the inbound switch,
// filed under the relay id it states):
//
//   POST /api/relay-asks/remote/ask        its agent asks about a session here
//   POST /api/relay-asks/remote/status     the outcome of the asks it asked
//   POST /api/relay-asks/remote/withdraw   it takes one back
//   POST /api/relay-asks/remote/answer | /dismiss
//                                          its user answers an ask of this
//                                          relay from its Inbox: asks only;
//                                          an approval or any other card is
//                                          never answered over the pairing
//   GET  /api/relay-asks/remote/inbox      what its Inbox shows of this relay
//
// Every text of an ask or card is an agent's: it goes out as data, and the
// browser shows it as plain text.

import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_ASK_LIMITS, relayQuestionKind } from '../../shared/relay-asks.mjs';
import { schemaFields } from '../../shared/question-schema.mjs';
import { findOriginRemoteRelay, admitRemoteRelayRequest, readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { RelayAskError } from '../services/relay-ask-service.mjs';
import { cleanSubscriberRelayId } from '../services/relay-event-service.mjs';
import { RELAY_ASK_REMOTE_PATHS, isMissingRelayAskRoute } from '../services/relay-ask-link-service.mjs';

const RELAY_ASK_ERROR_STATUS = Object.freeze({
  invalid: [400, REMOTE_RELAY_ERROR_CODES.invalidInput],
  notFound: [404, REMOTE_RELAY_ERROR_CODES.notFound],
  closed: [409, `${REMOTE_RELAY_ERROR_CODES.httpPrefix}409`],
  forbidden: [403, REMOTE_RELAY_ERROR_CODES.forbidden],
  limit: [409, REMOTE_RELAY_ERROR_CODES.questionLimit],
  unavailable: [503, REMOTE_RELAY_ERROR_CODES.unsupported],
});

// A paired relay's Inbox is asked this long before it counts as unreachable.
const INBOX_REMOTE_TIMEOUT_MS = 5_000;
// Cards answered in the last day are listed under the divider, at most these.
const INBOX_ANSWERED_CARDS_MAX = 50;
// Registry states that mean "do not even try" for the Inbox.
const UNREACHABLE_STATES = new Set(['offline', 'unauthorized']);

export function sendRelayAskError(res, error, what) {
  if (error instanceof RelayAskError) {
    const [status, code] = RELAY_ASK_ERROR_STATUS[error.code] || [400, REMOTE_RELAY_ERROR_CODES.invalidInput];
    return res.status(status).json({ error: error.message, code, ...(error.extra && typeof error.extra === 'object' ? error.extra : {}) });
  }
  return res.status(500).json({ error: `${what} failed: ${String(error?.message || error)}`, code: REMOTE_RELAY_ERROR_CODES.internal });
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * One Inbox item of a card a turn waits on (a formatted relay question).
 * `forRemote`: for a paired relay's Inbox, where it is shown, never
 * answered: an approval card goes with its header alone, an answered card
 * without its answer, and nothing that routes an answer goes at all.
 */
export function inboxItemOfCard(question, session, { forRemote = false } = {}) {
  const kind = relayQuestionKind(question);
  const context = asObject(question?.context);
  const base = {
    id: toText(question?.id),
    kind,
    session,
    header: toText(context.header) || null,
    status: toText(question?.status) || 'pending',
    createdAt: question?.createdAt || null,
    ...(question?.status === 'answered' ? { answeredAt: question?.answeredAt || null } : {}),
  };
  if (forRemote && kind === 'approval') return { ...base, question: '' };
  const fields = schemaFields(question?.requestSchema);
  return {
    ...base,
    question: String(question?.prompt || ''),
    options: Array.isArray(question?.choices) ? question.choices.map((choice) => String(choice ?? '')).filter(Boolean) : [],
    allowFreeform: question?.allowFreeform !== false,
    multiSelect: context.multiSelect === true,
    structured: fields.length > 0,
    // A paired relay learns that a card was answered, never the answer.
    ...(forRemote ? {} : {
      ...(question?.status === 'answered' ? { answer: String(question?.answer || '') } : {}),
      sdkSessionId: question?.sdkSessionId || null,
    }),
  };
}

/** One Inbox item of an ask (relay-ask-service.mjs shape). */
export function inboxItemOfAsk(ask) {
  const {
    id, session, question, options, recommendation, detail, urgency, status, answer, choice,
    answeredAt, answeredVia, askedBy, onBehalf, createdAt,
  } = ask;
  return {
    id,
    kind: 'ask',
    session,
    question,
    options,
    recommendation,
    detail,
    urgency,
    status,
    ...(answer !== undefined ? { answer, choice } : {}),
    ...(answeredAt ? { answeredAt } : {}),
    ...(answeredVia ? { answeredVia } : {}),
    askedBy,
    onBehalf,
    allowFreeform: true,
    createdAt,
  };
}

export function registerRelayAskRoutes(app, deps) {
  const {
    auth,
    db,
    stmts,
    formatQuestionRow,
    relayAskService = null,
    relayAskLinkService = null,
    remoteRelayInbound = null,
    // The pairings (remote-relay-registry-service.mjs) and the client that
    // calls them (remote-relay-client.mjs): the Inbox of paired relays.
    remoteRelayRegistry = null,
    remoteRelayClient = null,
    now = () => Date.now(),
  } = deps;

  const conversationStmt = db?.prepare?.(`SELECT id, title, origin_json FROM conversations WHERE id = ?`) || null;
  const answeredCardsStmt = db?.prepare?.(`
    SELECT * FROM relay_questions WHERE status = 'answered' AND answered_at >= ? ORDER BY answered_at DESC LIMIT ?
  `) || null;

  function sessionOf(id) {
    let row = null;
    try {
      row = conversationStmt?.get(toText(id)) || null;
    } catch {}
    return { id: toText(id), title: toText(row?.title) || null, startedBy: toText(row?.origin_json) ? 'agent' : 'owner' };
  }

  function available(res) {
    if (relayAskService?.isAvailable?.()) return true;
    res.status(503).json({
      error: 'Questions that don\'t block are not available on this relay right now (see its server log).',
      code: REMOTE_RELAY_ERROR_CODES.unsupported,
    });
    return false;
  }

  /** This relay's user only: another relay's agent, and this relay's own, are refused. */
  function refuseRemote(req, res) {
    const request = readRemoteRelayRequest(req, remoteRelayInbound || {});
    if (!request.remote) return false;
    res.status(403).json({ error: 'The Inbox is this relay\'s user\'s; agents use the remote_relay tool.', code: REMOTE_RELAY_ERROR_CODES.forbidden });
    return true;
  }

  /**
   * The paired relay a request comes from: `{ relayId, name }`, or null after
   * answering. `name` is what this relay calls it, else the name it gives
   * itself in `claimedName` (a pairing one way round knows no name here).
   */
  function admitPairedRelay(req, res, claimedName = '') {
    const request = admitRemoteRelayRequest(req, res, remoteRelayInbound);
    if (!request) return null;
    if (!request.remote || request.local) {
      res.status(403).json({
        error: 'Only another relay calls these routes; this relay\'s own agents use the remote_relay tool and its user the Inbox.',
        code: REMOTE_RELAY_ERROR_CODES.forbidden,
      });
      return null;
    }
    const relayId = cleanSubscriberRelayId(request.origin?.relayId);
    if (!relayId) {
      res.status(400).json({ error: 'The calling relay sent no relay id.', code: REMOTE_RELAY_ERROR_CODES.invalidInput });
      return null;
    }
    const paired = findOriginRemoteRelay(remoteRelayInbound, request.origin);
    const claimed = toText(claimedName).replace(/[\r\n]+/g, ' ').slice(0, 60);
    return { relayId, name: toText(paired?.name) || claimed || toText(request.origin?.relayName) || relayId };
  }

  /** What an Inbox shows of this relay: its asks, and the cards turns wait on. */
  function localInboxItems({ forRemote = false } = {}) {
    const items = (relayAskService?.isAvailable?.() ? relayAskService.listHere() : []).map(inboxItemOfAsk);
    let pending = [];
    try {
      pending = stmts.listQuestions.all('pending', null, null).map(formatQuestionRow).filter(Boolean);
    } catch {}
    let answered = [];
    try {
      const since = new Date(now() - RELAY_ASK_LIMITS.answeredKeepMs).toISOString();
      answered = (answeredCardsStmt?.all(since, INBOX_ANSWERED_CARDS_MAX) || []).map(formatQuestionRow).filter(Boolean);
    } catch {}
    for (const question of [...pending, ...answered]) {
      items.push(inboxItemOfCard(question, sessionOf(question.conversationId), { forRemote }));
    }
    return items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  function pendingOf(items) {
    return items.filter((item) => item.status === 'pending').length;
  }

  // GET /api/relay-asks?conversationId= — the asks a session's card shows
  // (pending, and closed in the last day), or this relay's for the Inbox.
  app.get('/api/relay-asks', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!relayAskService?.isAvailable?.()) return res.json({ available: false, asks: [], pending: 0 });
    const conversationId = toText(req.query.conversationId);
    const asks = conversationId
      ? relayAskService.listOf(conversationId).filter((ask) => !ask.relayId && ask.conversationId === conversationId)
      : relayAskService.listHere();
    res.json({ available: true, asks, pending: relayAskService.pendingCount() });
  });

  async function remoteInbox(relay) {
    const entry = { id: relay.id, name: toText(relay.name) || relay.id, url: toText(relay.url) || null };
    if (UNREACHABLE_STATES.has(toText(relay.lastStatus).toLowerCase())) {
      return { ...entry, reachable: false, error: toText(relay.lastError) || toText(relay.lastStatus), items: [] };
    }
    try {
      const response = await remoteRelayClient.request(relay, 'GET', RELAY_ASK_REMOTE_PATHS.inbox, { timeoutMs: INBOX_REMOTE_TIMEOUT_MS });
      const items = (Array.isArray(response?.items) ? response.items : []).slice(0, RELAY_ASK_LIMITS.listMax);
      return { ...entry, reachable: true, items };
    } catch (error) {
      const text = isMissingRelayAskRoute(error)
        ? 'runs an OAR version without the Inbox'
        : toText(error?.message || error).slice(0, 200);
      return { ...entry, reachable: false, error: text, items: [] };
    }
  }

  // GET /api/inbox — every pending question across this relay and the
  // paired relays that answer, with what was answered in the last day.
  app.get('/api/inbox', auth, async (req, res) => {
    if (refuseRemote(req, res)) return;
    const own = localInboxItems();
    const selfName = toText(remoteRelayRegistry?.selfName?.()) || 'this relay';
    let paired = [];
    try {
      paired = remoteRelayClient && remoteRelayRegistry?.list ? (remoteRelayRegistry.list() || []) : [];
    } catch {}
    const remote = await Promise.all(paired.map(remoteInbox));
    const relays = [{ id: 'self', name: selfName, self: true, reachable: true, items: own }, ...remote];
    res.json({ relays, pending: relays.reduce((sum, relay) => sum + pendingOf(relay.items), 0) });
  });

  function pairedRelayOf(relayId) {
    try {
      return remoteRelayRegistry?.get?.(toText(relayId)) || null;
    } catch {
      return null;
    }
  }

  async function answerThere(req, res, action) {
    if (refuseRemote(req, res)) return;
    const relay = pairedRelayOf(req.params.relayId);
    if (!relay || !remoteRelayClient) return res.status(404).json({ error: 'No paired relay with that id.', code: REMOTE_RELAY_ERROR_CODES.unknown });
    const body = asObject(req.body);
    try {
      const response = await remoteRelayClient.request(relay, 'POST', RELAY_ASK_REMOTE_PATHS[action], {
        body: {
          id: toText(req.params.id),
          ...(action === 'answer' ? { answer: String(body.answer ?? ''), choice: String(body.choice ?? '') } : {}),
          // Shown there as where the answer came from, when it has no name for this relay.
          via: toText(remoteRelayRegistry?.selfName?.()),
        },
      });
      res.json({ ok: true, ask: asObject(response?.ask) });
    } catch (error) {
      const status = Number(error?.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 502;
      res.status(status).json({ error: toText(error?.message) || `Relay "${relay.name}" did not answer.`, code: toText(error?.code) || REMOTE_RELAY_ERROR_CODES.offline });
    }
  }

  // POST /api/inbox/relays/:relayId/asks/:id/answer — `{ answer, choice }`.
  app.post('/api/inbox/relays/:relayId/asks/:id/answer', auth, (req, res) => { void answerThere(req, res, 'answer'); });
  app.post('/api/inbox/relays/:relayId/asks/:id/dismiss', auth, (req, res) => { void answerThere(req, res, 'dismiss'); });

  // ─── Paired relays ─────────────────────────────────────────────────────────

  // POST /api/relay-asks/remote/ask — `{ session, question, options,
  // recommendation, detail, urgency, asker: { conversationId, title, relayName } }`.
  app.post('/api/relay-asks/remote/ask', auth, (req, res) => {
    const body = asObject(req.body);
    const asker = asObject(body.asker);
    const caller = admitPairedRelay(req, res, asker.relayName);
    if (!caller || !available(res)) return;
    try {
      const ask = relayAskService.create({
        conversationId: toText(body.session),
        creator: { relayId: caller.relayId, relayName: caller.name, conversationId: toText(asker.conversationId), conversationTitle: toText(asker.title) },
        question: body.question,
        options: body.options,
        recommendation: body.recommendation,
        detail: body.detail,
        urgency: body.urgency,
      });
      res.json({ ok: true, ask });
    } catch (error) {
      sendRelayAskError(res, error, 'The ask');
    }
  });

  // POST /api/relay-asks/remote/status — `{ ids }`: the asks this relay's caller asked.
  app.post('/api/relay-asks/remote/status', auth, (req, res) => {
    const caller = admitPairedRelay(req, res);
    if (!caller || !available(res)) return;
    try {
      res.json({ ok: true, asks: relayAskService.statusForRelay({ relayId: caller.relayId, ids: asObject(req.body).ids }) });
    } catch (error) {
      sendRelayAskError(res, error, 'The status');
    }
  });

  // POST /api/relay-asks/remote/withdraw — `{ id }`.
  app.post('/api/relay-asks/remote/withdraw', auth, (req, res) => {
    const caller = admitPairedRelay(req, res);
    if (!caller || !available(res)) return;
    try {
      res.json({ ok: true, ask: relayAskService.withdraw(toText(asObject(req.body).id), { byRelayId: caller.relayId }) });
    } catch (error) {
      sendRelayAskError(res, error, 'The withdrawal');
    }
  });

  // POST /api/relay-asks/remote/answer — `{ id, answer, choice }`, and
  // /dismiss — `{ id }`: an ask of this relay, answered from a paired
  // relay's Inbox. Only asks: an id of any other card is not found here.
  app.post('/api/relay-asks/remote/answer', auth, (req, res) => {
    const body = asObject(req.body);
    const caller = admitPairedRelay(req, res, body.via);
    if (!caller || !available(res)) return;
    try {
      res.json({ ok: true, ask: relayAskService.answer(toText(body.id), { answer: String(body.answer ?? ''), choice: String(body.choice ?? ''), via: caller.name }) });
    } catch (error) {
      sendRelayAskError(res, error, 'The answer');
    }
  });

  app.post('/api/relay-asks/remote/dismiss', auth, (req, res) => {
    const body = asObject(req.body);
    const caller = admitPairedRelay(req, res, body.via);
    if (!caller || !available(res)) return;
    try {
      res.json({ ok: true, ask: relayAskService.dismiss(toText(body.id), { via: caller.name }) });
    } catch (error) {
      sendRelayAskError(res, error, 'The dismissal');
    }
  });

  // GET /api/relay-asks/remote/inbox — what a paired relay's Inbox shows of this one.
  app.get('/api/relay-asks/remote/inbox', auth, (req, res) => {
    const caller = admitPairedRelay(req, res);
    if (!caller) return;
    const items = localInboxItems({ forRemote: true });
    res.json({ ok: true, items, pending: pendingOf(items) });
  });

  return { localInboxItems, noteAsked: (relayId) => relayAskLinkService?.noteAsked?.(relayId) };
}
