'use strict';

// One page of a conversation's history, selected in SQL.
//
// The history route used to load every message, hydrate every reply and only
// then cut the page out (selectConversationHistoryPage in sessions-routes.mjs),
// so each page and each live poll paid for the whole conversation. This module
// selects the page's rows in SQL with the same cursor rules and the same
// pageInfo, so only the page is hydrated.
//
// The JS order is (timestamp in ms, then id by localeCompare). SQL orders by
// (timestamp text, id text). The two agree when every timestamp has the fixed
// ISO shape the relay writes (YYYY-MM-DDTHH:MM:SS.mmmZ) and every id is made
// of lowercase letters, digits and dashes (the relay's UUIDs). A conversation
// with any other row is not paged here: the selector returns null and the
// caller keeps the in-memory path, which handles every shape.

const ISO_TIMESTAMP_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ORDERABLE_ID_PATTERN = /^[-0-9a-z]+$/;

export function normalizeConversationTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const sqliteUtcLike = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  let normalized = text;
  if (!hasExplicitTimezone && sqliteUtcLike.test(text)) {
    const [, day, time] = text.match(sqliteUtcLike) || [];
    normalized = `${day}T${time}Z`;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeConversationHistoryLimit(value, fallback = 20) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

/**
 * The pageInfo of a history page: `pageMessages` in conversation order, and
 * whether the conversation has rows before the first and after the last.
 */
export function buildConversationHistoryPageInfo(pageMessages = [], { hasMoreOlder = false, hasMoreNewer = false } = {}) {
  const firstMessage = pageMessages[0] || null;
  const lastMessage = pageMessages[pageMessages.length - 1] || null;
  return {
    hasMore: hasMoreOlder,
    hasMoreOlder,
    hasMoreNewer,
    nextCursor: firstMessage ? {
      beforeMessageId: String(firstMessage.id || '').trim(),
      beforeTimestamp: String(firstMessage.timestamp || '').trim() || null,
    } : null,
    olderCursor: firstMessage ? {
      beforeMessageId: String(firstMessage.id || '').trim(),
      beforeTimestamp: String(firstMessage.timestamp || '').trim() || null,
    } : null,
    newerCursor: lastMessage ? {
      afterMessageId: String(lastMessage.id || '').trim(),
      afterTimestamp: String(lastMessage.timestamp || '').trim() || null,
    } : null,
  };
}

/**
 * The prepared statements for paging one conversation. `sharedOnly` pages
 * over the rows a shared view shows (not hidden from shares).
 */
export function createConversationHistoryPageStatements(db) {
  const messageColumns = new Set(db.prepare(`PRAGMA table_info(messages)`).all().map((column) => column.name));
  const sharedFilter = messageColumns.has('hidden_from_shares') ? 'AND hidden_from_shares = 0' : '';
  const hasResendColumns = messageColumns.has('source_message_id') && messageColumns.has('resend_of_message_id');
  const build = (visibility) => {
    const base = `FROM messages WHERE conversation_id = @conversationId ${visibility}`;
    const older = `(timestamp < @timestamp OR (timestamp = @timestamp AND @id IS NOT NULL AND id < @id))`;
    const newer = `(timestamp > @timestamp OR (timestamp = @timestamp AND @id IS NOT NULL AND id > @id))`;
    return {
      irregular: db.prepare(`
        SELECT EXISTS (
          SELECT 1 ${base}
          AND NOT (timestamp GLOB '${ISO_TIMESTAMP_GLOB}' AND id <> '' AND id NOT GLOB '*[^-0-9a-z]*')
        ) AS irregular
      `),
      findById: db.prepare(`SELECT id, timestamp ${base} AND id = @id`),
      older: db.prepare(`SELECT * ${base} AND ${older} ORDER BY timestamp DESC, id DESC LIMIT @limit`),
      newer: db.prepare(`SELECT * ${base} AND ${newer} ORDER BY timestamp ASC, id ASC LIMIT @limit`),
      fromInclusive: db.prepare(`
        SELECT * ${base} AND (timestamp > @timestamp OR (timestamp = @timestamp AND id >= @id))
        ORDER BY timestamp ASC, id ASC LIMIT @limit
      `),
      tail: db.prepare(`SELECT * ${base} ORDER BY timestamp DESC, id DESC LIMIT @limit`),
      existsOlder: db.prepare(`SELECT EXISTS (SELECT 1 ${base} AND ${older}) AS found`),
      existsNewer: db.prepare(`SELECT EXISTS (SELECT 1 ${base} AND ${newer}) AS found`),
      // What liveResendsByOriginal reads, for the whole conversation: a
      // stopped marker on the page may have its Resend outside it.
      resendIndex: hasResendColumns
        ? db.prepare(`SELECT id, role, source_message_id, resend_of_message_id ${base} ORDER BY timestamp ASC`)
        : null,
    };
  };
  const all = build('');
  const shared = build(sharedFilter);
  return {
    selectConversationHistoryPage(conversationId, options = {}) {
      return selectConversationHistoryPageFromStatements(options.sharedOnly ? shared : all, conversationId, options);
    },
    listConversationResendIndex(conversationId, { sharedOnly = false } = {}) {
      const statement = (sharedOnly ? shared : all).resendIndex;
      return statement ? statement.all({ conversationId }) : [];
    },
  };
}

// A cursor as the in-memory selector resolves it, in the SQL shape: the
// message's own timestamp when its id is in the conversation, else the given
// timestamp. Null when there is no cursor; `unsupported` when the given
// values cannot be compared in SQL the way the selector compares them.
function resolveCursor(statements, conversationId, { messageId = '', timestamp = '' } = {}) {
  const cursorMessageId = String(messageId || '').trim();
  const cursorTimestampText = String(timestamp || '').trim();
  if (cursorMessageId) {
    const row = statements.findById.get({ conversationId, id: cursorMessageId });
    if (row) return { id: cursorMessageId, timestamp: String(row.timestamp) };
  }
  if (!cursorTimestampText) return null;
  if (cursorMessageId && !ORDERABLE_ID_PATTERN.test(cursorMessageId)) return 'unsupported';
  let canonical = cursorTimestampText;
  if (!ISO_TIMESTAMP_PATTERN.test(canonical)) {
    canonical = new Date(normalizeConversationTimestampMs(cursorTimestampText)).toISOString();
    if (!ISO_TIMESTAMP_PATTERN.test(canonical)) return 'unsupported';
  }
  return { id: cursorMessageId || null, timestamp: canonical };
}

/**
 * The page of rows (raw message rows, in conversation order) and its
 * pageInfo, by the rules of selectConversationHistoryPage; null when the
 * conversation or the cursor cannot be paged in SQL (see the top note).
 */
function selectConversationHistoryPageFromStatements(statements, conversationId, {
  limit = 20,
  beforeMessageId = '',
  beforeTimestamp = '',
  afterMessageId = '',
  afterTimestamp = '',
  aroundMessageId = '',
} = {}) {
  if (statements.irregular.get({ conversationId })?.irregular) return null;
  const pageLimit = normalizeConversationHistoryLimit(limit);
  const aroundId = String(aroundMessageId || '').trim();
  const requestedAroundWindow = !!aroundId;
  const requestedAfterWindow = !!String(afterMessageId || '').trim();
  const beforeCursor = resolveCursor(statements, conversationId, { messageId: beforeMessageId, timestamp: beforeTimestamp });
  const afterCursor = resolveCursor(statements, conversationId, { messageId: afterMessageId, timestamp: afterTimestamp });
  if (beforeCursor === 'unsupported' || afterCursor === 'unsupported') return null;

  let rows = [];
  if (aroundId) {
    const anchor = statements.findById.get({ conversationId, id: aroundId });
    if (anchor) {
      // Enough rows on both sides for the in-memory window rules to give the
      // same window as over the whole conversation.
      const before = statements.older
        .all({ conversationId, timestamp: anchor.timestamp, id: anchor.id, limit: pageLimit - 1 })
        .reverse();
      const fromAnchor = statements.fromInclusive
        .all({ conversationId, timestamp: anchor.timestamp, id: anchor.id, limit: pageLimit });
      const local = [...before, ...fromAnchor];
      const aroundIndex = before.length;
      const halfWindow = Math.floor((pageLimit - 1) / 2);
      let start = Math.max(0, aroundIndex - halfWindow);
      const end = Math.min(local.length, start + pageLimit);
      if ((end - start) < pageLimit) start = Math.max(0, end - pageLimit);
      rows = local.slice(start, end);
    }
  }
  if (!rows.length && !requestedAroundWindow && afterCursor) {
    rows = statements.newer.all({ conversationId, ...afterCursor, limit: pageLimit });
  }
  if (!rows.length && !requestedAfterWindow && !requestedAroundWindow) {
    rows = (beforeCursor
      ? statements.older.all({ conversationId, ...beforeCursor, limit: pageLimit })
      : statements.tail.all({ conversationId, limit: pageLimit })
    ).reverse();
  }

  const first = rows[0] || null;
  const last = rows[rows.length - 1] || null;
  const hasMoreOlder = first
    ? !!statements.existsOlder.get({ conversationId, timestamp: first.timestamp, id: first.id })?.found
    : false;
  const hasMoreNewer = last
    ? !!statements.existsNewer.get({ conversationId, timestamp: last.timestamp, id: last.id })?.found
    : false;
  return { rows, pageInfo: buildConversationHistoryPageInfo(rows, { hasMoreOlder, hasMoreNewer }) };
}
