'use strict';

// Stateless helpers of the sessions routes, imported by the route modules
// that use them.

import { liveResendsByOriginal } from '../services/steer-resend.mjs';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import { stopSessionWorkerProcesses } from '../services/session-worker-stop-service.mjs';
import { parseRemoteRelayOriginJson } from '../repositories/remote-relay-repository.mjs';
import { resolveGroupDisplayName } from '../repositories/conversation-group-repository.mjs';
import {
  REMOTE_RELAY_GROUP_LIMITS,
  formatSessionGroupList,
} from '../../shared/remote-relay-contract.mjs';
import {
  buildConversationHistoryPageInfo,
  normalizeConversationHistoryLimit,
  normalizeConversationTimestampMs,
} from '../services/conversation-history-page.mjs';
import {
  OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE,
  isOpenAIImageModelId,
  openAIImageModelNeedsOpenAIText,
} from '../../shared/openai-image-options.mjs';

// Registry statuses that mean "this worker is currently running" (same triple
// as ACTIVE_SESSION_CWD_STATUSES in server-runtime.mjs).
const SESSION_WORKER_ACTIVE_STATUSES = Object.freeze(['starting', 'ready', 'processing']);

/** The refusal of a Copilot chat on an image model (400), or null for any other model. */
function copilotImageModelRefusal(model = '') {
  const modelId = String(model || '').trim();
  if (!isOpenAIImageModelId(modelId)) return null;
  return { ok: false, error: openAIImageModelNeedsOpenAIText(modelId), code: OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE };
}

function isPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase();
    if (code === 'EPERM') return true;
    return false;
  }
}

// A launch refused because the chat is Copilot's and Copilot is switched off.
export const COPILOT_SWITCHED_OFF_LAUNCH = Object.freeze({
  code: 'COPILOT_SWITCHED_OFF',
  error: 'Copilot is switched off on this relay, so no Copilot worker was started. Switch it on in Settings → Providers → Copilot.',
});

export async function launchWorkspaceRootSession(
  runtimeState = {},
  sessionWorkerSupervisor = null,
  sdkSessionId = '',
  sessionWorkerRegistry = null,
  // Defaults preserve the behaviour of POST /api/session-worker/:id/launch.
  // The CWD relaunch route passes { allowProcessReuse: false } so the new
  // directory is actually applied, { resetKilledMarker: false } because it
  // clears the kill block itself once the old CLI is verifiably dead, and
  // { requireStoppedWorker: false } because it has already done that check —
  // re-running it here would reject on stale registry state.
  // `failCopilotRowsWithoutLaunch` (the runtime's, through the route deps):
  // true for a Copilot chat while Copilot is switched off, its pending rows
  // then failed with the switch's note; no worker is launched for it.
  { allowProcessReuse = true, resetKilledMarker = true, requireStoppedWorker = true, failCopilotRowsWithoutLaunch = null } = {},
) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) {
    return { ok: false, statusCode: 400, error: 'Missing session id' };
  }
  if (typeof failCopilotRowsWithoutLaunch === 'function' && failCopilotRowsWithoutLaunch(sid) === true) {
    return { ok: false, statusCode: 409, code: COPILOT_SWITCHED_OFF_LAUNCH.code, error: COPILOT_SWITCHED_OFF_LAUNCH.error };
  }
  const activeStatuses = SESSION_WORKER_ACTIVE_STATUSES;
  const selectedWorkerState = typeof sessionWorkerSupervisor?.getWorkerState === 'function'
    ? sessionWorkerSupervisor.getWorkerState(sid)
    : null;
  const selectedWorkerPid = Number(selectedWorkerState?.pid);
  const selectedWorkerHasPid = Number.isInteger(selectedWorkerPid) && selectedWorkerPid > 0;
  const selectedWorkerPidAlive = isPidAlive(selectedWorkerPid);
  const selectedWorkerStatus = String(selectedWorkerState?.status || '').trim().toLowerCase();
  if (requireStoppedWorker && activeStatuses.includes(selectedWorkerStatus) && (!selectedWorkerHasPid || selectedWorkerPidAlive)) {
    return { ok: false, statusCode: 409, error: 'Selected CLI is already running' };
  }
  if (activeStatuses.includes(selectedWorkerStatus) && selectedWorkerHasPid && !selectedWorkerPidAlive) {
    sessionWorkerSupervisor?.clearRestartSchedule?.(sid, { resetKilledMarker });
    sessionWorkerRegistry?.removeWorker?.(sid);
  } else if (resetKilledMarker) {
    // Explicit user-triggered launch always clears the kill block so it is not
    // stuck behind the 30-second grace window from a prior kill.
    sessionWorkerSupervisor?.clearRestartSchedule?.(sid, { resetKilledMarker: true });
  }
  if (!sessionWorkerSupervisor || typeof sessionWorkerSupervisor.ensureWorker !== 'function') {
    return { ok: false, statusCode: 500, error: 'Session worker launcher is unavailable' };
  }

  const result = await sessionWorkerSupervisor.ensureWorker(sid, { allowProcessReuse });
  if (!result?.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: result?.error || 'launch-failed',
      worker: result?.worker || null,
      lifecycle: result?.lifecycle || null,
    };
  }
  return { ok: true, statusCode: 200, ...result };
}

