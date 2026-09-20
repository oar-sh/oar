'use strict';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeWorkerId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeConversationId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeRuntimeSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function toPositivePid(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return null;
    return value;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTimestamp(value, fallbackIso) {
  const text = String(value || '').trim();
  if (!text) return fallbackIso;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return fallbackIso;
  return parsed.toISOString();
}

const STATUS_ALIASES = Object.freeze({
  idle: 'ready',
  queued: 'processing',
  failed: 'error',
});

const ALLOWED_STATUSES = new Set(['new', 'starting', 'ready', 'processing', 'error', 'stopped']);

function normalizeStatus(value) {
  const normalized = String(value || 'new').trim().toLowerCase();
  const mapped = STATUS_ALIASES[normalized] || normalized || 'new';
  return ALLOWED_STATUSES.has(mapped) ? mapped : 'new';
}

const STEERING_HOLD_REASONS = new Set(['question', 'compaction', 'adoption', 'delivery', 'other']);

// The worker's composer-facing steering snapshot, published on its heartbeat.
// Callers follow the registry convention of spreading the existing entry into
// upserts, so an update without `steering` keeps the last known snapshot.
// Exported so the heartbeat route compares apples to apples: normalizing there
// with different rules would make an unknown holdReason never converge and
// re-upsert on every heartbeat.
export function normalizeWorkerSteeringSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const holdReason = String(raw.holdReason || '').trim().toLowerCase();
  const messageId = String(raw.messageId || '').trim().slice(0, 64);
  return {
    turnActive: raw.turnActive === true,
    canSteer: raw.canSteer === true,
    holdReason: STEERING_HOLD_REASONS.has(holdReason) ? holdReason : null,
    messageId: messageId || null,
  };
}

function sanitizeState(raw = null) {
  const nowIso = new Date().toISOString();
  const base = raw && typeof raw === 'object' ? raw : {};
  const createdAt = normalizeTimestamp(base.createdAt, nowIso);
  return {
    workerId: normalizeWorkerId(base.workerId),
    conversationId: normalizeConversationId(base.conversationId),
    runtimeSessionId: normalizeRuntimeSessionId(base.runtimeSessionId),
    sdkSessionId: normalizeSessionId(base.sdkSessionId),
    status: normalizeStatus(base.status),
    pid: toPositivePid(base.pid),
    queueDepth: toNonNegativeInt(base.queueDepth, 0),
    retryCount: toNonNegativeInt(base.retryCount, 0),
    lastError: String(base.lastError || '').trim() || null,
    steering: normalizeWorkerSteeringSnapshot(base.steering),
    updatedAt: normalizeTimestamp(base.updatedAt, nowIso),
    createdAt,
  };
}

function toSnapshot(entry) {
  return Object.freeze({ ...entry });
}

