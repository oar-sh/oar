'use strict';

import { randomBytes } from 'node:crypto';

// Public conversation shares and their access log (migration 0016).
//
// A conversation has at most one active share: its newest unrevoked row in
// `conversation_shares`. A share is a lineage of tokens: renewing it adds a
// row with a new token and the same `lineage_id` and revokes the old token in
// the same transaction, so the access log, keyed to the lineage, carries over.
// Stopping a share revokes it and deletes its log.
//
// Every reader tolerates a schema without the migration: a share then has its
// token as its lineage, nothing is logged, and the log reads as empty.

export const SHARE_STORE_VIEWER_IP_SETTING_KEY = 'shares_store_viewer_ip';
const SHARE_VIEWER_KEY_SECRET_SETTING_KEY = 'shares_viewer_key_secret';

export const SHARE_OPENS_PAGE_DEFAULT = 200;
export const SHARE_OPENS_PAGE_MAX = 1000;

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function isRevoked(row) {
  return !!String(row?.revoked_at || '').trim();
}

function mapShareRow(row) {
  if (!row?.token) return null;
  return {
    token: String(row.token),
    conversationId: String(row.conversation_id || ''),
    lineageId: String(row.lineage_id || '').trim() || String(row.token),
    createdAt: row.created_at || null,
    revokedAt: row.revoked_at || null,
  };
}

function mapOpenRow(row) {
  return {
    openedAt: row.opened_at,
    ip: row.ip || null,
    country: row.country || null,
    userAgent: row.user_agent || null,
    // Enough to tell viewers apart in a list; the key itself stays here.
    viewer: String(row.viewer_key || '').slice(0, 8) || null,
  };
}

