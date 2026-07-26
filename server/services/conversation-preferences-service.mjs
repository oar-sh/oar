'use strict';

function normalizeModeWith(value, normalizeMode) {
  if (typeof normalizeMode === 'function') {
    const normalized = normalizeMode(value);
    const text = String(normalized || '').trim();
    return text || null;
  }
  const text = String(value || '').trim();
  return text || null;
}

export function parsePreferredModelsByMode(value, { normalizeMode } = {}) {
  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return {};
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const normalized = {};
  for (const [mode, model] of Object.entries(parsed)) {
    const modeKey = normalizeModeWith(mode, normalizeMode);
    const modelText = String(model || '').trim();
    if (!modeKey || !modelText) continue;
    normalized[modeKey] = modelText;
  }
  return normalized;
}

export function parsePreferredReasoningByMode(value, { normalizeMode } = {}) {
  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return {};
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const normalized = {};
  for (const [mode, reasoningEffort] of Object.entries(parsed)) {
    const modeKey = normalizeModeWith(mode, normalizeMode);
    const effortText = String(reasoningEffort || '').trim().toLowerCase();
    if (!modeKey || !effortText) continue;
    normalized[modeKey] = effortText;
  }
  return normalized;
}

export function mergePreferredModelForMode({
  preferredModelsByMode = {},
  relayMode = '',
  model = '',
  normalizeMode,
} = {}) {
  const normalized = parsePreferredModelsByMode(preferredModelsByMode, { normalizeMode });
  const modeKey = normalizeModeWith(relayMode, normalizeMode);
  const modelText = String(model || '').trim();
  if (!modeKey || !modelText) return normalized;
  normalized[modeKey] = modelText;
  return normalized;
}

export function persistConversationPreferences({
  db,
  stmts,
  conversationId = '',
  preferredRelayMode = '',
  preferredModelsByMode = {},
  preferredReasoningByMode = {},
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const mode = String(preferredRelayMode || '').trim();
  if (!db || !stmts || !convId || !mode) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode,
      preferredModelsByMode: {},
      preferredReasoningByMode: {},
      updatedAt,
    };
  }
  const normalizedMap = parsePreferredModelsByMode(preferredModelsByMode);
  const normalizedReasoningMap = parsePreferredReasoningByMode(preferredReasoningByMode);
  const jsonMap = JSON.stringify(normalizedMap);
  const jsonReasoningMap = JSON.stringify(normalizedReasoningMap);
  const safeTitle = String(createTitle || '').trim() || 'Session';
  const writePreferences = db.transaction(() => {
    const existing = typeof stmts.getConvAnyStatus?.get === 'function'
      ? (stmts.getConvAnyStatus.get(convId) || null)
      : null;
    if (!existing && createIfMissing && typeof stmts.insertConv?.run === 'function') {
      stmts.insertConv.run(convId, safeTitle, updatedAt, updatedAt);
    }
    try {
      if (typeof stmts.updateConvPreferences?.run === 'function') {
        stmts.updateConvPreferences.run(mode, jsonMap, jsonReasoningMap, updatedAt, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_models_by_mode = ?, preferred_reasoning_by_mode = ?, updated_at = ?
          WHERE id = ?
        `).run(mode, jsonMap, jsonReasoningMap, updatedAt, convId);
      }
    } catch (error) {
      if (!tolerateMissingColumns) throw error;
    }
    return {
      ok: true,
      created: !existing,
      preferredRelayMode: mode,
      preferredModelsByMode: normalizedMap,
      preferredReasoningByMode: normalizedReasoningMap,
      updatedAt,
    };
  });
  return writePreferences();
}

export function persistConversationModeModelPreference({
  db,
  stmts,
  conversationId = '',
  relayMode = '',
  model = '',
  preferredReasoningByMode = {},
  normalizeMode,
  fallbackRelayMode = 'agent',
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const modelText = String(model || '').trim();
  const normalizedRelayMode = normalizeModeWith(relayMode, normalizeMode);
  const fallbackMode = normalizeModeWith(fallbackRelayMode, normalizeMode) || String(fallbackRelayMode || '').trim() || 'agent';
  const mode = normalizedRelayMode || fallbackMode;
  if (!db || !stmts || !convId || !mode || !modelText) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode || fallbackMode,
      preferredModelsByMode: {},
      preferredReasoningByMode: {},
      updatedAt,
    };
  }

  const safeTitle = String(createTitle || '').trim() || 'Session';
  const writeModeModelPreference = db.transaction(() => {
    const existing = typeof stmts.getConvAnyStatus?.get === 'function'
      ? (stmts.getConvAnyStatus.get(convId) || null)
      : null;
    if (!existing && createIfMissing && typeof stmts.insertConv?.run === 'function') {
      stmts.insertConv.run(convId, safeTitle, updatedAt, updatedAt);
    }
    const currentMap = parsePreferredModelsByMode(existing?.preferred_models_by_mode, { normalizeMode });
    const currentReasoningMap = parsePreferredReasoningByMode(existing?.preferred_reasoning_by_mode, { normalizeMode });
    currentMap[mode] = modelText;
    const incomingReasoningByMode = parsePreferredReasoningByMode(preferredReasoningByMode, { normalizeMode });
    for (const [reasoningMode, effort] of Object.entries(incomingReasoningByMode)) {
      currentReasoningMap[reasoningMode] = effort;
    }
    const jsonMap = JSON.stringify(currentMap);
    const jsonReasoningMap = JSON.stringify(currentReasoningMap);
    try {
      if (typeof stmts.updateConvPreferences?.run === 'function') {
        stmts.updateConvPreferences.run(mode, jsonMap, jsonReasoningMap, updatedAt, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_models_by_mode = ?, preferred_reasoning_by_mode = ?, updated_at = ?
          WHERE id = ?
        `).run(mode, jsonMap, jsonReasoningMap, updatedAt, convId);
      }
    } catch (error) {
      if (!tolerateMissingColumns) throw error;
    }
    return {
      ok: true,
      created: !existing,
      preferredRelayMode: mode,
      preferredModelsByMode: currentMap,
      preferredReasoningByMode: currentReasoningMap,
      updatedAt,
    };
  });
  return writeModeModelPreference();
}
