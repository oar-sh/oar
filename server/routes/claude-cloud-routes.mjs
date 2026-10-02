'use strict';

// Routes of the Claude Cloud provider (`claude-cloud`):
//
//   GET  /api/settings/claude-cloud   the provider tab: switch, default model,
//                                     environment, account, login state
//   POST /api/settings/claude-cloud   { enabled?, defaultModel?, environmentId? }
//   POST /api/claude-cloud-session    the worker's binding report
//   GET  /api/claude-cloud/repos      the repositories New Chat may suggest
//                                     (`?refresh=1` reads them afresh)
//   GET  /api/claude-cloud/branches   `?repo=<owner/name or URL>` → its branches
//   POST /api/claude-cloud/login-nudge  make the Claude CLI refresh its login
//                                     (a cloud worker asks before giving up
//                                     on an expired token); answers what the
//                                     credentials reader says, never the token
//
// The Claude login never passes through here: the settings body carries where
// it comes from and when it runs out, not the token.

/** Whether a query flag such as `?refresh=1` is set. */
function queryFlag(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return ['1', 'true', 'yes'].includes(String(text ?? '').trim().toLowerCase());
}

export function registerClaudeCloudRoutes(app, deps = {}) {
  const {
    auth,
    touchCli = () => {},
    claudeCloudSettingsService = null,
    claudeCloudSessionService = null,
    claudeCloudRepoService = null,
    // `{ describe() }` of the credentials reader and nothing more: no route
    // can reach the login itself.
    claudeCloudLoginStatus = null,
    claudeAuthService = null,
  } = deps;

  if (claudeCloudSettingsService) {
    app.get('/api/settings/claude-cloud', auth, async (_req, res) => {
      try {
        return res.json(await claudeCloudSettingsService.describe());
      } catch (error) {
        console.warn(`[claude-cloud] settings read failed: ${error?.code || 'error'}`);
        return res.status(500).json({ error: 'Failed to read Claude Cloud settings' });
      }
    });

    app.post('/api/settings/claude-cloud', auth, async (req, res) => {
      let result;
      try {
        result = await claudeCloudSettingsService.update(req.body);
      } catch (error) {
        console.warn(`[claude-cloud] settings update failed: ${error?.code || 'error'}`);
        return res.status(500).json({ error: 'Failed to update Claude Cloud settings' });
      }
      if (!result?.ok) {
        return res.status(result?.statusCode || 400).json({
          error: result?.error || 'Failed to update Claude Cloud settings',
          ...(result?.code ? { code: result.code } : {}),
        });
      }
      return res.json({ ok: true, ...result.settings });
    });
  }

  if (claudeCloudSessionService) {
    // POST /api/claude-cloud-session — the Claude Cloud worker reports the
    // cloud session it created for a conversation and keeps the binding
    // current: `{ conversationId, cloudSessionId, sessionUrl, lastSequence,
    // pushedBranch?, costUsd?, model? }` after the session was created, after
    // every result, and on a push. The stored sequence is where a restarted
    // worker resumes the event stream.
    app.post('/api/claude-cloud-session', auth, (req, res) => {
      touchCli();
      const result = claudeCloudSessionService.recordWorkerReport(req.body);
      if (!result.ok) return res.status(result.statusCode || 400).json({ error: result.error });
      return res.json({ ok: true, cloud: result.cloud });
    });
  }

  if (claudeCloudLoginStatus) {
    // The workers read the CLI's login file themselves and cannot run the
    // CLI; the relay can, through the same probe the settings tab uses
    // (`claude auth status`, which refreshes a login whose refresh token is
    // still good). Serialised by the auth service; a failed probe is no
    // error here: the file decides, and the answer says what it holds.
    app.post('/api/claude-cloud/login-nudge', auth, async (_req, res) => {
      let nudged = false;
      try {
        if (typeof claudeAuthService?.getStatus === 'function') {
          await claudeAuthService.getStatus({ force: true });
          nudged = true;
        }
      } catch (error) {
        console.warn(`[claude-cloud] login nudge failed: ${error?.code || error?.message || 'error'}`);
      }
      let login = null;
      try {
        login = typeof claudeCloudLoginStatus.describe === 'function' ? claudeCloudLoginStatus.describe() : null;
      } catch {
        login = null;
      }
      return res.json({
        ok: true,
        nudged,
        hasToken: login?.hasToken === true,
        expiresAt: login?.expiresAt || null,
        expired: login?.expired === true,
      });
    });
  }

  if (claudeCloudRepoService) {
    // Every answer the service gives is 200, also an `ok: false` one: the
    // browser shows the recent repositories with the error text beside them.
    app.get('/api/claude-cloud/repos', auth, async (req, res) => {
      try {
        return res.json(await claudeCloudRepoService.listRepositories({ force: queryFlag(req.query?.refresh) }));
      } catch (error) {
        console.warn(`[claude-cloud] repository list failed: ${error?.code || 'error'}`);
        return res.status(500).json({ error: 'Failed to list Claude Cloud repositories' });
      }
    });

    app.get('/api/claude-cloud/branches', auth, async (req, res) => {
      const repo = Array.isArray(req.query?.repo) ? req.query.repo[0] : req.query?.repo;
      let result;
      try {
        result = await claudeCloudRepoService.listBranches(typeof repo === 'string' ? repo : '');
      } catch (error) {
        console.warn(`[claude-cloud] branch list failed: ${error?.code || 'error'}`);
        return res.status(500).json({ error: 'Failed to list the repository branches' });
      }
      // A repository the service cannot even name is the caller's mistake.
      if (!result?.ok && result?.error?.code === 'invalid_repo') return res.status(400).json(result);
      return res.json(result);
    });
  }
}