export function createShareRepository(db) {
  const shareColumns = new Set(db.prepare(`PRAGMA table_info(conversation_shares)`).all().map((column) => column.name));
  const hasLineage = shareColumns.has('lineage_id');
  const hasLog = tableExists(db, 'conversation_share_opens');
  const lineageSelect = hasLineage ? 'lineage_id' : 'NULL AS lineage_id';
  const shareSelect = `token, conversation_id, created_at, revoked_at, ${lineageSelect}`;

  const stmts = {
    activeByConversation: db.prepare(`
      SELECT ${shareSelect}
      FROM conversation_shares
      WHERE conversation_id = ?
        AND (revoked_at IS NULL OR revoked_at = '')
      ORDER BY created_at DESC
      LIMIT 1
    `),
    byToken: db.prepare(`SELECT ${shareSelect} FROM conversation_shares WHERE token = ? LIMIT 1`),
    insert: hasLineage
      ? db.prepare(`
        INSERT INTO conversation_shares (token, conversation_id, created_at, last_accessed_at, revoked_at, lineage_id)
        VALUES (?, ?, ?, NULL, NULL, ?)
      `)
      : db.prepare(`
        INSERT INTO conversation_shares (token, conversation_id, created_at, last_accessed_at, revoked_at)
        VALUES (?, ?, ?, NULL, NULL)
      `),
    revokeOthers: db.prepare(`
      UPDATE conversation_shares
      SET revoked_at = ?
      WHERE conversation_id = ?
        AND token <> ?
        AND (revoked_at IS NULL OR revoked_at = '')
    `),
    revokeAll: db.prepare(`
      UPDATE conversation_shares
      SET revoked_at = ?
      WHERE conversation_id = ?
        AND (revoked_at IS NULL OR revoked_at = '')
    `),
    listActive: db.prepare(`
      SELECT s.token, s.conversation_id, s.created_at, s.revoked_at, ${hasLineage ? 's.lineage_id' : 'NULL AS lineage_id'},
        c.title AS conversation_title, c.archived AS conversation_archived
      FROM conversation_shares s
      JOIN conversations c ON c.id = s.conversation_id
      WHERE (s.revoked_at IS NULL OR s.revoked_at = '')
        AND c.status != 'deleted'
      ORDER BY s.created_at DESC
    `),
    conversationStatus: db.prepare(`SELECT id, status FROM conversations WHERE id = ?`),
    getSetting: db.prepare(`SELECT value FROM app_settings WHERE key = ? LIMIT 1`),
    upsertSetting: db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
  };
  // Addresses already stored: the access log's `ip` and the `viewerIp` of the
  // status log's shared reads. A row whose payload is not JSON is left alone.
  const hasEvents = tableExists(db, 'status_events');
  const EVENT_IP = `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.viewerIp') END`;
  const ipSources = [
    ...(hasLog ? [`SELECT ip AS address FROM conversation_share_opens WHERE ip IS NOT NULL AND ip <> ''`] : []),
    ...(hasEvents ? [`SELECT ${EVENT_IP} AS address FROM status_events WHERE type = 'shared-access-opened' AND COALESCE(${EVENT_IP}, '') <> ''`] : []),
  ];
  const ipStmts = {
    count: ipSources.length ? db.prepare(`SELECT COUNT(*) AS n FROM (${ipSources.join(' UNION ')})`) : null,
    clearOpens: hasLog ? db.prepare(`UPDATE conversation_share_opens SET ip = NULL WHERE ip IS NOT NULL`) : null,
    clearEvents: hasEvents ? db.prepare(`
      UPDATE status_events
      SET payload_json = json_remove(payload_json, '$.viewerIp')
      WHERE type = 'shared-access-opened' AND ${EVENT_IP} IS NOT NULL
    `) : null,
  };

  const logStmts = hasLog ? {
    insert: db.prepare(`
      INSERT INTO conversation_share_opens (lineage_id, conversation_id, opened_at, ip, user_agent, country, viewer_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    stats: db.prepare(`
      SELECT COUNT(*) AS opens, COUNT(DISTINCT viewer_key) AS viewers, MAX(opened_at) AS last_opened_at
      FROM conversation_share_opens
      WHERE lineage_id = ?
    `),
    page: db.prepare(`
      SELECT opened_at, ip, user_agent, country, viewer_key
      FROM conversation_share_opens
      WHERE lineage_id = ?
      ORDER BY opened_at DESC, id DESC
      LIMIT ?
    `),
    lastOpenOf: db.prepare(`
      SELECT MAX(opened_at) AS opened_at
      FROM conversation_share_opens
      WHERE lineage_id = ? AND viewer_key = ?
    `),
    deleteForConversation: db.prepare(`DELETE FROM conversation_share_opens WHERE conversation_id = ?`),
  } : null;

  function findActiveShare(conversationId) {
    return mapShareRow(stmts.activeByConversation.get(String(conversationId || '').trim()));
  }

  function findShareByToken(token) {
    return mapShareRow(stmts.byToken.get(String(token || '').trim()));
  }

  /**
   * The share a public request may read: the token's row, neither revoked nor
   * renewed, of a conversation that still exists. Null otherwise, and every
   * share route answers that with a 404.
   */
  function findLiveShare(token) {
    const row = stmts.byToken.get(String(token || '').trim());
    if (!row || isRevoked(row)) return null;
    const share = mapShareRow(row);
    const conversation = stmts.conversationStatus.get(share.conversationId);
    if (!conversation || String(conversation.status || '').trim().toLowerCase() === 'deleted') return null;
    return share;
  }

  function insertShare(conversationId, token, now, lineageId) {
    if (hasLineage) stmts.insert.run(token, conversationId, now, lineageId || token);
    else stmts.insert.run(token, conversationId, now);
  }

  /** The active share, or a new one; `created` tells which. */
  const getOrCreateShare = db.transaction((conversationId, makeToken, now) => {
    const existing = findActiveShare(conversationId);
    if (existing) return { share: existing, created: false };
    const token = makeToken();
    insertShare(conversationId, token, now, token);
    return { share: findShareByToken(token), created: true };
  });

  /**
   * A new token for the conversation's active share, same lineage; every other
   * token of the conversation is revoked with it. Null without an active share.
   */
  const renewShare = db.transaction((conversationId, makeToken, now) => {
    const existing = findActiveShare(conversationId);
    if (!existing) return null;
    const token = makeToken();
    insertShare(conversationId, token, now, existing.lineageId);
    stmts.revokeOthers.run(now, conversationId, token);
    return { share: findShareByToken(token), previousToken: existing.token };
  });

  /** Revokes every token of the conversation and deletes its access log. */
  const stopSharing = db.transaction((conversationId, now) => {
    const revoked = stmts.revokeAll.run(now, conversationId).changes;
    const opensDeleted = logStmts ? logStmts.deleteForConversation.run(conversationId).changes : 0;
    return { revokedCount: Number(revoked || 0), opensDeleted: Number(opensDeleted || 0) };
  });

  function forgetConversation(conversationId) {
    return logStmts ? Number(logStmts.deleteForConversation.run(conversationId).changes || 0) : 0;
  }

  function shareStats(lineageId) {
    const row = logStmts ? logStmts.stats.get(lineageId) : null;
    return {
      openCount: Number(row?.opens || 0),
      viewerCount: Number(row?.viewers || 0),
      lastOpenedAt: row?.last_opened_at || null,
    };
  }

  /** One entry per conversation with an active share, newest share first. */
  function listActiveShares() {
    const seen = new Set();
    const shares = [];
    for (const row of stmts.listActive.all()) {
      const conversationId = String(row.conversation_id || '');
      if (seen.has(conversationId)) continue;
      seen.add(conversationId);
      const share = mapShareRow(row);
      // The lineage started with its first token; that row holds the date.
      const first = share.lineageId === share.token ? row : stmts.byToken.get(share.lineageId);
      shares.push({
        ...share,
        title: String(row.conversation_title || '').trim(),
        archived: Number(row.conversation_archived || 0) === 1,
        sharedSince: first?.created_at || share.createdAt,
        ...shareStats(share.lineageId),
      });
    }
    return shares;
  }

  function recordOpen({ lineageId, conversationId, openedAt, ip = null, userAgent = null, country = null, viewerKey }) {
    if (!logStmts) return false;
    logStmts.insert.run(lineageId, conversationId, openedAt, ip || null, userAgent || null, country || null, viewerKey);
    return true;
  }

  function lastOpenAt(lineageId, viewerKey) {
    return logStmts ? logStmts.lastOpenOf.get(lineageId, viewerKey)?.opened_at || null : null;
  }

  function listOpens(lineageId, { limit = SHARE_OPENS_PAGE_DEFAULT } = {}) {
    const pageSize = Math.max(1, Math.min(SHARE_OPENS_PAGE_MAX, Math.trunc(Number(limit) || SHARE_OPENS_PAGE_DEFAULT)));
    if (!logStmts) return { opens: [], total: 0, limit: pageSize };
    return {
      opens: logStmts.page.all(lineageId, pageSize).map(mapOpenRow),
      total: shareStats(lineageId).openCount,
      limit: pageSize,
    };
  }

  // Default on: a relay records the address of a public reader unless told not to.
  function readStoreViewerIp() {
    return String(stmts.getSetting.get(SHARE_STORE_VIEWER_IP_SETTING_KEY)?.value || '').trim() !== 'false';
  }

  function writeStoreViewerIp(enabled) {
    stmts.upsertSetting.run(SHARE_STORE_VIEWER_IP_SETTING_KEY, enabled ? 'true' : 'false', new Date().toISOString());
    return readStoreViewerIp();
  }

  /** How many distinct viewer addresses the relay still holds. */
  function countStoredViewerIps() {
    return Number(ipStmts.count?.get()?.n || 0);
  }

  /**
   * Drops every stored viewer address: the access log keeps its rows and
   * viewer keys (so viewer counts stay), the status log its events.
   */
  const forgetStoredViewerIps = db.transaction(() => ({
    opens: Number(ipStmts.clearOpens?.run().changes || 0),
    events: Number(ipStmts.clearEvents?.run().changes || 0),
  }));

  // The key of the viewer hash, made once per relay. Kept next to the log, so
  // it keeps addresses out of the log but does not hide them from someone
  // holding the whole database.
  let viewerKeySecret = '';
  function readViewerKeySecret() {
    if (viewerKeySecret) return viewerKeySecret;
    const stored = String(stmts.getSetting.get(SHARE_VIEWER_KEY_SECRET_SETTING_KEY)?.value || '').trim();
    if (stored) {
      viewerKeySecret = stored;
      return stored;
    }
    const created = randomBytes(32).toString('hex');
    stmts.upsertSetting.run(SHARE_VIEWER_KEY_SECRET_SETTING_KEY, created, new Date().toISOString());
    viewerKeySecret = created;
    return created;
  }

  return {
    logAvailable: hasLog,
    findActiveShare,
    findShareByToken,
    findLiveShare,
    getOrCreateShare,
    renewShare,
    stopSharing,
    forgetConversation,
    shareStats,
    listActiveShares,
    recordOpen,
    lastOpenAt,
    listOpens,
    readStoreViewerIp,
    writeStoreViewerIp,
    countStoredViewerIps,
    forgetStoredViewerIps,
    readViewerKeySecret,
  };
}
