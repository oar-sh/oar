'use strict';

// Preview management API. Lives on the *relay* port behind `auth` — the preview
// listener itself has no routes and no way to register anything. Creating or
// closing a preview therefore always requires the relay token, even though the
// resulting URL is public.
//
// Conversation scope. A preview's token is its only credential, so an agent's
// preview tool must not see or close another conversation's. A request that
// names a conversation — the `conversationId` query, else the
// `X-Relay-Conversation-Id` header every worker and the OAR MCP server send —
// is scoped to it: GET lists only its previews, DELETE refuses another
// conversation's with a 403. Only a request with neither (the web UI's
// Settings → Previews) gets the relay-wide view. Agent-side callers present the
// same relay token as the owner, so this is a boundary for the tools, not
// against a caller that deliberately leaves both out.

import { validateStaticRoot } from '../services/preview-static-handler.mjs';

/**
 * The conversation ids a named scope covers: the id itself, and — when it
 * names a conversation by its id or by its session id — that conversation's id
 * and session id. They differ after a placeholder rekey, and a worker's or
 * tool server's own identity is the session id. A lookup that fails narrows
 * the scope to the named id rather than failing the request.
 */
export function createPreviewScopeResolver({
  getConversation = () => null,
  getConversationBySdkSessionId = () => null,
} = {}) {
  return function resolveConversationScope(id) {
    const named = String(id || '').trim();
    if (!named) return [];
    const ids = new Set([named]);
    let conversation = null;
    try {
      conversation = getConversation(named) || getConversationBySdkSessionId(named) || null;
    } catch {}
    for (const value of [conversation?.id, conversation?.sdk_session_id]) {
      const text = String(value || '').trim();
      if (text) ids.add(text);
    }
    return [...ids];
  };
}

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
    // (scope id) => the conversation ids it covers; createPreviewScopeResolver.
    resolveConversationScope = (id) => (id ? [id] : []),
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

  // The conversation ids a request is scoped to, or null for the owner's
  // view. The query wins over the header: the header is the worker's own
  // session, while a worker can be handed a row of another conversation (a
  // placeholder rekey, or the shared fallback of the worker's pending lookup)
  // and its tool names the conversation of the turn it is running.
  function requestScope(req) {
    const named = String(req.query?.conversationId || '').trim()
      || String(req.headers?.['x-relay-conversation-id'] || '').trim();
    if (!named) return null;
    const ids = resolveConversationScope(named);
    return Array.isArray(ids) && ids.length ? ids : [named];
  }

  // GET /api/previews — one conversation's live previews when scoped (see the
  // top of the file), else every one. Unscoped is what the settings "Live
  // previews" list uses: nothing expires on its own, so there has to be one
  // place that shows everything.
  app.get('/api/previews', auth, (req, res) => {
    const scope = requestScope(req);
    const previews = scope
      ? previewRegistry.list().filter((entry) => scope.includes(entry.conversationId))
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
    // `existing`: this conversation already had a preview of the same target,
    // and this is it (same token, same link, label unchanged).
    res.json({
      ok: true,
      existing: created.existing === true,
      preview: created.preview,
      url: created.preview.url,
      basePath: created.preview.basePath,
    });
  });

  // DELETE /api/previews/:token — the link stops resolving immediately. The dev
  // server behind it is untouched; it is a separate background task. A scoped
  // request may close only its own conversation's previews.
  app.delete('/api/previews/:token', auth, (req, res) => {
    const scope = requestScope(req);
    if (scope) {
      const token = String(req.params?.token || '').trim();
      // list() also holds the stored previews a restart could not check yet.
      const target = previewRegistry.list().find((entry) => entry.token === token);
      if (target && !scope.includes(target.conversationId)) {
        return res.status(403).json({
          error: 'This preview belongs to another conversation; a conversation can close only its own previews. '
            + 'The owner can close it in Settings → Previews.',
        });
      }
    }
    const closed = previewRegistry.close(req.params?.token);
    if (!closed.ok) return res.status(closed.status || 404).json({ error: closed.error });
    res.json({ ok: true, preview: closed.preview });
  });
}
