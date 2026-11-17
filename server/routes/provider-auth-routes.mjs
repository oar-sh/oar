'use strict';

// The provider sign-in routes (Claude and Grok accounts), the provider CLI
// install and the self-update routes, registered by registerSessionsRoutes.
import { createClaudeAuthService } from '../services/claude-auth-service.mjs';
import { createCliInstallService } from '../services/cli-install-service.mjs';
import { createGrokAuthService } from '../services/grok-auth-service.mjs';
import {
  SESSION_WORKER_ACTIVE_STATUSES,
  isPidAlive,
} from './sessions-helpers.mjs';

export function registerProviderAuthRoutes(app, deps, shared) {
  const {
    auth,
    io,
    stmts,
    sessionWorkerRegistry,
  } = deps;
  const {
    claudeAuthService,
    cliInstallService,
    grokAuthService,
    updateCheckService,
    updateInstallService,
    buildUpdateStatePayload,
    copilotModelDiscoveryService,
    getClaudeProviderSettings,
    refreshClaudeProviderModels,
    getGrokProviderSettings,
    refreshGrokProviderModels,
    getModelCatalogState,
    modelsUpdatedPayload,
    isCopilotEnabled = () => true,
  } = shared;

  // --- Claude account (CLI OAuth) -----------------------------------------
  // Drives `claude auth login/logout` on the host so an account switch does not
  // need shell access. No Claude secret passes through the relay: the CLI writes
  // its own credentials file, which the workers already read.
  // Owned by server-runtime (so dispose() reaches it on shutdown); the local
  // construction is the test-harness fallback.
  const claudeAuth = claudeAuthService || createClaudeAuthService();

  // Stand-in for the window before the first `claude auth status` read lands:
  // the payload shape is fixed, so a broadcast carries a neutral status rather
  // than dropping the field.
  const CLAUDE_AUTH_UNKNOWN_STATUS = Object.freeze({
    ok: false,
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
    email: null,
    orgId: null,
    orgName: null,
    subscriptionType: null,
    error: null,
    checkedAt: null,
  });

  /**
   * Workers of one provider that are actually running right now. The worker
   * registry carries no provider field, so each active entry is resolved back to
   * its runtime_sessions row (provider_type). Feeds the logout confirmation
   * dialogs (Claude and Grok both name the count before signing out).
   */
  function countRunningWorkersForProvider(providerType) {
    const wantedProvider = String(providerType || '').trim().toLowerCase();
    const workers = typeof sessionWorkerRegistry?.listWorkers === 'function'
      ? sessionWorkerRegistry.listWorkers()
      : [];
    let count = 0;
    for (const worker of (Array.isArray(workers) ? workers : [])) {
      const workerStatus = String(worker?.status || '').trim().toLowerCase();
      if (!SESSION_WORKER_ACTIVE_STATUSES.includes(workerStatus)) continue;
      // A registry entry survives a crash and an entry can predate its process,
      // so only a recorded *and* live pid counts as running.
      const pid = Number(worker?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) continue;
      const sid = String(worker?.sdkSessionId || '').trim();
      if (!sid) continue;
      let runtimeSessionRow = null;
      try {
        runtimeSessionRow = stmts.getRuntimeSessionBySdkSessionId?.get?.(sid) || null;
      } catch {
        runtimeSessionRow = null;
      }
      if (String(runtimeSessionRow?.provider_type || '').trim().toLowerCase() === wantedProvider) count += 1;
    }
    return count;
  }

  // Each count walks the registry and reads one runtime_sessions row per worker,
  // so it is recomputed only where the number is consumed (the status read and
  // the logout confirmation) and reused for the login-transition broadcasts.
  let lastRunningClaudeWorkers = 0;
  function refreshRunningClaudeWorkers() {
    lastRunningClaudeWorkers = countRunningWorkersForProvider('claude');
    return lastRunningClaudeWorkers;
  }

  function claudeAuthPayload({ status = null, login = null, runningClaudeWorkers = lastRunningClaudeWorkers } = {}) {
    return {
      status: status || CLAUDE_AUTH_UNKNOWN_STATUS,
      login: login || claudeAuth.getLoginState(),
      runningClaudeWorkers,
    };
  }

  async function buildClaudeAuthPayload({
    login = null,
    forceStatus = false,
    status = null,
    countWorkers = false,
  } = {}) {
    // getStatus() never rejects: a failed probe resolves as `ok:false` with the
    // reason in `error`.
    const resolved = status || await claudeAuth.getStatus({ force: forceStatus });
    return claudeAuthPayload({
      status: resolved,
      login,
      runningClaudeWorkers: countWorkers ? refreshRunningClaudeWorkers() : lastRunningClaudeWorkers,
    });
  }

  // Login transitions broadcast synchronously off the last known status: the
  // awaiting_code emit carries the authorize URL, and building it around a
  // status read would park it behind a CLI spawn (up to 20s on a cold cache).
  // The service re-emits the same state once a fresh status lands.
  claudeAuth.subscribe((login) => {
    io.emit('claude_auth_state', claudeAuthPayload({ status: claudeAuth.getCachedStatus(), login }));
  });

  // A fresh login usually unblocks model discovery (it fails opaquely while
  // logged out), so the catalog is repopulated without a relay restart.
  // Running workers are deliberately left alone: they keep the previous
  // account's token until they exit.
  claudeAuth.onLoginSuccess(async () => {
    try {
      await refreshClaudeProviderModels();
    } catch (error) {
      console.log(`[claude-auth] model refresh after login failed: ${error?.message || error}`);
    }
    const settings = getClaudeProviderSettings();
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('claude_settings_updated', {
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5',
      models: Array.isArray(settings?.models) ? settings.models : [],
      availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
    });
  });

  app.get('/api/claude/auth/status', auth, async (_req, res) => {
    return res.json(await buildClaudeAuthPayload({ countWorkers: true }));
  });

  app.post('/api/claude/auth/login/start', auth, async (req, res) => {
    const result = claudeAuth.startLogin();
    if (!result?.ok) {
      return res.status(500).json({
        error: result?.error || 'Failed to start Claude login',
        ...(await buildClaudeAuthPayload()),
      });
    }
    return res.json({
      ok: true,
      reused: result.reused === true,
      ...(await buildClaudeAuthPayload({ login: result.login })),
    });
  });

  app.post('/api/claude/auth/login/code', auth, async (req, res) => {
    // The code itself is never logged, echoed back, or broadcast.
    const result = claudeAuth.submitCode(req.body?.code);
    if (!result?.ok) {
      return res.status(Number(result?.statusCode) || 400).json({
        error: result?.error || 'Failed to submit the Claude login code',
        ...(await buildClaudeAuthPayload()),
      });
    }
    return res.json({ ok: true, ...(await buildClaudeAuthPayload({ login: result.login })) });
  });

  app.post('/api/claude/auth/login/cancel', auth, async (_req, res) => {
    const result = claudeAuth.cancel();
    return res.json({ ok: true, ...(await buildClaudeAuthPayload({ login: result.login })) });
  });

  app.post('/api/claude/auth/logout', auth, async (_req, res) => {
    const result = await claudeAuth.logout();
    if (!result?.ok) {
      return res.status(Number(result?.statusCode) || 500).json({
        error: result?.error || 'Failed to log out of Claude',
        ...(await buildClaudeAuthPayload({ status: result?.status || null, countWorkers: true })),
      });
    }
    // logout() already force-refreshed the status and its idle transition
    // already broadcast it, so neither the spawn nor the emit is repeated.
    return res.json({
      ok: true,
      ...(await buildClaudeAuthPayload({ status: result.status, countWorkers: true })),
    });
  });

  // --- Provider CLI install / update --------------------------------------
  // Runs the vendors' own install one-liners on the relay host so a missing
  // `grok` (relay.grok-cli-missing) can be fixed from the phone instead of from
  // a shell. Every command is a frozen literal in cli-install-service.mjs; a
  // request body only ever carries a descriptor id and an action name, and an
  // unknown id is a 400 before any spawn is considered.
  // Owned by server-runtime (so dispose() reaches a running installer on
  // shutdown); the local construction is the test-harness fallback.
  const cliInstall = cliInstallService || createCliInstallService();

  // Install transitions broadcast off the last known probe rather than a fresh
  // one: each log chunk emits, and re-probing three CLIs per chunk would spawn
  // more processes than the install itself. The service re-probes (and
  // re-emits) once the install closes.
  cliInstall.subscribe(() => {
    io.emit('cli_install_state', cliInstall.getCachedStatusSnapshot());
  });

  // A freshly installed CLI usually unblocks that provider's model discovery
  // (it fails opaquely with no binary), so the catalog is repopulated without a
  // relay restart. Running workers are deliberately left alone: they keep the
  // binary they launched with.
  cliInstall.onInstallSuccess(async ({ providerId } = {}) => {
    if (providerId === 'grok') {
      try {
        await refreshGrokProviderModels();
      } catch (error) {
        console.log(`[cli-install] Grok model refresh after install failed: ${error?.message || error}`);
      }
      const settings = getGrokProviderSettings();
      io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
      io.emit('grok_settings_updated', {
        configured: settings?.configured === true,
        enabled: settings?.enabled === true,
        model: String(settings?.model || 'grok-4.5').trim() || 'grok-4.5',
        models: Array.isArray(settings?.models) ? settings.models : [],
        availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
      });
      return;
    }
    if (providerId === 'claude') {
      try {
        await refreshClaudeProviderModels();
      } catch (error) {
        console.log(`[cli-install] Claude model refresh after install failed: ${error?.message || error}`);
      }
      const settings = getClaudeProviderSettings();
      io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
      io.emit('claude_settings_updated', {
        configured: settings?.configured === true,
        enabled: settings?.enabled === true,
        model: String(settings?.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5',
        models: Array.isArray(settings?.models) ? settings.models : [],
        availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
      });
      return;
    }
    if (providerId === 'copilot') {
      // The install found the SDK, so discovery can now start a Copilot
      // client; a catalog it publishes reaches clients through the
      // setOnCatalogUpdated listener above. Not while Copilot is switched
      // off: switching it on runs one (settings-routes.mjs).
      if (!isCopilotEnabled()) return;
      try {
        await copilotModelDiscoveryService?.refresh?.('cli-install');
      } catch (error) {
        console.log(`[cli-install] Copilot model refresh after install failed: ${error?.message || error}`);
      }
    }
  });

  app.get('/api/cli/status', auth, async (req, res) => {
    // Each probe spawns up to three short-lived CLI processes, so the 30s cache
    // is the default and a refresh is opt-in (the settings panel asks for one
    // when it opens).
    const force = ['1', 'true', 'yes'].includes(String(req.query?.force || '').trim().toLowerCase());
    return res.json(await cliInstall.getStatusSnapshot({ force }));
  });

  app.post('/api/cli/install', auth, async (req, res) => {
    const result = cliInstall.runInstall(req.body?.provider, { action: req.body?.action });
    if (!result?.ok) {
      return res.status(Number(result?.statusCode) || 400).json({
        error: result?.error || 'Failed to start the CLI install',
        ...cliInstall.getCachedStatusSnapshot(),
      });
    }
    // The cached provider rows ride along so the caller renders the panel
    // without a second round trip; the install itself finishes over the socket.
    return res.json({
      ok: true,
      reused: result.reused === true,
      ...cliInstall.getCachedStatusSnapshot(),
      install: result.install,
    });
  });

  app.post('/api/cli/install/cancel', auth, async (_req, res) => {
    const result = cliInstall.cancel();
    return res.json({
      ok: true,
      ...cliInstall.getCachedStatusSnapshot(),
      install: result.install,
    });
  });

  // --- OAR self-update ----------------------------------------------------
  // Checking is opt-in (zero telemetry by default). All routes are no-ops
  // with clear errors when OAR_NO_UPDATE_CHECK killed the check service.
  const updateStatePayload = () => (typeof buildUpdateStatePayload === 'function' ? buildUpdateStatePayload() : null);

  app.get('/api/update/state', auth, (_req, res) => {
    res.json({ ok: true, update: updateStatePayload() });
  });

  app.post('/api/update/auto-check', auth, (req, res) => {
    if (!updateCheckService) {
      return res.status(503).json({ error: 'Update checks are disabled on this relay (OAR_NO_UPDATE_CHECK)' });
    }
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    updateCheckService.setAutoCheck(enabled);
    return res.json({ ok: true, update: updateStatePayload() });
  });

  app.post('/api/update/check', auth, async (_req, res) => {
    if (!updateCheckService) {
      return res.status(503).json({ error: 'Update checks are disabled on this relay (OAR_NO_UPDATE_CHECK)' });
    }
    await updateCheckService.checkNow();
    return res.json({ ok: true, update: updateStatePayload() });
  });

  app.post('/api/update/dismiss', auth, (req, res) => {
    if (req.body?.outcome === true) {
      const cleared = updateInstallService?.clearOutcome?.();
      return cleared?.ok
        ? res.json({ ok: true, update: updateStatePayload() })
        : res.status(500).json({ error: 'Update state is unavailable' });
    }
    if (!updateCheckService) {
      return res.status(503).json({ error: 'Update checks are disabled on this relay (OAR_NO_UPDATE_CHECK)' });
    }
    const result = updateCheckService.dismissVersion(req.body?.version);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ ok: true, update: updateStatePayload() });
  });

  app.post('/api/update/cancel', auth, (_req, res) => {
    if (!updateInstallService?.cancel) {
      return res.status(503).json({ error: 'Updates are unavailable on this relay' });
    }
    updateInstallService.cancel();
    return res.json({ ok: true, update: updateStatePayload() });
  });

  app.post('/api/update/apply', auth, async (req, res) => {
    if (!updateInstallService) {
      return res.status(503).json({ error: 'Updates are unavailable on this relay' });
    }
    const result = await updateInstallService.startUpdate({ version: req.body?.version });
    if (!result.ok) {
      return res.status(Number(result.statusCode) || 400).json({
        error: result.error || 'Failed to start the update',
        update: updateStatePayload(),
      });
    }
    return res.json({ ok: true, targetVersion: result.targetVersion, update: updateStatePayload() });
  });

  // --- Grok account (CLI device-code OAuth) -------------------------------
  // Same shape as the Claude block above, one state shorter: `grok login
  // --device-auth` prints a URL carrying the device code, then polls x.ai and
  // exits on its own, so nothing is ever pasted back through the relay and there
  // is no `/login/code` route. Owned by server-runtime (so dispose() reaches it
  // on shutdown); the local construction is the test-harness fallback.
  const grokAuth = grokAuthService || createGrokAuthService();

  // Stand-in for the window before the first auth-store read lands: the payload
  // shape is fixed, so a broadcast carries a neutral status rather than dropping
  // the field.
  const GROK_AUTH_UNKNOWN_STATUS = Object.freeze({
    ok: false,
    loggedIn: false,
    expiresAt: null,
    expired: false,
    plan: null,
    usagePercent: null,
    periodType: null,
    periodEnd: null,
    error: null,
    checkedAt: null,
  });

  let lastRunningGrokWorkers = 0;
  function refreshRunningGrokWorkers() {
    lastRunningGrokWorkers = countRunningWorkersForProvider('grok');
    return lastRunningGrokWorkers;
  }

  function grokAuthPayload({ status = null, login = null, runningGrokWorkers = lastRunningGrokWorkers } = {}) {
    return {
      status: status || GROK_AUTH_UNKNOWN_STATUS,
      login: login || grokAuth.getLoginState(),
      runningGrokWorkers,
    };
  }

  async function buildGrokAuthPayload({
    login = null,
    forceStatus = false,
    status = null,
    countWorkers = false,
  } = {}) {
    // getStatus() never rejects: a failed read resolves as a logged-out payload.
    const resolved = status || await grokAuth.getStatus({ force: forceStatus });
    return grokAuthPayload({
      status: resolved,
      login,
      runningGrokWorkers: countWorkers ? refreshRunningGrokWorkers() : lastRunningGrokWorkers,
    });
  }

  // Login transitions broadcast synchronously off the last known status: the
  // awaiting_authorization emit carries the device URL and code, and building it
  // around a status read would park it behind the billing proxy fetch. The
  // service re-emits the same state once a fresh status lands.
  grokAuth.subscribe((login) => {
    io.emit('grok_auth_state', grokAuthPayload({ status: grokAuth.getCachedStatus(), login }));
  });

  // A fresh login unblocks model discovery (the ACP initialize probe fails while
  // logged out), so the catalog is repopulated without a relay restart. Running
  // workers are deliberately left alone: they keep the previous account's token
  // until they exit.
  grokAuth.onLoginSuccess(async () => {
    try {
      await refreshGrokProviderModels();
    } catch (error) {
      console.log(`[grok-auth] model refresh after login failed: ${error?.message || error}`);
    }
    const settings = getGrokProviderSettings();
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('grok_settings_updated', {
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'grok-4.5').trim() || 'grok-4.5',
      models: Array.isArray(settings?.models) ? settings.models : [],
      availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
    });
  });

  app.get('/api/grok/auth/status', auth, async (_req, res) => {
    return res.json(await buildGrokAuthPayload({ countWorkers: true }));
  });

  app.post('/api/grok/auth/login/start', auth, async (_req, res) => {
    const result = grokAuth.startLogin();
    if (!result?.ok) {
      return res.status(500).json({
        error: result?.error || 'Failed to start Grok login',
        ...(await buildGrokAuthPayload()),
      });
    }
    return res.json({
      ok: true,
      reused: result.reused === true,
      ...(await buildGrokAuthPayload({ login: result.login })),
    });
  });

  app.post('/api/grok/auth/login/cancel', auth, async (_req, res) => {
    const result = grokAuth.cancel();
    return res.json({ ok: true, ...(await buildGrokAuthPayload({ login: result.login })) });
  });

  app.post('/api/grok/auth/logout', auth, async (_req, res) => {
    const result = await grokAuth.logout();
    if (!result?.ok) {
      return res.status(Number(result?.statusCode) || 500).json({
        error: result?.error || 'Failed to log out of Grok',
        ...(await buildGrokAuthPayload({ status: result?.status || null, countWorkers: true })),
      });
    }
    // logout() already force-refreshed the status and its idle transition
    // already broadcast it, so neither the read nor the emit is repeated.
    return res.json({
      ok: true,
      ...(await buildGrokAuthPayload({ status: result.status, countWorkers: true })),
    });
  });
}