export function createSessionWorkerRegistry() {
  const bySession = new Map();
  const sessionByWorkerId = new Map();
  const sessionByConversationId = new Map();
  const sessionByRuntimeSessionId = new Map();

  function clearIndexesForSession(entry) {
    if (!entry) return;
    // Only drop an index that still points at THIS entry's session: a newer
    // entry may have legitimately claimed the same workerId/conversationId/
    // runtimeSessionId since, and deleting blindly would orphan it.
    if (entry.workerId && sessionByWorkerId.get(entry.workerId) === entry.sdkSessionId) {
      sessionByWorkerId.delete(entry.workerId);
    }
    if (entry.conversationId && sessionByConversationId.get(entry.conversationId) === entry.sdkSessionId) {
      sessionByConversationId.delete(entry.conversationId);
    }
    if (entry.runtimeSessionId && sessionByRuntimeSessionId.get(entry.runtimeSessionId) === entry.sdkSessionId) {
      sessionByRuntimeSessionId.delete(entry.runtimeSessionId);
    }
  }

  function updateIndexesForSession(entry) {
    if (!entry) return;
    if (entry.workerId) sessionByWorkerId.set(entry.workerId, entry.sdkSessionId);
    if (entry.conversationId) sessionByConversationId.set(entry.conversationId, entry.sdkSessionId);
    if (entry.runtimeSessionId) sessionByRuntimeSessionId.set(entry.runtimeSessionId, entry.sdkSessionId);
  }

  function getWorker(sdkSessionId) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return null;
    const entry = bySession.get(sessionId);
    return entry ? toSnapshot(entry) : null;
  }

  function getWorkerByWorkerId(workerId) {
    const normalized = normalizeWorkerId(workerId);
    if (!normalized) return null;
    const sessionId = sessionByWorkerId.get(normalized);
    if (!sessionId) return null;
    return getWorker(sessionId);
  }

  function getWorkerByConversationId(conversationId) {
    const normalized = normalizeConversationId(conversationId);
    if (!normalized) return null;
    const sessionId = sessionByConversationId.get(normalized);
    if (!sessionId) return null;
    return getWorker(sessionId);
  }

  function getWorkerByRuntimeSessionId(runtimeSessionId) {
    const normalized = normalizeRuntimeSessionId(runtimeSessionId);
    if (!normalized) return null;
    const sessionId = sessionByRuntimeSessionId.get(normalized);
    if (!sessionId) return null;
    return getWorker(sessionId);
  }

  function listWorkers() {
    return Object.freeze(Array.from(bySession.values()).map((entry) => toSnapshot(entry)));
  }

  function upsertWorker(rawState = {}) {
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
      throw new TypeError('upsertWorker requires a state object');
    }
    const state = sanitizeState(rawState);
    if (!state.sdkSessionId) {
      throw new Error('upsertWorker requires sdkSessionId');
    }
    const existing = bySession.get(state.sdkSessionId);
    const next = sanitizeState({
      ...(existing || {}),
      ...state,
      sdkSessionId: state.sdkSessionId,
      createdAt: existing?.createdAt || state.createdAt,
      updatedAt: new Date().toISOString(),
    });
    clearIndexesForSession(existing);
    bySession.set(state.sdkSessionId, next);
    updateIndexesForSession(next);
    return toSnapshot(next);
  }

  function removeWorker(sdkSessionId) {
    const sessionId = normalizeSessionId(sdkSessionId);
    if (!sessionId) return false;
    const existing = bySession.get(sessionId);
    if (!existing) return false;
    clearIndexesForSession(existing);
    return bySession.delete(sessionId);
  }

  // Placeholder→real session rekey (audit #22). Session sync migrates the DB
  // side (conversation binding, runtime session, queue owners) in one
  // transaction; this is the in-memory half, moving the registry entry and its
  // secondary indexes so the placeholder never lingers as a phantom worker.
  function rekeyWorker(fromSdkSessionId, toSdkSessionId) {
    const from = normalizeSessionId(fromSdkSessionId);
    const to = normalizeSessionId(toSdkSessionId);
    if (!from || !to || from === to) return null;
    const placeholder = bySession.get(from);
    if (!placeholder) return null;
    const existingTarget = bySession.get(to) || null;
    // An entry already registered under the real id is newer than the
    // placeholder — its fields win, the placeholder only backfills gaps.
    const next = sanitizeState({
      ...placeholder,
      ...(existingTarget || {}),
      sdkSessionId: to,
      createdAt: placeholder.createdAt,
      updatedAt: new Date().toISOString(),
    });
    clearIndexesForSession(placeholder);
    if (existingTarget) clearIndexesForSession(existingTarget);
    bySession.delete(from);
    bySession.set(to, next);
    updateIndexesForSession(next);
    return toSnapshot(next);
  }

  function clearAll() {
    bySession.clear();
    sessionByWorkerId.clear();
    sessionByConversationId.clear();
    sessionByRuntimeSessionId.clear();
  }

  return {
    normalizeSessionId,
    normalizeWorkerId,
    normalizeConversationId,
    normalizeRuntimeSessionId,
    getWorker,
    getWorkerByWorkerId,
    getWorkerByConversationId,
    getWorkerByRuntimeSessionId,
    listWorkers,
    upsertWorker,
    removeWorker,
    rekeyWorker,
    clearAll,
  };
}

