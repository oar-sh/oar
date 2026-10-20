'use strict';

// The queued relay restart beyond queueing and cancelling it (those two are
// POST /api/relay/shutdown and /api/relay/shutdown/cancel in
// messages-routes.mjs): what a restart would wait for and leave running, the
// "keep waiting" answer to the max-wait question, and the max-wait setting
// (services/relay-restart-queue.mjs). Token only, like the restart itself.

import {
  DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES,
  RELAY_RESTART_MAX_WAIT_CHOICES,
  parseRelayRestartMaxWaitUpdate,
} from '../services/relay-restart-queue.mjs';

function requestedByOf(req) {
  return String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
}

export function registerRelayRestartRoutes(app, {
  auth,
  getState = null,
  collectRestartPicture = null,
  keepWaiting = null,
  getMaxWaitMinutes = () => DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES,
  setMaxWaitMinutes = null,
  maxWaitOverrideMs = null,
} = {}) {
  // The queued request's state, and with `?action=` the picture for a
  // restart or shutdown asked now (the confirmation reads it first).
  app.get('/api/relay/shutdown', auth, (req, res) => {
    if (typeof getState !== 'function') {
      return res.status(501).json({ error: 'Relay shutdown orchestration is unavailable' });
    }
    const state = getState();
    const action = String(req.query?.action || 'restart').trim().toLowerCase() === 'shutdown' ? 'shutdown' : 'restart';
    let preview = null;
    if (typeof collectRestartPicture === 'function') {
      try { preview = { action, ...collectRestartPicture({ action }) }; } catch {}
    }
    return res.json({ ok: true, ...state, preview });
  });

  app.post('/api/relay/shutdown/keep-waiting', auth, (req, res) => {
    if (typeof keepWaiting !== 'function') {
      return res.status(501).json({ error: 'Relay shutdown orchestration is unavailable' });
    }
    return res.json({ ok: true, ...keepWaiting({ requestedBy: requestedByOf(req) }) });
  });

  const settingPayload = (maxWaitMinutes) => ({
    ok: true,
    maxWaitMinutes,
    choices: [...RELAY_RESTART_MAX_WAIT_CHOICES],
    defaultMinutes: DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES,
    // A test relay's environment override wins over the stored value.
    overrideMs: maxWaitOverrideMs,
  });

  app.get('/api/settings/relay-restart-max-wait', auth, (_req, res) => {
    res.json(settingPayload(getMaxWaitMinutes()));
  });

  app.post('/api/settings/relay-restart-max-wait', auth, (req, res) => {
    const parsed = parseRelayRestartMaxWaitUpdate(req.body?.maxWaitMinutes);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    if (typeof setMaxWaitMinutes !== 'function') {
      return res.status(503).json({ ok: false, error: 'Relay restart settings are unavailable' });
    }
    const result = setMaxWaitMinutes(parsed.minutes);
    if (!result?.ok) return res.status(500).json({ ok: false, error: result?.error || 'Saving failed' });
    return res.json(settingPayload(result.maxWaitMinutes));
  });
}
