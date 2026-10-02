'use strict';

// Routes of the Claude Cloud provider (`claude-cloud`):
//
//   GET  /api/settings/claude-cloud   the provider tab: switch, default model,
//                                     environment, account, login state
//   POST /api/settings/claude-cloud   { enabled?, defaultModel?, environmentId? }
//   POST /api/claude-cloud-session    the worker's binding report
//
// The Claude login never passes through here: the settings body carries where
// it comes from and when it runs out, not the token.

export function registerClaudeCloudRoutes(app, deps = {}) {
  const {
    auth,
    touchCli = () => {},
    claudeCloudSettingsService = null,
    claudeCloudSessionService = null,
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
}
