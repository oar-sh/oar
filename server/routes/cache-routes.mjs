'use strict';

import { createCacheRebuildService } from '../services/cache-rebuild-service.mjs';

export function registerCacheRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    fs,
    path,
    uploadsDir,
    bootstrapRuntimeSessionBindings,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    closeConversationPreviews,
    conversationGroups = null,
  } = deps;

  const cacheRebuildService = createCacheRebuildService({
    db,
    stmts,
    io,
    fs,
    path,
    uploadsDir,
    bootstrapRuntimeSessionBindings,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    closeConversationPreviews,
    conversationGroups,
  });

  app.post('/api/cache/rebuild', auth, (req, res) => {
    const mode = String(req.body?.mode || 'reconcile').trim().toLowerCase();
    try {
      const result = cacheRebuildService.rebuildCache({ mode });
      io.emit('cache_rebuilt', result);
      return res.json({ ok: true, mode: result.mode, summary: result.summary });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      return res.status(Number.isInteger(statusCode) ? statusCode : 500).json({
        error: error?.message || 'Failed to rebuild cache',
      });
    }
  });
}
