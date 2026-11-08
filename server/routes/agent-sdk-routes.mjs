'use strict';

// The agent SDKs the relay installs on demand (agent-sdk-store.mjs): their
// status, and Install / Reinstall / Cancel from Settings. A request body only
// ever carries an SDK id, looked up through the store's frozen table; an
// unknown id is a 400 before anything runs. The store itself refuses a spawn
// while COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN is set (503), and that answer is
// passed through as it is.

const UNKNOWN_SDK_ERROR = 'Unknown agent SDK';

export function registerAgentSdkRoutes(app, { auth, io = null, agentSdkStore = null } = {}) {
  const store = agentSdkStore;

  // Every transition and log flush (four a second at most, the store
  // coalesces them) goes to every client, as cli_install_state does.
  if (store && io && typeof store.subscribe === 'function') {
    store.subscribe((snapshot) => {
      io.emit('agent_sdk_state', snapshot);
    });
  }

  const unavailable = (res) => res.status(503).json({ error: 'Agent SDKs are unavailable on this relay' });

  // A string the store knows, or null. Only a string: String(['claude'])
  // would otherwise read as a valid id.
  const knownId = (raw) => (typeof raw === 'string' && store.status(raw) ? raw : null);

  app.get('/api/agent-sdks/status', auth, (_req, res) => {
    if (!store) return unavailable(res);
    return res.json(store.snapshot());
  });

  app.post('/api/agent-sdks/install', auth, (req, res) => {
    if (!store) return unavailable(res);
    const sdk = knownId(req.body?.sdk);
    if (!sdk) return res.status(400).json({ error: UNKNOWN_SDK_ERROR, ...store.snapshot() });
    let result;
    try {
      result = store.install(sdk, { force: req.body?.reinstall === true });
    } catch (error) {
      return res.status(500).json({ error: `The install could not start: ${String(error?.message || error)}`, ...store.snapshot() });
    }
    if (!result?.ok) {
      return res.status(Number(result?.statusCode) || 400).json({
        error: result?.error || 'Failed to start the agent SDK install',
        ...store.snapshot(),
      });
    }
    // The rows ride along so the caller renders without a second round trip;
    // the install itself finishes over the socket.
    return res.json({
      ok: true,
      reused: result.reused === true,
      ready: result.ready === true,
      ...store.snapshot(),
    });
  });

  app.post('/api/agent-sdks/install/cancel', auth, (req, res) => {
    if (!store) return unavailable(res);
    const sdk = knownId(req.body?.sdk);
    if (!sdk) return res.status(400).json({ error: UNKNOWN_SDK_ERROR, ...store.snapshot() });
    const result = store.cancel(sdk);
    if (!result?.ok) {
      return res.status(Number(result?.statusCode) || 400).json({
        error: result?.error || 'Failed to cancel the agent SDK install',
        ...store.snapshot(),
      });
    }
    return res.json({ ok: true, ...store.snapshot() });
  });
}
