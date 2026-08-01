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

export function normalizePreferredModel(value) {
  return String(value || '').trim();
}

export function normalizePreferredReasoningEffort(value) {
  return String(value || '').trim().toLowerCase();
}

export function persistConversationPreferences({
  db,
  stmts,
  conversationId = '',
  preferredRelayMode = '',
  preferredModel = '',
  preferredReasoningEffort = '',
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const mode = String(preferredRelayMode || '').trim();
  const model = normalizePreferredModel(preferredModel);
  const reasoningEffort = normalizePreferredReasoningEffort(preferredReasoningEffort);
  if (!db || !stmts || !convId || !mode) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode,
      preferredModel: '',
      preferredReasoningEffort: '',
      updatedAt,
    };
  }
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
        stmts.updateConvPreferences.run(mode, model || null, reasoningEffort || null, updatedAt, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_model = ?, preferred_reasoning_effort = ?, updated_at = ?
          WHERE id = ?
        `).run(mode, model || null, reasoningEffort || null, updatedAt, convId);
      }
    } catch (error) {
      if (!tolerateMissingColumns) throw error;
    }
    return {
      ok: true,
      created: !existing,
      preferredRelayMode: mode,
      preferredModel: model,
      preferredReasoningEffort: reasoningEffort,
      updatedAt,
    };
  });
  return writePreferences();
}

export function persistConversationModelPreference({
  db,
  stmts,
  conversationId = '',
  relayMode = '',
  model = '',
  reasoningEffort = '',
  normalizeMode,
  fallbackRelayMode = 'agent',
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const modelText = normalizePreferredModel(model);
  const normalizedRelayMode = normalizeModeWith(relayMode, normalizeMode);
  const fallbackMode = normalizeModeWith(fallbackRelayMode, normalizeMode) || String(fallbackRelayMode || '').trim() || 'agent';
  const mode = normalizedRelayMode || fallbackMode;
  const effortText = normalizePreferredReasoningEffort(reasoningEffort);
  if (!db || !stmts || !convId || !mode || !modelText) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode || fallbackMode,
      preferredModel: '',
      preferredReasoningEffort: '',
      updatedAt,
    };
  }

  const safeTitle = String(createTitle || '').trim() || 'Session';
  const writeModelPreference = db.transaction(() => {
    const existing = typeof stmts.getConvAnyStatus?.get === 'function'
      ? (stmts.getConvAnyStatus.get(convId) || null)
      : null;
    if (!existing && createIfMissing && typeof stmts.insertConv?.run === 'function') {
      stmts.insertConv.run(convId, safeTitle, updatedAt, updatedAt);
    }
    const effort = effortText || normalizePreferredReasoningEffort(existing?.preferred_reasoning_effort);
    try {
      if (typeof stmts.updateConvPreferences?.run === 'function') {
        stmts.updateConvPreferences.run(mode, modelText, effort || null, updatedAt, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_model = ?, preferred_reasoning_effort = ?, updated_at = ?
          WHERE id = ?
        `).run(mode, modelText, effort || null, updatedAt, convId);
      }
    } catch (error) {
      if (!tolerateMissingColumns) throw error;
    }
    return {
      ok: true,
      created: !existing,
      preferredRelayMode: mode,
      preferredModel: modelText,
      preferredReasoningEffort: effort,
      updatedAt,
    };
  });
  return writeModelPreference();
}
