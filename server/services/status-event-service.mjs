import { createHash, randomUUID } from 'crypto';

const DEFAULT_MAX_EVENTS = 1_000;
const DEFAULT_SHARED_ACCESS_DEDUPE_TTL_MS = 60_000;
const DEFAULT_MAX_SHARED_ACCESS_DEDUPE_KEYS = 4_096;

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : Date.now();
}

function normalizeLimit(value, fallback = 40) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function formatStatusEventRow(row) {
  let details = {};
  try {
    const parsed = JSON.parse(String(row?.payload_json || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed;
  } catch {}
  return {
    id: String(row?.id || ''),
    timestamp: normalizeTimestamp(row?.timestamp),
    type: String(row?.type || 'event'),
    source: 'server',
    details,
  };
}

function shareIdentifier(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}

export function createStatusEventService(db, {
  maxEvents = DEFAULT_MAX_EVENTS,
  sharedAccessDedupeTtlMs = DEFAULT_SHARED_ACCESS_DEDUPE_TTL_MS,
  maxSharedAccessDedupeKeys = DEFAULT_MAX_SHARED_ACCESS_DEDUPE_KEYS,
} = {}) {
  const normalizedMaxEvents = Math.max(1, Math.trunc(Number(maxEvents) || DEFAULT_MAX_EVENTS));
  const normalizedDedupeTtlMs = Math.max(1, Math.trunc(Number(sharedAccessDedupeTtlMs) || DEFAULT_SHARED_ACCESS_DEDUPE_TTL_MS));
  const normalizedMaxDedupeKeys = Math.max(1, Math.trunc(Number(maxSharedAccessDedupeKeys) || DEFAULT_MAX_SHARED_ACCESS_DEDUPE_KEYS));
  const sharedAccessDedupe = new Map();
  const insertEvent = db.prepare(`
    INSERT INTO status_events (id, timestamp, type, source, payload_json)
    VALUES (?, ?, ?, 'server', ?)
  `);
  const deleteExpiredEvents = db.prepare(`
    DELETE FROM status_events
    WHERE id IN (
      SELECT id
      FROM status_events
      ORDER BY timestamp DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  `);
  const listEvents = db.prepare(`
    SELECT id, timestamp, type, source, payload_json
    FROM status_events
    WHERE (
      @beforeTimestamp IS NULL
      OR timestamp < @beforeTimestamp
      OR (timestamp = @beforeTimestamp AND id < @beforeId)
    )
    ORDER BY timestamp DESC, id DESC
    LIMIT @limit
  `);

  function pruneSharedAccessDedupe(now = Date.now()) {
    for (const [key, lastSeenAt] of sharedAccessDedupe.entries()) {
      if ((now - lastSeenAt) > normalizedDedupeTtlMs) sharedAccessDedupe.delete(key);
    }
    if (sharedAccessDedupe.size <= normalizedMaxDedupeKeys) return;
    const oldest = Array.from(sharedAccessDedupe.entries())
      .sort((left, right) => left[1] - right[1])
      .slice(0, sharedAccessDedupe.size - normalizedMaxDedupeKeys);
    for (const [key] of oldest) sharedAccessDedupe.delete(key);
  }

  function recordSharedAccess({
    shareToken,
    viewerIp,
    conversationId,
    timestamp = Date.now(),
  } = {}) {
    const now = normalizeTimestamp(timestamp);
    const token = String(shareToken || '').trim();
    const ip = String(viewerIp || '').trim() || 'unknown';
    const normalizedConversationId = String(conversationId || '').trim();
    const dedupeKey = `${token}:${ip}`;
    const previousSeenAt = sharedAccessDedupe.get(dedupeKey);
    sharedAccessDedupe.set(dedupeKey, now);
    pruneSharedAccessDedupe(now);
    if (Number.isFinite(previousSeenAt) && (now - previousSeenAt) <= normalizedDedupeTtlMs) {
      return { event: null, deduped: true };
    }

    const event = {
      id: `status-${randomUUID()}`,
      timestamp: now,
      type: 'shared-access-opened',
      source: 'server',
      details: {
        shareId: shareIdentifier(token),
        viewerIp: ip,
        conversationId: normalizedConversationId || undefined,
      },
    };
    const persist = db.transaction(() => {
      insertEvent.run(event.id, event.timestamp, event.type, JSON.stringify(event.details));
      deleteExpiredEvents.run(normalizedMaxEvents);
    });
    persist();
    return { event, deduped: false };
  }

  function recordEvent(type, details = {}, timestamp = Date.now()) {
    const event = {
      id: `status-${randomUUID()}`,
      timestamp: normalizeTimestamp(timestamp),
      type: String(type || 'event'),
      source: 'server',
      details: details && typeof details === 'object' ? details : {},
    };
    const persist = db.transaction(() => {
      insertEvent.run(event.id, event.timestamp, event.type, JSON.stringify(event.details));
      deleteExpiredEvents.run(normalizedMaxEvents);
    });
    persist();
    return event;
  }

  function getEventsPage({ beforeTimestamp = null, beforeId = '', limit = 40 } = {}) {
    const hasCursor = beforeTimestamp !== null && beforeTimestamp !== undefined && String(beforeId || '').trim();
    const timestamp = Number(beforeTimestamp);
    const rows = listEvents.all({
      beforeTimestamp: hasCursor && Number.isFinite(timestamp) ? Math.trunc(timestamp) : null,
      beforeId: String(beforeId || ''),
      limit: normalizeLimit(limit) + 1,
    });
    const hasMore = rows.length > normalizeLimit(limit);
    const items = rows.slice(0, normalizeLimit(limit)).reverse().map(formatStatusEventRow);
    const first = items[0] || null;
    return {
      items,
      hasMore,
      nextCursor: first ? { timestamp: first.timestamp, id: first.id } : null,
    };
  }

  return {
    getEventsPage,
    recordEvent,
    recordSharedAccess,
  };
}
