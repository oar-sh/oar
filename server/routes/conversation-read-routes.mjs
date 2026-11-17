'use strict';

// The conversation list and read routes (the list, the runtime sessions, the
// folder attribution, the context, message search, the history refresh, one
// conversation's page and its pins), registered by registerSessionsRoutes.
import fs from 'fs';
import path from 'path';
import {
  normalizeConversationHistoryLimit,
  normalizeConversationTimestampMs,
} from '../services/conversation-history-page.mjs';
import { MESSAGE_PIN_LIMIT } from '../services/message-pin-list.mjs';
import { readMayCreateSessions, readPlanOnly } from '../services/conversation-preferences-service.mjs';
import { parseAutoCompactWindow } from '../../shared/auto-compact-window.mjs';
import { CLAUDE_ATTRIBUTION_MODES, DEFAULT_CLAUDE_ATTRIBUTION_MODE, claudeAttributionModelLabel, claudeAttributionTrailer, normalizeClaudeAttributionMode, resolveClaudeAttributionMode } from '../../shared/claude-attribution.mjs';
import { parseThinkingDisplay, parseThinkingEnabled } from '../../shared/claude-thinking.mjs';
import { mapUsageSnapshotRow } from '../services/usage-snapshot-helpers.mjs';
import { readStoredClaudeContextUsage, resolveAutoCompactWindowStatus } from '../services/claude-context-usage.mjs';
import { buildContextUsageView } from '../services/context-usage-view.mjs';
import { withGeneratedImageFiles } from '../services/generated-image-files.mjs';
import { normalizeWorkspaceRootKey } from '../services/workspace-root-path-policy.mjs';
import { parseRemoteRelayOriginJson } from '../repositories/remote-relay-repository.mjs';
import { conversationGroupPosition, conversationGroupRole, groupActivityTimes, pageConversationRows } from '../public/app/conversation-group-order.mjs';
import { detailsVersion, parseHeldDetailsParam, thoughtFingerprint } from '../public/app/held-details.mjs';
import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import {
  buildConversationCloudPayload,
  isClaudeCloudProviderType,
} from '../services/claude-cloud-session-service.mjs';
import {
  DEFAULT_TASK_STALL_MINUTES,
} from '../../shared/task-output-text.mjs';
import {
  buildConversationMessages,
  createConversationGroupHelpers,
  parseDraftAttachmentsColumn,
  resolveConversationPreferences,
  resolveConversationTitle,
  selectConversationHistoryPage,
} from './sessions-helpers.mjs';

/**
 * A folder's attribution override update: `{ path, attributionMode }` with
 * the mode one of the three, or null to inherit the provider setting again.
 */
export function parseWorkspaceRootAttributionUpdate(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const path = String(payload.path || '').trim();
  if (!path) return { ok: false, error: 'Missing path' };
  if (!Object.prototype.hasOwnProperty.call(payload, 'attributionMode')) {
    return { ok: false, error: 'Missing attributionMode (oar, vanilla, off, or null to inherit)' };
  }
  if (payload.attributionMode === null || payload.attributionMode === '') return { ok: true, path, attributionMode: null };
  const attributionMode = normalizeClaudeAttributionMode(payload.attributionMode);
  if (!attributionMode) {
    return { ok: false, error: `Invalid attribution mode (one of ${CLAUDE_ATTRIBUTION_MODES.join(', ')}, or null to inherit)` };
  }
  return { ok: true, path, attributionMode };
}

/** What a folder's Claude sessions will say, given the provider setting and the folder's own choice. */
export function buildWorkspaceRootAttributionPayload({ path = '', folderMode = null, providerMode = null, model = '' } = {}) {
  const effectiveMode = resolveClaudeAttributionMode({ providerMode, folderMode });
  return {
    path: String(path || '').trim(),
    attributionMode: normalizeClaudeAttributionMode(folderMode),
    providerMode: normalizeClaudeAttributionMode(providerMode) || DEFAULT_CLAUDE_ATTRIBUTION_MODE,
    effectiveMode,
    attributionModes: [...CLAUDE_ATTRIBUTION_MODES],
    attributionExample: effectiveMode === 'oar'
      ? claudeAttributionTrailer(claudeAttributionModelLabel(String(model || 'claude-sonnet-5')))
      : (effectiveMode === 'off' ? '' : null),
  };
}

export function buildConversationSessionRootPayload({
  conversationId = '',
  sdkSessionId = '',
  title = '',
  resolveSessionStateRoot = null,
  providerType = '',
  claudeNativeSessionId = '',
  workspaceRootPath = '',
  resolveClaudeSessionRoot = null,
  // The same Claude Code layout, in the DeepSeek workers' own config dir.
  resolveDeepSeekSessionRoot = null,
  resolveCursorSessionRoot = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim() || String(conversationId || '').trim();
  // A Claude Cloud session lives in Anthropic's cloud: there is no session
  // folder on this host, and it must not be looked up as a Copilot one.
  if (isClaudeCloudProviderType(providerType)) return null;
  // Cursor sessions have no ~/.copilot/session-state entry either — their
  // on-disk footprint is the worker's per-session agent store, created on the
  // first turn.
  if (String(providerType || '').trim().toLowerCase() === 'cursor') {
    if (!sid || typeof resolveCursorSessionRoot !== 'function') return null;
    const cursorRoot = resolveCursorSessionRoot({ sdkSessionId: sid });
    if (!cursorRoot?.sessionRootPath) return null;
    return {
      sdkSessionId: sid,
      sessionRootPath: cursorRoot.sessionRootPath,
      sessionRootName: cursorRoot.sessionRootName || 'Session',
    };
  }
  // Claude sessions have no ~/.copilot/session-state entry — only the Copilot
  // CLI creates those — so they resolve against the Agent SDK's own layout and
  // never fall through to the branch below. A Claude API session is a Claude
  // session on an API key, in the same place.
  const claudeCodeProvider = String(providerType || '').trim().toLowerCase();
  if (claudeCodeProvider === 'claude' || claudeCodeProvider === 'deepseek' || claudeCodeProvider === 'claude-api') {
    const nativeSessionId = String(claudeNativeSessionId || '').trim();
    const resolveRoot = claudeCodeProvider === 'deepseek' ? resolveDeepSeekSessionRoot : resolveClaudeSessionRoot;
    if (!nativeSessionId || typeof resolveRoot !== 'function') return null;
    const claudeRoot = resolveRoot({
      claudeNativeSessionId: nativeSessionId,
      workspaceRootPath: String(workspaceRootPath || '').trim(),
    });
    if (!claudeRoot?.sessionRootPath) return null;
    return {
      sdkSessionId: sid,
      sessionRootPath: claudeRoot.sessionRootPath,
      sessionRootName: claudeRoot.sessionRootName || 'Session',
    };
  }
  if (!sid || typeof resolveSessionStateRoot !== 'function') return null;
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) return null;
  const rootPath = path.join(root, sid);
  if (!fs.existsSync(rootPath)) return null;
  let stat = null;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  return {
    sdkSessionId: sid,
    sessionRootPath: rootPath,
    sessionRootName: 'Session',
  };
}

