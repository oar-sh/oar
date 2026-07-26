const DEFAULT_DELETE_RETRIES = 3;
const RETRY_DELAYS_MS = [250, 500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeConversationId(value) {
  return String(value || '').trim();
}

function createSdkDeleteSessionCaller(sdkClient) {
  if (sdkClient && typeof sdkClient.deleteSession === 'function') {
    return sdkClient.deleteSession.bind(sdkClient);
  }
  let warned = false;
  return async (sessionId) => {
    if (!warned) {
      warned = true;
      console.warn(`[delete-archive] SDK deleteSession() is unavailable; skipping remote delete lifecycle.`);
    }
    return { ok: true, skipped: true, sessionId };
  };
}

import { cleanupGeneratedImagesForConversation } from './generated-image-cleanup-service.mjs';

export function createDeleteArchiveService(db, sdkClient, { resolveSessionStateRoot = null } = {}) {
  const callDeleteSession = createSdkDeleteSessionCaller(sdkClient);

  const stmts = {
    getConversation: db.prepare(`
      SELECT c.id, c.status, c.sdk_session_id
      FROM conversations c
      WHERE c.id = ?
      LIMIT 1
    `),
    markDeleted: db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = ? WHERE id = ?`),
    markArchived: db.prepare(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`),
    listDeletedWithSdkSession: db.prepare(`
      SELECT c.id, c.sdk_session_id
      FROM conversations c
      WHERE c.status = 'deleted'
      ORDER BY c.updated_at ASC
    `),
    listConversationMessages: db.prepare(`
      SELECT attachments
      FROM messages
      WHERE conversation_id = ?
      ORDER BY timestamp ASC
    `),
    hardDeleteConversation: db.transaction((conversationId) => {
      db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`).run(conversationId);
      db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`).run(conversationId);
      db.prepare(`DELETE FROM queue WHERE conversation_id = ?`).run(conversationId);
      db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
      db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(conversationId);
      db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
    }),
  };

  async function deleteSdkSessionWithRetries(sdkSessionId, conversationId) {
    let lastError = null;
    for (let attempt = 1; attempt <= DEFAULT_DELETE_RETRIES; attempt += 1) {
      try {
        await callDeleteSession(sdkSessionId);
        return { ok: true };
      } catch (error) {
        lastError = error;
        const suffix = attempt >= DEFAULT_DELETE_RETRIES ? ' (no more retries)' : '';
        console.warn(
          `[delete-archive] SDK delete failed for conversation=${conversationId}, session=${sdkSessionId}, attempt=${attempt}/${DEFAULT_DELETE_RETRIES}${suffix}: ${error?.message || error}`
        );
        if (attempt < DEFAULT_DELETE_RETRIES) {
          await sleep(RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] || 0);
        }
      }
    }
    return { ok: false, error: lastError };
  }

  async function hardDeleteConversation(conversationId) {
    const row = stmts.getConversation.get(conversationId);
    cleanupGeneratedImagesForConversation({
      conversationId,
      sdkSessionId: String(row?.sdk_session_id || '').trim() || null,
      messageRows: stmts.listConversationMessages.all(conversationId),
      resolveSessionStateRoot,
    });
    stmts.hardDeleteConversation(conversationId);
  }

  async function deleteConversation(conversationId) {
    const id = normalizeConversationId(conversationId);
    if (!id) return { ok: false, error: 'Missing conversation id' };

    const row = stmts.getConversation.get(id);
    if (!row) return { ok: true, alreadyDeleted: true };
    if (row.status === 'deleted') return { ok: true, alreadyDeleted: true, tombstoned: true };

    stmts.markDeleted.run(new Date().toISOString(), id);

    const sdkSessionId = String(row.sdk_session_id || '').trim();

    if (!sdkSessionId) {
      await hardDeleteConversation(id);
      return { ok: true, deleted: true, tombstoned: true };
    }

    const sdkDeleteResult = await deleteSdkSessionWithRetries(sdkSessionId, id);
    if (sdkDeleteResult.ok) {
      await hardDeleteConversation(id);
      return { ok: true, deleted: true, tombstoned: true, sdkDeleted: true };
    }

    console.warn(`[delete-archive] Leaving tombstoned conversation=${id}; SDK delete failed. Will retry on next startup.`);
    return { ok: true, deleted: false, tombstoned: true, sdkDeleted: false };
  }

  async function archiveConversation(conversationId) {
    const id = normalizeConversationId(conversationId);
    if (!id) return { ok: false, error: 'Missing conversation id' };

    const row = stmts.getConversation.get(id);
    if (!row) return { ok: true, alreadyDeleted: true };
    if (row.status === 'deleted') return { ok: true, alreadyDeleted: true, tombstoned: true };

    stmts.markArchived.run(new Date().toISOString(), id);
    return { ok: true, archived: true };
  }

  async function retryPendingDeletesOnStartup() {
    const pendingRows = stmts.listDeletedWithSdkSession.all();
    for (const row of pendingRows) {
      if (!row || !row.id) continue;
      const id = String(row.id).trim();
      if (!id) continue;
      const sdkSessionId = String(row.sdk_session_id || '').trim();
      if (!sdkSessionId) {
        await hardDeleteConversation(id);
        continue;
      }
      const sdkDeleteResult = await deleteSdkSessionWithRetries(sdkSessionId, id);
      if (sdkDeleteResult.ok) {
        await hardDeleteConversation(id);
      } else {
        console.warn(`[delete-archive] Startup retry failed for conversation=${id}; tombstone retained for next restart.`);
      }
    }
    return { ok: true, pendingCount: pendingRows.length };
  }

  return { deleteConversation, archiveConversation, retryPendingDeletesOnStartup };
}
