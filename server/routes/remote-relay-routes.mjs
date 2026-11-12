'use strict';

// Remote relays API (plan §5.1, §5.4, §5.6): this relay's identity, the list
// of paired relays, adding/pairing, self settings and the single endpoint all
// agent tool calls converge on. Everything is behind `auth` — including the
// inbound pairing call, which another relay makes with a token that works here.
//
// No response carries a stored token: the registry's public views drop it, and
// the pairing service's answers never contain one.

import { REMOTE_RELAY_ERROR_CODES, REMOTE_RELAY_INBOUND_KEY_PATH, REMOTE_RELAY_PEER_KEY_PATHS } from '../../shared/remote-relay-contract.mjs';
import { AUTH_ERROR_CODES } from '../../shared/relay-route-policy.mjs';
import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { principalOf } from '../services/relay-principal.mjs';

/**
 * The conversation a relay_tool call acts for. A session's agent token is
 * bound to its conversation: a call that names another one is refused
 * (null), and one that names none acts for the token's. Every other caller
 * (the person, the cli token) names it in the body, as before.
 */
export function relayToolConversationOf(req) {
  const declared = String(req?.body?.conversationId ?? '').trim();
  const principal = principalOf(req);
  if (principal?.kind !== 'agent' || principal.agentKind !== 's') return { conversationId: req?.body?.conversationId };
  const bound = String(principal.conversationId || '').trim();
  if (!bound || (declared && declared !== bound)) return null;
  return { conversationId: bound };
}

function sendResult(res, result, fallbackStatus = 400) {
  const { status, ...payload } = result || {};
  const code = Number.isInteger(status) ? status : (payload.ok === false ? fallbackStatus : 200);
  return res.status(code).json(payload);
}

function internalError(res, error, what) {
  return res.status(500).json({ error: `${what} failed: ${String(error?.message || error)}` });
}

