'use strict';

// Remote relays API (plan §5.1, §5.4, §5.6): this relay's identity, the list
// of paired relays, adding/pairing, self settings and the single endpoint all
// agent tool calls converge on. Everything is behind `auth` — including the
// inbound pairing call, which another relay makes with a token that works here.
//
// No response carries a stored token: the registry's public views drop it, and
// the pairing service's answers never contain one.

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
  } = deps;

  // Static paths first: Express would otherwise hand them to /:id.

  // GET /api/relay/identity — who this relay is, for other relays' probes.
  app.get('/api/relay/identity', auth, (_req, res) => {
    res.json(registry.selfIdentity());
  });

  app.get('/api/remote-relays', auth, (_req, res) => {
    res.json({
      relays: registry.listPublic(),
      self: { ...registry.selfIdentity(), ...registry.getSelfSettings() },
    });
  });

  // Workers ask at start whether to register the remote_relay tool at all:
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
      sendResult(res, await pairing.addFromLink(req.body || {}));
    } catch (error) {
      internalError(res, error, 'Adding the remote relay');
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

  // POST /api/remote-relays/tool — every provider adapter's remote_relay call.
  app.post('/api/remote-relays/tool', auth, async (req, res) => {
    if (!dispatcher) return res.status(503).json({ error: 'Remote relay dispatcher unavailable' });
    // A worker that gives up on the call (turn stopped, worker gone) closes
    // the request: withdraw its approval card and stop waiting for the reply.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const result = await dispatcher.dispatch({
        conversationId: req.body?.conversationId,
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
}
