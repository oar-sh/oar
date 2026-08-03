'use strict';

// Routes backing the "Git changes" modal. The repository root is always
// resolved server-side from the conversation scope (mirroring the file
// preview routes) — the client never sends absolute paths.

export function resolveGitScopedRootPath(req, {
  resolveConversationWorkspaceState,
  currentWorkspaceRootPath,
} = {}) {
  const conversationId = String(
    req?.query?.conversationId
    || req?.query?.conversation_id
    || req?.headers?.['x-conversation-id']
    || '',
  ).trim();
  const sdkSessionId = String(
    req?.query?.sdkSessionId
    || req?.query?.sdk_session_id
    || req?.headers?.['x-sdk-session-id']
    || '',
  ).trim();
  if ((conversationId || sdkSessionId) && typeof resolveConversationWorkspaceState === 'function') {
    const state = resolveConversationWorkspaceState({ conversationId, sdkSessionId });
    const scoped = String(state?.currentWorkspaceRootPath || '').trim();
    if (scoped) return scoped;
  }
  if (typeof currentWorkspaceRootPath === 'function') {
    const fallback = String(currentWorkspaceRootPath() || '').trim();
    if (fallback) return fallback;
  }
  return null;
}

export function registerGitRoutes(app, deps) {
  const {
    auth,
    gitChangesService,
    resolveConversationWorkspaceState,
    currentWorkspaceRootPath,
    normalizeWorkspaceRelativePath,
    resolveWorkspaceFilePath,
  } = deps;

  if (!gitChangesService) return;

  function requireRootPath(req, res) {
    const rootPath = resolveGitScopedRootPath(req, {
      resolveConversationWorkspaceState,
      currentWorkspaceRootPath,
    });
    if (!rootPath) {
      res.status(400).json({ error: 'No workspace root available' });
      return null;
    }
    return rootPath;
  }

  app.get('/api/git/status', auth, async (req, res) => {
    const rootPath = requireRootPath(req, res);
    if (!rootPath) return;
    const payload = await gitChangesService.getStatus(rootPath);
    res.setHeader('Cache-Control', 'no-store');
    if (!payload.ok) return res.status(500).json({ error: payload.error || 'Failed to read git status' });
    res.json({ ...payload, rootPath });
  });

  app.get('/api/git/diff', auth, async (req, res) => {
    const rootPath = requireRootPath(req, res);
    if (!rootPath) return;
    const requestedPath = String(req.query?.path || '').trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const absolutePath = resolveWorkspaceFilePath(requestedPath, rootPath);
    if (!normalizedPath || !absolutePath) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    const untracked = String(req.query?.untracked || '') === '1';
    const payload = await gitChangesService.getDiff(rootPath, normalizedPath.replace(/\\/g, '/'), { untracked });
    res.setHeader('Cache-Control', 'no-store');
    if (!payload.ok) return res.status(500).json({ error: payload.error || 'Failed to read git diff' });
    res.json(payload);
  });

  app.post('/api/git/pull', auth, async (req, res) => {
    const rootPath = requireRootPath(req, res);
    if (!rootPath) return;
    const payload = await gitChangesService.pull(rootPath);
    res.setHeader('Cache-Control', 'no-store');
    if (!payload.ok) return res.status(500).json({ error: payload.error || 'git pull failed' });
    res.json(payload);
  });
}
