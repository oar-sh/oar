'use strict';

// Preview management API. Lives on the *relay* port behind `auth` — the preview
// listener itself has no routes and no way to register anything. Creating or
// closing a preview therefore always requires the relay token, even though the
// resulting URL is public.

import { validateStaticRoot } from '../services/preview-static-handler.mjs';

export function registerPreviewRoutes(app, deps) {
  const {
    auth,
    previewRegistry,
    previewHealthProbe = null,
    // (conversationId) => absolute workspace root or ''. Static previews are
    // jailed to it; without one they are refused rather than served unscoped.
    resolvePreviewWorkspaceRoot = () => '',
    // (conversationId, preview) => void. Pins a transcript card when a turn is
    // in flight for the conversation; a no-op otherwise (manual /preview
    // publishes stay panel-only — the transcript records the conversation, not
    // panel actions).
    recordPreviewCard = () => {},
  } = deps;

  function laneUnavailable(res) {
    const settings = previewRegistry?.settings;
    if (!settings) return res.status(503).json({ error: 'Preview lane is unavailable' });
    // The interlock errors are the actionable part of a disabled lane ("you set
    // publicBaseUrl to the relay's hostname"), so they are handed back verbatim
    // rather than collapsed into a generic 503.
    return res.status(503).json({
      error: settings.requested
        ? 'Preview lane failed its startup checks'
        : 'Preview lane is disabled (set previews.enabled and previews.publicBaseUrl)',
      details: settings.errors || [],
    });
  }

  // GET /api/previews — every live preview, or one conversation's when filtered.
  // Unfiltered is what the settings "Live previews" list uses: nothing expires
  // on its own, so there has to be one place that shows everything.
  app.get('/api/previews', auth, (req, res) => {
    const conversationId = String(req.query?.conversationId || '').trim();
    const previews = conversationId
      ? previewRegistry.listForConversation(conversationId)
      : previewRegistry.list();
    res.json({
      previews,
      enabled: previewRegistry.settings?.enabled === true,
      publicBaseUrl: previewRegistry.settings?.publicBaseUrl || '',
      errors: previewRegistry.settings?.errors || [],
    });
  });

  // POST /api/previews — publish an already-listening local port, or a
  // directory the lane serves itself (static mode).
  app.post('/api/previews', auth, (req, res) => {
    if (previewRegistry.settings?.enabled !== true) return laneUnavailable(res);

    const dir = String(req.body?.dir || '').trim();
    const hasPort = req.body?.port !== undefined && req.body?.port !== null && String(req.body.port).trim() !== '';
    if (dir && hasPort) {
      return res.status(400).json({ error: 'Pass either port or dir, not both' });
    }

    let created;
    if (dir) {
      const conversationId = String(req.body?.conversationId || '').trim();
      let workspaceRoot = '';
      try {
        workspaceRoot = String(resolvePreviewWorkspaceRoot(conversationId) || '');
      } catch {}
      const jailed = validateStaticRoot(dir, { workspaceRoot });
      if (!jailed.ok) return res.status(400).json({ error: jailed.error });
      created = previewRegistry.createStatic({
        conversationId,
        rootDir: jailed.rootDir,
        label: req.body?.label,
      });
    } else {
      const port = Number(req.body?.port);
      if (!Number.isFinite(port)) return res.status(400).json({ error: 'Missing or invalid port (or pass dir for a static preview)' });
      created = previewRegistry.create({
        conversationId: req.body?.conversationId,
        port,
        host: req.body?.host,
        label: req.body?.label,
      });
    }
    if (!created.ok) return res.status(created.status || 400).json({ error: created.error });

    try {
      recordPreviewCard(String(req.body?.conversationId || '').trim(), created.preview);
    } catch {}
    // Probe immediately so the card does not sit badge-less until the next
    // scheduled sweep — and so a typo'd port shows as offline right away.
    previewHealthProbe?.probeNow?.(created.preview.token);
    res.json({ ok: true, preview: created.preview, url: created.preview.url, basePath: created.preview.basePath });
  });

  // DELETE /api/previews/:token — the link stops resolving immediately. The dev
  // server behind it is untouched; it is a separate background task.
  app.delete('/api/previews/:token', auth, (req, res) => {
    const closed = previewRegistry.close(req.params?.token);
    if (!closed.ok) return res.status(closed.status || 404).json({ error: closed.error });
    res.json({ ok: true, preview: closed.preview });
  });
}
