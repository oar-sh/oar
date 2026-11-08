'use strict';

// The media gallery index (migration 0039): the queue of messages to
// (re)index and the `media_items` rows made from them. Every reader tolerates
// a schema without the migration: it then sees an empty index and writes
// nothing.

export const MEDIA_PENDING_COUNT_CAP = 10_000;

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/** Who a message comes from, for the Source filter: the owner, an agent, or the relay itself. */
export function mediaSenderFor({ role, kind, originJson }) {
  if (role === 'assistant') return 'agent';
  if (role === 'user' && !kind && !originJson) return 'me';
  return 'relay';
}

export function createMediaRepository(db) {
  const available = tableExists(db, 'media_items')
    && tableExists(db, 'media_index_queue')
    && tableExists(db, 'messages');
  if (!available) {
    return {
      available: false,
      nextQueueBatch: () => [],
      loadQueuedMessage: () => null,
      replaceMessageItems: () => 0,
      pendingCount: () => 0,
      hasPending: () => false,
      removeOrphanQueueRows: () => 0,
      inTransaction: (fn) => fn(),
      listMedia: () => [],
      countMedia: () => ({ media: 0, file: 0 }),
      mediaFacets: () => ({ sessions: [], providers: [] }),
      getMediaItem: () => null,
    };
  }
  const messageColumns = columnsOf(db, 'messages');
  // octet_length reads a value's size without reading the value (SQLite 3.43+).
  let hasOctetLength = true;
  try {
    db.prepare(`SELECT octet_length('x')`).get();
  } catch {
    hasOctetLength = false;
  }
  const sizeOf = (column) => (hasOctetLength ? `octet_length(${column})` : `length(${column})`);
  const conversationColumns = columnsOf(db, 'conversations');
  const optional = (columns, column, alias) => (columns.includes(column) ? `${alias}.${column}` : 'NULL');
  const workspaceRoot = `COALESCE(${optional(conversationColumns, 'runtime_workspace_root_path', 'c')}, ${optional(conversationColumns, 'configured_workspace_root_path', 'c')})`;

  const statements = {
    // Queue order is the rowid (insertion order); no sort over the queue.
    // Ids and body sizes only: a batch never loads message bodies, which can be
    // megabytes (a pasted data image); the indexer loads them one by one.
    nextBatch: db.prepare(`
      SELECT q.message_id AS messageId, q.seq AS seq,
             ${sizeOf('m.text')} + COALESCE(${sizeOf('m.attachments')}, 0) AS bytes
        FROM media_index_queue q
        JOIN messages m ON m.id = q.message_id
       ORDER BY q.rowid
       LIMIT ?
    `),
    loadMessage: db.prepare(`
      SELECT m.id AS messageId,
             m.conversation_id AS conversationId, m.role AS role, m.text AS text,
             m.attachments AS attachments, m.timestamp AS timestamp,
             ${optional(messageColumns, 'kind', 'm')} AS kind,
             ${optional(messageColumns, 'origin_json', 'm')} AS originJson,
             ${workspaceRoot} AS workspaceRoot
        FROM messages m
        LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ?
    `),
    deleteItems: db.prepare(`DELETE FROM media_items WHERE message_id = ?`),
    insertItem: db.prepare(`
      INSERT INTO media_items (message_id, conversation_id, ordinal, role, sender, origin, locator_kind, locator,
        identity_key, category, media_kind, mime, name, alt, size_bytes, message_ts)
      VALUES (@messageId, @conversationId, @ordinal, @role, @sender, @origin, @locatorKind, @locator,
        @identityKey, @category, @mediaKind, @mime, @name, @alt, @sizeBytes, @messageTs)
    `),
    // Only the queue row that was read: a re-queue meanwhile bumped `seq`
    // and keeps the row for the next batch.
    deleteQueueRow: db.prepare(`DELETE FROM media_index_queue WHERE message_id = ? AND seq = ?`),
    // Capped: a full count over a large backfill queue costs tens of ms.
    pending: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM media_index_queue LIMIT ${MEDIA_PENDING_COUNT_CAP + 1})`),
    hasPending: db.prepare(`SELECT EXISTS (SELECT 1 FROM media_index_queue) AS present`),
    // Rows whose message is gone while foreign keys were off (an outside tool).
    removeOrphans: db.prepare(`DELETE FROM media_index_queue WHERE message_id NOT IN (SELECT id FROM messages)`),
  };

  const replace = db.transaction((row, items) => {
    statements.deleteItems.run(row.messageId);
    const sender = mediaSenderFor(row);
    for (const item of items) {
      statements.insertItem.run({
        messageId: row.messageId,
        conversationId: row.conversationId,
        ordinal: item.ordinal,
        role: String(row.role || ''),
        sender,
        origin: item.origin,
        locatorKind: item.locatorKind,
        locator: item.locator,
        identityKey: item.identityKey,
        category: item.category,
        mediaKind: item.mediaKind,
        mime: item.mime ?? null,
        name: item.name ?? null,
        alt: item.alt ?? null,
        sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : null,
        messageTs: String(row.timestamp || ''),
      });
    }
    statements.deleteQueueRow.run(row.messageId, row.seq);
    return items.length;
  });

  return {
    available: true,
    /** Queued messages in queue order: `{ messageId, seq, bytes }`, no bodies. */
    nextQueueBatch: (limit = 200) => statements.nextBatch.all(Math.max(1, Math.min(1000, Number(limit) || 200))),
    /** A queued message with what the indexer needs; null when it is gone. */
    loadQueuedMessage: (entry) => {
      const row = statements.loadMessage.get(entry.messageId);
      return row ? { ...row, seq: entry.seq } : null;
    },
    /** Replaces the rows of one queued message and removes its queue row, in one transaction. */
    replaceMessageItems: (row, items) => replace(row, items),
    /** Queued messages, counted up to MEDIA_PENDING_COUNT_CAP + 1 (that value means "more"). */
    pendingCount: () => statements.pending.get().n,
    hasPending: () => statements.hasPending.get().present === 1,
    removeOrphanQueueRows: () => statements.removeOrphans.run().changes,
    /** Runs `fn` in one transaction (one commit for a whole slice of messages). */
    inTransaction: (fn) => db.transaction(fn)(),
    ...createMediaQueries(db),
  };
}

// --- reading the gallery ---------------------------------------------------

export const MEDIA_SOURCES = Object.freeze(['all', 'mine', 'agent', 'generated']);
export const MEDIA_PAGE_MAX = 120;

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Opaque page cursor: the (message time, id) of the last item of a page. */
export function encodeMediaCursor(item) {
  return Buffer.from(JSON.stringify([item.timestamp, item.id]), 'utf8').toString('base64url');
}

export function decodeMediaCursor(raw) {
  if (!raw) return null;
  try {
    const [timestamp, id] = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (typeof timestamp !== 'string' || !Number.isSafeInteger(id)) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
}

function createMediaQueries(db) {
  const runtimeColumns = tableExists(db, 'runtime_sessions') ? columnsOf(db, 'runtime_sessions') : [];
  // The session's provider, as the sidebar shows it (github when unknown).
  const providerExpr = runtimeColumns.includes('provider_type')
    ? `COALESCE((SELECT rs.provider_type FROM runtime_sessions rs WHERE rs.conversation_id = c.id AND rs.provider_type IS NOT NULL ORDER BY rs.last_used_at DESC LIMIT 1), 'github')`
    : `'github'`;
  const cache = new Map();
  const prepared = (key, sql) => {
    if (!cache.has(key)) cache.set(key, db.prepare(sql));
    return cache.get(key);
  };

  const providerFor = (c) => providerExpr.replace('rs.conversation_id = c.id', `rs.conversation_id = ${c}.id`);

  // The scope's conditions for a media row `mi` of a session `c` (aliases
  // given, so the dedupe check can ask them of another row).
  function scopeClauses({ conversationId, source, provider, archived, q }, params, mi = 'mi', c = 'c') {
    const where = [`${c}.status != 'deleted'`];
    const key = [];
    if (conversationId) {
      where.push(`${mi}.conversation_id = @conversationId`);
      params.conversationId = String(conversationId);
      key.push('conv');
    }
    if (source === 'mine') { where.push(`${mi}.sender = 'me' AND ${mi}.origin != 'generated'`); key.push('mine'); }
    if (source === 'agent') { where.push(`${mi}.sender != 'me' AND ${mi}.origin != 'generated'`); key.push('agent'); }
    if (source === 'generated') { where.push(`${mi}.origin = 'generated'`); key.push('generated'); }
    if (provider) {
      where.push(`${providerFor(c)} = @provider`);
      params.provider = String(provider);
      key.push('provider');
    }
    if (archived === 'hide') { where.push(`${c}.archived = 0`); key.push('live'); }
    const text = String(q || '').trim().slice(0, 200);
    if (text) {
      where.push(`(${mi}.name LIKE @q ESCAPE '\\' OR ${mi}.alt LIKE @q ESCAPE '\\' OR ${c}.title LIKE @q ESCAPE '\\')`);
      params.q = `%${escapeLike(text)}%`;
      key.push('q');
    }
    return { where: where.join(' AND '), key: key.join(',') };
  }

  /**
   * One page of a gallery: each picture once (its newest occurrence in the
   * scope), newest first. The rows are walked newest first along the time
   * index and a row is kept when no newer row of the scope has its identity,
   * so a page stops after `limit` hits instead of sorting the whole scope,
   * and an older copy of a picture never comes back on a later page. The
   * occurrences, the session's title and its provider are read for the
   * page's rows alone.
   */
  function listMedia({ category = 'media', cursor = null, limit = 60, ...filters } = {}) {
    const params = { category: category === 'file' ? 'file' : 'media', limit: Math.max(1, Math.min(MEDIA_PAGE_MAX, Number(limit) || 60)) };
    const scope = scopeClauses(filters, params);
    // For the other rows of an identity (n: a newer copy, o: every copy) the
    // columns are written as +col: a unary plus keeps a column out of index
    // lookups, so identity_key = ? is the only one left and the planner takes
    // idx_media_items_identity by itself (an index hint would fail outright on
    // a database that lacks the index; this falls back to a slower scan).
    const newer = scopeClauses(filters, {}, '+n', 'cn');
    const same = scopeClauses(filters, {}, '+o', 'co');
    let after = '';
    if (cursor) {
      after = 'AND (mi.message_ts < @cursorTs OR (mi.message_ts = @cursorTs AND mi.id < @cursorId))';
      params.cursorTs = cursor.timestamp;
      params.cursorId = cursor.id;
    }
    const sql = `
      SELECT mi.id, mi.conversation_id AS conversationId, mi.message_id AS messageId, mi.role, mi.sender, mi.origin,
             mi.locator_kind AS locatorKind, mi.locator, mi.identity_key AS identityKey, mi.category,
             mi.media_kind AS mediaKind, mi.mime, mi.name, mi.alt, mi.size_bytes AS sizeBytes,
             mi.message_ts AS message_ts, c.title AS conversationTitle, c.archived AS archived,
             ${providerFor('c')} AS provider,
             (SELECT COUNT(*) FROM media_items o JOIN conversations co ON co.id = o.conversation_id
               WHERE o.identity_key = mi.identity_key AND +o.category = mi.category AND ${same.where}) AS occurrences
        FROM media_items mi
        JOIN conversations c ON c.id = mi.conversation_id
       WHERE mi.category = @category AND ${scope.where} ${after}
         AND EXISTS (SELECT 1 FROM messages m WHERE m.id = mi.message_id)
         AND NOT EXISTS (
           SELECT 1 FROM media_items n JOIN conversations cn ON cn.id = n.conversation_id
            WHERE n.identity_key = mi.identity_key AND +n.category = mi.category
              AND (+n.message_ts, +n.id) > (mi.message_ts, mi.id)
              AND ${newer.where})
       ORDER BY mi.message_ts DESC, mi.id DESC
       LIMIT @limit`;
    const rows = prepared(`list:${scope.key}:${cursor ? 'c' : ''}`, sql).all(params);
    return rows.map(({ message_ts: timestamp, archived, ...row }) => ({ ...row, timestamp, archived: archived === 1 }));
  }
  /** How many distinct pictures and files a scope has. */
  function countMedia(filters = {}) {
    const params = {};
    const scope = scopeClauses(filters, params);
    const sql = `
      SELECT mi.category AS category, COUNT(DISTINCT mi.identity_key) AS n
        FROM media_items mi
        JOIN messages m ON m.id = mi.message_id
        JOIN conversations c ON c.id = mi.conversation_id
       WHERE ${scope.where}
       GROUP BY mi.category`;
    const counts = { media: 0, file: 0 };
    for (const row of prepared(`count:${scope.key}`, sql).all(params)) counts[row.category] = row.n;
    return counts;
  }

  /** Sessions and providers that have media, for the global filters. */
  function mediaFacets() {
    const sessions = prepared('facets:sessions', `
      SELECT c.id AS id, c.title AS title, c.archived AS archived, ${providerExpr} AS provider,
             COUNT(DISTINCT mi.identity_key) AS count, MAX(mi.message_ts) AS lastAt
        FROM media_items mi
        JOIN conversations c ON c.id = mi.conversation_id
       WHERE c.status != 'deleted'
       GROUP BY c.id
       ORDER BY lastAt DESC
       LIMIT 1000`).all().map((row) => ({ ...row, archived: row.archived === 1 }));
    const providers = [...new Set(sessions.map((row) => row.provider).filter(Boolean))].sort();
    return { sessions, providers };
  }

  /** One indexed item with what serving it needs; null when gone or its session is deleted. */
  function getMediaItem(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return prepared('item', `
      SELECT mi.id, mi.conversation_id AS conversationId, mi.message_id AS messageId, mi.locator_kind AS locatorKind,
             mi.locator, mi.identity_key AS identityKey, mi.category, mi.media_kind AS mediaKind, mi.mime, mi.name,
             m.text AS text, m.attachments AS attachments
        FROM media_items mi
        JOIN messages m ON m.id = mi.message_id
        JOIN conversations c ON c.id = mi.conversation_id
       WHERE mi.id = ? AND c.status != 'deleted'`).get(id) || null;
  }

  return { listMedia, countMedia, mediaFacets, getMediaItem };
}