async function stopIdleWorkspaceRootSession({
  sdkSessionId,
  worker,
  sessionWorkerSupervisor,
  sessionWorkerRegistry,
  sessionWorkerProcessInspector,
  stopOverrides = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return { ok: false, error: 'Missing session id' };
  sessionWorkerSupervisor?.markKilled?.(sid);
  await sessionWorkerSupervisor?.cancelPendingStart?.(sid, { wait: true });

  const stopped = await stopSessionWorkerProcesses({
    sdkSessionId: sid,
    worker,
    processInspector: sessionWorkerProcessInspector,
    isPidAliveImpl: isPidAlive,
    killTmuxSessionImpl: killTmuxSession,
    ...(stopOverrides || {}),
  });
  // Only tear down the bookkeeping once every process is verifiably gone.
  // Clearing it while a CLI is still alive is what lets the relaunch "succeed"
  // by silently reusing that CLI in the old working directory.
  if (!stopped.ok) {
    return {
      ok: false,
      timedOut: stopped.timedOut === true,
      remainingPids: stopped.remainingPids || [],
      stoppedPids: stopped.pids || [],
      error: stopped.error || 'Failed to stop the idle CLI',
    };
  }

  sessionWorkerRegistry?.removeWorker?.(sid);
  sessionWorkerSupervisor?.clearRestartSchedule?.(sid);
  sessionWorkerSupervisor?.resetHealth?.(sid, { clearFailureCount: false });
  return { ok: true, stoppedPids: stopped.pids || [] };
}

const FALLBACK_RELAY_MODE = 'agent';

export function normalizeRelayModePreference(value, {
  supportedRelayModes = [],
  fallbackMode = FALLBACK_RELAY_MODE,
} = {}) {
  const allowedModes = Array.isArray(supportedRelayModes)
    ? supportedRelayModes.map((mode) => String(mode || '').trim()).filter(Boolean)
    : [];
  const fallback = allowedModes.includes(fallbackMode)
    ? fallbackMode
    : (allowedModes[0] || FALLBACK_RELAY_MODE);
  const mode = String(value || '').trim();
  if (!mode) return fallback;
  return allowedModes.includes(mode) ? mode : fallback;
}

export function normalizePreferredModel(value) {
  return String(value || '').trim();
}

export function normalizePreferredReasoningEffort(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseDraftAttachmentsColumn(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveConversationPreferences(row, {
  supportedRelayModes = [],
  defaultRelayMode = FALLBACK_RELAY_MODE,
} = {}) {
  return {
    preferredRelayMode: normalizeRelayModePreference(row?.preferred_relay_mode, {
      supportedRelayModes,
      fallbackMode: defaultRelayMode,
    }),
    preferredModel: normalizePreferredModel(row?.preferred_model),
    preferredReasoningEffort: normalizePreferredReasoningEffort(row?.preferred_reasoning_effort),
  };
}

export function resolveConversationTitle({ title = '', titleSource = '', discoveredTitle = '' } = {}) {
  const storedTitle = String(title || '').trim();
  const source = String(titleSource || '').trim().toLowerCase();
  const discovered = String(discoveredTitle || '').trim();
  const normalizedDiscovered = discovered.toLowerCase();
  const poisonedDiscoveredTitle = normalizedDiscovered.startsWith('[relay mode:')
    || normalizedDiscovered.startsWith('implement relay tool guidance')
    || normalizedDiscovered.includes('relay tool guidance')
    || normalizedDiscovered.includes('for any user-facing question or clarification, use the ask_user tool')
    || normalizedDiscovered.includes('these instructions remain in effect until relay mode changes');
  const safeDiscovered = poisonedDiscoveredTitle ? '' : discovered;
  if (source === 'manual') return storedTitle || safeDiscovered;
  return safeDiscovered || storedTitle;
}

function activityEntryMetadata(value) {
  const metadata = value && typeof value === 'object' ? value.metadata : null;
  return (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : null;
}

function mergeUniqueActivityTexts(primary = [], secondary = []) {
  const merged = [];
  const indexByKey = new Map();
  for (const value of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const text = value && typeof value === 'object'
      ? String(value.text || '').trim()
      : String(value || '').trim();
    const subagentRunId = value && typeof value === 'object' && value.subagentRunId
      ? String(value.subagentRunId).trim()
      : '';
    const key = `${subagentRunId}::${text}`;
    if (!text) continue;
    const entry = value && typeof value === 'object' ? { ...value, text } : text;
    if (indexByKey.has(key)) {
      // Same prose from two sources: the structured copy wins. A compaction
      // boundary reaches the transcript branch as prose only, and dropping
      // the metadata-bearing duplicate would cost the client its break row.
      const existingIndex = indexByKey.get(key);
      if (activityEntryMetadata(entry) && !activityEntryMetadata(merged[existingIndex])) {
        merged[existingIndex] = entry;
      }
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(entry);
  }
  return merged;
}

function normalizeConversationMessageIdentityText(value) {
  const raw = String(value || '');
  const withoutAttachmentMarkers = raw.replace(/\s*\[(?:Attached file|Attached files):[^\]]+\]\s*/gi, ' ');
  return withoutAttachmentMarkers.replace(/\s+/g, ' ').trim();
}

function conversationMessageIdentityKey(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  const timestamp = String(message?.timestamp || '').trim();
  const text = normalizeConversationMessageIdentityText(message?.text);
  return `${role}::${timestamp}::${text}`;
}

function conversationMessageRoleTextKey(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  const text = normalizeConversationMessageIdentityText(message?.text);
  return `${role}::${text}`;
}

function isLikelyCanonicalDuplicateMessage(a, b, timestampWindowMs = 30_000) {
  const aRoleText = conversationMessageRoleTextKey(a);
  const bRoleText = conversationMessageRoleTextKey(b);
  if (!aRoleText || !bRoleText || aRoleText !== bRoleText) return false;

  const aSource = String(a?.sourceMessageId || '').trim();
  const bSource = String(b?.sourceMessageId || '').trim();
  if (aSource && bSource) return aSource === bSource;

  const aTs = normalizeConversationTimestampMs(a?.timestamp);
  const bTs = normalizeConversationTimestampMs(b?.timestamp);
  if (!aTs || !bTs) return false;
  return Math.abs(aTs - bTs) <= Math.max(1_000, Number(timestampWindowMs) || 30_000);
}


function isTranscriptUserEchoOfQueuedMessage({
  transcriptMessage = null,
  canonicalDbMessages = [],
  queueRowsById = new Map(),
  firstAssistantTimestampBySourceId = new Map(),
  responseGraceMs = 5_000,
} = {}) {
  if (String(transcriptMessage?.role || '').trim().toLowerCase() !== 'user') return false;
  const transcriptTimestampMs = normalizeConversationTimestampMs(transcriptMessage?.timestamp);
  if (!transcriptTimestampMs) return false;
  const graceMs = Math.max(0, Number(responseGraceMs) || 0);
  for (const dbMessage of Array.isArray(canonicalDbMessages) ? canonicalDbMessages : []) {
    const canonicalId = String(dbMessage?.id || '').trim();
    if (!canonicalId) continue;
    const canonicalTimestampMs = normalizeConversationTimestampMs(dbMessage?.timestamp);
    if (!canonicalTimestampMs || transcriptTimestampMs < canonicalTimestampMs) continue;
    const queueRow = queueRowsById.get(canonicalId) || null;
    if (!queueRow) continue;
    const queueStatus = String(queueRow?.status || '').trim().toLowerCase();
    if (queueStatus === 'pending' || queueStatus === 'processing' || queueStatus === 'parked') {
      return true;
    }
    const assistantTimestampMs = normalizeConversationTimestampMs(firstAssistantTimestampBySourceId.get(canonicalId));
    if (assistantTimestampMs && transcriptTimestampMs <= (assistantTimestampMs + graceMs)) {
      return true;
    }
  }
  return false;
}

function compareConversationMessageOrder(a, b) {
  const aTs = normalizeConversationTimestampMs(a?.timestamp);
  const bTs = normalizeConversationTimestampMs(b?.timestamp);
  if (aTs !== bTs) return aTs - bTs;
  const aId = String(a?.id || '').trim();
  const bId = String(b?.id || '').trim();
  return aId.localeCompare(bId);
}

function resolveConversationHistoryCursor(messages = [], {
  messageId = '',
  timestamp = '',
} = {}) {
  const cursorMessageId = String(messageId || '').trim();
  const cursorTimestampText = String(timestamp || '').trim();
  const list = Array.isArray(messages) ? messages : [];

  if (cursorMessageId) {
    const cursorMessage = list.find((message) => String(message?.id || '').trim() === cursorMessageId) || null;
    if (cursorMessage) {
      return {
        beforeMessageId: cursorMessageId,
        beforeTimestamp: String(cursorMessage.timestamp || '').trim() || null,
        timestampMs: normalizeConversationTimestampMs(cursorMessage.timestamp),
      };
    }
  }

  if (cursorTimestampText) {
    return {
      beforeMessageId: cursorMessageId || null,
      beforeTimestamp: cursorTimestampText,
      timestampMs: normalizeConversationTimestampMs(cursorTimestampText),
    };
  }

  return null;
}

export function selectConversationHistoryPage(messages = [], {
  limit = 20,
  beforeMessageId = '',
  beforeTimestamp = '',
  afterMessageId = '',
  afterTimestamp = '',
  aroundMessageId = '',
} = {}) {
  const pageLimit = normalizeConversationHistoryLimit(limit);
  const ordered = Array.isArray(messages)
    ? messages.filter((message) => !!message).slice().sort(compareConversationMessageOrder)
    : [];
  const aroundId = String(aroundMessageId || '').trim();
  const requestedAroundWindow = !!aroundId;
  const beforeCursor = resolveConversationHistoryCursor(ordered, { messageId: beforeMessageId, timestamp: beforeTimestamp });
  const afterCursor = resolveConversationHistoryCursor(ordered, { messageId: afterMessageId, timestamp: afterTimestamp });

  let pageMessages = [];
  if (aroundId) {
    const aroundIndex = ordered.findIndex((message) => String(message?.id || '').trim() === aroundId);
    if (aroundIndex >= 0) {
      const halfWindow = Math.floor((pageLimit - 1) / 2);
      let start = Math.max(0, aroundIndex - halfWindow);
      let end = Math.min(ordered.length, start + pageLimit);
      if ((end - start) < pageLimit) {
        start = Math.max(0, end - pageLimit);
      }
      pageMessages = ordered.slice(start, end);
    }
  }
  // Treat any non-empty afterMessageId as an intentional "after" request even when the
  // cursor message is not found in the current list (e.g. transcript-only session where
  // the ID is absent).  Without this guard the fallback branch would silently return a
  // stale tail page instead of an empty result.
  const requestedAfterWindow = !!String(afterMessageId || '').trim();
  if (!pageMessages.length && !requestedAroundWindow && afterCursor) {
    const newerMessages = ordered.filter((message) => {
      const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
      if (messageTimestampMs > afterCursor.timestampMs) return true;
      if (messageTimestampMs < afterCursor.timestampMs) return false;
      if (!afterCursor.beforeMessageId) return false;
      return String(message?.id || '').trim().localeCompare(afterCursor.beforeMessageId) > 0;
    });
    pageMessages = newerMessages.slice(0, pageLimit);
  }
  if (!pageMessages.length && !requestedAfterWindow && !requestedAroundWindow) {
    const olderMessages = beforeCursor
      ? ordered.filter((message) => {
          const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
          if (messageTimestampMs < beforeCursor.timestampMs) return true;
          if (messageTimestampMs > beforeCursor.timestampMs) return false;
          if (!beforeCursor.beforeMessageId) return false;
          return String(message?.id || '').trim().localeCompare(beforeCursor.beforeMessageId) < 0;
        })
      : ordered;
    pageMessages = olderMessages.slice(-pageLimit);
  }

  const firstMessage = pageMessages[0] || null;
  const lastMessage = pageMessages[pageMessages.length - 1] || null;
  let firstIdx = -1;
  let lastIdx = -1;
  if (firstMessage && lastMessage) {
    firstIdx = ordered.findIndex((message) => String(message?.id || '').trim() === String(firstMessage.id || '').trim());
    for (let idx = ordered.length - 1; idx >= 0; idx -= 1) {
      if (String(ordered[idx]?.id || '').trim() === String(lastMessage.id || '').trim()) {
        lastIdx = idx;
        break;
      }
    }
  }
  const hasMoreOlder = firstIdx > 0;
  const hasMoreNewer = lastIdx >= 0 && lastIdx < (ordered.length - 1);
  return {
    messages: pageMessages,
    pageInfo: buildConversationHistoryPageInfo(pageMessages, { hasMoreOlder, hasMoreNewer }),
  };
}

export function buildConversationMessages({
  dbMessages = [],
  transcriptMessages = [],
  relayActivitiesByMessageId = new Map(),
  relayThoughtsByMessageId = new Map(),
  subagentRunsByMessageId = new Map(),
  workflowRunsByMessageId = new Map(),
  previewCardsByMessageId = new Map(),
  responseMessageToSourceId = new Map(),
  queueRows = [],
  usageByResponseMessageId = new Map(),
  // When dbMessages is one page: the conversation's rows liveResendsByOriginal
  // reads (id, role, source_message_id, resend_of_message_id), since a stopped
  // marker on the page may have its Resend outside it.
  resendIndexMessages = null,
} = {}) {
  const queueRowsById = new Map(
    (Array.isArray(queueRows) ? queueRows : [])
      .map((row) => [String(row?.id || '').trim(), row])
      .filter(([id]) => !!id),
  );
  // A stopped steer's marker says "Resent" from the data, so it holds across
  // reloads and devices (the relay refuses a second Resend on the same basis).
  const liveResends = liveResendsByOriginal(Array.isArray(resendIndexMessages) ? resendIndexMessages : dbMessages, queueRows);
  const normalizedDbMessages = Array.isArray(dbMessages)
    ? dbMessages.map((message) => {
        const id = String(message?.id || '').trim();
        // The queue's link is pruned with old rows; the message's own column
        // keeps it, so a reload still anchors the reply under its prompt.
        const sourceMessageId = message?.role === 'assistant'
          ? (responseMessageToSourceId.get(id) || String(message?.source_message_id || '').trim() || undefined)
          : undefined;
        // A user row's queue entry shares its id; assistant rows reach the same
        // entry through the response mapping. Both need it for the effort tag.
        const queueRow = sourceMessageId
          ? queueRowsById.get(sourceMessageId)
          : (message?.role === 'user' ? queueRowsById.get(id) : null);
        // Provenance of a prompt another relay's agent sent: the bubble's badge.
        const origin = message?.role === 'user' ? parseRemoteRelayOriginJson(message?.origin_json) : null;
        return {
          activities: message?.role === 'assistant' ? (relayActivitiesByMessageId.get(id) || []) : [],
          thoughts: message?.role === 'assistant' ? (relayThoughtsByMessageId.get(id) || []) : [],
          subagentRuns: message?.role === 'assistant' ? (subagentRunsByMessageId.get(id) || []) : [],
          workflowRuns: message?.role === 'assistant' ? (workflowRunsByMessageId.get(id) || []) : [],
          previewCards: message?.role === 'assistant' ? (previewCardsByMessageId.get(id) || []) : [],
          id,
          role: message?.role,
          text: stripRelayPromptContext(message?.text, message?.mode),
          model: message?.model || undefined,
          modelOrigin: message?.model_origin
            || message?.modelOrigin
            || ((String(queueRow?.model || '').trim().toLowerCase() === 'auto') ? 'auto' : undefined),
          reasoningEffort: queueRow?.reasoning_effort || undefined,
          usage: message?.role === 'assistant' ? (usageByResponseMessageId.get(id) || undefined) : undefined,
          attachments: message?.attachments || [],
          mode: message?.mode || undefined,
          hiddenFromShares: Number(message?.hidden_from_shares || 0) === 1,
          pinned: !!message?.pinned_at,
          timestamp: message?.timestamp,
          sourceMessageId,
          executedProvider: message?.executed_provider || message?.executedProvider || undefined,
          // 'continuation' badges a self-started turn; 'absorbed' marks a
          // reply that continues through the next (steered) user message;
          // 'folded'/'stopped' are a steer's settle markers, and
          // 'answered-elsewhere' marks a message whose answer is on a
          // continuation row. Without this the live-appended
          // badge/merge/marker vanished on reload.
          kind: message?.kind || undefined,
          resendOfMessageId: message?.role === 'user' ? (message?.resend_of_message_id || undefined) : undefined,
          resentAs: (message?.role === 'assistant' && message?.kind === 'stopped' && sourceMessageId)
            ? (liveResends.get(sourceMessageId) || undefined)
            : undefined,
          ...(origin ? { origin } : {}),
        };
      })
    : [];
  const normalizedTranscriptMessages = (Array.isArray(transcriptMessages) ? transcriptMessages : []).map((message) => {
    const id = String(message?.id || '').trim();
    const sourceMessageId = message?.role === 'assistant'
      ? (responseMessageToSourceId.get(id) || message?.sourceMessageId || undefined)
      : message?.sourceMessageId;
    // As in the db branch: a user row's queue entry is keyed by its own id.
    const queueRow = sourceMessageId
      ? queueRowsById.get(String(sourceMessageId || '').trim())
      : (message?.role === 'user' ? queueRowsById.get(id) : null);
    return {
      ...message,
      id,
      activities: mergeUniqueActivityTexts(
        Array.isArray(message?.activities) ? message.activities : [],
        id ? (relayActivitiesByMessageId.get(id) || []) : [],
      ),
      thoughts: (Array.isArray(message?.thoughts) && message.thoughts.length)
        ? message.thoughts
        : (id ? (relayThoughtsByMessageId.get(id) || []) : []),
      subagentRuns: (Array.isArray(message?.subagentRuns) && message.subagentRuns.length)
        ? message.subagentRuns
        : (id ? (subagentRunsByMessageId.get(id) || []) : []),
      workflowRuns: (Array.isArray(message?.workflowRuns) && message.workflowRuns.length)
        ? message.workflowRuns
        : (id ? (workflowRunsByMessageId.get(id) || []) : []),
      previewCards: (Array.isArray(message?.previewCards) && message.previewCards.length)
        ? message.previewCards
        : (id ? (previewCardsByMessageId.get(id) || []) : []),
      text: stripRelayPromptContext(message?.text, message?.mode),
      sourceMessageId,
      modelOrigin: message?.modelOrigin
        || message?.model_origin
        || ((String(queueRow?.model || '').trim().toLowerCase() === 'auto') ? 'auto' : undefined),
      reasoningEffort: message?.reasoningEffort || queueRow?.reasoning_effort || undefined,
      usage: message?.role === 'assistant' ? (usageByResponseMessageId.get(id) || message?.usage || undefined) : message?.usage,
    };
  });

  const transcriptById = new Map(
    normalizedTranscriptMessages
      .map((message) => [String(message?.id || '').trim(), message])
      .filter(([id]) => !!id),
  );

  const messagesById = new Map();
  for (const message of normalizedDbMessages) {
    messagesById.set(String(message.id || '').trim(), message);
  }

  if (normalizedDbMessages.length === 0) {
    return normalizedTranscriptMessages.slice().sort(compareConversationMessageOrder);
  }

  const dbIdentityKeys = new Set(
    normalizedDbMessages.map((message) => conversationMessageIdentityKey(message)),
  );
  const dbMessagesByRoleText = new Map();
  for (const message of normalizedDbMessages) {
    const key = conversationMessageRoleTextKey(message);
    if (!key || key.endsWith('::')) continue;
    const bucket = dbMessagesByRoleText.get(key) || [];
    bucket.push(message);
    dbMessagesByRoleText.set(key, bucket);
  }
  const firstAssistantTimestampBySourceId = new Map();
  for (const message of normalizedDbMessages) {
    if (String(message?.role || '').trim().toLowerCase() !== 'assistant') continue;
    const sourceMessageId = String(message?.sourceMessageId || '').trim();
    if (!sourceMessageId) continue;
    const timestamp = String(message?.timestamp || '').trim();
    if (!timestamp) continue;
    const existing = String(firstAssistantTimestampBySourceId.get(sourceMessageId) || '').trim();
    if (!existing || normalizeConversationTimestampMs(timestamp) < normalizeConversationTimestampMs(existing)) {
      firstAssistantTimestampBySourceId.set(sourceMessageId, timestamp);
    }
  }
  const retriedQueueRowsByRoleText = new Map();
  for (const row of Array.isArray(queueRows) ? queueRows : []) {
    const retryCount = Math.max(0, Number(row?.retry_count || 0));
    if (retryCount < 1) continue;
    const key = conversationMessageRoleTextKey({
      role: 'user',
      text: row?.text,
    });
    if (!key || key.endsWith('::')) continue;
    const bucket = retriedQueueRowsByRoleText.get(key) || [];
    bucket.push({
      id: String(row?.id || '').trim(),
      timestamp: String(row?.timestamp || '').trim(),
      retryCount,
    });
    retriedQueueRowsByRoleText.set(key, bucket);
  }

  for (const message of transcriptById.values()) {
    const id = String(message?.id || '').trim();
    if (!id) continue;
    const existing = messagesById.get(id);
    if (!existing) continue;
    if (existing.role !== 'assistant') continue;
    const transcriptMessage = transcriptById.get(id) || null;
    if (!transcriptMessage) continue;
    messagesById.set(id, {
      ...existing,
      activities: mergeUniqueActivityTexts(
        Array.isArray(existing.activities) ? existing.activities : [],
        Array.isArray(transcriptMessage.activities) ? transcriptMessage.activities : [],
      ),
      text: stripRelayPromptContext(existing.text, existing.mode),
    });
  }

  for (const message of normalizedTranscriptMessages) {
    const id = String(message?.id || '').trim();
    if (id && messagesById.has(id)) continue;
    const identityKey = conversationMessageIdentityKey(message);
    if (dbIdentityKeys.has(identityKey)) continue;
    const roleTextKey = conversationMessageRoleTextKey(message);
    const maybeCanonicalRows = roleTextKey ? (dbMessagesByRoleText.get(roleTextKey) || []) : [];
    const retriedQueueRows = roleTextKey ? (retriedQueueRowsByRoleText.get(roleTextKey) || []) : [];
    if (
      message?.role === 'user'
      && maybeCanonicalRows.length > 0
      && retriedQueueRows.some((row) => maybeCanonicalRows.some((dbRow) => String(dbRow?.id || '').trim() === row.id))
    ) {
      const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
      const earliestCanonicalTimestampMs = maybeCanonicalRows.reduce((earliest, row) => {
        const next = normalizeConversationTimestampMs(row?.timestamp);
        if (!next) return earliest;
        if (!earliest) return next;
        return Math.min(earliest, next);
      }, 0);
      if (!earliestCanonicalTimestampMs || !messageTimestampMs || messageTimestampMs >= earliestCanonicalTimestampMs) {
        continue;
      }
    }
    if (maybeCanonicalRows.some((row) => isLikelyCanonicalDuplicateMessage(row, message))) continue;
    if (isTranscriptUserEchoOfQueuedMessage({
      transcriptMessage: message,
      canonicalDbMessages: maybeCanonicalRows,
      queueRowsById,
      firstAssistantTimestampBySourceId,
    })) {
      continue;
    }
    dbIdentityKeys.add(identityKey);
    if (!id) continue;
    messagesById.set(id, message);
  }

  return Array.from(messagesById.values()).sort(compareConversationMessageOrder);
}

/**
 * The session-group helpers of the sessions routes, bound to the socket and
 * the group repository. They keep no state of their own, so each route
 * module that needs them builds its own.
 */
export function createConversationGroupHelpers({ io, conversationGroups = null } = {}) {
  /**
   * A session group as the list payload carries it: name, display name (the
   * head's current title when none was given), head and member counts.
   */
  function groupSummaryPayload(group) {
    if (!group) return null;
    const members = conversationGroups?.membersOf?.(group.id) || [];
    const head = group.parentConversationId
      ? members.find((member) => member.id === group.parentConversationId) || null
      : null;
    return {
      id: group.id,
      name: group.name || null,
      displayName: resolveGroupDisplayName({
        name: group.name,
        headTitle: head ? resolveConversationTitle({ title: head.title, titleSource: 'auto' }) : null,
      }),
      parentConversationId: group.parentConversationId || null,
      memberCount: members.length,
      liveMemberCount: members.filter((member) => !member.archived).length,
      // An owner's group an agent emptied, which stays until the owner acts.
      keptEmptyAt: group.keptEmptyAt || null,
    };
  }

  /**
   * Tells every page a group changed, with what the page can apply in place:
   * the group's summary (null once dissolved), the named conversations'
   * membership, the group's order (head first) and the positions of its
   * members and of the named conversations.
   */
  function emitGroupChanged(groupId, conversationIds = []) {
    const ids = [...new Set(conversationIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const group = groupId ? groupSummaryPayload(conversationGroups?.getGroup?.(groupId) || null) : null;
    const order = group ? conversationGroups?.orderOf?.(groupId) || [] : [];
    io.emit('conversation_group_changed', {
      groupId: groupId || null,
      conversationIds: ids,
      group,
      memberships: conversationGroups?.membershipsOf?.(ids) || {},
      order,
      positions: conversationGroups?.positionsOf?.([...order, ...ids]) || {},
    });
  }

  // A session group named at bootstrap (an agent's create_session `group`):
  // what the lookup sees is what an agent may see (GET /api/conversation-groups).
  const autoTitle = (title) => resolveConversationTitle({ title, titleSource: 'auto' });
  const listGroupsForAgents = () => conversationGroups?.listGroups?.({ headTitle: autoTitle }) || [];

  /** `{ id, name, role }` of the group a conversation sits in (list_sessions' shape), or null. */
  function conversationGroupField(conversationId) {
    const membership = conversationGroups?.membershipsOf?.([conversationId])?.[conversationId];
    if (!membership?.groupId) return null;
    const described = conversationGroups.describeGroup?.(membership.groupId, { headTitle: autoTitle }) || null;
    return { id: membership.groupId, name: described?.displayName || null, role: membership.role === 'head' ? 'head' : 'member' };
  }

  return { groupSummaryPayload, emitGroupChanged, listGroupsForAgents, conversationGroupField };
}

/** The 400 body for a group this relay does not have, or has several of by that name. */
export function bootstrapGroupRefusal(found, requested, groups) {
  const ambiguous = found.status === 'ambiguous';
  const listed = ambiguous ? found.matches : groups;
  const asked = String(requested || '').replace(/["\r\n]+/g, ' ').slice(0, 80);
  let error;
  if (ambiguous) error = `"${asked}" names several session groups here: ${formatSessionGroupList(listed)}. Pass the id.`;
  else if (groups.length) error = `No session group "${asked}" here. Groups: ${formatSessionGroupList(groups)}.`;
  else error = `No session group "${asked}" here: this relay has no session groups.`;
  return {
    ok: false,
    code: ambiguous ? 'SESSION_GROUP_AMBIGUOUS' : 'SESSION_GROUP_NOT_FOUND',
    error: `${error} No conversation was created.`,
    groups: listed.slice(0, REMOTE_RELAY_GROUP_LIMITS.refusalMax).map((group) => ({ id: group.id, name: group.name })),
    // How many there are when `groups` is cut to the cap.
    ...(listed.length > REMOTE_RELAY_GROUP_LIMITS.refusalMax ? { groupsTotal: listed.length } : {}),
  };
}

export {
  SESSION_WORKER_ACTIVE_STATUSES,
  copilotImageModelRefusal,
  isPidAlive,
  resolveConversationPreferences,
  stopIdleWorkspaceRootSession,
};