function normalizeConversationTimestampIso(value, fallback = null) {
  const ms = normalizeConversationTimestampMs(value);
  if (!ms) return fallback;
  return new Date(ms).toISOString();
}

export function normalizeMessageSearchLimit(value, fallback = 30) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(100, Math.max(1, Math.trunc(Number(fallback) || 30)));
  return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

export function normalizeMessageSearchOffset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

export function buildMessageSearchMatchQuery(rawQuery = '') {
  const query = String(rawQuery || '').trim();
  if (!query) return '';
  const tokens = query
    .split(/\s+/)
    .map((part) => part.replace(/"/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map((part) => `"${part}"*`).join(' AND ');
}

const DEFAULT_CONVERSATION_LIST_LIMIT = 40;
const MAX_CONVERSATION_LIST_LIMIT = 100;

export function normalizeConversationListLimit(value, fallback = DEFAULT_CONVERSATION_LIST_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(MAX_CONVERSATION_LIST_LIMIT, Math.max(1, Number(fallback) || DEFAULT_CONVERSATION_LIST_LIMIT));
  }
  return Math.min(MAX_CONVERSATION_LIST_LIMIT, Math.max(1, Math.trunc(parsed)));
}

/**
 * One page of the conversation list, newest first, with session groups kept
 * whole: the order and the cursor are those of conversation-group-order.mjs,
 * which the sidebar uses too. `groups` is the `Map<id, group>` of the rows'
 * groups (the head of each group is needed for the order inside it).
 */
export function selectConversationListPage(rows = [], {
  limit = DEFAULT_CONVERSATION_LIST_LIMIT,
  beforeConversationId = '',
  beforeUpdatedAt = '',
  beforeGroupId = '',
  groups = null,
} = {}) {
  return pageConversationRows(rows, groups, {
    limit: normalizeConversationListLimit(limit),
    beforeConversationId,
    beforeUpdatedAt,
    beforeGroupId,
  });
}

export function registerConversationReadRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    relayThoughtsForResponse,
    subagentRunsForResponse,
    workflowRunsForResponse,
    previewCardsForResponse,
    buildContextResponseText,
    readContextFromSessionEvents,
    inFlightStateForConversation,
    backgroundTaskStore,
    listConversationPreviews,
    resolveConversationWorkspaceState,
    sessionHistoryRefreshService,
    sdkSessionImportService,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    sessionWorkerRegistry,
    resolveSessionStateRoot,
  } = deps;
  const {
    describeSessionActivity,
    resolveConversationByIdOrSdkSessionId,
    selectConversationHistoryPageRows,
    usageSnapshotsForPage,
    resendIndexForPage,
    listConversationPins,
    listConversationHiddenMessages,
    conversationPinRevision,
    bumpConversationPinRevision,
    conversationHiddenMessagesRevision,
    getClaudeProviderSettings,
    conversationGroups,
    remoteRelayInbound,
    backgroundWorkView,
    sessionActivityTracker,
    resolveClaudeSessionRoot,
    resolveDeepSeekSessionRoot,
    resolveCursorSessionRoot,
    getTaskStallMinutes,
    usageLimitPauseService,
    claudeBillingSwitchService,
  } = shared;
  const { groupSummaryPayload } = createConversationGroupHelpers({ io, conversationGroups });
  let listRunningRunConversations = null;
  try {
    listRunningRunConversations = db.prepare(`SELECT DISTINCT conversation_id FROM subagent_runs WHERE status = 'running'`);
  } catch {}

  /** The conversations that may be busy: a turn queued, a run or task known. */
  function activityCandidates(activeTurnConversationIds) {
    const ids = new Set(activeTurnConversationIds);
    for (const id of sessionActivityTracker?.knownConversationIds?.() || []) ids.add(String(id));
    try {
      for (const row of listRunningRunConversations?.all?.() || []) ids.add(String(row.conversation_id || ''));
    } catch {}
    return ids;
  }

  const getConversationUsageSnapshotAggregate = db.prepare(`
    SELECT
      COUNT(*) AS snapshot_count,
      MAX(captured_at) AS captured_at,
      SUM(CASE WHEN plan_delta_used IS NOT NULL AND plan_delta_used > 0 THEN plan_delta_used ELSE 0 END) AS plan_credits_used,
      MAX(plan_entitlement) AS plan_entitlement,
      SUM(CASE WHEN premium_delta_used IS NOT NULL AND premium_delta_used > 0 THEN premium_delta_used ELSE 0 END) AS premium_credits_used,
      SUM(CASE WHEN premium_delta_used IS NOT NULL AND premium_delta_used > 0 THEN 1 ELSE 0 END) AS premium_request_count
    FROM message_usage_snapshots
    WHERE conversation_id = ?
  `);

  /**
   * The `group` field of a single conversation payload: the summary and the
   * conversation's role. The live members, with what each is doing, only
   * when asked for (`groupMembers=1`, the relay_tool's read_session)
   * and never for a paired relay's agent: the browser does not read them,
   * and archived members' titles stay on this relay.
   */
  function conversationGroupPayload(conversationId, req = null) {
    const group = conversationGroups?.groupOfConversation?.(conversationId) || null;
    if (!group) return null;
    const summary = groupSummaryPayload(group);
    const payload = {
      ...summary,
      role: conversationId === group.parentConversationId ? 'head' : 'member',
    };
    const wantsMembers = String(req?.query?.groupMembers || '').trim() === '1';
    const request = req ? readRemoteRelayRequest(req, remoteRelayInbound) : { remote: false };
    if (wantsMembers && (!request.remote || request.local === true)) {
      payload.members = (conversationGroups.membersOf(group.id) || [])
        .filter((member) => member.archived !== true)
        .slice(0, 50)
        .map((member) => ({
          id: member.id,
          title: resolveConversationTitle({ title: member.title, titleSource: 'auto' }),
          role: member.id === group.parentConversationId ? 'head' : 'member',
          state: describeSessionActivity(member.id)?.sessionState || 'idle',
        }));
    }
    return payload;
  }

  /** A conversation row's place in its group's hand order; null outside a group. */
  function conversationGroupPositionOf(conv) {
    if (!String(conv?.group_id || '').trim() || !conversationGroups?.getGroup?.(conv.group_id)) return null;
    return conversationGroupPosition(conv);
  }

  /** The `cloud` field of a conversation payload; null unless it is a cloud one. */
  function conversationCloudPayload(conversation, runtimeSession) {
    return buildConversationCloudPayload({
      cloudSourceJson: conversation?.cloud_source_json,
      costUsd: runtimeSession?.claude_cloud_cost_usd,
    });
  }

  function resolveConversationUsageSummary({ conversationId } = {}) {
    const convId = String(conversationId || '').trim();
    if (!convId) return null;
    const aggregate = getConversationUsageSnapshotAggregate.get(convId) || null;
    const snapshotCount = Number(aggregate?.snapshot_count || 0);
    if (!Number.isFinite(snapshotCount) || snapshotCount <= 0) return null;
    const planCreditsUsed = Number(aggregate?.plan_credits_used);
    const planEntitlement = Number(aggregate?.plan_entitlement);
    const planMonthlyPercentUsed = Number.isFinite(planCreditsUsed) && Number.isFinite(planEntitlement) && planEntitlement > 0
      ? Math.max(0, (planCreditsUsed / planEntitlement) * 100)
      : null;
    const premiumCreditsUsed = Number(aggregate?.premium_credits_used);
    const premiumRequestCount = Number(aggregate?.premium_request_count);
    const normalizedPlanCreditsUsed = Number.isFinite(planCreditsUsed) ? Math.max(0, planCreditsUsed) : null;
    const normalizedPremiumCreditsUsed = Number.isFinite(premiumCreditsUsed) ? Math.max(0, premiumCreditsUsed) : null;
    const estimatedAicUsed = (
      normalizedPlanCreditsUsed != null && normalizedPlanCreditsUsed > 0
        ? normalizedPlanCreditsUsed
        : (normalizedPremiumCreditsUsed != null && normalizedPremiumCreditsUsed > 0
          ? normalizedPremiumCreditsUsed
          : null)
    );
    return {
      shutdownAt: null,
      aicUsed: estimatedAicUsed,
      totalPremiumRequests: null,
      totalNanoAiu: null,
      totalApiDurationMs: null,
      requestCount: null,
      source: 'usage-snapshots',
      estimated: true,
      capturedAt: aggregate?.captured_at || null,
      planCreditsUsed: normalizedPlanCreditsUsed,
      planEntitlement: Number.isFinite(planEntitlement) ? planEntitlement : null,
      planMonthlyPercentUsed,
      premiumCreditsUsed: normalizedPremiumCreditsUsed,
      premiumRequestEstimate: Number.isFinite(premiumRequestCount) ? Math.max(0, Math.trunc(premiumRequestCount)) : null,
    };
  }

  // GET /api/conversations — list all conversations
  app.get('/api/conversations', auth, (req, res) => {
    // `archived=true` lists both, `archived=only` the archived ones (the
    // sidebar's Archived view), nothing: the live ones.
    const archivedMode = String(req.query.archived || '').trim().toLowerCase();
    const limit = normalizeConversationListLimit(req.query.limit, DEFAULT_CONVERSATION_LIST_LIMIT);
    const beforeConversationId = String(req.query.beforeConversationId || '').trim();
    const beforeUpdatedAt = String(req.query.beforeUpdatedAt || '').trim();
    const beforeGroupId = String(req.query.beforeGroupId || '').trim();
    const rows = stmts.listConvs.all(archivedMode === 'true' ? 1 : 0, archivedMode === 'only' ? 1 : 0);
    // The groups of the listed rows: the order inside a group needs its head.
    const groups = conversationGroups?.listGroupsByIds?.(rows.map((row) => row?.group_id)) || new Map();
    // The time a row sorts by (its group's newest row): a caller that pages
    // by a row that is gone by then continues from this, not the row's own.
    const activityTimes = groupActivityTimes(rows);
    const page = selectConversationListPage(rows, {
      limit,
      beforeConversationId,
      beforeUpdatedAt,
      beforeGroupId,
      groups,
    });
    const activeTurnConversationIds = new Set(
      (stmts.listConversationIdsWithActiveQueue?.all() || [])
        .map((row) => String(row?.conversation_id || '').trim())
        .filter(Boolean),
    );
    const busyCandidates = sessionActivityTracker ? activityCandidates(activeTurnConversationIds) : null;
    const conversations = page.rows.map((r) => {
      const sid = String(r.sdk_session_id || '').trim();
      const workspaceState = typeof resolveConversationWorkspaceState === 'function'
        ? resolveConversationWorkspaceState({
          conversationId: r.id,
          sdkSessionId: sid,
          discoveredWorkspaceRootPath: '',
        })
        : null;
      const preferences = resolveConversationPreferences(r, {
        supportedRelayModes: SUPPORTED_RELAY_MODES,
        defaultRelayMode: DEFAULT_RELAY_MODE,
      });
      return {
        id:           r.id,
        sdkSessionId: sid || null,
        title:        resolveConversationTitle({ title: r.title, titleSource: r.title_source }),
        activeTurn:   activeTurnConversationIds.has(String(r.id || '').trim()),
        ...(describeSessionActivity(r.id, busyCandidates) || {}),
        archived:     Number(r.archived || 0) === 1,
        compactedInto: r.compacted_into || null,
        compactedFrom: r.compacted_from || null,
        runtimeSessionId: r.runtime_session_id || null,
        runtimeSessionStrategy: r.runtime_strategy || null,
        runtimeSessionStatus: r.runtime_status || null,
        runtimeSessionLastUsedAt: r.runtime_last_used_at || null,
        runtimeModel: r.runtime_model || null,
        runtimeProviderType: String(r.runtime_provider_type || 'github').trim().toLowerCase() || 'github',
        runtimeProviderModel: r.runtime_provider_model || null,
        configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
        createdAt:    normalizeConversationTimestampIso(r.created_at, r.created_at),
        updatedAt:    normalizeConversationTimestampIso(r.updated_at, r.updated_at),
        messageCount: Number(r.message_count || 0),
        preferredRelayMode: preferences.preferredRelayMode,
        preferredModel: preferences.preferredModel,
        preferredReasoningEffort: preferences.preferredReasoningEffort,
        draftText: String(r.draft_text || ''),
        draftAttachments: parseDraftAttachmentsColumn(r.draft_attachments),
        draftUpdatedAt: r.draft_updated_at || null,
        draftUpdatedByClientId: r.draft_updated_by_client_id || null,
        // Set on conversations another relay's agent created ("via <relay>").
        origin: parseRemoteRelayOriginJson(r.origin_json),
        // The owner let this agent-started session's agents start sessions.
        mayCreateSessions: readMayCreateSessions(r),
        planOnly: readPlanOnly(r),
        // Set on Claude Cloud conversations: repository, branch, session link.
        cloud: buildConversationCloudPayload({
          cloudSourceJson: r.cloud_source_json,
          costUsd: r.runtime_claude_cloud_cost_usd,
        }),
        // Session group: its id and whether this row is the group's head.
        groupId: groups.has(String(r.group_id || '')) ? String(r.group_id) : null,
        groupRole: groups.has(String(r.group_id || '')) ? conversationGroupRole({ id: r.id, groupId: r.group_id }, groups) : null,
        // Its place in the group's hand order; null for the head, for a
        // group nobody reordered, and outside a group.
        groupPosition: groups.has(String(r.group_id || '')) ? conversationGroupPosition(r) : null,
        activityAt: (() => {
          const own = normalizeConversationTimestampMs(r.updated_at);
          const ms = groups.has(String(r.group_id || '')) ? Math.max(activityTimes.get(String(r.group_id)) || 0, own) : own;
          return ms ? new Date(ms).toISOString() : normalizeConversationTimestampIso(r.updated_at, r.updated_at);
        })(),
      };
    });
    // The groups that have a row on this page, with what the sidebar's head
    // row shows without the members' rows.
    const groupsPayload = {};
    for (const groupId of new Set(page.rows.map((row) => String(row?.group_id || '')).filter((id) => groups.has(id)))) {
      groupsPayload[groupId] = groupSummaryPayload(groups.get(groupId));
    }
    // The owner's groups an agent emptied have no row to come with: the live
    // list's first page brings them, so the sidebar shows them as empty
    // groups the owner can rename or dissolve.
    if (archivedMode !== 'only' && !beforeConversationId) {
      for (const group of conversationGroups?.listKeptEmptyGroups?.() || []) {
        groupsPayload[group.id] = groupSummaryPayload(group);
      }
    }

    return res.json({
      conversations,
      pageInfo: page.pageInfo,
      groups: groupsPayload,
    });
  });

  app.get('/api/sessions', auth, (req, res) => {
    const sessions = stmts.listRuntimeSessions.all().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title || row.conversation_id,
      strategy: row.strategy || null,
      runtimeKey: row.runtime_key || null,
      model: row.model || null,
      status: row.status || null,
      createdAt: row.created_at || null,
      lastUsedAt: row.last_used_at || null,
      conversationUpdatedAt: row.conversation_updated_at || null,
    }));
    res.json({ sessions });
  });

  /**
   * Resolve the context payload for a conversation id or sdk_session_id.
   *
   * Claude sessions are served from the breakdown their worker reported after
   * the last turn; tailing Copilot's events.jsonl can only ever fail for them.
   * Both providers get the same `contextUsage` view so one renderer serves both.
   */
  function resolveContextPayload(lookupId) {
    // Prefer canonical sdk_session_id routing when available; keep conversation-id lookup for compatibility.
    const runtimeSessionBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(lookupId) || null;
    const runtimeSession = runtimeSessionBySdkSessionId
      || stmts.getRuntimeSessionByConversation.get(lookupId)
      || null;
    const copilotSessionId = String(runtimeSessionBySdkSessionId?.sdk_session_id || runtimeSession?.sdk_session_id || '').trim() || null;
    const providerType = String(runtimeSession?.provider_type || 'github').trim().toLowerCase();
    // The cursor and grok workers post the same Claude-shaped usage blob, and
    // so does the Claude Cloud worker (the cloud session's context and token
    // usage), and so does the DeepSeek worker (the Claude one, pointed at
    // DeepSeek), and so does the Claude API one (the Claude worker on an API
    // key), so all six providers share the stored reader.
    const usesStoredContextUsage = providerType === 'claude' || providerType === 'cursor'
      || providerType === 'grok' || providerType === 'claude-cloud' || providerType === 'deepseek'
      || providerType === 'claude-api';

    const parsed = usesStoredContextUsage
      ? (() => {
        const stored = readStoredClaudeContextUsage(runtimeSession);
        return {
          snapshot: stored.snapshot,
          contextUsage: stored.contextUsage,
          modelContextLimit: stored.modelContextLimit,
          eventsPath: null,
          error: stored.snapshot
            ? null
            : 'No context data captured yet for this session; it is recorded when a turn completes.',
        };
      })()
      : {
        ...readContextFromSessionEvents(
          runtimeSession?.id || null,
          copilotSessionId || runtimeSession?.runtime_key || runtimeSession?.id || null,
        ),
        contextUsage: null,
      };

    // The modal renders the stored preference next to the measured threshold,
    // so both come from this one fetch. The lookup id may be an sdk_session_id.
    const conversationRow = resolveConversationByIdOrSdkSessionId(
      String(runtimeSession?.conversation_id || '').trim() || lookupId,
    );
    const autoCompactWindow = parseAutoCompactWindow(conversationRow?.auto_compact_window);
    // Only the local Claude worker (and the DeepSeek and Claude API ones, the
    // same runner) runs a CLI whose window the slider sets; it reports that
    // CLI on its heartbeat's steering snapshot.
    const windowStatus = resolveAutoCompactWindowStatus({
      storedWindow: autoCompactWindow,
      steering: (providerType === 'claude' || providerType === 'deepseek' || providerType === 'claude-api') && copilotSessionId
        ? sessionWorkerRegistry?.getWorker?.(copilotSessionId)?.steering || null
        : null,
    });

    return {
      conversationId: lookupId,
      // The lookup id above may be an sdk_session_id (that echo is load-bearing
      // for the modal's refresh handle), so the id a preferences PATCH needs is
      // reported separately.
      resolvedConversationId: conversationRow?.id || null,
      autoCompactWindow,
      activeAutoCompactWindow: windowStatus.activeAutoCompactWindow,
      autoCompactWindowDeferred: windowStatus.autoCompactWindowDeferred,
      modelContextLimit: parsed.modelContextLimit ?? null,
      thinkingEnabled: parseThinkingEnabled(conversationRow?.thinking_enabled),
      thinkingDisplay: parseThinkingDisplay(conversationRow?.thinking_display),
      // What this folder's Claude commits say (the 🧠 modal's override row).
      // A Claude Cloud chat has the row when it was started from a folder,
      // with its own model in the example.
      ...(providerType === 'claude' || providerType === 'claude-api'
        ? { attribution: workspaceRootAttributionFor(conversationRow) }
        : {}),
      ...(providerType === 'claude-cloud' && cloudConversationFolder(conversationRow)
        ? {
          attribution: workspaceRootAttributionFor(conversationRow, '', {
            model: runtimeSession?.provider_model || runtimeSession?.model || '',
          }),
        }
        : {}),
      runtimeSessionId: runtimeSession?.id || null,
      copilotSessionId,
      providerType: usesStoredContextUsage ? providerType : 'github',
      snapshot: parsed.snapshot || null,
      contextUsage: buildContextUsageView({
        snapshot: parsed.snapshot,
        contextUsage: parsed.contextUsage,
      }),
      eventsPath: parsed.eventsPath || null,
      error: parsed.error || null,
      text: buildContextResponseText({
        snapshot: parsed.snapshot,
        runtimeSession,
        conversationId: lookupId,
        eventsPath: parsed.eventsPath,
        error: parsed.error,
      }),
    };
  }

  // --- Per-folder commit attribution (shared/claude-attribution.mjs) -----
  function workspaceRootSettingsRow(rootPath) {
    const root = String(rootPath || '').trim();
    if (!root || typeof stmts?.getWorkspaceRootSettings?.get !== 'function') return null;
    try {
      return stmts.getWorkspaceRootSettings.get(normalizeWorkspaceRootKey(root)) || null;
    } catch {
      return null;
    }
  }

  /** The folder a Claude Cloud chat was started from, if it was started from one. */
  function cloudConversationFolder(conversationRow) {
    return String(conversationRow?.runtime_workspace_root_path || conversationRow?.configured_workspace_root_path || '').trim();
  }

  function workspaceRootAttributionFor(conversationRow, explicitPath = '', { model = '' } = {}) {
    const path = String(explicitPath
      || conversationRow?.runtime_workspace_root_path
      || conversationRow?.configured_workspace_root_path
      || '').trim();
    const provider = typeof getClaudeProviderSettings === 'function' ? getClaudeProviderSettings() : {};
    return buildWorkspaceRootAttributionPayload({
      path,
      folderMode: workspaceRootSettingsRow(path)?.attribution_mode || null,
      providerMode: provider?.attributionMode,
      model: String(model || '').trim() || provider?.model,
    });
  }

  app.get('/api/workspace-root/attribution', auth, (req, res) => {
    const path = String(req.query.path || '').trim();
    if (!path) return res.status(400).json({ error: 'Missing path' });
    res.json({ ok: true, ...workspaceRootAttributionFor(null, path) });
  });

  app.post('/api/workspace-root/attribution', auth, (req, res) => {
    const parsed = parseWorkspaceRootAttributionUpdate(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (typeof stmts?.upsertWorkspaceRootAttribution?.run !== 'function') {
      return res.status(503).json({ error: 'Folder settings are unavailable' });
    }
    const key = normalizeWorkspaceRootKey(parsed.path);
    const now = new Date().toISOString();
    if (parsed.attributionMode === null) {
      stmts.deleteWorkspaceRootSettings.run(key);
    } else {
      stmts.upsertWorkspaceRootAttribution.run(key, parsed.path, parsed.attributionMode, now);
    }
    const payload = workspaceRootAttributionFor(null, parsed.path);
    try { io.emit('workspace_root_attribution_updated', payload); } catch {}
    res.json({ ok: true, ...payload });
  });

  app.get('/api/context/:conversationId', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    res.json(resolveContextPayload(conversationId));
  });

  app.get('/api/context', auth, (req, res) => {
    const explicitConversationId = String(req.query.conversationId || '').trim();
    if (explicitConversationId) {
      return res.json(resolveContextPayload(explicitConversationId));
    }
    return res.json({
      conversationId: null,
      runtimeSessionId: null,
      snapshot: null,
      contextUsage: null,
      eventsPath: null,
      error: 'Missing conversationId query parameter',
      text: 'Context is unavailable until a conversation is selected.',
    });
  });

  // GET /api/search/messages — search text across all conversation messages
  app.get('/api/search/messages', auth, (req, res) => {
    const rawQuery = String(req.query.q || '').trim();
    const limit = normalizeMessageSearchLimit(req.query.limit, 30);
    const offset = normalizeMessageSearchOffset(req.query.offset);
    if (!rawQuery || rawQuery.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }
    const matchQuery = buildMessageSearchMatchQuery(rawQuery);
    if (!matchQuery) {
      return res.status(400).json({ error: 'Search query is empty' });
    }
    const total = Number(stmts.searchMessagesCount.get(matchQuery)?.cnt || 0);
    const rows = stmts.searchMessagesPage.all(matchQuery, limit, offset);
    const results = rows.map((row) => ({
      conversationId: String(row?.conversation_id || '').trim(),
      conversationTitle: String(row?.conversation_title || '').trim() || 'Conversation',
      messageId: String(row?.message_id || '').trim(),
      role: String(row?.role || '').trim(),
      timestamp: String(row?.timestamp || '').trim() || null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      snippet: String(row?.snippet || '').trim() || String(row?.raw_text || '').trim().slice(0, 240),
    })).filter((item) => item.conversationId && item.messageId);
    const hasMore = (offset + results.length) < total;
    return res.json({
      query: rawQuery,
      results,
      pageInfo: {
        limit,
        offset,
        total,
        hasMore,
        nextOffset: hasMore ? (offset + results.length) : null,
      },
    });
  });

  // POST /api/conversation/:id/refresh-history — clear retrievable history and rebuild from SDK events
  app.post('/api/conversation/:id/refresh-history', auth, async (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    const limit = normalizeConversationHistoryLimit(req.query.limit, 20);
    const beforeMessageId = String(req.query.beforeMessageId || '').trim();
    const beforeTimestamp = String(req.query.beforeTimestamp || '').trim();
    const afterMessageId = String(req.query.afterMessageId || '').trim();
    const afterTimestamp = String(req.query.afterTimestamp || '').trim();
    const aroundMessageId = String(req.query.aroundMessageId || '').trim();
    if (stmts.getDeletedSdkSession.get(requestedId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const existingConversation = resolveConversationByIdOrSdkSessionId(requestedId);
    if (!existingConversation) return res.status(404).json({ error: 'Conversation not found' });
    const conversationId = String(existingConversation.id).trim();

    const idleState = sessionHistoryRefreshService.evaluateRefreshIdleState(conversationId);
    if (!idleState?.idle) {
      return res.status(409).json({
        error: 'Conversation is busy',
        code: String(idleState?.reason || 'conversation-busy'),
      });
    }

    try {
      const result = await sdkSessionImportService.refreshConversation(existingConversation);
      if (result.status === 'failed') throw new Error(result.error || 'Failed to refresh conversation history');
      if (result.status !== 'completed') {
        // Each skip gets its precise cause; the old blanket "already in
        // progress" told users a relay-owned conversation was merely busy and
        // to try again (audit #19).
        const skip = result.category === 'relay-owned'
          ? { statusCode: 409, code: 'relay-owned', message: 'Conversation history is owned by the relay and cannot be re-imported' }
          : result.category === 'bound-elsewhere'
            ? { statusCode: 409, code: 'bound-elsewhere', message: 'SDK session is bound to another conversation' }
            : result.reason === 'tombstoned'
              ? { statusCode: 404, code: 'not-found', message: 'Conversation not found' }
              : result.reason === 'importer-closing'
                ? { statusCode: 503, code: 'shutting-down', message: 'Relay is shutting down' }
                : { statusCode: 409, code: 'refresh-in-progress', message: 'Conversation history refresh is already in progress' };
        const error = new Error(skip.message);
        error.statusCode = skip.statusCode;
        error.code = skip.code;
        throw error;
      }
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        error: error?.message || 'Failed to refresh conversation history',
        ...(error?.code ? { code: error.code } : {}),
      });
    }

    const conv = stmts.getConv.get(conversationId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId) || null;
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
    });
    const preferences = resolveConversationPreferences(conv, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
    });
    const inFlight = inFlightStateForConversation(conversationId);
    const sessionUsageSummary = resolveConversationUsageSummary({ conversationId });
    const workspaceState = typeof resolveConversationWorkspaceState === 'function'
      ? resolveConversationWorkspaceState({
        conversationId,
        sdkSessionId: conv.sdk_session_id || conversationId,
        discoveredWorkspaceRootPath: '',
      })
      : null;
    const sessionRoot = buildConversationSessionRootPayload({
      conversationId,
      sdkSessionId: conv.sdk_session_id || conversationId,
      title: resolvedTitle,
      resolveSessionStateRoot,
      providerType: runtimeSession?.provider_type || '',
      claudeNativeSessionId: runtimeSession?.claude_native_session_id || '',
      workspaceRootPath: workspaceState?.currentWorkspaceRootPath || '',
      resolveClaudeSessionRoot,
      resolveDeepSeekSessionRoot,
      resolveCursorSessionRoot,
    });
    const dbMessages = stmts.getMessages.all(conversationId);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model, status
      FROM queue
      WHERE conversation_id = ?
    `).all(conversationId);
    const responseMessageToSourceId = new Map(
      queueRows
        .map((row) => [String(row?.response_message_id || '').trim(), String(row?.id || '').trim()])
        .filter(([responseMessageId, sourceMessageId]) => !!responseMessageId && !!sourceMessageId),
    );
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    const relayThoughtsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayThoughtsForResponse ? relayThoughtsForResponse(m.id) : []]),
    );
    const subagentRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, subagentRunsForResponse ? subagentRunsForResponse(m.id) : []]),
    );
    const workflowRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, workflowRunsForResponse ? workflowRunsForResponse(m.id) : []]),
    );
    const previewCardsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, previewCardsForResponse ? previewCardsForResponse(m.id) : []]),
    );
    const usageByResponseMessageId = new Map(
      (stmts.listMessageUsageSnapshotsByConversation?.all(conversationId) || [])
        .map((row) => [String(row?.response_message_id || '').trim(), mapUsageSnapshotRow(row)])
        .filter(([messageId, usage]) => !!messageId && !!usage),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments).map(hydrateAttachment).filter(Boolean),
      })),
      transcriptMessages: [],
      relayActivitiesByMessageId,
      relayThoughtsByMessageId,
      subagentRunsByMessageId,
      workflowRunsByMessageId,
      previewCardsByMessageId,
      responseMessageToSourceId,
      queueRows,
      usageByResponseMessageId,
    });
    messages = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const sourceMessageId = responseMessageToSourceId.get(String(message.id || '').trim()) || message.sourceMessageId || undefined;
      return sourceMessageId ? { ...message, sourceMessageId } : message;
    });
    const history = selectConversationHistoryPage(messages, {
      limit,
      beforeMessageId,
      beforeTimestamp,
      afterMessageId,
      afterTimestamp,
      aroundMessageId,
    });
    return res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      sessionRootPath: sessionRoot?.sessionRootPath || null,
      sessionRootName: sessionRoot?.sessionRootName || resolvedTitle || 'Session',
      configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
        sdkSessionId: runtimeSession.sdk_session_id || conv.sdk_session_id || conv.id,
        strategy: runtimeSession.strategy || null,
        status: runtimeSession.status || null,
        model: runtimeSession.model || null,
        providerType: String(runtimeSession.provider_type || 'github').trim().toLowerCase() || 'github',
        providerModel: runtimeSession.provider_model || null,
        createdAt: runtimeSession.created_at || null,
        lastUsedAt: runtimeSession.last_used_at || null,
      } : null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      sessionUsageSummary,
      inFlight,
      preferredRelayMode: preferences.preferredRelayMode,
      preferredModel: preferences.preferredModel,
      preferredReasoningEffort: preferences.preferredReasoningEffort,
      draftText: String(conv.draft_text || ''),
      draftAttachments: parseDraftAttachmentsColumn(conv.draft_attachments),
      draftUpdatedAt: conv.draft_updated_at || null,
      draftUpdatedByClientId: conv.draft_updated_by_client_id || null,
      origin: parseRemoteRelayOriginJson(conv.origin_json),
      mayCreateSessions: readMayCreateSessions(conv),
      planOnly: readPlanOnly(conv),
      cloud: conversationCloudPayload(conv, runtimeSession),
      group: conversationGroupPayload(conversationId),
      groupPosition: conversationGroupPositionOf(conv),
      messages: history.messages,
      pageInfo: history.pageInfo,
      // A re-import can move a pin onto a new message id.
      pins: listConversationPins(conversationId),
      pinsRevision: conversationPinRevision(conversationId),
      // And a hidden mark.
      hiddenMessages: listConversationHiddenMessages(conversationId),
      hiddenMessagesRevision: conversationHiddenMessagesRevision(conversationId),
      refreshed: true,
    });
  });

  // GET /api/conversation/:id — get paginated conversation history
  // The details version of each finished reply (held-details.mjs), one query
  // per table for the whole window (the ids go in as one JSON parameter).
  // Tool rows are only inserted: their count and highest row id. Thought rows
  // are updated in place as they stream and when done: their rows are read
  // (id, done, text) and fingerprinted, so any change shows.
  let detailsVersionStatements = null;
  function relayDetailsVersions(messageIds) {
    const ids = [...new Set(messageIds.filter(Boolean))];
    const versions = new Map();
    if (!ids.length || typeof db?.prepare !== 'function') return versions;
    try {
      detailsVersionStatements ||= {
        activity: db.prepare(`
          SELECT response_message_id AS id, COUNT(*) AS n, MAX(rowid) AS max_rowid
          FROM relay_activity
          WHERE response_message_id IN (SELECT value FROM json_each(?))
          GROUP BY response_message_id
        `),
        thought: db.prepare(`
          SELECT response_message_id AS response_id, rowid AS row_id, done, text
          FROM relay_thought
          WHERE response_message_id IN (SELECT value FROM json_each(?))
        `),
      };
      const idsJson = JSON.stringify(ids);
      const activity = new Map();
      for (const row of detailsVersionStatements.activity.all(idsJson) || []) {
        activity.set(String(row?.id || ''), { n: Number(row.n) || 0, max: Number(row.max_rowid) || 0 });
      }
      const thoughtRows = new Map();
      for (const row of detailsVersionStatements.thought.all(idsJson) || []) {
        const id = String(row?.response_id || '');
        if (!thoughtRows.has(id)) thoughtRows.set(id, []);
        thoughtRows.get(id).push({ rowid: row.row_id, done: row.done, text: row.text });
      }
      for (const id of ids) {
        const tools = activity.get(id) || { n: 0, max: 0 };
        const thoughts = thoughtRows.get(id) || [];
        versions.set(id, detailsVersion({
          activityCount: tools.n,
          activityMaxRowId: tools.max,
          thoughtCount: thoughts.length,
          thoughtMaxRowId: thoughts.reduce((max, row) => Math.max(max, Number(row.rowid) || 0), 0),
          thoughtHash: thoughtFingerprint(thoughts),
        }));
      }
    } catch {
      // No versions: nothing is held, everything goes out in full.
      return new Map();
    }
    return versions;
  }

  app.get('/api/conversation/:id', auth, (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    const limit = normalizeConversationHistoryLimit(req.query.limit, 20);
    const beforeMessageId = String(req.query.beforeMessageId || '').trim();
    const beforeTimestamp = String(req.query.beforeTimestamp || '').trim();
    const afterMessageId = String(req.query.afterMessageId || '').trim();
    const afterTimestamp = String(req.query.afterTimestamp || '').trim();
    const aroundMessageId = String(req.query.aroundMessageId || '').trim();
    if (stmts.getDeletedSdkSession.get(requestedId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = resolveConversationByIdOrSdkSessionId(requestedId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const resolvedConversationId = String(conv.id || '').trim() || requestedId;
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(resolvedConversationId) || null;
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
    });
    const preferences = resolveConversationPreferences(conv, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
    });
    // The running turn's tool lines: as many per thread as this page shows
    // (its "Tool lines shown" setting); none given, the relay's default.
    const inFlight = inFlightStateForConversation(resolvedConversationId, { activityCap: req.query.activityCap });
    const sessionUsageSummary = resolveConversationUsageSummary({ conversationId: resolvedConversationId });
    const workspaceState = typeof resolveConversationWorkspaceState === 'function'
      ? resolveConversationWorkspaceState({
        conversationId: resolvedConversationId,
        sdkSessionId: conv.sdk_session_id || resolvedConversationId,
        discoveredWorkspaceRootPath: '',
      })
      : null;
    const sessionRoot = buildConversationSessionRootPayload({
      conversationId: resolvedConversationId,
      sdkSessionId: conv.sdk_session_id || resolvedConversationId,
      title: resolvedTitle,
      resolveSessionStateRoot,
      providerType: runtimeSession?.provider_type || '',
      claudeNativeSessionId: runtimeSession?.claude_native_session_id || '',
      workspaceRootPath: workspaceState?.currentWorkspaceRootPath || '',
      resolveClaudeSessionRoot,
      resolveDeepSeekSessionRoot,
      resolveCursorSessionRoot,
    });
    const historyCursor = { limit, beforeMessageId, beforeTimestamp, afterMessageId, afterTimestamp, aroundMessageId };
    // The page's rows only: every later lookup is per page, not per conversation.
    const sqlPage = selectConversationHistoryPageRows(resolvedConversationId, historyCursor);
    const dbMessages = sqlPage ? sqlPage.rows : stmts.getMessages.all(resolvedConversationId);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model, status
      FROM queue
      WHERE conversation_id = ?
    `).all(resolvedConversationId);
    const responseMessageToSourceId = new Map(
      queueRows
        .map((row) => [String(row?.response_message_id || '').trim(), String(row?.id || '').trim()])
        .filter(([responseMessageId, sourceMessageId]) => !!responseMessageId && !!sourceMessageId),
    );
    // The live poll names the finished replies whose tool lines and thoughts
    // it holds (`heldDetails`, held-details.mjs); those whose details have
    // not changed since (the same `detailsVersion`) go out without them.
    const assistantIds = dbMessages.filter((m) => m.role === 'assistant').map((m) => String(m.id));
    const detailsVersions = relayDetailsVersions(assistantIds);
    const heldParam = parseHeldDetailsParam(req.query.heldDetails);
    const heldNow = new Set(heldParam
      ? assistantIds.filter((id) => heldParam.get(id) === detailsVersions.get(id))
      : []);
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant' && !heldNow.has(String(m.id)))
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    const relayThoughtsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant' && !heldNow.has(String(m.id)))
        .map((m) => [m.id, relayThoughtsForResponse ? relayThoughtsForResponse(m.id) : []]),
    );
    const subagentRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, subagentRunsForResponse ? subagentRunsForResponse(m.id) : []]),
    );
    const workflowRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, workflowRunsForResponse ? workflowRunsForResponse(m.id) : []]),
    );
    const previewCardsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, previewCardsForResponse ? previewCardsForResponse(m.id) : []]),
    );
    const usageByResponseMessageId = sqlPage ? usageSnapshotsForPage(conv.id, dbMessages) : new Map(
      (stmts.listMessageUsageSnapshotsByConversation?.all(conv.id) || [])
        .map((row) => [String(row?.response_message_id || '').trim(), mapUsageSnapshotRow(row)])
        .filter(([messageId, usage]) => !!messageId && !!usage),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments).map(hydrateAttachment).filter(Boolean),
      })),
      transcriptMessages: [],
      relayActivitiesByMessageId,
      relayThoughtsByMessageId,
      subagentRunsByMessageId,
      workflowRunsByMessageId,
      previewCardsByMessageId,
      responseMessageToSourceId,
      queueRows,
      usageByResponseMessageId,
      resendIndexMessages: sqlPage ? resendIndexForPage(resolvedConversationId, dbMessages, { sharedOnly: false }) : null,
    });
    messages = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const id = String(message.id || '').trim();
      const sourceMessageId = responseMessageToSourceId.get(id) || message.sourceMessageId || undefined;
      // Held: the page fills these from what it has. Otherwise the version
      // the page keeps with them.
      const details = heldNow.has(id)
        ? { activities: [], thoughts: [], detailsHeld: true }
        : (detailsVersions.has(id) ? { detailsVersion: detailsVersions.get(id) } : {});
      return { ...message, ...(sourceMessageId ? { sourceMessageId } : {}), ...details };
    });
    const history = sqlPage
      ? { messages, pageInfo: sqlPage.pageInfo }
      : selectConversationHistoryPage(messages, historyCursor);
    res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      sessionRootPath: sessionRoot?.sessionRootPath || null,
      sessionRootName: sessionRoot?.sessionRootName || resolvedTitle || 'Session',
      configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
        sdkSessionId: runtimeSession.sdk_session_id || conv.sdk_session_id || null,
        strategy: runtimeSession.strategy || null,
        status: runtimeSession.status || null,
        model: runtimeSession.model || null,
        providerType: String(runtimeSession.provider_type || 'github').trim().toLowerCase() || 'github',
        providerModel: runtimeSession.provider_model || null,
        createdAt: runtimeSession.created_at || null,
        lastUsedAt: runtimeSession.last_used_at || null,
      } : null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      sessionUsageSummary,
      inFlight,
      // A queued (pending/parked) row counts too: inFlight covers only the
      // processing one. Another relay's agent tells "still queued" from
      // "cancelled" with it.
      activeTurn: Number(stmts.getConversationActiveQueueCount?.get?.(resolvedConversationId)?.count || 0) > 0,
      ...(describeSessionActivity(resolvedConversationId) || {}),
      // The published set, else the placeholder for background work a live
      // worker reports without this runtime knowing its details.
      // Each with the health poller's last reading (`health`); the tasks
      // that ended within the hour with a console beside them.
      backgroundTasks: (() => {
        const taskKeys = [resolvedConversationId, runtimeSession?.sdk_session_id];
        const tasks = backgroundWorkView
          ? backgroundWorkView.panelTasks(...taskKeys)
          : (backgroundTaskStore?.get?.(resolvedConversationId) || []);
        return backgroundTaskStore?.withHealth ? backgroundTaskStore.withHealth(tasks, ...taskKeys) : tasks;
      })(),
      endedBackgroundTasks: backgroundTaskStore?.ended?.(resolvedConversationId, runtimeSession?.sdk_session_id) || [],
      // Minutes without output after which the panel calls a task quiet.
      taskStallMinutes: (() => {
        try { return getTaskStallMinutes(); } catch { return DEFAULT_TASK_STALL_MINUTES; }
      })(),
      usageLimitPause: usageLimitPauseService?.getPause?.(resolvedConversationId) || null,
      // A Claude chat's billing (subscription or API key) and whether the
      // composer's toggle may switch it now, with the reason when not.
      billing: claudeBillingSwitchService?.billingState?.(resolvedConversationId) || null,
      previews: listConversationPreviews?.(resolvedConversationId) || [],
      // Every pin of the conversation, also those outside this history page.
      pins: listConversationPins(resolvedConversationId),
      pinsRevision: conversationPinRevision(resolvedConversationId),
      // Every message hidden from shared viewers, also those outside the page.
      hiddenMessages: listConversationHiddenMessages(resolvedConversationId),
      hiddenMessagesRevision: conversationHiddenMessagesRevision(resolvedConversationId),
      preferredRelayMode: preferences.preferredRelayMode,
      preferredModel: preferences.preferredModel,
      preferredReasoningEffort: preferences.preferredReasoningEffort,
      draftText: String(conv.draft_text || ''),
      draftAttachments: parseDraftAttachmentsColumn(conv.draft_attachments),
      draftUpdatedAt: conv.draft_updated_at || null,
      draftUpdatedByClientId: conv.draft_updated_by_client_id || null,
      // Set on conversations another relay's agent created ("via <relay>").
      origin: parseRemoteRelayOriginJson(conv.origin_json),
      mayCreateSessions: readMayCreateSessions(conv),
      planOnly: readPlanOnly(conv),
      // Set on Claude Cloud conversations: repository, branch, session link.
      cloud: conversationCloudPayload(conv, runtimeSession),
      // The session group it is in, with the other members; null when none.
      group: conversationGroupPayload(resolvedConversationId, req),
      // Its place in the group's hand order, as on the list rows.
      groupPosition: conversationGroupPositionOf(conv),
      // Generated images with their file on this relay and their size, for
      // this page's rows only (agents on other relays name the files).
      messages: withGeneratedImageFiles(history.messages, { resolveSessionStateRoot }),
      pageInfo: history.pageInfo,
    });
  });

  // Pin or unpin one message. Unlike share visibility this may change while
  // the message's turn runs (nothing public depends on it), and every open
  // client learns of it through the socket instead of reloading.
  app.patch('/api/conversation/:id/message/:messageId/pin', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const messageId = String(req.params.messageId || '').trim();
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: 'Missing conversation or message id' });
    }
    if (typeof req.body?.pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    const conv = stmts.getConvAnyStatus.get(conversationId);
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const message = stmts.getMessageByConversation?.get(messageId, conversationId) || null;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!stmts.setMessagePinnedAt || !stmts.countPinnedMessages) {
      return res.status(503).json({ error: 'Pinning messages is unavailable until the relay restarts' });
    }

    const pinned = req.body.pinned === true;
    const currentlyPinned = !!message.pinned_at;
    if (currentlyPinned !== pinned) {
      if (pinned && Number(stmts.countPinnedMessages.get(conversationId)?.cnt || 0) >= MESSAGE_PIN_LIMIT) {
        return res.status(409).json({
          error: `This conversation already has ${MESSAGE_PIN_LIMIT} pinned messages. Unpin one first.`,
          code: 'pin-limit',
          limit: MESSAGE_PIN_LIMIT,
        });
      }
      stmts.setMessagePinnedAt.run(pinned ? new Date().toISOString() : null, messageId, conversationId);
    }

    const pins = listConversationPins(conversationId);
    if (currentlyPinned !== pinned) {
      const revision = bumpConversationPinRevision(conversationId);
      io?.emit?.('conversation_pins_updated', { conversationId, pins, revision });
    }
    return res.json({
      ok: true,
      conversationId,
      messageId,
      pinned,
      pins,
      pinsRevision: conversationPinRevision(conversationId),
    });
  });
}
