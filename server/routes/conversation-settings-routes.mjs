'use strict';

// The routes that change one conversation's settings: its title, its
// preferences, the relay_tool's update_session, its draft and its workspace
// root, registered by registerSessionsRoutes.
import { persistConversationPreferences, readPlanOnly } from '../services/conversation-preferences-service.mjs';
import { parseAutoCompactWindow } from '../../shared/auto-compact-window.mjs';
import { parseThinkingDisplay, parseThinkingEnabled } from '../../shared/claude-thinking.mjs';
import {
  readWorkspaceRootPathFromBody,
  validateRequestedWorkspaceRoot, normalizeWorkspaceRootKey } from '../services/workspace-root-path-policy.mjs';
import { workspaceRootDisplayName } from '../workspace-root.mjs';
import { sessionLaunchMutex } from '../services/session-launch-mutex-service.mjs';
import { parseRemoteRelayOriginJson } from '../repositories/remote-relay-repository.mjs';
import { GROUP_NAME_MAX } from '../repositories/conversation-group-repository.mjs';
import { admitRemoteRelayRequest, isRemoteRelayLoopbackRequest, originCarriesWeight, readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { isPerson, notPerson, principalOf } from '../services/relay-principal.mjs';
import { AUTH_ERROR_CODES } from '../../shared/relay-route-policy.mjs';
import {
  RELAUNCH_COALESCE_WINDOW_MS,
  buildRelaunchRequestKey,
  createRelaunchCoalescer,
  evaluateReuseCwdMismatch,
  evaluateWorkspaceRootRelaunch,
} from '../services/workspace-root-relaunch-service.mjs';
import {
  IMAGE_INPUT_REFUSED_CODE,
  OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE,
  isOpenAIImageModelId,
  openAIImageModelNeedsOpenAIText,
  validateOpenAIImageOptions,
} from '../../shared/openai-image-options.mjs';
import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_GROUP_LIMITS,
  REMOTE_RELAY_SESSION_SETTINGS,
  formatSessionGroupList,
  resolveSessionGroupReference,
  validateRemoteRelaySessionSettings,
} from '../../shared/remote-relay-contract.mjs';
import { PLAN_ONLY_REFUSAL, planOnlyRefusesMode } from '../../shared/plan-only.mjs';
import {
  bootstrapGroupRefusal,
  copilotImageModelRefusal,
  createConversationGroupHelpers,
  isPidAlive,
  launchWorkspaceRootSession,
  normalizePreferredModel,
  normalizePreferredReasoningEffort,
  normalizeRelayModePreference,
  parseDraftAttachmentsColumn,
  resolveConversationTitle,
  stopIdleWorkspaceRootSession,
} from './sessions-helpers.mjs';

// The web client caps what it saves at the same length (MAX_DRAFT_TEXT_LENGTH
// in public/app/conversation-draft-sync.mjs); a test pins them together.
export const MAX_CONVERSATION_DRAFT_LENGTH = 20_000;

function normalizeConversationDraftText(value, { maxLength = MAX_CONVERSATION_DRAFT_LENGTH } = {}) {
  const text = String(value ?? '');
  if (!text.trim()) return '';
  if (text.length <= maxLength) return text;
  // Never split a surrogate pair: SQLite would store the lone half as U+FFFD,
  // and the client (which cuts the same way) would no longer match its draft.
  const cut = text.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function normalizeOptionalIsoTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function hasConversationDraftVersionConflict({
  existingDraftUpdatedAt = null,
  baseDraftUpdatedAt = null,
  compareEnabled = false,
} = {}) {
  if (!compareEnabled) return false;
  return normalizeOptionalIsoTimestamp(existingDraftUpdatedAt) !== normalizeOptionalIsoTimestamp(baseDraftUpdatedAt);
}

export const MAX_CONVERSATION_DRAFT_ATTACHMENTS = 6;
export const DRAFT_UPLOAD_MESSAGE_ID = '__draft__';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Validates a client-supplied draft attachment list. Every entry must reference
 * a blob that already exists, so a draft can never point at content the server
 * does not hold. Returns `{ ok:false, error }` instead of throwing so the route
 * can answer with a 400.
 */
export function normalizeDraftAttachmentsInput(value, {
  lookupUploadFile,
  max = MAX_CONVERSATION_DRAFT_ATTACHMENTS,
} = {}) {
  if (value === undefined) return { ok: true, provided: false, attachments: [] };
  if (value === null) return { ok: true, provided: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'draftAttachments must be an array' };
  if (value.length > max) return { ok: false, error: `At most ${max} draft attachments are allowed` };

  const seen = new Set();
  const attachments = [];
  for (const entry of value) {
    const sha256 = String(entry?.sha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) return { ok: false, error: 'Invalid draft attachment id' };
    if (seen.has(sha256)) continue;
    seen.add(sha256);

    const row = typeof lookupUploadFile === 'function' ? lookupUploadFile(sha256) : null;
    if (!row) return { ok: false, error: 'Unknown draft attachment' };

    attachments.push({
      sha256,
      name: String(entry?.name || row.original_name || '').trim().slice(0, 255) || `upload-${sha256.slice(0, 12)}`,
      type: String(entry?.type || row.mime_type || 'application/octet-stream').trim().toLowerCase().slice(0, 127),
      size: Math.max(0, Number(entry?.size ?? row.size_bytes ?? 0) || 0),
    });
  }

  return { ok: true, provided: true, attachments };
}

export function diffDraftAttachmentHashes(previous = [], next = []) {
  const before = new Set(previous.map((item) => String(item?.sha256 || item || '').trim().toLowerCase()).filter(Boolean));
  const after = new Set(next.map((item) => String(item?.sha256 || item || '').trim().toLowerCase()).filter(Boolean));
  return {
    added: [...after].filter((sha) => !before.has(sha)),
    removed: [...before].filter((sha) => !after.has(sha)),
  };
}

const MAX_CONVERSATION_TITLE_LENGTH = 120;

export function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) return '';
  return title.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

export function persistConversationTitle({
  db,
  stmts,
  io = null,
  conversationId = '',
  title = '',
} = {}) {
  const id = String(conversationId || '').trim();
  const nextTitle = normalizeConversationTitle(title);
  if (!id) {
    return { ok: false, statusCode: 400, error: 'Missing conversation id' };
  }
  if (!nextTitle) {
    return { ok: false, statusCode: 400, error: 'Missing title' };
  }

  const existing = stmts?.getConvAnyStatus?.get?.(id) || null;
  if (existing && String(existing.status || '').trim() === 'deleted') {
    return { ok: false, statusCode: 404, error: 'Conversation not found' };
  }

  const updatedAt = existing?.updated_at || new Date().toISOString();

  if (!existing) {
    if (typeof stmts?.insertConv?.run === 'function') {
      stmts.insertConv.run(id, nextTitle, updatedAt, updatedAt);
    } else if (db && typeof db.prepare === 'function') {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, nextTitle, updatedAt, updatedAt);
    }
  }

  if (typeof stmts?.updateConvTitle?.run === 'function') {
    stmts.updateConvTitle.run(nextTitle, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?`).run(nextTitle, id);
  }

  if (typeof stmts?.setConvSdkSessionIdIfMissing?.run === 'function') {
    stmts.setConvSdkSessionIdIfMissing.run(id, updatedAt, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')`).run(id, updatedAt, id);
  }

  const payload = {
    conversationId: id,
    title: nextTitle,
    updatedAt,
    workspaceYamlPath: null,
  };
  io?.emit?.('conversation_title_updated', payload);
  return { ok: true, ...payload, created: !existing };
}