export function registerRemoteRelayRoutes(app, deps) {
  const {
    auth,
    registry,
    pairing,
    // WP2's dispatcher: `{ dispatch({ conversationId, action, args, req }) →
    // Promise<{ status, body }>, inflight(conversationId) → number }`.
    dispatcher = null,
    // The inbound facts (remote-relay-inbound.mjs): which requests come from
    // another relay.
    remoteRelayInbound = null,
    // Peer keys (remote-relay-peer-keys.mjs): delivery, check, request, and
    // the owner's Renew, Revoke, confirm and the refusal notice.
    peerKeys = null,
  } = deps;

  function peerKeysUnavailable(res) {
    if (peerKeys) return false;
    res.status(503).json({ error: 'Peer keys are not available on this relay right now', code: REMOTE_RELAY_ERROR_CODES.unsupported });
    return true;
  }

  // Static paths first: Express would otherwise hand them to /:id.

  // GET /api/relay/identity — who this relay is, for other relays' probes.
  app.get('/api/relay/identity', auth, (_req, res) => {
    res.json(registry.selfIdentity());
  });

  app.get('/api/remote-relays', auth, (_req, res) => {
    res.json({
      relays: registry.listPublic(),
      // Relays that added this one one way and hold an inbound-only key:
      // never called from here, shown in Settings → Relays with Remove.
      inbound: registry.listInboundPublic?.() || [],
      self: registry.selfPayload(),
    });
  });

  // Workers ask at start whether to register the relay_tool at all:
  // when a relay is paired (`count`), or when this relay's own sessions are
  // open to its agents (`localEnabled`, the local target).
  app.get('/api/remote-relays/summary', auth, (_req, res) => {
    const relays = registry.listPublic();
    res.json({
      count: relays.length,
      online: relays.filter((relay) => relay.lastStatus === 'online').length,
      localEnabled: registry.getAgentSessionsSettings?.().enabled === true,
    });
  });

  // The Grok inactivity hold asks whether a tool call is still running.
  app.get('/api/remote-relays/inflight', auth, (req, res) => {
    const conversationId = String(req.query?.conversationId || '').trim();
    let inflight = 0;
    try {
      inflight = Number(dispatcher?.inflight?.(conversationId)) || 0;
    } catch {}
    res.json({ inflight });
  });

  // POST /api/remote-relays — add a relay from a pasted link (and pair back).
  app.post('/api/remote-relays', auth, async (req, res) => {
    try {
      // The page's own origin (through the trust-proxy setting): pasting
      // this relay's address is refused before any probe.
      const host = typeof req.get === 'function' ? req.get('host') : req.headers?.host;
      const requestOrigin = req.protocol && host ? `${req.protocol}://${host}` : '';
      sendResult(res, await pairing.addFromLink(req.body || {}, { requestOrigin }));
    } catch (error) {
      internalError(res, error, 'Adding the remote relay');
    }
  });

  // ─── Peer keys ────────────────────────────────────────────────────────────
  // Static paths, before /:id.

  // POST /api/remote-relays/peer-key — a paired relay delivers a key it made
  // for this relay `{ issuer, seq, key, proof? }`; kept only after the check
  // at that relay's stored address agrees.
  app.post(REMOTE_RELAY_PEER_KEY_PATHS.deliver, auth, async (req, res) => {
    if (peerKeysUnavailable(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await peerKeys.handleDelivery(principalOf(req), req.body || {});
      res.status(result.status).json(result.body);
    } catch (error) {
      internalError(res, error, 'The key delivery');
    }
  });

  // GET /api/remote-relays/peer-key/check — the holder of a key just
  // delivered asks, with that key, who issued it to whom.
  app.get(REMOTE_RELAY_PEER_KEY_PATHS.check, auth, (req, res) => {
    if (peerKeysUnavailable(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const result = peerKeys.handleCheck(principalOf(req));
    res.status(result.status).json(result.body);
  });

  // POST /api/remote-relays/peer-key/request — a paired relay asks for a
  // (new) key; it is delivered to that relay's stored address, never here.
  app.post(REMOTE_RELAY_PEER_KEY_PATHS.request, auth, async (req, res) => {
    if (peerKeysUnavailable(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await peerKeys.handleRequest(principalOf(req), req.body || {});
      res.status(result.status).json(result.body);
    } catch (error) {
      internalError(res, error, 'The key request');
    }
  });

  // POST /api/remote-relays/peer-key/inbound — a relay that adds this one
  // one way asks, with the owner token from this relay's pairing link, for a
  // key of its own: it is listed here as inbound only (never called), and
  // the key is in the answer. Person-only in the route policy: an agent
  // token or a paired relay's key gets 403.
  app.post(REMOTE_RELAY_INBOUND_KEY_PATH, auth, (req, res) => {
    if (peerKeysUnavailable(res)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = peerKeys.mintInbound(principalOf(req), req.body || {});
      res.status(result.status).json(result.body);
    } catch (error) {
      internalError(res, error, 'The inbound-only key');
    }
  });

  // POST /api/remote-relays/pair — another relay introduces itself.
  app.post('/api/remote-relays/pair', auth, async (req, res) => {
    try {
      sendResult(res, await pairing.acceptPairing(req.body || {}));
    } catch (error) {
      internalError(res, error, 'Pairing');
    }
  });

  // POST /api/remote-relays/tool — every provider adapter's relay_tool call.
  app.post('/api/remote-relays/tool', auth, async (req, res) => {
    if (!dispatcher) return res.status(503).json({ error: 'Remote relay dispatcher unavailable' });
    // The tool acts for one of this relay's conversations: another relay
    // never calls it (it would act, or subscribe, for a conversation it does
    // not host). Its agents reach this relay through the routes it calls.
    if (readRemoteRelayRequest(req, remoteRelayInbound).remote) {
      return res.status(403).json({
        error: 'The relay_tool of this relay is for its own sessions; another relay cannot call it.',
        code: REMOTE_RELAY_ERROR_CODES.forbidden,
      });
    }
    // A worker that gives up on the call (turn stopped, worker gone) closes
    // the request: withdraw its approval card and stop waiting for the reply.
    const target = relayToolConversationOf(req);
    if (!target) {
      return res.status(403).json({
        error: 'This agent token belongs to another session: relay_tool acts only for the session the token was made for.',
        code: AUTH_ERROR_CODES.conversationMismatch,
      });
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const result = await dispatcher.dispatch({
        conversationId: target.conversationId,
        action: req.body?.action,
        args: req.body?.args || {},
        req,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      res.status(Number.isInteger(result?.status) ? result.status : 200).json(result?.body ?? {});
    } catch (error) {
      internalError(res, error, 'The remote relay call');
    }
  });

  app.get('/api/settings/remote-relays', auth, (_req, res) => {
    res.json(registry.getSelfSettings());
  });

  app.post('/api/settings/remote-relays', auth, (req, res) => {
    sendResult(res, registry.setSelfSettings(req.body || {}));
  });

  // Agent sessions: whether this relay's agents may start and use sessions on
  // it, and the longest wait of one tool call. POST takes
  // `{ enabled?, maxWaitSeconds? }` and answers the GET shape plus `ok`.
  app.get('/api/settings/agent-sessions', auth, (_req, res) => {
    res.json(registry.getAgentSessionsSettings());
  });

  app.post('/api/settings/agent-sessions', auth, (req, res) => {
    sendResult(res, registry.setAgentSessionsSettings(req.body || {}));
  });

  // PATCH /api/remote-relays/:id — { permission, url, token, tokenMode }.
  app.patch('/api/remote-relays/:id', auth, (req, res) => {
    sendResult(res, registry.update(req.params?.id, req.body || {}));
  });

  // DELETE /api/remote-relays/:id — local only; the other side keeps its entry.
  app.delete('/api/remote-relays/:id', auth, (req, res) => {
    sendResult(res, registry.remove(req.params?.id), 404);
  });

  app.post('/api/remote-relays/:id/check', auth, async (req, res) => {
    try {
      const relay = await registry.check(req.params?.id);
      if (!relay) return res.status(404).json({ error: 'Unknown remote relay' });
      res.json({ ok: true, relay });
    } catch (error) {
      internalError(res, error, 'The check');
    }
  });

  // POST /api/remote-relays/:id/repair — one click: probe the stored
  // address, pair back without rewriting the entry, keys both ways. A relay
  // below protocol 2, or one that refuses the stored credential, answers
  // `needsLink: true` (paste its pairing link, as for Add a relay).
  app.post('/api/remote-relays/:id/repair', auth, async (req, res) => {
    try {
      sendResult(res, await pairing.repair(req.params?.id, { confirmIdentity: req.body?.confirmIdentity === true }), 400);
    } catch (error) {
      internalError(res, error, 'Re-pair');
    }
  });

  app.post('/api/remote-relays/:id/renew-key', auth, async (req, res) => {
    if (peerKeysUnavailable(res)) return;
    try {
      const result = await peerKeys.renew(req.params?.id);
      sendResult(res, result.ok ? { ok: true, relay: registry.publicOf(registry.get(req.params?.id)) } : { ...result, status: result.status || 409 });
    } catch (error) {
      internalError(res, error, 'Renew key');
    }
  });

  app.post('/api/remote-relays/:id/revoke-key', auth, (req, res) => {
    if (peerKeysUnavailable(res)) return;
    const result = peerKeys.revoke(req.params?.id);
    sendResult(res, result.ok ? { ok: true, relay: registry.publicOf(registry.get(req.params?.id)) } : result, 404);
  });

  // The owner confirms a held identity change (new address or relay id):
  // the pinned fields follow, and keys can be issued again.
  app.post('/api/remote-relays/:id/confirm-identity', auth, async (req, res) => {
    if (peerKeysUnavailable(res)) return;
    const result = peerKeys.confirmIdentity(req.params?.id);
    if (!result.ok) return sendResult(res, result, 404);
    res.json({ ok: true, relay: registry.publicOf(registry.get(req.params?.id)) });
  });

  app.post('/api/remote-relays/:id/refusal-notice/dismiss', auth, (req, res) => {
    if (peerKeysUnavailable(res)) return;
    sendResult(res, peerKeys.dismissRefusalNotice(req.params?.id), 404);
  });
}
