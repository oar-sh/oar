'use strict';

function normalizeId(value) {
  return String(value || '').trim();
}

function buildLegacyConversationList(db) {
  return db.prepare(`
    SELECT id, sdk_session_id, archived, status, updated_at
    FROM conversations
    WHERE status != 'deleted'
      AND (sdk_session_id IS NULL OR sdk_session_id = '')
    ORDER BY updated_at DESC, id ASC
  `);
}

function buildBoundConversationList(db) {
  return db.prepare(`
    SELECT id, sdk_session_id
    FROM conversations
    WHERE status != 'deleted'
      AND sdk_session_id IS NOT NULL
      AND sdk_session_id != ''
    ORDER BY updated_at DESC, id ASC
  `);
}

function buildConversationActivityStatements(db) {
  return {
    queueCount: db.prepare(`
      SELECT COUNT(*) AS cnt
        FROM queue
        WHERE conversation_id = ?
        AND status IN ('pending', 'processing', 'parked')
    `),
    runtimeSessionCount: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM runtime_sessions
      WHERE conversation_id = ?
    `),
    pendingQuestionCount: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM relay_questions
      WHERE conversation_id = ?
        AND status = 'pending'
    `),
    conversationRows: db.prepare(`
      SELECT id
      FROM conversations
      WHERE status != 'deleted'
    `),
  };
}