export function registerConversationSettingsRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    deleteOrphanedUploads,
    workspaceRootPayload,
    resolveConversationWorkspaceState,
    updateConversationConfiguredWorkspaceRoot,
    learnConversationWorkspaceRoot,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    sessionWorkerProcessInspector,
  } = deps;
  const {
    conversationGroups,
    remoteRelayInbound,
    sessionWorkerStopOverrides,
    workspaceRootAllowList,
    describeSessionActivity,
    resolveConversationByIdOrSdkSessionId,
    consumeWorkspaceRootRateLimit,
  } = shared;
  const { emitGroupChanged, listGroupsForAgents, conversationGroupField } = createConversationGroupHelpers({ io, conversationGroups });

  /**
   * Drops draft references to the given blobs and reclaims any that no longer
   * have a reference at all. Blobs still referenced by a sent message survive.
   *
   * Only blobs that actually held a draft reference for this conversation are
   * considered: a blob with no references at all is either owned by someone else
   * or still mid-upload, and must not be collected here.
   */
  function releaseDraftUploadReferences(conversationId, hashes = []) {
    const list = [...new Set((hashes || []).map((sha) => String(sha || '').trim().toLowerCase()).filter(Boolean))];
    if (!list.length) return;
    const released = [];
    for (const sha256 of list) {
      const result = stmts.deleteDraftUploadRef?.run?.(conversationId, sha256);
      if (Number(result?.changes || 0) > 0) released.push(sha256);
    }
    if (released.length && typeof deleteOrphanedUploads === 'function') {
      deleteOrphanedUploads(released);
    }
  }
  const countActiveConversationQueueRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'processing', 'parked')
  `);
  // Everything that reaches the session-worker launch path is serialized by
  // the relay-wide sessionLaunchMutex (services/session-launch-mutex-service.mjs),
  // keyed by sdkSessionId, which the worker recycle takes too; plus a
  // coalescer so a duplicated request replays one result.
  const relaunchCoalescer = createRelaunchCoalescer({ windowMs: RELAUNCH_COALESCE_WINDOW_MS });

  app.patch('/api/conversation/:id', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const result = persistConversationTitle({
      db,
      stmts,
      io,
      conversationId,
      title: req.body?.title,
    });
    if (!result.ok) {
      return res.status(result.statusCode || 500).json({ error: result.error || 'Failed to update conversation title' });
    }
    return res.json({
      ok: true,
      conversationId: result.conversationId,
      title: result.title,
      updatedAt: result.updatedAt,
      created: result.created === true,
    });
  });

  /**
   * Writes a conversation's preferences and tells every open page: the one
   * code path of PATCH …/preferences (the composer, the context modal) and of
   * an agent's update_session (PATCH …/settings). `body` uses the preferences
   * route's keys; a key it does not mention keeps the stored value.
   */
  function applyConversationPreferences({ conversationId, existing, body = {}, senderClientId = null }) {
    const now = new Date().toISOString();
    // Every write replaces all four columns, so a caller that only wants to
    // change one field (the context modal's auto-compact slider) must not have
    // the others reset to their defaults: an unmentioned key keeps the stored
    // value. The composer always sends all three, so its behaviour — including
    // clearing a preference with an explicit '' — is unchanged.
    const mentions = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);
    const preferredRelayMode = normalizeRelayModePreference(
      mentions('preferredRelayMode') ? body.preferredRelayMode : existing?.preferred_relay_mode,
      {
        supportedRelayModes: SUPPORTED_RELAY_MODES,
        fallbackMode: DEFAULT_RELAY_MODE,
      },
    );
    const preferredModel = normalizePreferredModel(
      mentions('preferredModel') ? body.preferredModel : existing?.preferred_model,
    );
    const preferredReasoningEffort = normalizePreferredReasoningEffort(
      mentions('preferredReasoningEffort') ? body.preferredReasoningEffort : existing?.preferred_reasoning_effort,
    );
    // Only an explicit mention rewrites the window (null = Auto is a real
    // value, so a plain falsy check would not do). Same for the thinking
    // control, where null = Host default.
    const persisted = persistConversationPreferences({
      db,
      stmts,
      conversationId,
      preferredRelayMode,
      preferredModel,
      preferredReasoningEffort,
      ...(mentions('autoCompactWindow')
        ? { autoCompactWindow: parseAutoCompactWindow(body.autoCompactWindow) }
        : {}),
      ...(mentions('thinkingEnabled')
        ? { thinkingEnabled: parseThinkingEnabled(body.thinkingEnabled) }
        : {}),
      ...(mentions('thinkingDisplay')
        ? { thinkingDisplay: parseThinkingDisplay(body.thinkingDisplay) }
        : {}),
      ...(mentions('mayCreateSessions') ? { mayCreateSessions: body.mayCreateSessions === true } : {}),
      ...(mentions('planOnly') ? { planOnly: body.planOnly === true } : {}),
      updatedAt: now,
      createIfMissing: !existing,
      createTitle: 'Session',
    });
    const payload = {
      conversationId,
      preferredRelayMode: persisted.preferredRelayMode,
      preferredModel: persisted.preferredModel,
      preferredReasoningEffort: persisted.preferredReasoningEffort,
      autoCompactWindow: persisted.autoCompactWindow ?? null,
      thinkingEnabled: persisted.thinkingEnabled ?? null,
      thinkingDisplay: persisted.thinkingDisplay ?? null,
      mayCreateSessions: persisted.mayCreateSessions === true,
      planOnly: persisted.planOnly === true,
      updatedAt: persisted.updatedAt,
      senderClientId,
    };
    io.emit('conversation_preferences_updated', payload);
    return { ...payload, created: persisted.created };
  }

  app.patch('/api/conversation/:id/preferences', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const senderClientId = String(req.body?.clientId || '').trim() || null;

    const existing = stmts.getConvAnyStatus.get(conversationId);
    if (existing && String(existing.status || '').trim() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    // "Agents in this conversation may start sessions" is the owner's alone:
    // an agent (of this relay or a paired one) could grant it to itself.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'mayCreateSessions')) {
      if (notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound))) {
        return res.status(403).json({ error: 'Whether agents in a conversation may start sessions is the owner\'s setting alone.' });
      }
      if (typeof req.body.mayCreateSessions !== 'boolean') {
        return res.status(400).json({ error: 'mayCreateSessions must be true or false' });
      }
      if (!stmts.conversationsHaveMayCreateSessions) {
        return res.status(503).json({ error: 'This setting is unavailable until the relay restarts (its storage is missing).' });
      }
    }
    // Plan-only: the owner's toggle here. Agents set and clear it through
    // update_session only (its dry run and Allow card), never through this
    // route, and they cannot change a plan-only session's mode here either.
    const remoteRequest = notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound));
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'planOnly')) {
      if (remoteRequest) {
        return res.status(403).json({ error: 'Agents set plan-only through relay_tool update_session, not through this route.' });
      }
      if (typeof req.body.planOnly !== 'boolean') {
        return res.status(400).json({ error: 'planOnly must be true or false' });
      }
      if (!stmts.conversationsHavePlanOnly) {
        return res.status(503).json({ error: 'This setting is unavailable until the relay restarts (its storage is missing).' });
      }
    }
    // A Copilot chat cannot move to an image model: its runtime cannot serve
    // one. The model it has already is written back as before.
    if (
      existing
      && Object.prototype.hasOwnProperty.call(req.body || {}, 'preferredModel')
      && normalizePreferredModel(req.body.preferredModel) !== normalizePreferredModel(existing.preferred_model)
    ) {
      const runtime = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
      const provider = String(runtime?.provider_type || '').trim().toLowerCase();
      const imageRefusal = provider === 'github' ? copilotImageModelRefusal(req.body.preferredModel) : null;
      if (imageRefusal) return res.status(400).json(imageRefusal);
    }
    if (remoteRequest && readPlanOnly(existing)
      && Object.prototype.hasOwnProperty.call(req.body || {}, 'preferredRelayMode')
      && planOnlyRefusesMode(req.body.preferredRelayMode)) {
      return res.status(409).json(PLAN_ONLY_REFUSAL);
    }

    const persisted = applyConversationPreferences({ conversationId, existing, body: req.body || {}, senderClientId });
    return res.json({ ok: true, ...persisted });
  });

  // ─── PATCH /api/conversation/:id/settings — the relay_tool's update_session ───
  //
  // `{ settings: { model, effort, mode, auto_compact_window, title, group,
  // thinking_enabled, thinking_display, cwd, image }, dry_run, owner_approved }`.
  // Reached by an agent of this relay (the loopback) and by a paired relay's
  // agent (under the inbound switch); the owner may call it too. It applies
  // this relay's own rule: an agent changes freely only a session its own
  // conversation started (the request's origin against the session's); any
  // other changes only with `owner_approved` (the calling relay asked its
  // user). A dry run checks everything, writes nothing, and says whether
  // approval is needed. A group the owner made never goes through this path
  // (it may stay empty); one an agent made here goes once empty. A step that
  // fails after an earlier one wrote answers `changed` with what was written.
  // Every write goes through the code the owner's
  // own controls use (preferences, title, group, workspace root), with their
  // socket events, so an open page shows the change at once. The owner's
  // "may start sessions" switch is not among the settings.

  const SESSION_SETTINGS_INVALID = 'SESSION_SETTINGS_INVALID';

  /** An image session's defaults as stored (`{}` for none, or for any other session). */
  function readImageDefaults(conversationId) {
    try {
      return stmts.readConversationImageDefaults?.(conversationId) || {};
    } catch {
      return {};
    }
  }

  function currentSessionSettings(conversationId) {
    const conv = stmts.getConvAnyStatus.get(conversationId) || {};
    const runtime = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    const workspace = resolveConversationWorkspaceState?.({ conversationId }) || null;
    const window = parseAutoCompactWindow(conv.auto_compact_window);
    const imageDefaults = readImageDefaults(conversationId);
    return {
      model: normalizePreferredModel(conv.preferred_model) || String(runtime?.provider_model || runtime?.model || '').trim() || null,
      effort: normalizePreferredReasoningEffort(conv.preferred_reasoning_effort) || null,
      mode: normalizeRelayModePreference(conv.preferred_relay_mode, { supportedRelayModes: SUPPORTED_RELAY_MODES, fallbackMode: DEFAULT_RELAY_MODE }),
      auto_compact_window: window === null ? 'auto' : window,
      title: resolveConversationTitle({ title: conv.title, titleSource: conv.title_source }) || null,
      group: conversationGroupField(conversationId),
      thinking_enabled: parseThinkingEnabled(conv.thinking_enabled),
      thinking_display: parseThinkingDisplay(conv.thinking_display),
      cwd: String(workspace?.currentWorkspaceRootPath || workspace?.configuredWorkspaceRootPath || conv.configured_workspace_root_path || '').trim() || null,
      planOnly: readPlanOnly(conv),
      ...(Object.keys(imageDefaults).length ? { image: imageDefaults } : {}),
    };
  }

  /**
   * Whether the agent calling the settings route started this session from
   * its own conversation: the session's origin names that conversation, and
   * this relay's own agent (the loopback) for a local origin, the same
   * paired relay for one from there.
   */
  function sessionStartedByCaller(createdBy, remoteRequest) {
    const caller = remoteRequest?.remote ? remoteRequest.origin : null;
    if (!createdBy || !caller) return false;
    const callerConversation = String(caller.conversationId || '').trim();
    if (!callerConversation || String(createdBy.conversationId || '').trim() !== callerConversation) return false;
    if (remoteRequest.local === true) return createdBy.local === true && caller.local === true;
    // Origin binding: a paired relay's request (its key) matches a session
    // only that same registry entry started, verified, at its current epoch.
    if (createdBy.local === true || caller.verified !== true || createdBy.verified !== true) return false;
    if (String(createdBy.entryId || '') !== String(caller.entryId || '')) return false;
    return originCarriesWeight(createdBy, (id) => {
      try {
        // An inbound-only entry (a relay that added this one one way) is no
        // listed relay, and its key opens what any paired relay's does.
        if (typeof remoteRelayInbound?.getRelay === 'function') return remoteRelayInbound.getRelay(id);
        const listed = remoteRelayInbound?.listRelays?.() || [];
        return listed.find((entry) => String(entry?.id || '') === String(id)) || null;
      } catch {
        return null;
      }
    });
  }

  /** Why a session cannot move to another folder now ('' when it can). */
  function sessionBusyReason(conversationId) {
    if (Number(countActiveConversationQueueRows.get(conversationId)?.count || 0) > 0) return 'a turn is queued or running there';
    const state = describeSessionActivity(conversationId)?.sessionState;
    if (state === 'running_turn') return 'a turn is running there';
    if (state === 'background_only') return 'a background task is running there';
    return '';
  }

  /**
   * What update_session would do: `{ ok, plan }` or `{ ok:false, status,
   * body }`. The plan holds what changes (`changed`, in the order of the
   * contract's settings) and how.
   */
  function planSessionSettings(conversation, raw, { remote = false } = {}) {
    const conversationId = String(conversation.id);
    const fail = (status, error, extra = {}) => ({ ok: false, status, body: { ok: false, error, ...extra } });
    const settingsInput = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!settingsInput) return fail(400, 'settings must be an object', { code: SESSION_SETTINGS_INVALID });
    const unknown = Object.keys(settingsInput).filter((key) => !REMOTE_RELAY_SESSION_SETTINGS.includes(key));
    if (unknown.length) {
      return fail(400, `Not a setting an agent may change: ${unknown.slice(0, 10).join(', ')}. Settings: ${REMOTE_RELAY_SESSION_SETTINGS.join(', ')}.`, { code: SESSION_SETTINGS_INVALID });
    }
    const checked = validateRemoteRelaySessionSettings(settingsInput);
    if (!checked.ok) return fail(400, checked.error, { code: SESSION_SETTINGS_INVALID });
    const wanted = checked.values;
    const current = currentSessionSettings(conversationId);
    const runtime = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    const provider = String(runtime?.provider_type || 'github').trim().toLowerCase() || 'github';
    const plan = { conversationId, provider, current, wanted, changed: [], preferences: {}, notes: [] };
    const change = (key) => { if (!plan.changed.includes(key)) plan.changed.push(key); };

    if (wanted.model !== undefined && normalizePreferredModel(wanted.model) !== normalizePreferredModel(conversation.preferred_model)) {
      const imageRefusal = provider === 'github' ? copilotImageModelRefusal(wanted.model) : null;
      if (imageRefusal) return fail(400, `${imageRefusal.error} Nothing was changed.`, { code: imageRefusal.code });
      plan.preferences.preferredModel = wanted.model;
      change('model');
    }
    if (wanted.effort !== undefined && wanted.effort !== normalizePreferredReasoningEffort(conversation.preferred_reasoning_effort)) {
      plan.preferences.preferredReasoningEffort = wanted.effort;
      change('effort');
    }
    if (wanted.mode !== undefined) {
      if (!SUPPORTED_RELAY_MODES.includes(wanted.mode)) {
        return fail(400, `This relay has no mode "${wanted.mode}". Modes: ${SUPPORTED_RELAY_MODES.join(', ')}.`, { code: SESSION_SETTINGS_INVALID });
      }
      if (wanted.mode !== current.mode) {
        plan.preferences.preferredRelayMode = wanted.mode;
        change('mode');
      }
    }
    // Plan-only, read as it is after this call: one that clears the flag may
    // name another mode too, one that keeps or sets it may not. Checked before
    // anything else is planned, so a dry run refuses before any Allow card.
    if (wanted.planOnly !== undefined && !stmts.conversationsHavePlanOnly) {
      return fail(503, 'planOnly is unavailable until the relay restarts (its storage is missing). Nothing was changed.', { code: SESSION_SETTINGS_INVALID });
    }
    // planOnly:false counts only in the call that switches to another mode:
    // alone (or with plan) it is passed over, so a caller that fills every
    // property with false never drops the lock by accident.
    if (wanted.planOnly === false && !(wanted.mode !== undefined && wanted.mode !== 'plan')) {
      delete wanted.planOnly;
      if (current.planOnly === true) plan.notes.push('planOnly unchanged: clear it in the same call as the new mode.');
    }
    const planOnlyAfter = wanted.planOnly !== undefined ? wanted.planOnly === true : current.planOnly === true;
    if (remote && planOnlyAfter && wanted.mode !== undefined && planOnlyRefusesMode(wanted.mode)) {
      return fail(409, `${PLAN_ONLY_REFUSAL.error} Nothing was changed.`, { code: PLAN_ONLY_REFUSAL.code });
    }
    if (wanted.planOnly !== undefined && wanted.planOnly !== current.planOnly) {
      if (wanted.planOnly === true && (wanted.mode !== undefined ? wanted.mode : current.mode) !== 'plan') {
        return fail(400, `planOnly keeps a session in plan mode, and this one is in ${current.mode} mode: add mode: "plan" in the same call. Nothing was changed.`, { code: SESSION_SETTINGS_INVALID });
      }
      plan.preferences.planOnly = wanted.planOnly;
      change('planOnly');
    }
    if (wanted.auto_compact_window !== undefined) {
      const window = wanted.auto_compact_window === 'auto' ? null : parseAutoCompactWindow(wanted.auto_compact_window);
      if (window !== parseAutoCompactWindow(conversation.auto_compact_window)) {
        plan.preferences.autoCompactWindow = window;
        change('auto_compact_window');
      }
      if (window !== null && window !== wanted.auto_compact_window) {
        plan.notes.push(`auto_compact_window ${wanted.auto_compact_window} was taken as ${window}, the nearest window this relay offers.`);
      }
    }
    if (wanted.thinking_enabled !== undefined && wanted.thinking_enabled !== current.thinking_enabled) {
      plan.preferences.thinkingEnabled = wanted.thinking_enabled;
      change('thinking_enabled');
    }
    if (wanted.thinking_display !== undefined && wanted.thinking_display !== current.thinking_display) {
      plan.preferences.thinkingDisplay = wanted.thinking_display;
      change('thinking_display');
    }
    if (provider !== 'claude' && provider !== 'claude-api' && ['auto_compact_window', 'thinking_enabled', 'thinking_display'].some((key) => wanted[key] !== undefined)) {
      plan.notes.push(`auto_compact_window and thinking apply to Claude sessions only; this one runs on ${provider}, so they are stored but change nothing there.`);
    }
    if (wanted.title !== undefined) {
      const title = normalizeConversationTitle(wanted.title);
      if (title !== current.title) {
        plan.title = title;
        change('title');
      }
    }
    if (Object.prototype.hasOwnProperty.call(wanted, 'group')) {
      if (!conversationGroups?.enabled) {
        return fail(503, 'Session groups are not available on this relay (its storage for them is missing). Nothing was changed.', { code: 'SESSION_GROUPS_UNAVAILABLE' });
      }
      if (wanted.group === null) {
        if (current.group) {
          plan.group = { action: 'leave', previous: current.group };
          change('group');
        }
      } else {
        const groups = listGroupsForAgents();
        const found = resolveSessionGroupReference(groups, wanted.group);
        if (found.status === 'ambiguous') {
          const refusal = bootstrapGroupRefusal(found, wanted.group, groups);
          return fail(400, refusal.error.replace('No conversation was created.', 'Nothing was changed.'), { code: refusal.code, groups: refusal.groups, ...(refusal.groupsTotal ? { groupsTotal: refusal.groupsTotal } : {}) });
        }
        if (found.status === 'found') {
          if (current.group?.id !== found.group.id) {
            plan.group = { action: 'join', id: found.group.id, name: found.group.name };
            change('group');
          }
        } else if (/^grp_/i.test(wanted.group)) {
          // An id that is not there names no group to make.
          const refusal = bootstrapGroupRefusal(found, wanted.group, groups);
          return fail(400, refusal.error.replace('No conversation was created.', 'Nothing was changed.'), { code: refusal.code, groups: refusal.groups, ...(refusal.groupsTotal ? { groupsTotal: refusal.groupsTotal } : {}) });
        } else if (remote) {
          // Making a group is the person's (agent auth §0.2): an agent moves
          // a session into an existing group or out of one.
          const asked = String(wanted.group).replace(/["\r\n]+/g, ' ').slice(0, 80);
          return fail(403, `Only the person makes session groups: there is no group "${asked}" here${groups.length ? ` (groups: ${formatSessionGroupList(groups)})` : ''}. Name an existing group (relay_info lists them), or ask the user to make it. Nothing was changed.`, {
            code: AUTH_ERROR_CODES.personRequired,
            groups: groups.slice(0, REMOTE_RELAY_GROUP_LIMITS.refusalMax).map((group) => ({ id: group.id, name: group.name })),
          });
        } else if (wanted.group.replace(/\s+/g, ' ').length > GROUP_NAME_MAX) {
          return fail(400, `A group name has at most ${GROUP_NAME_MAX} characters. Nothing was changed.`, { code: SESSION_SETTINGS_INVALID });
        } else {
          plan.group = { action: 'create', name: wanted.group.replace(/\s+/g, ' ') };
          change('group');
        }
      }
    }
    if (wanted.cwd !== undefined) {
      if (provider === 'claude-cloud') {
        return fail(400, 'cwd does not apply to a Claude Cloud session: it works on a clone of its repository. Nothing was changed.', { code: SESSION_SETTINGS_INVALID });
      }
      if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
        return fail(503, 'Conversation workspace updates are unavailable on this relay. Nothing was changed.', { code: SESSION_SETTINGS_INVALID });
      }
      const validated = validateRequestedWorkspaceRoot(wanted.cwd, { allowList: workspaceRootAllowList });
      if (!validated.ok) {
        return fail(validated.code === 'root-path-not-allowed' ? 403 : 400, `${validated.error || 'cwd is not a folder this relay may use'}. Nothing was changed.`, { code: validated.code || SESSION_SETTINGS_INVALID });
      }
      if (normalizeWorkspaceRootKey(validated.realPath) !== normalizeWorkspaceRootKey(current.cwd || '')) {
        const busy = sessionBusyReason(conversationId);
        if (busy) {
          return fail(409, `The session cannot move to another folder now: ${busy}. Wait for it to finish (wait or read_session), then try again. Nothing was changed.`, { code: 'SESSION_BUSY', reason: busy });
        }
        plan.cwd = validated.realPath;
        change('cwd');
      }
    }
    // An image session's defaults: what is named replaces the stored value of
    // that option, the rest stays. Checked against the model the session has
    // after this call; any other session is refused.
    if (wanted.image !== undefined) {
      // The model an image turn runs: the runtime session's (the send path's),
      // or the one this call moves it to.
      const imageModel = String(plan.preferences.preferredModel || runtime?.provider_model || runtime?.model || current.model || '').trim();
      if (provider === 'github' && isOpenAIImageModelId(imageModel)) {
        return fail(400, `${openAIImageModelNeedsOpenAIText(imageModel)} Nothing was changed.`, { code: OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE });
      }
      if (provider !== 'openai' || !isOpenAIImageModelId(imageModel)) {
        return fail(400, `Image defaults go to an OpenAI image session; this session runs ${imageModel || provider}. Nothing was changed.`, { code: IMAGE_INPUT_REFUSED_CODE });
      }
      const stored = readImageDefaults(conversationId);
      const checkedImage = validateOpenAIImageOptions({ ...stored, ...wanted.image }, { model: imageModel });
      if (!checkedImage.ok) return fail(400, `${checkedImage.error}. Nothing was changed.`, { code: IMAGE_INPUT_REFUSED_CODE });
      const sameAsStored = Object.keys(checkedImage.values).length === Object.keys(stored).length
        && Object.entries(checkedImage.values).every(([key, value]) => stored[key] === value);
      if (!sameAsStored) {
        plan.image = checkedImage.values;
        change('image');
      }
    }
    plan.changed.sort((a, b) => REMOTE_RELAY_SESSION_SETTINGS.indexOf(a) - REMOTE_RELAY_SESSION_SETTINGS.indexOf(b));
    return { ok: true, plan };
  }

  /** The session's folder through the owner's CWD path: saved, and its CLI relaunched there when it has one. */
  async function applySessionCwd(plan, req) {
    const { conversationId } = plan;
    const rateLimited = consumeWorkspaceRootRateLimit(conversationId, req);
    if (!rateLimited.ok) {
      return { ok: false, status: 429, body: { ok: false, code: 'rate-limited', error: 'Too many CWD updates. Try again shortly. Nothing was changed.' } };
    }
    const sdkSessionId = String(resolveConversationWorkspaceState?.({ conversationId })?.sdkSessionId || '').trim();
    if (!sdkSessionId) {
      // Never launched: the folder is saved for its first launch.
      const saved = await sessionLaunchMutex.runExclusive(`conv:${conversationId}`, () => {
        const busy = sessionBusyReason(conversationId);
        return busy ? { ok: false, busyReason: busy } : updateConversationConfiguredWorkspaceRoot({ conversationId, rootPath: plan.cwd });
      });
      if (saved?.busyReason) {
        return { ok: false, status: 409, body: { ok: false, code: 'SESSION_BUSY', reason: saved.busyReason, error: `The session cannot move to another folder now: ${saved.busyReason}. Wait for it to finish, then try again. Nothing was changed.` } };
      }
      if (!saved?.ok) return { ok: false, status: 400, body: { ok: false, error: `${saved?.error || 'Failed to update the session\'s folder'}. Nothing was changed.` } };
      const state = saved.state || null;
      io.emit('conversation_workspace_root_updated', {
        conversationId,
        sdkSessionId: state?.sdkSessionId || null,
        configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
        recentWorkspaceRoots: Array.isArray(workspaceRootPayload()?.recentWorkspaceRoots) ? workspaceRootPayload().recentWorkspaceRoots : [],
      });
      return { ok: true, relaunched: false };
    }
    let attempt;
    try {
      attempt = await sessionLaunchMutex.tryRunExclusive(sdkSessionId, () => {
        // Asked again under the lock, right before the relaunch: a turn or a
        // task may have started since the plan.
        const busy = sessionBusyReason(conversationId);
        if (busy) return { busyReason: busy };
        return runWorkspaceRootRelaunch({ conversationId, sdkSessionId, rootPath: plan.cwd });
      });
    } catch (error) {
      return { ok: false, status: 500, body: { ok: false, code: 'relaunch-error', error: error?.message || 'Failed to relaunch the CLI' } };
    }
    if (attempt.busy) {
      return { ok: false, status: 409, body: { ok: false, code: 'SESSION_BUSY', reason: 'its CLI is being relaunched', error: 'The session cannot move to another folder now: its CLI is being relaunched. Try again shortly. Nothing was changed.' } };
    }
    const outcome = attempt.result || {};
    if (outcome.busyReason) {
      return { ok: false, status: 409, body: { ok: false, code: 'SESSION_BUSY', reason: outcome.busyReason, error: `The session cannot move to another folder now: ${outcome.busyReason}. Wait for it to finish, then try again. Nothing was changed.` } };
    }
    // The relay could not read its process list, so it cannot tell whether
    // the session's CLI still runs: nothing is stopped or started.
    if (/^process-list-unreadable/.test(String(outcome.error || ''))) {
      return {
        ok: false,
        status: 503,
        body: {
          ok: false,
          code: 'PROCESS_LIST_UNREADABLE',
          error: 'This relay could not read its process list, so it cannot tell whether the session\'s CLI still runs; the folder was not changed. Try again shortly. Nothing was changed.',
        },
      };
    }
    if (outcome.statusCode !== 200 || outcome.body?.ok !== true) {
      const body = outcome.body || {};
      const busy = body.code === 'relaunch-not-eligible';
      // A CLI that would not stop or start: the folder is saved for the next
      // launch all the same (the owner's route does the same), so cwd changed.
      const saved = !busy && !!body.configuredWorkspaceRootPath;
      return {
        ok: false,
        status: outcome.statusCode || 500,
        body: {
          ...body,
          ok: false,
          ...(busy ? { code: 'SESSION_BUSY', reason: 'a turn is queued or running there' } : {}),
          error: busy
            ? `The session cannot move to another folder now: ${body.error || 'it is busy'}. Nothing was changed.`
            : `${body.error || 'Failed to relaunch the CLI'}${saved ? ' The folder is saved for its next launch; nothing else was changed.' : ' Nothing was changed.'}`,
          changed: saved ? ['cwd'] : [],
        },
      };
    }
    return {
      ok: true,
      relaunched: outcome.body.relaunched === true,
      ...(outcome.body.relaunched === true ? {} : { warning: outcome.body.message || 'The folder is saved for the next launch, but the running CLI kept its current folder.' }),
    };
  }

  app.patch('/api/conversation/:id/settings', auth, async (req, res) => {
    const remoteRequest = admitRemoteRelayRequest(req, res, remoteRelayInbound);
    if (!remoteRequest) return;
    const requestedId = String(req.params.id || '').trim();
    const conversation = requestedId ? resolveConversationByIdOrSdkSessionId(requestedId) : null;
    if (!conversation || String(conversation.status || '').trim() === 'deleted') {
      return res.status(404).json({ ok: false, code: 'SESSION_NOT_FOUND', error: 'Conversation not found' });
    }
    const conversationId = String(conversation.id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Not the person (an agent token, or another relay's agent): mode and
    // plan-only changes are held, and another's session needs the owner's
    // Allow (agent auth §2.2).
    const byAgent = notPerson(req, remoteRequest);
    const planned = planSessionSettings(conversation, body.settings, { remote: byAgent });
    if (!planned.ok) return res.status(planned.status).json(planned.body);
    const { plan } = planned;
    const createdBy = parseRemoteRelayOriginJson(conversation.origin_json);
    const byCaller = sessionStartedByCaller(createdBy, remoteRequest);
    // An agent changes freely only a session its own conversation started;
    // any other (the owner's, another agent's, its own creator's) needs the
    // owner's Allow, which the calling relay asks for and states.
    const approvalNeeded = byAgent && !byCaller;
    const facts = { session: conversationId, provider: plan.provider, ownerStarted: !createdBy, startedByCaller: byCaller, approvalNeeded };
    if (body.dry_run === true) {
      return res.json({
        ok: true,
        dryRun: true,
        ...facts,
        settings: plan.current,
        changed: plan.changed,
        ...(plan.group ? { group: plan.group } : {}),
        ...(plan.notes.length ? { notes: plan.notes } : {}),
      });
    }
    // This relay's own rule, whatever the calling relay checked. An agent
    // token's `owner_approved` is ignored: only this relay's own relay_tool
    // (the loopback, after the owner's Allow card) and, until peer keys,
    // another relay calling with the owner token may state it.
    // A paired relay's key is never the person, so its `owner_approved` is
    // ignored too (origin binding §6.4).
    const ownerApproved = body.owner_approved === true
      && (isRemoteRelayLoopbackRequest(req) || (isPerson(req) && remoteRequest.remote === true));
    // A paired relay's key never moves a session to another folder here.
    if (plan.cwd && principalOf(req)?.kind === 'peer') {
      return res.status(403).json({
        ok: false,
        code: REMOTE_RELAY_ERROR_CODES.permission,
        ...facts,
        error: 'A paired relay cannot change a session\'s folder on this relay. Nothing was changed.',
      });
    }
    if (approvalNeeded && !ownerApproved) {
      return res.status(403).json({
        ok: false,
        code: REMOTE_RELAY_ERROR_CODES.permission,
        ...facts,
        error: 'This session was not started by the calling conversation: an agent changes its settings only after the relay\'s owner allowed that for the calling conversation.',
      });
    }
    if (!plan.changed.length) {
      return res.json({ ok: true, ...facts, settings: plan.current, changed: [], ...(plan.notes.length ? { notes: plan.notes } : {}) });
    }

    // What is written so far: a step that fails later answers it, so a
    // partial change is never passed off as none.
    const written = [];
    const failAfter = (status, payload) => res.status(status).json({
      ...payload,
      ok: false,
      error: `${payload.error}${written.length ? ` These settings were changed before: ${written.join(', ')}.` : ' Nothing was changed.'}`,
      changed: [...written],
    });
    // The folder first: it is the one change that can fail after the checks
    // (a CLI that does not stop or start), and then nothing else is written.
    let cwdResult = null;
    if (plan.cwd) {
      cwdResult = await applySessionCwd(plan, req);
      if (!cwdResult.ok) return res.status(cwdResult.status).json(cwdResult.body);
      written.push('cwd');
    }
    if (plan.title !== undefined) {
      const titled = persistConversationTitle({ db, stmts, io, conversationId, title: plan.title });
      if (!titled.ok) return failAfter(titled.statusCode || 500, { error: titled.error || 'Failed to update the title.' });
      written.push('title');
    }
    if (plan.image) {
      try {
        if (typeof stmts.writeConversationImageDefaults !== 'function') throw new Error('Image session defaults are unavailable on this relay');
        stmts.writeConversationImageDefaults(conversationId, plan.image);
      } catch (error) {
        return failAfter(503, { code: 'IMAGE_DEFAULTS_UNAVAILABLE', error: `${error?.message || 'The image defaults could not be stored'}.` });
      }
      written.push('image');
    }
    if (Object.keys(plan.preferences).length) {
      applyConversationPreferences({
        conversationId,
        existing: stmts.getConvAnyStatus.get(conversationId),
        body: plan.preferences,
      });
      written.push(...plan.changed.filter((key) => !['cwd', 'title', 'group', 'image'].includes(key)));
    }
    // Groups through the agent path: an owner's group the session leaves is
    // never removed (it stays, empty if it was the last member); a group an
    // agent made goes once empty.
    const groupOptions = { keepOwnerGroups: byAgent };
    let groupCreated = null;
    let groupPlan = plan.group;
    if (groupPlan?.action === 'create') {
      // Looked up once more right before it is made: a call that ran beside
      // this one may have made the group of that name meanwhile.
      const groups = listGroupsForAgents();
      const found = resolveSessionGroupReference(groups, groupPlan.name);
      if (found.status === 'found') groupPlan = { action: 'join', id: found.group.id, name: found.group.name };
      // Several of that name by now: refused as the first lookup refuses.
      if (found.status === 'ambiguous') {
        const refusal = bootstrapGroupRefusal(found, groupPlan.name, groups);
        return failAfter(400, {
          code: refusal.code,
          error: refusal.error.replace(' No conversation was created.', ''),
          groups: refusal.groups,
          ...(refusal.groupsTotal ? { groupsTotal: refusal.groupsTotal } : {}),
        });
      }
    }
    if (groupPlan?.action === 'leave') {
      const left = conversationGroups.setMembership(conversationId, null, undefined, groupOptions);
      if (left.ok && left.changed) emitGroupChanged(left.previousGroupId, [conversationId]);
    } else if (groupPlan?.action === 'join') {
      const joined = conversationGroups.setMembership(conversationId, groupPlan.id, undefined, groupOptions);
      if (!joined.ok) {
        return failAfter(400, { code: 'SESSION_GROUP_NOT_FOUND', error: `The session group ${groupPlan.id} is gone.` });
      }
      if (joined.changed) {
        emitGroupChanged(groupPlan.id, [conversationId]);
        if (joined.previousGroupId && joined.previousGroupId !== groupPlan.id) emitGroupChanged(joined.previousGroupId, [conversationId]);
      }
    } else if (groupPlan?.action === 'create') {
      const previousGroupId = conversationGroups.groupOfConversation(conversationId)?.id || null;
      const group = conversationGroups.createGroup({ name: groupPlan.name, conversationIds: [conversationId], agentMade: byAgent, ...groupOptions });
      groupCreated = group ? { id: group.id, name: group.name } : null;
      if (group) emitGroupChanged(group.id, [conversationId]);
      if (previousGroupId) emitGroupChanged(previousGroupId, [conversationId]);
    }

    const notes = [...plan.notes];
    if (cwdResult?.warning) notes.push(cwdResult.warning);
    return res.json({
      ok: true,
      ...facts,
      settings: currentSessionSettings(conversationId),
      changed: plan.changed,
      ...(cwdResult ? { relaunched: cwdResult.relaunched } : {}),
      ...(groupCreated ? { groupCreated } : {}),
      ...(notes.length ? { notes } : {}),
    });
  });

  app.patch('/api/conversation/:id/draft', auth, (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    if (!requestedId) return res.status(400).json({ error: 'Missing conversation id' });
    const resolvedConversation = resolveConversationByIdOrSdkSessionId(requestedId);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });
    const conversationId = String(resolvedConversation.id).trim();
    const senderClientId = String(req.body?.clientId || '').trim() || null;
    const existing = stmts.getConvAnyStatus.get(conversationId);
    if (!existing || String(existing.status || '').trim() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    // A null base means "I have seen no draft" and conflicts with any versioned
    // draft — but only from clients that declare the versioned protocol. Older
    // tabs also send an explicit null (after every keystroke), and a 409 there
    // would revert their typing, so for them null stays unconditional.
    const baseDraftUpdatedAtValue = req.body?.baseDraftUpdatedAt !== undefined
      ? req.body.baseDraftUpdatedAt
      : req.body?.base_draft_updated_at;
    const speaksVersionedDraftProtocol = Number(req.body?.draftSyncVersion) >= 2;
    const comparesDraftVersion = baseDraftUpdatedAtValue !== undefined
      && (baseDraftUpdatedAtValue !== null || speaksVersionedDraftProtocol);
    const normalizedBaseDraftUpdatedAt = normalizeOptionalIsoTimestamp(baseDraftUpdatedAtValue);
    const suppliedBaseTimestamp = String(baseDraftUpdatedAtValue ?? '').trim();
    if (comparesDraftVersion && suppliedBaseTimestamp && !normalizedBaseDraftUpdatedAt) {
      return res.status(400).json({ error: 'Invalid baseDraftUpdatedAt timestamp' });
    }
    const existingDraftUpdatedAt = normalizeOptionalIsoTimestamp(existing.draft_updated_at);
    // A pagehide copy taken while this client's own send was in flight carries
    // the pre-send base; the send transaction has since moved the version. That
    // move (recorded with the sender's client id) is the only mismatch it may
    // pass — a newer draft from anyone else still conflicts.
    const acceptsOwnSendVersion = req.body?.acceptOwnSend === true
      && !!senderClientId
      && String(existing.draft_updated_by_client_id || '') === senderClientId;
    if (!acceptsOwnSendVersion && hasConversationDraftVersionConflict({
      existingDraftUpdatedAt,
      baseDraftUpdatedAt: normalizedBaseDraftUpdatedAt,
      compareEnabled: comparesDraftVersion,
    })) {
      return res.status(409).json({
        ok: false,
        error: 'Draft version conflict',
        code: 'draft-version-conflict',
        conflict: true,
        conversationId,
        draftText: String(existing.draft_text || ''),
        draftAttachments: parseDraftAttachmentsColumn(existing.draft_attachments),
        draftUpdatedAt: existingDraftUpdatedAt,
        draftUpdatedByClientId: existing.draft_updated_by_client_id || null,
      });
    }
    const now = new Date().toISOString();
    const draftText = normalizeConversationDraftText(req.body?.draftText ?? req.body?.text);
    const persistedDraftText = draftText || null;

    const attachmentsInput = normalizeDraftAttachmentsInput(req.body?.draftAttachments, {
      lookupUploadFile: (sha256) => stmts.getUploadFile?.get?.(sha256) || null,
    });
    if (!attachmentsInput.ok) {
      return res.status(400).json({ error: attachmentsInput.error });
    }

    const previousAttachments = parseDraftAttachmentsColumn(existing.draft_attachments);
    const nextAttachments = attachmentsInput.provided ? attachmentsInput.attachments : previousAttachments;

    if (typeof stmts.updateConvDraft?.run === 'function') {
      stmts.updateConvDraft.run(persistedDraftText, now, senderClientId, conversationId);
    } else {
      db.prepare(`
        UPDATE conversations
        SET draft_text = ?, draft_updated_at = ?, draft_updated_by_client_id = ?
        WHERE id = ?
      `).run(persistedDraftText, now, senderClientId, conversationId);
    }

    if (attachmentsInput.provided) {
      const serialized = nextAttachments.length ? JSON.stringify(nextAttachments) : null;
      if (typeof stmts.updateConvDraftAttachments?.run === 'function') {
        stmts.updateConvDraftAttachments.run(serialized, now, senderClientId, conversationId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET draft_attachments = ?, draft_updated_at = ?, draft_updated_by_client_id = ?
          WHERE id = ?
        `).run(serialized, now, senderClientId, conversationId);
      }

      // Keep upload references in step with the draft so blobs stay alive while
      // referenced and become collectable the moment they are not.
      const { added, removed } = diffDraftAttachmentHashes(previousAttachments, nextAttachments);
      for (const sha256 of added) {
        stmts.insertUploadRef?.run?.(sha256, conversationId, DRAFT_UPLOAD_MESSAGE_ID, now);
      }
      if (removed.length && typeof releaseDraftUploadReferences === 'function') {
        releaseDraftUploadReferences(conversationId, removed);
      }
    }

    const payload = {
      conversationId,
      draftText: persistedDraftText || '',
      draftAttachments: nextAttachments,
      draftUpdatedAt: now,
      draftUpdatedByClientId: senderClientId,
      senderClientId,
    };
    io.emit('conversation_draft_updated', payload);
    return res.json({
      ok: true,
      ...payload,
    });
  });

  app.post('/api/conversation/:id/workspace-root', auth, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const nextRootPath = readWorkspaceRootPathFromBody(req.body);
    if (!nextRootPath) {
      return res.status(400).json({ error: 'Missing rootPath' });
    }
    if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Conversation workspace updates are unavailable' });
    }
    const validated = validateRequestedWorkspaceRoot(nextRootPath, {
      allowList: workspaceRootAllowList,
    });
    if (!validated.ok) {
      return res.status(validated.code === 'root-path-not-allowed' ? 403 : 400)
        .json({ ok: false, code: validated.code, error: validated.error });
    }
    const rateLimited = consumeWorkspaceRootRateLimit(conversationId, req);
    if (!rateLimited.ok) {
      res.set('Retry-After', String(rateLimited.retryAfterSeconds));
      return res.status(429).json({ ok: false, code: 'rate-limited', error: 'Too many CWD updates. Try again shortly.' });
    }

    // Queue behind any in-flight relaunch for this session: otherwise this write
    // can swap the configured root between that relaunch's stop and its spawn.
    const lockSessionId = String(
      resolveConversationWorkspaceState?.({ conversationId })?.sdkSessionId || '',
    ).trim();
    const result = await sessionLaunchMutex.runExclusive(
      lockSessionId || `conv:${conversationId}`,
      () => updateConversationConfiguredWorkspaceRoot({
        conversationId,
        rootPath: validated.realPath,
      }),
    );

    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update conversation workspace root' });
    }
    const state = result.state || null;
    const workspaceHints = workspaceRootPayload();
    io.emit('conversation_workspace_root_updated', {
      conversationId,
      sdkSessionId: state?.sdkSessionId || null,
      configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
      recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
    });
    return res.json({
      ok: true,
      conversationId,
      sdkSessionId: state?.sdkSessionId || null,
      configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
      recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
    });
  });

  // Performs one relaunch. Always runs under sessionLaunchMutex, so it may assume
  // no other launch-path request is interleaving with it.
  async function runWorkspaceRootRelaunch({ conversationId, sdkSessionId, rootPath }) {
    const worker = sessionWorkerSupervisor?.getWorkerState?.(sdkSessionId)
      || sessionWorkerRegistry?.getWorker?.(sdkSessionId)
      || null;
    const activeQueueCount = Number(countActiveConversationQueueRows.get(conversationId)?.count || 0);
    // A session that is not 'ready' can still own a live process (status 'error',
    // or no registry entry at all). Detect that, or the stop is skipped and the
    // launch silently reuses the old process in the old directory.
    let liveProcessDetected = false;
    try {
      liveProcessDetected = !!(await sessionWorkerProcessInspector?.findProcessForSessionAsync?.(sdkSessionId, { fresh: true }));
    } catch (error) {
      // An unreadable list must not pass for "no process": the relaunch would
      // start a second CLI next to the one it could not see.
      return { ok: false, statusCode: 409, error: `process-list-unreadable: ${error?.message || error}` };
    }
    const eligibility = evaluateWorkspaceRootRelaunch({
      workerStatus: worker?.status,
      activeQueueCount,
      workerPidAlive: isPidAlive(worker?.pid),
      liveProcessDetected,
    });
    if (!eligibility.ok) {
      return { statusCode: eligibility.statusCode, body: { ok: false, code: 'relaunch-not-eligible', error: eligibility.error } };
    }

    const updateResult = updateConversationConfiguredWorkspaceRoot({ conversationId, rootPath });
    if (!updateResult?.ok) {
      return { statusCode: 400, body: { ok: false, error: updateResult?.error || 'Failed to update conversation workspace root' } };
    }
    const state = updateResult.state || null;

    let stoppedPids = [];
    if (eligibility.stopWorker) {
      const stopped = await stopIdleWorkspaceRootSession({
        sdkSessionId,
        worker,
        sessionWorkerSupervisor,
        sessionWorkerRegistry,
        sessionWorkerProcessInspector,
        stopOverrides: sessionWorkerStopOverrides,
      });
      if (!stopped.ok) {
        // Do not launch on top of a process we could not kill. The CWD is saved,
        // so the next clean launch will pick it up.
        return {
          statusCode: stopped.timedOut ? 409 : 500,
          body: {
            ok: false,
            code: stopped.timedOut ? 'worker-stop-timeout' : 'worker-stop-failed',
            remainingPids: stopped.remainingPids || [],
            configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
            workspaceRootApplied: false,
            error: stopped.timedOut
              ? 'Could not stop the running CLI. The CWD is saved for the next launch.'
              : (stopped.error || 'Failed to stop the running CLI'),
          },
        };
      }
      stoppedPids = stopped.stoppedPids || [];
    }

    // Every process is verified dead, so lift the kill block exactly once, here,
    // rather than letting the launch helper clear it as a side effect.
    sessionWorkerSupervisor?.clearRestartSchedule?.(sdkSessionId, { resetKilledMarker: true });

    const launched = await launchWorkspaceRootSession(
      runtimeState,
      sessionWorkerSupervisor,
      sdkSessionId,
      sessionWorkerRegistry,
      {
        allowProcessReuse: false,
        resetKilledMarker: false,
        requireStoppedWorker: false,
        failCopilotRowsWithoutLaunch: deps.failCopilotRowsWithoutLaunch,
      },
    );
    if (!launched?.ok) {
      return {
        statusCode: launched?.statusCode || 409,
        body: {
          ok: false,
          code: launched?.code || 'relaunch-failed',
          configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
          workspaceRootApplied: false,
          error: launched?.error || 'Failed to relaunch the CLI',
        },
      };
    }

    // Belt and braces: if a process was reused anyway, or the "new" pid is one we
    // just tried to kill, the requested directory did not take. Say so.
    const launchedPid = Number(launched.worker?.pid) || null;
    // `state` was resolved before the stop, so its runtime value still
    // describes the CLI we just killed. It is only meaningful for the reuse
    // check — never as the directory we report back.
    const preLaunchRootPath = state?.runtimeWorkspaceRootPath || '';
    const reusedExistingProcess = launched.reused === true
      || (launchedPid !== null && stoppedPids.includes(launchedPid));
    const reuseCheck = reusedExistingProcess
      ? evaluateReuseCwdMismatch({ requestedRootPath: rootPath, observedRootPath: preLaunchRootPath })
      : { comparable: false, mismatch: false };
    const workspaceRootApplied = !reusedExistingProcess && !(reuseCheck.comparable && reuseCheck.mismatch);

    // A fresh process launched in the requested directory, so the stale runtime
    // root must be replaced now.
    // Waiting for the new CLI leaves every client showing the old CWD in the
    // header and the file explorer until the next turn.
    let effectiveState = state;
    if (workspaceRootApplied) {
      const learned = typeof learnConversationWorkspaceRoot === 'function'
        ? learnConversationWorkspaceRoot({
          conversationId,
          sdkSessionId,
          rootPath,
          seedConfigured: false,
        })
        : null;
      effectiveState = (learned?.ok && learned.state)
        ? learned.state
        // The persist call is the only thing that can fail here, and the root was
        // already validated as an existing directory. Report the applied CWD
        // anyway so clients never render the directory of the process we killed.
        : {
          ...(state || {}),
          runtimeWorkspaceRootPath: rootPath,
          runtimeWorkspaceRootName: workspaceRootDisplayName(rootPath),
          currentWorkspaceRootPath: rootPath,
          currentWorkspaceRootName: workspaceRootDisplayName(rootPath),
        };
    }

    const workspaceHints = workspaceRootPayload();
    io.emit('conversation_workspace_root_updated', {
      conversationId,
      sdkSessionId,
      configuredWorkspaceRootPath: effectiveState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: effectiveState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: effectiveState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: effectiveState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: effectiveState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: effectiveState?.currentWorkspaceRootName || null,
      workspaceRootApplied,
      recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        conversationId,
        sdkSessionId,
        ...effectiveState,
        relaunched: workspaceRootApplied,
        workspaceRootApplied,
        reusedExistingProcess,
        stoppedPids,
        launchedPid,
        ...(workspaceRootApplied ? {} : {
          warning: 'cwd-not-applied',
          activeWorkspaceRootPath: preLaunchRootPath || null,
          message: 'CWD saved for the next launch, but the running CLI kept its current directory.',
        }),
        worker: launched.worker || null,
        lifecycle: launched.lifecycle || null,
      },
    };
  }

  app.post('/api/conversation/:id/relaunch-with-workspace-root', auth, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const rootPath = readWorkspaceRootPathFromBody(req.body);
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    if (!rootPath) return res.status(400).json({ error: 'Missing rootPath' });
    if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Conversation workspace updates are unavailable' });
    }

    const validated = validateRequestedWorkspaceRoot(rootPath, { allowList: workspaceRootAllowList });
    if (!validated.ok) {
      return res.status(validated.code === 'root-path-not-allowed' ? 403 : 400)
        .json({ ok: false, code: validated.code, error: validated.error });
    }

    const workspaceState = resolveConversationWorkspaceState?.({ conversationId }) || null;
    const sdkSessionId = String(workspaceState?.sdkSessionId || '').trim();
    if (!sdkSessionId) {
      return res.status(409).json({ error: 'Open a conversation with a bound session before relaunching.' });
    }

    const rateLimited = consumeWorkspaceRootRateLimit(sdkSessionId, req);
    if (!rateLimited.ok) {
      res.set('Retry-After', String(rateLimited.retryAfterSeconds));
      return res.status(429).json({ ok: false, code: 'rate-limited', error: 'Too many relaunch requests. Try again shortly.' });
    }

    const requestKey = buildRelaunchRequestKey({
      conversationId,
      rootPath: validated.realPath,
      idempotencyKey: req.headers?.['idempotency-key'] || req.body?.idempotencyKey,
    });

    // A duplicated request (mobile ghost tap, a second tab, a retried fetch) must
    // replay one result rather than driving a second stop/spawn cycle.
    const pending = relaunchCoalescer.peek(sdkSessionId, requestKey);
    if (pending.state === 'in-flight') {
      const shared = await pending.promise;
      return res.status(shared.statusCode).json({ ...shared.body, coalesced: true });
    }
    if (pending.state === 'cached') {
      return res.status(pending.result.statusCode).json({ ...pending.result.body, coalesced: true, cached: true });
    }
    if (pending.state === 'busy') {
      return res.status(409).json({
        ok: false,
        code: 'relaunch_in_progress',
        sdkSessionId,
        retryAfterMs: RELAUNCH_COALESCE_WINDOW_MS,
        error: 'A different CWD change is already running for this session.',
      });
    }

    const { settle } = relaunchCoalescer.begin(sdkSessionId, requestKey);
    let outcome;
    try {
      const attempt = await sessionLaunchMutex.tryRunExclusive(sdkSessionId, () => runWorkspaceRootRelaunch({
        conversationId,
        sdkSessionId,
        rootPath: validated.realPath,
      }));
      outcome = attempt.busy
        ? {
          statusCode: 409,
          body: {
            ok: false,
            code: 'relaunch_in_progress',
            sdkSessionId,
            retryAfterMs: RELAUNCH_COALESCE_WINDOW_MS,
            error: 'A different CWD change is already running for this session.',
          },
        }
        : attempt.result;
    } catch (error) {
      outcome = { statusCode: 500, body: { ok: false, code: 'relaunch-error', error: error?.message || 'Failed to relaunch the CLI' } };
    }
    relaunchCoalescer.settle(sdkSessionId, requestKey, outcome);
    settle(outcome);
    return res.status(outcome.statusCode).json(outcome.body);
  });
}
