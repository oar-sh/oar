'use strict';

import { parseAutoCompactWindow } from '../../shared/auto-compact-window.mjs';
import {
  DEFAULT_THINKING_DISPLAY,
  DEFAULT_THINKING_ENABLED,
  parseThinkingDisplay,
  parseThinkingEnabled,
} from '../../shared/claude-thinking.mjs';

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
  // `undefined` means "not part of this write" — the composer PATCHes the same
  // route without ever mentioning the window, and must not clear it.
  autoCompactWindow = undefined,
  // Same contract for the thinking control: `undefined` leaves the stored
  // value alone. Anything else is resolved through the shared parsers, whose
  // fallback is the relay default (on / summarized).
  thinkingEnabled = undefined,
  thinkingDisplay = undefined,
  // The owner's "agents in this conversation may start sessions" (a boolean;
  // `undefined` leaves it alone). The route decides who may write it.
  mayCreateSessions = undefined,
  // Plan-only: agents cannot take the session out of plan mode (a boolean;
  // `undefined` leaves it alone). The routes decide who may write it.
  planOnly = undefined,
  updatedAt = new Date().toISOString(),
  createIfMissing = false,
  createTitle = 'Session',
  tolerateMissingColumns = false,
} = {}) {
  const convId = String(conversationId || '').trim();
  const mode = String(preferredRelayMode || '').trim();
  const model = normalizePreferredModel(preferredModel);
  const reasoningEffort = normalizePreferredReasoningEffort(preferredReasoningEffort);
  const writesAutoCompactWindow = autoCompactWindow !== undefined;
  const window = writesAutoCompactWindow ? parseAutoCompactWindow(autoCompactWindow) : null;
  const writesThinkingEnabled = thinkingEnabled !== undefined;
  const enabled = writesThinkingEnabled ? parseThinkingEnabled(thinkingEnabled) : DEFAULT_THINKING_ENABLED;
  const writesThinkingDisplay = thinkingDisplay !== undefined;
  const display = writesThinkingDisplay ? parseThinkingDisplay(thinkingDisplay) : null;
  const writesMayCreateSessions = mayCreateSessions !== undefined;
  const writesPlanOnly = planOnly !== undefined;
  if (!db || !stmts || !convId || !mode) {
    return {
      ok: false,
      created: false,
      preferredRelayMode: mode,
      preferredModel: '',
      preferredReasoningEffort: '',
      autoCompactWindow: null,
      thinkingEnabled: DEFAULT_THINKING_ENABLED,
      thinkingDisplay: DEFAULT_THINKING_DISPLAY,
      mayCreateSessions: false,
      planOnly: false,
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
    // Extra per-conversation setting columns this write mentions. The prepared
    // statement can't carry them, and these writes are rare (one control
    // change each) — the dynamic form keeps the hot composer path on the
    // prepared statement.
    const extraSets = [];
    const extraValues = [];
    if (writesAutoCompactWindow) {
      extraSets.push('auto_compact_window = ?');
      extraValues.push(window);
    }
    // Both axes store the RESOLVED value, never NULL-as-default: NULL means
    // "never set" and is read back as the relay default, so canonicalizing a
    // default choice to NULL would silently re-point those rows if the relay
    // default ever changed.
    if (writesThinkingEnabled) {
      extraSets.push('thinking_enabled = ?');
      extraValues.push(enabled ? 1 : 0);
    }
    if (writesThinkingDisplay) {
      extraSets.push('thinking_display = ?');
      extraValues.push(display);
    }
    if (writesMayCreateSessions) {
      extraSets.push('may_create_sessions = ?');
      extraValues.push(mayCreateSessions === true ? 1 : 0);
    }
    if (writesPlanOnly) {
      extraSets.push('plan_only = ?');
      extraValues.push(planOnly === true ? 1 : 0);
    }
    try {
      if (extraSets.length) {
        db.prepare(`
          UPDATE conversations
          SET preferred_relay_mode = ?, preferred_model = ?, preferred_reasoning_effort = ?,
              ${extraSets.join(', ')}, updated_at = ?
          WHERE id = ?
        `).run(mode, model || null, reasoningEffort || null, ...extraValues, updatedAt, convId);
      } else if (typeof stmts.updateConvPreferences?.run === 'function') {
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
      // Always echoed, so a write that didn't touch the window still tells the
      // client what the stored value is.
      autoCompactWindow: writesAutoCompactWindow
        ? window
        : parseAutoCompactWindow(existing?.auto_compact_window),
      thinkingEnabled: writesThinkingEnabled
        ? enabled
        : parseThinkingEnabled(existing?.thinking_enabled),
      thinkingDisplay: writesThinkingDisplay
        ? display
        : parseThinkingDisplay(existing?.thinking_display),
      mayCreateSessions: writesMayCreateSessions
        ? mayCreateSessions === true
        : readMayCreateSessions(existing),
      planOnly: writesPlanOnly
        ? planOnly === true
        : readPlanOnly(existing),
      updatedAt,
    };
  });
  return writePreferences();
}

/** The owner's "agents in this conversation may start sessions" of a conversations row. */
export function readMayCreateSessions(row) {
  return Number(row?.may_create_sessions) === 1;
}

/** Whether a conversations row is plan-only (migration 0035; NULL is not). */
export function readPlanOnly(row) {
  return Number(row?.plan_only) === 1;
}

/**
 * A compaction's new conversation keeps a plan-only source's lock and the
 * mode it is saved in, so the work goes on as locked as it was. Nothing for
 * any other source. Returns whether it carried the lock.
 */
export function carryPlanOnlyToCompacted({ db, stmts, source, targetConversationId, updatedAt = new Date().toISOString() } = {}) {
  if (!db || !stmts?.conversationsHavePlanOnly || !readPlanOnly(source)) return false;
  const target = String(targetConversationId || '').trim();
  if (!target) return false;
  const mode = String(source?.preferred_relay_mode || '').trim() || 'plan';
  db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = ?, updated_at = ? WHERE id = ?`).run(mode, updatedAt, target);
  return true;
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