export function createCacheRebuildService({
  db,
  stmts,
  io,
  fs,
  path,
  uploadsDir,
  bootstrapRuntimeSessionBindings,
  collectOrphanedUploadsFromConversation,
  deleteOrphanedUploads,
  // (conversationId) => void: a hard-deleted conversation takes its preview
  // links with it, as a delete from the UI does. Archiving keeps them.
  closeConversationPreviews = null,
  // Session groups: a purged head leaves its group, and a wipe is followed
  // by a repair of what the wiped rows headed. Absent in older wiring.
  conversationGroups = null,
}) {
  const legacyConversationList = buildLegacyConversationList(db);
  const boundConversationList = buildBoundConversationList(db);
  const activity = buildConversationActivityStatements(db);

  function isLegacyConversationActive(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return false;
    const queueCount = Number(activity.queueCount.get(sid)?.cnt || 0);
    const runtimeSessionCount = Number(activity.runtimeSessionCount.get(sid)?.cnt || 0);
    const pendingQuestionCount = Number(activity.pendingQuestionCount.get(sid)?.cnt || 0);
    return queueCount > 0 || runtimeSessionCount > 0 || pendingQuestionCount > 0;
  }

  function purgeConversation(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return [];
    const orphanedUploads = collectOrphanedUploadsFromConversation(sid);
    db.transaction(() => {
      try { conversationGroups?.forgetConversation?.(sid); } catch {}
      db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM queue WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(sid);
      db.prepare(`DELETE FROM conversations WHERE id = ?`).run(sid);
    })();
    closePreviews(sid);
    deleteOrphanedUploads(orphanedUploads);
    return orphanedUploads;
  }

  function closePreviews(conversationId) {
    try {
      closeConversationPreviews?.(conversationId);
    } catch (error) {
      console.warn(`[preview] closing the previews of a purged conversation failed: ${error?.message || error}`);
    }
  }

  function archiveConversation(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return false;
    const result = db.prepare(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ? AND status != 'deleted'`).run(new Date().toISOString(), sid);
    return Number(result?.changes || 0) > 0;
  }

  function fullWipeCache() {
    const now = new Date().toISOString();
    const conversationIds = activity.conversationRows.all().map((row) => normalizeId(row?.id)).filter(Boolean);
    const manualTitleConversations = db.prepare(`
      SELECT id
      FROM conversations
      WHERE status != 'deleted'
        AND title_source = 'manual'
    `).all().map((row) => normalizeId(row?.id)).filter(Boolean);
    const manualTitleConversationSet = new Set(manualTitleConversations);
    // The groups headed by a row about to go keep the head's title as their
    // name, so a group whose hand-titled members survive is not nameless; the
    // head link stays for a re-import under the same id.
    try {
      conversationGroups?.freezeNamesForHeads?.(conversationIds.filter((id) => !manualTitleConversationSet.has(id)), now);
    } catch {}
    const uploadHashes = [];
    for (const conversationId of conversationIds) {
      for (const hash of collectOrphanedUploadsFromConversation(conversationId)) {
        if (!uploadHashes.includes(hash)) uploadHashes.push(hash);
      }
    }

    db.transaction(() => {
      db.prepare(`DELETE FROM relay_questions`).run();
      db.prepare(`DELETE FROM relay_boards`).run();
      db.prepare(`DELETE FROM relay_activity`).run();
      db.prepare(`DELETE FROM relay_stream_events`).run();
      db.prepare(`DELETE FROM relay_thought`).run();
      db.prepare(`DELETE FROM queue`).run();
      db.prepare(`DELETE FROM messages`).run();
      db.prepare(`DELETE FROM runtime_sessions`).run();
      db.prepare(`DELETE FROM conversations WHERE status = 'deleted' OR title_source != 'manual'`).run();
      for (const conversationId of manualTitleConversations) {
        db.prepare(`
          UPDATE conversations
          SET archived = 0,
              status = 'active',
              compacted_into = NULL,
              compacted_from = NULL,
              summary_seed = NULL,
              seed_pending = 0,
              updated_at = ?
          WHERE id = ?
        `).run(now, conversationId);
      }
      db.prepare(`DELETE FROM deleted_sdk_sessions`).run();
      db.prepare(`DELETE FROM sdk_delete_requests`).run();
      db.prepare(`DELETE FROM sdk_session_imports`).run();
      db.prepare(`DELETE FROM upload_refs`).run();
      db.prepare(`DELETE FROM uploaded_files`).run();
      // Groups whose rows are all gone go too; one whose head was wiped but
      // whose hand-titled members stay keeps the frozen name and the head
      // link (a re-imported head takes it up again).
      try { conversationGroups?.sweepEmpty?.(); } catch {}
    })();

    for (const conversationId of conversationIds) {
      if (!manualTitleConversationSet.has(conversationId)) closePreviews(conversationId);
    }

    deleteOrphanedUploads(uploadHashes);

    if (uploadsDir && fs?.existsSync?.(uploadsDir)) {
      try {
        for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
          const entryPath = path.join(uploadsDir, entry.name);
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch {}
      try {
        fs.mkdirSync(uploadsDir, { recursive: true });
      } catch {}
    }

    return {
      wipedAt: now,
      conversationsRemoved: conversationIds.length - manualTitleConversations.length,
      manualTitleConversationsRetained: manualTitleConversationSet.size,
      uploadsRemoved: uploadHashes.length,
    };
  }

  function reconcileCache() {
    const legacyRows = legacyConversationList.all();
    const summary = {
      purgedConversationIds: [],
      archivedConversationIds: [],
      retainedConversationIds: [],
      runtimeSessionsBootstrapped: 0,
      uploadsRemoved: 0,
    };

    for (const row of legacyRows) {
      const conversationId = normalizeId(row?.id);
      if (!conversationId) continue;

      if (isLegacyConversationActive(conversationId)) {
        if (archiveConversation(conversationId)) {
          summary.archivedConversationIds.push(conversationId);
        } else {
          summary.retainedConversationIds.push(conversationId);
        }
        continue;
      }

      purgeConversation(conversationId);
      summary.purgedConversationIds.push(conversationId);
    }

    summary.runtimeSessionsBootstrapped = bootstrapRuntimeSessionBindings();
    return summary;
  }

  function rebuildCache({ mode = 'reconcile' } = {}) {
    const normalizedMode = String(mode || 'reconcile').trim().toLowerCase();
    if (normalizedMode === 'full' || normalizedMode === 'wipe' || normalizedMode === 'rebuild') {
      return {
        mode: 'full',
        summary: fullWipeCache(),
      };
    }

    if (normalizedMode !== 'reconcile') {
      const error = new Error(`Unsupported cache rebuild mode: ${normalizedMode || 'empty'}`);
      error.statusCode = 400;
      throw error;
    }

    return {
      mode: 'reconcile',
      summary: reconcileCache(),
    };
  }

  return {
    rebuildCache,
    reconcileCache,
    fullWipeCache,
    purgeConversation,
    archiveConversation,
    isLegacyConversationActive,
    listLegacyConversations: () => legacyConversationList.all(),
    listBoundConversations: () => boundConversationList.all(),
  };
}
