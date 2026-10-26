'use strict';

// Relay event subscriptions, for the browser: the active subscriptions (the
// "watching" chip and the "watched" badges) and Unsubscribe. Agents use the
// relay_tool instead; a request from another relay's agent is
// refused here, so only this relay's user ends a subscription from outside
// its conversation.
//
// And for paired relays: their agents subscribe to this relay's sessions
// (POST /api/relay-events/remote/subscribe) and their relay fetches the
// events (POST /api/relay-events/remote/pull, relay-event-link-service.mjs on
// the other side). Only another relay's request is taken there, under the
// inbound switch like a prompt; its subscriptions are filed under the relay
// id it states, which never names a conversation here.

import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';
import { admitRemoteRelayRequest, readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { RelayEventError, cleanSubscriberRelayId } from '../services/relay-event-service.mjs';

const RELAY_EVENT_ERROR_STATUS = Object.freeze({
  invalid: [400, REMOTE_RELAY_ERROR_CODES.invalidInput],
  notFound: [404, REMOTE_RELAY_ERROR_CODES.notFound],
  ownSession: [400, REMOTE_RELAY_ERROR_CODES.ownSession],
  limit: [409, REMOTE_RELAY_ERROR_CODES.subscriptionLimit],
  unavailable: [503, REMOTE_RELAY_ERROR_CODES.unsupported],
});

function sendRelayEventError(res, error, what) {
  if (error instanceof RelayEventError) {
    const [status, code] = RELAY_EVENT_ERROR_STATUS[error.code] || [400, REMOTE_RELAY_ERROR_CODES.invalidInput];
    return res.status(status).json({ error: error.message, code, ...(error.extra && typeof error.extra === 'object' ? error.extra : {}) });
  }
  return res.status(500).json({ error: `${what} failed: ${String(error?.message || error)}`, code: REMOTE_RELAY_ERROR_CODES.internal });
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function registerRelayEventRoutes(app, deps) {
  const {
    auth,
    relayEventService = null,
    remoteRelayInbound = null,
  } = deps;

  function refuseRemote(req, res) {
    const request = readRemoteRelayRequest(req, remoteRelayInbound || {});
    if (!request.remote) return false;
    res.status(403).json({ error: 'Relay event subscriptions are managed by this relay\'s user and its own agents only.' });
    return true;
  }

  // GET /api/relay-events/subscriptions — every active subscription.
  app.get('/api/relay-events/subscriptions', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!relayEventService?.isAvailable?.()) return res.json({ available: false, subscriptions: [] });
    res.json({ available: true, subscriptions: relayEventService.listActive() });
  });

  /**
   * The paired relay a request comes from: its stated relay id, or null
   * after answering. Refused: this relay's own agents and the browser (they
   * have the tool and the routes above), any request while the inbound
   * switch is off, and one that names no relay.
   */
  function admitPairedRelay(req, res) {
    const request = admitRemoteRelayRequest(req, res, remoteRelayInbound);
    if (!request) return null;
    if (!request.remote || request.local) {
      res.status(403).json({
        error: 'Only another relay subscribes to sessions here this way; this relay\'s own agents use the relay_tool.',
        code: REMOTE_RELAY_ERROR_CODES.forbidden,
      });
      return null;
    }
    const subscriber = cleanSubscriberRelayId(request.origin?.relayId);
    if (!subscriber) {
      res.status(400).json({ error: 'The calling relay sent no relay id.', code: REMOTE_RELAY_ERROR_CODES.invalidInput });
      return null;
    }
    if (!relayEventService?.isCrossRelayAvailable?.()) {
      res.status(503).json({
        error: 'Event subscriptions across relays are not available on this relay right now (see its server log).',
        code: REMOTE_RELAY_ERROR_CODES.unsupported,
      });
      return null;
    }
    return subscriber;
  }

  // POST /api/relay-events/remote/subscribe — a paired relay's agent
  // subscribes: `{ watcher: { conversationId, title }, subscriber: { name },
  // scope, sessions, events, once, match, stalled_minutes, heartbeat_minutes,
  // exclude, dry_run }`. A dry run checks everything and stores nothing.
  // Digest and quiet hours are the watching relay's: never sent here.
  app.post('/api/relay-events/remote/subscribe', auth, (req, res) => {
    const subscriber = admitPairedRelay(req, res);
    if (!subscriber) return;
    const body = asObject(req.body);
    const watcher = asObject(body.watcher);
    try {
      const subscription = relayEventService.subscribeServed({
        subscriberRelayId: subscriber,
        subscriberRelayName: String(asObject(body.subscriber).name || ''),
        watcherId: String(watcher.conversationId || ''),
        watcherTitle: String(watcher.title || ''),
        scope: body.scope === 'all' ? 'all' : 'sessions',
        sessionIds: Array.isArray(body.sessions) ? body.sessions.map((id) => String(id ?? '')) : [],
        events: Array.isArray(body.events) ? body.events.map((type) => String(type ?? '')) : null,
        once: body.once === true,
        match: typeof body.match === 'string' ? body.match : '',
        stalledMinutes: body.stalled_minutes ?? null,
        heartbeatMinutes: body.heartbeat_minutes ?? null,
        exclude: Array.isArray(body.exclude) ? body.exclude.map((id) => String(id ?? '')) : null,
        dryRun: body.dry_run === true,
      });
      res.json({ ok: true, ...(body.dry_run === true ? { dryRun: true } : {}), subscription });
    } catch (error) {
      sendRelayEventError(res, error, 'Subscribe');
    }
  });

  // POST /api/relay-events/remote/pull — a paired relay fetches its events:
  // `{ after, subscriptions: [{ id, watcher }], ended: [ids] }`.
  app.post('/api/relay-events/remote/pull', auth, (req, res) => {
    const subscriber = admitPairedRelay(req, res);
    if (!subscriber) return;
    const body = asObject(req.body);
    try {
      res.json({
        ok: true,
        ...relayEventService.pullServed({
          subscriberRelayId: subscriber,
          after: body.after,
          subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions : [],
          ended: Array.isArray(body.ended) ? body.ended : [],
        }),
      });
    } catch (error) {
      sendRelayEventError(res, error, 'The event fetch');
    }
  });

  // DELETE /api/relay-events/subscriptions/:id — the user's Unsubscribe.
  app.delete('/api/relay-events/subscriptions/:id', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!relayEventService?.isAvailable?.()) return res.status(503).json({ error: 'Relay event subscriptions are not available' });
    try {
      const ended = relayEventService.unsubscribe({ subscriptionId: String(req.params.id || '').trim(), reason: 'unsubscribed-by-user' });
      res.json({ ok: true, ended });
    } catch (error) {
      if (error instanceof RelayEventError) {
        return res.status(error.code === 'notFound' ? 404 : 400).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: `Unsubscribe failed: ${String(error?.message || error)}` });
    }
  });
}
