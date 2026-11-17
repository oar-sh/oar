import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import {
  AUTO_MODEL_SENTINEL,
  asSentence,
  deriveModelOrigin,
  normalizeOpenAIImageSize,
  normalizeSessionWorkerId,
} from './messages-helpers.mjs';
import {
  persistConversationModelPreference as persistConversationModelPreferenceTx,
  readPlanOnly,
} from '../services/conversation-preferences-service.mjs';
import { fallbackReasoningEffort, inheritedConversationModel } from '../services/conversation-model-fallback.mjs';
import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';
import { DEFAULT_CLAUDE_REASONING_EFFORTS } from '../services/provider-reasoning-effort.mjs';
import { claudeBaseModelId, claudeLongContextModelId } from '../../shared/model-id.mjs';
import { isLiveResend } from '../services/steer-resend.mjs';
import {
  checkRequestedProviderModel,
  resolveProviderModelSelection,
  unknownProviderModelText,
} from '../services/provider-model-selection.mjs';
import { stripAllRemotePromptHeaders, stripRemotePromptHeader, withRemotePromptHeader } from '../../shared/remote-relay-contract.mjs';
import {
  OPENAI_IMAGE_LIMITS,
  OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE,
  isOpenAIImageModelId,
  mergeOpenAIImageOptions,
  openAIImageModelNeedsOpenAIText,
  validateOpenAIImageOptions,
} from '../../shared/openai-image-options.mjs';
import { OPENAI_IMAGE_DAILY_CAP_REACHED_CODE } from '../../shared/openai-image-spend.mjs';
import {
  OPENAI_IMAGE_PRESETS_SETTING_KEY,
  findOpenAIImagePreset,
  parseOwnOpenAIImagePresets,
  splitOpenAIImagePreset,
} from '../../shared/openai-image-presets.mjs';
import { IMAGE_INPUT_REFUSED_CODE, resolveImageInputRoots, resolveImageInputs } from '../services/image-input-paths.mjs';
import { stripModelTierSuffix } from '../../shared/claude-cloud/repo-url.mjs';
import {
  DEEPSEEK_REASONING_EFFORTS,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  deepseekModelAcceptsImages,
  deepseekModelLabel,
  deepseekReasoningEffortFor,
} from '../../shared/deepseek-models.mjs';
import { normalizeClaudeBilling } from '../services/claude-billing-switch-service.mjs';
import { copilotEnabledFromStmts, copilotOffCreateRefusal } from '../services/copilot-settings-service.mjs';
import { PLAN_ONLY_REFUSAL, planOnlyRefusesMode } from '../../shared/plan-only.mjs';
import { notPerson } from '../services/relay-principal.mjs';
import { AUTH_ERROR_CODES, AUTH_RELAY_TOOL_REQUIRED_MESSAGE } from '../../shared/relay-route-policy.mjs';
import {
  admitRemoteRelayRequest,
  isDirectAgentRequest,
  findMentionedRemoteRelays,
  findOriginRemoteRelay,
  formatRemoteRelayOriginHint,
  remoteOriginAnswerFields,
  formatRemoteRelayMentionHint,
  recordRemoteRelayUnlocks,
  withRemoteRelayMentionHint,
} from '../services/remote-relay-inbound.mjs';
import { queueIntoConversation, unarchivedConversationEvent } from '../repositories/queue-insert.mjs';

const DUPLICATE_USER_MESSAGE_WINDOW_MS = 10 * 60 * 1000;

export function resolveOpenAIReasoningEffort(explicitReasoningEffort = '', model = '') {
  const explicit = String(explicitReasoningEffort || '').trim().toLowerCase();
  const supported = openAIReasoningEffortsForModel(model);
  if (explicit && !supported.includes(explicit)) {
    return {
      ok: false,
      effort: null,
      supported,
      error: `OpenAI model "${String(model || 'configured model').trim()}" does not support reasoning effort "${explicit}"`,
    };
  }
  const fallback = supported.includes('none') ? 'none' : (supported[0] || null);
  return { ok: true, effort: explicit || fallback, supported };
}

// runtimeBoundToOtherProvider covers sessions already pinned to a non-OpenAI
// provider (Claude, Cursor). Those resolve model ids against their own catalog,
// and providers reuse each other's ids, so matching the configured OpenAI model
// id there says nothing about the request targeting OpenAI.
export function shouldRequireNewOpenAIConversation({
  shouldCreateConversation = false,
  runtimeUsesOpenAI = false,
  requestedConfiguredOpenAIModel = false,
  githubModelAvailable = false,
  runtimeBoundToOtherProvider = false,
} = {}) {
  return (
    !shouldCreateConversation
    && !runtimeUsesOpenAI
    && !runtimeBoundToOtherProvider
    && requestedConfiguredOpenAIModel
    && !githubModelAvailable
  );
}

function normalizeRequestedProviderType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok' || normalized === 'openai-image') return 'openai';
  // `copilot` is the tab's and the CLI's name for the provider `github`.
  if (normalized === 'github' || normalized === 'github-copilot' || normalized === 'copilot') return 'github';
  if (normalized === 'cursor') return 'cursor';
  // Without these, an explicit request for a bootstrap-only provider read as
  // "no provider stated" and the guards below could never fire.
  if (normalized === 'grok' || normalized === 'xai' || normalized === 'xai-grok') return 'grok';
  if (normalized === 'claude' || normalized === 'anthropic') return 'claude';
  // Its own provider, never read as `claude`.
  if (normalized === 'claude-cloud') return 'claude-cloud';
  if (normalized === 'deepseek') return 'deepseek';
  // Its own provider too (Claude on an API key), never read as `claude`.
  if (normalized === 'claude-api') return 'claude-api';
  return '';
}

const BOOTSTRAP_ONLY_PROVIDER_LABELS = Object.freeze({
  cursor: 'Cursor',
  grok: 'Grok',
  claude: 'Claude',
  'claude-cloud': 'Claude Cloud',
  deepseek: 'DeepSeek',
  'claude-api': 'Claude API',
});

function normalizeDuplicateMessageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findRecentDuplicateUserMessage({
  recentUserMessages = [],
  recentQueueRows = [],
  text = '',
  now = Date.now(),
  windowMs = DUPLICATE_USER_MESSAGE_WINDOW_MS,
  // A message the user deliberately sends again (Resend of a steer a Stop
  // cut off) is not a duplicate of its own original, nor of an earlier Resend
  // of it that was cancelled or failed.
  exemptMessageIds = [],
} = {}) {
  const fingerprint = normalizeDuplicateMessageText(text);
  if (!fingerprint) return null;
  const maxAgeMs = Math.max(60_000, Number(windowMs) || DUPLICATE_USER_MESSAGE_WINDOW_MS);
  const exempt = new Set((Array.isArray(exemptMessageIds) ? exemptMessageIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean));
  const isExempt = (row) => exempt.has(String(row?.id || '').trim());
  // A message whose turn failed never ran, so sending it again is a retry,
  // not a double submit. Only failed rows: a cancelled or finished turn stays
  // a duplicate, as before.
  const failedTurnIds = new Set((Array.isArray(recentQueueRows) ? recentQueueRows : [])
    .filter((row) => String(row?.status || '').trim().toLowerCase() === 'failed')
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean));

  for (const row of Array.isArray(recentUserMessages) ? recentUserMessages : []) {
    if (isExempt(row)) continue;
    if (failedTurnIds.has(String(row?.id || '').trim())) continue;
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    if ((now - rowTime) <= maxAgeMs) {
      return { source: 'message', messageId: row?.id || null, timestamp: row?.timestamp || null };
    }
  }

  for (const row of Array.isArray(recentQueueRows) ? recentQueueRows : []) {
    if (isExempt(row)) continue;
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    const status = String(row?.status || '').trim().toLowerCase();
    if (['pending', 'processing', 'parked'].includes(status) && (now - rowTime) <= maxAgeMs) {
      return { source: 'queue', messageId: row?.id || null, timestamp: row?.timestamp || null, status };
    }
  }

  return null;
}

export function resolveInitialQueueOwnerSessionId({
  requesterSessionId = null,
  runtimeSession = null,
  conversationSdkSessionId = null,
  conversationId = null,
  isNewConversation = false,
} = {}) {
  const runtimeSdkSessionId = normalizeSessionWorkerId(runtimeSession?.sdk_session_id);
  const boundConversationSessionId = normalizeSessionWorkerId(conversationSdkSessionId);
  const normalizedConversationId = normalizeSessionWorkerId(conversationId);
  const unboundConversation = !runtimeSdkSessionId && !boundConversationSessionId;
  if (normalizedConversationId && (isNewConversation || unboundConversation)) {
    return normalizedConversationId;
  }
  return normalizeSessionWorkerId(
    runtimeSdkSessionId
    || boundConversationSessionId
    || requesterSessionId,
  );
}

// `deps` is the object registerMessagesRoutes gets; `shared` carries what
// that function resolved or built itself (the deps that have a default
// there, and its own helpers), as the same values.
export function registerMessagesIntakeRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    uuidv4,
    ts,
    MAX_UPLOAD_ATTACHMENTS,
    uploadsDir,
    persistUploadBuffer,
    maybeApplyWorkspaceRootFromMessage,
    updateConversationConfiguredWorkspaceRoot,
    getOrCreateConversation,
    ensureRuntimeSessionBinding,
    resolveConversationWorkspaceState,
    linkUploadReferences,
    normalizeAttachments,
    collectReferenceAttachmentsFromText,
    mergeMessageAttachments,
    attachmentSummary,
    createCompactedConversation,
    workspaceRootPayload,
    queueCounts,
    ensureSessionId,
    resolveRequestedModel,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    emitToClientsExceptSessionId,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    resolveSessionStateRoot,
    claudeCloudSessionService,
    // Decides the Copilot switch once on a new database
    // (copilot-settings-service.mjs); absent, an unset switch reads as on.
    detectCopilotCli = null,
  } = deps;
  const isCopilotEnabled = () => copilotEnabledFromStmts(stmts, { detectCli: detectCopilotCli });
  const {
    uploadReadDirs,
    imageInputDenyPaths,
    resolveRequestedReasoningEffort,
    getOpenAIProviderSettings,
    getClaudeProviderSettings,
    getCursorProviderSettings,
    getGrokProviderSettings,
    getClaudeCloudProviderSettings,
    getDeepSeekProviderSettings,
    getClaudeApiProviderSettings,
    rebindUnstartedOpenAIConversationModel,
    claudeBillingSwitchService,
    getClaudeApiCapState,
    imageOperationService,
    remoteRelayInbound,
    readAppSettingText,
    imageSpend,
    readBridgeIdentity,
    emitSessionWorkerTelemetry,
    getConversationSessionState,
    rejectSessionBinding,
  } = shared;

  // Whether a conversation's history holds an image the user attached. Read
  // only for a DeepSeek model switch; prepared on first use, so a database
  // without the messages table (tests) is answered with "no".
  let conversationHasImageStatement = null;
  function conversationHasImageAttachment(conversationId) {
    try {
      conversationHasImageStatement ||= db.prepare(`
        SELECT 1 FROM messages
        WHERE conversation_id = ? AND role = 'user' AND attachments LIKE '%"image/%'
        LIMIT 1
      `);
      return !!conversationHasImageStatement.get(conversationId);
    } catch {
      return false;
    }
  }

  function persistConversationModelPreference(conversationId, relayMode, model, reasoningEffort = '', nowIso = new Date().toISOString()) {
    const convId = String(conversationId || '').trim();
    const mode = normalizeRelayMode(relayMode) || DEFAULT_RELAY_MODE;
    const modelId = String(model || '').trim();
    if (!convId || !mode || !modelId) {
      return {
        preferredRelayMode: mode || DEFAULT_RELAY_MODE,
        preferredModel: '',
        preferredReasoningEffort: '',
      };
    }
    const persisted = persistConversationModelPreferenceTx({
      db,
      stmts,
      conversationId: convId,
      relayMode: mode,
      model: modelId,
      reasoningEffort,
      normalizeMode: (value) => normalizeRelayMode(value) || null,
      fallbackRelayMode: DEFAULT_RELAY_MODE,
      updatedAt: nowIso,
      tolerateMissingColumns: true,
    });
    return {
      preferredRelayMode: persisted.preferredRelayMode || mode,
      preferredModel: persisted.preferredModel || '',
      preferredReasoningEffort: persisted.preferredReasoningEffort || '',
    };
  }

  // The stored preferences, for a send that must leave them alone.
  function readConversationModelPreference(conversationId, fallbackRelayMode = DEFAULT_RELAY_MODE) {
    const row = stmts.getConvAnyStatus?.get?.(String(conversationId || '').trim()) || null;
    return {
      preferredRelayMode: normalizeRelayMode(row?.preferred_relay_mode) || fallbackRelayMode || DEFAULT_RELAY_MODE,
      preferredModel: String(row?.preferred_model || '').trim(),
      preferredReasoningEffort: String(row?.preferred_reasoning_effort || '').trim(),
    };
  }

  // A Resend of a steer a Stop cut off unanswered. Honored only for a user
  // message of this conversation whose own settle marker is kind='stopped' and
  // whose text is what is being sent; anything else is an ordinary send (and
  // gets the ordinary duplicate guard). Returns { originId } to honor it,
  // { alreadyResentAs } when an earlier Resend of it still stands (from any
  // device, at any time), or null.
  function resolveStoppedSteerResend(conversationId, rawMessageId, text) {
    const messageId = String(rawMessageId || '').trim();
    if (!messageId || !conversationId) return null;
    try {
      const original = db.prepare(`
        SELECT id, text, mode FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'
      `).get(messageId, conversationId);
      if (!original) return null;
      // Stored user text may carry the relay's prompt context; the incoming
      // text is already stripped, so compare like with like.
      const originalText = stripRelayPromptContext(original.text, original.mode);
      if (normalizeDuplicateMessageText(originalText) !== normalizeDuplicateMessageText(text)) return null;
      const stopped = db.prepare(`
        SELECT 1 FROM messages
        WHERE conversation_id = ? AND role = 'assistant' AND kind = 'stopped'
          AND (source_message_id = ? OR id IN (SELECT response_message_id FROM queue WHERE id = ?))
        LIMIT 1
      `).get(conversationId, messageId, messageId);
      if (!stopped) return null;
      const earlier = db.prepare(`
        SELECT m.id,
          q.id AS queue_id,
          q.status AS queue_status,
          EXISTS (SELECT 1 FROM messages a WHERE a.role = 'assistant' AND a.source_message_id = m.id) AS answered
        FROM messages m
        LEFT JOIN queue q ON q.id = m.id
        WHERE m.conversation_id = ? AND m.role = 'user' AND m.resend_of_message_id = ?
      `).all(conversationId, messageId);
      const standing = earlier.find((row) => isLiveResend({
        hasQueueRow: !!row.queue_id,
        queueStatus: row.queue_status,
        answered: !!row.answered,
      }));
      if (standing) return { alreadyResentAs: standing.id };
      return { originId: messageId, exemptIds: [messageId, ...earlier.map((row) => row.id)] };
    } catch {
      return null;
    }
  }

  // POST /api/message — browser sends a message
  // The send route's handler. The billing route runs it too, for an agent's
  // send that switches the chat's billing with its message: that request
  // carries `oarBillingSwitch` (set by the route, never read from a body),
  // and the switch happens in the same transaction as the enqueue.
  const handleSendMessage = async (req, res) => {
    const {
      messageId: clientMessageId,
      clientId,
      conversationId,
      text: rawText,
      newConversation,
      model,
      reasoningEffort,
      contextTier,
      relayMode,
      mode,
      providerType,
      provider,
      attachments: rawAttachments,
      imageTarget: rawImageTarget,
      imagePaths: rawImagePaths,
      image: rawImageOptions,
    } = req.body;
    // A prompt from another relay's agent (body `origin` or the
    // X-OAR-Remote-Origin header) is refused while the inbound switch is off.
    // Otherwise its provenance is stored with the message, and it never
    // unlocks relays or touches the composer draft and preferences.
    const remoteRequest = admitRemoteRelayRequest(req, res, remoteRelayInbound);
    if (!remoteRequest) return;
    // Another relay's prompt: every header line it sent goes, and this relay
    // writes its own from the stored origin (the registry's name when the
    // relay signed in with its key, the claimed one marked "(unverified)").
    const text = remoteRequest.remote && !remoteRequest.local && remoteRequest.origin && typeof rawText === 'string'
      ? withRemotePromptHeader(stripAllRemotePromptHeaders(rawText).trim(), remoteRequest.origin)
      : rawText;
    // Not the person (an agent token, or another relay's agent): its send
    // never unlocks relays, touches the composer draft or the saved model,
    // and is held to plan-only (agent auth §2.2).
    const byAgent = notPerson(req, remoteRequest);
    const sessionId = clientId || ensureSessionId(req, res);
    const requesterIdentity = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requesterIdentity?.sessionId);
    let conversationSdkSessionId = null;
    // The conversation's saved choices, for a send that leaves one out: a
    // send to an existing conversation that names no mode runs in the mode
    // the conversation is in, not the relay default.
    const existingConversation = (!newConversation && conversationId)
      ? (stmts.getConvAnyStatus?.get?.(conversationId) || null)
      : null;
    const explicitRelayModeGiven = !!String(relayMode || mode || '').trim();
    const savedRelayMode = !explicitRelayModeGiven && existingConversation?.preferred_relay_mode
      ? normalizeRelayMode(existingConversation.preferred_relay_mode)
      : null;
    const requestedRelayMode = savedRelayMode || normalizeRelayMode(relayMode || mode);
    // Plan-only: an agent's send that names another mode is refused
    // and nothing is queued (nor a billing switched). Without a mode it runs
    // in the session's own. The owner's own sends are not limited.
    if (byAgent && readPlanOnly(existingConversation) && planOnlyRefusesMode(relayMode || mode)) {
      return res.status(409).json({ ...PLAN_ONLY_REFUSAL, conversationId });
    }
    const trimmedText = stripRelayPromptContext(text, requestedRelayMode || relayMode || mode);
    const normalizedAttachments = normalizeAttachments(rawAttachments);
    const requestedAttachmentCount = Math.min(
      MAX_UPLOAD_ATTACHMENTS,
      Array.isArray(rawAttachments) ? rawAttachments.filter((item) => item && typeof item === 'object').length : (rawAttachments ? 1 : 0),
    );
    const referenceResolution = collectReferenceAttachmentsFromText(trimmedText);
    let attachments = mergeMessageAttachments(normalizedAttachments, referenceResolution.attachments);
    const imageTarget = rawImageTarget && typeof rawImageTarget === 'object'
      ? {
          messageId: String(rawImageTarget.messageId || '').trim(),
          imageId: String(rawImageTarget.imageId || '').trim(),
          nodeId: String(rawImageTarget.nodeId || '').trim() || null,
        }
      : null;
    // Images named by path on this relay and the turn's own image options
    // (relay_tool send and create_session). Both go to an OpenAI image
    // session only; the paths are read before anything is stored, and one
    // that may not be read refuses the whole send.
    const refuseImageInput = (error) => res.status(400).json({ code: IMAGE_INPUT_REFUSED_CODE, error });
    const imagePathsGiven = rawImagePaths !== undefined && rawImagePaths !== null;
    const imageOptionsGiven = rawImageOptions !== undefined && rawImageOptions !== null;
    if (imagePathsGiven && (!Array.isArray(rawImagePaths) || rawImagePaths.some((entry) => typeof entry !== 'string'))) {
      return refuseImageInput('imagePaths must be a list of absolute file paths on this relay');
    }
    const imagePathList = imagePathsGiven ? rawImagePaths.filter((entry) => entry !== '') : [];

    if (trimmedText.toLowerCase() === '/compact') {
      if (attachments.length) return res.status(400).json({ error: 'Compact command does not accept attachments' });
      if (!conversationId) return res.status(400).json({ error: 'Compact command requires an existing conversation' });
      const compacted = createCompactedConversation(conversationId);
      if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
      io.emit('conversation_compacted', compacted);
      return res.json({
        ok: true,
        command: 'compact',
        compacted: true,
        sourceConversationId: compacted.sourceConversationId,
        conversationId: compacted.targetConversationId,
        compactedConversationId: compacted.targetConversationId,
        runtimeSessionId: compacted.runtimeSessionId,
        summarySeedPreview: compacted.summarySeed.slice(0, 240),
      });
    }

    if (!trimmedText && attachments.length === 0) return res.status(400).json({ error: 'Empty message' });
    const shouldCreateConversation = !!newConversation || !conversationId;
    // A new session by an agent token's own request: through relay_tool
    // only, where the dispatcher's rules apply (as on the bootstrap route).
    if (shouldCreateConversation && isDirectAgentRequest(req)) {
      return res.status(403).json({ ok: false, code: AUTH_ERROR_CODES.relayToolRequired, error: AUTH_RELAY_TOOL_REQUIRED_MESSAGE });
    }
    const existingRuntimeSession = shouldCreateConversation
      ? null
      : (stmts.getRuntimeSessionByConversation.get(conversationId) || null);
    const configuredOpenAI = getOpenAIProviderSettings();
    const requestedProviderType = normalizeRequestedProviderType(providerType || provider);
    const boundProviderType = String(existingRuntimeSession?.provider_type || '').trim().toLowerCase();
    // A Claude chat runs on the subscription (`claude`) or the saved API key
    // (`claude-api`). A send never moves it: the billing route does
    // (claude-billing-switch-service.mjs). A send that names the other
    // billing is refused, and so is one from a page that still showed the
    // other one (`billing`), so nobody's turn runs on a bill they did not
    // see. A send without `billing` (an older page, an agent) is not checked.
    const boundClaudeBilling = shouldCreateConversation ? '' : normalizeClaudeBilling(boundProviderType);
    const billingSwitch = boundClaudeBilling && req.oarBillingSwitch
      ? { to: normalizeClaudeBilling(req.oarBillingSwitch.to), by: String(req.oarBillingSwitch.by || 'agent') }
      : null;
    if (boundClaudeBilling && !billingSwitch) {
      const namedBilling = normalizeClaudeBilling(requestedProviderType);
      if (namedBilling && namedBilling !== boundClaudeBilling) {
        return res.status(409).json({
          error: `This chat runs on the ${boundClaudeBilling === 'claude-api' ? 'Claude API key' : 'Claude subscription'}. Switch its billing first; a send does not.`,
          code: 'CLAUDE_BILLING_SWITCH_REQUIRED',
          conversationId,
          billing: boundClaudeBilling,
        });
      }
      const shownBilling = normalizeClaudeBilling(req.body?.billing);
      if (shownBilling && shownBilling !== boundClaudeBilling) {
        // The text is not lost: it goes into the chat's draft (after what is
        // there), where every page shows it, so a page's own retry and a
        // replay from the outbox both leave it for the user to send again.
        const keptText = String(trimmedText || '').trim();
        const conversationRow = keptText ? (stmts.getConvAnyStatus?.get?.(conversationId) || null) : null;
        if (conversationRow) {
          const draft = String(conversationRow.draft_text || '');
          if (!draft.includes(keptText)) {
            const keptDraft = draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${keptText}` : keptText;
            const keptAt = new Date().toISOString();
            db.prepare(`UPDATE conversations SET draft_text = ?, draft_updated_at = ?, draft_updated_by_client_id = NULL WHERE id = ?`)
              .run(keptDraft, keptAt, conversationId);
            // The draft's attachments stay what they are: the update must not
            // clear them on the other pages.
            let keptAttachments = [];
            try {
              const parsed = JSON.parse(String(conversationRow.draft_attachments || '[]'));
              keptAttachments = Array.isArray(parsed) ? parsed : [];
            } catch {
              keptAttachments = [];
            }
            io.emit('conversation_draft_updated', {
              conversationId,
              draftText: keptDraft,
              draftAttachments: keptAttachments,
              draftUpdatedAt: keptAt,
              draftUpdatedByClientId: null,
              senderClientId: null,
            });
          }
        }
        return res.status(409).json({
          error: `This chat now runs on the ${boundClaudeBilling === 'claude-api' ? 'Claude API key' : 'Claude subscription'}. Send again to confirm.`,
          code: 'CLAUDE_BILLING_CHANGED',
          conversationId,
          billing: boundClaudeBilling,
          keptInDraft: true,
        });
      }
    }
    // A switch with the message: the rest of the send resolves the model,
    // effort and limits against the billing it switches to.
    const runtimeProviderType = billingSwitch?.to || boundProviderType;
    // A Copilot chat (provider `github`, or none: a chat from before
    // providers) does not take a message while Copilot is switched off. It
    // is not moved; switched on again, it works, and the message is sent
    // again by hand. OpenAI chats share Copilot's worker but not its switch.
    if (!shouldCreateConversation && (runtimeProviderType === 'github' || runtimeProviderType === '') && !isCopilotEnabled()) {
      return res.status(409).json({
        error: 'Copilot is switched off on this relay, so this message was not sent. Switch it on in Settings → Providers → Copilot.',
        code: 'COPILOT_SWITCHED_OFF',
        conversationId,
      });
    }
    // An agent's send to a chat on the key while this month's cap is reached
    // is refused before anything is stored, so the agent hears it at once (a
    // page's send is queued and refused at the claim, with its note there).
    // A send that switches to the key was refused by the switch's own check;
    // one that names the key for a chat already on it (a switch that changes
    // nothing) is refused here like any other.
    if (byAgent && (!billingSwitch || billingSwitch.to === 'claude-api') && runtimeProviderType === 'claude-api') {
      let cap = null;
      try { cap = getClaudeApiCapState() || null; } catch { cap = { reached: true }; }
      if (cap?.reached === true) {
        return res.status(409).json({
          error: `${String(cap.error || '').trim() || 'This month\'s Claude API spend has reached its cap.'} Nothing was queued. Send with provider "claude" to move the session to the Claude subscription, or ask the user to raise the cap.`,
          code: 'CLAUDE_API_CAP_REACHED',
          conversationId,
          billing: 'claude-api',
        });
      }
    }
    const runtimeUsesOpenAI = runtimeProviderType === 'openai';
    // Providers that resell each other's model ids ("claude-opus-5" is served by
    // Claude, Copilot and Cursor alike) make a model id useless for deciding
    // which provider a request targets. A session already bound to an explicit
    // provider resolves ids against that provider's own catalog, so the
    // cross-provider guards below must not infer a switch from the id alone.
    // A session already bound to a managed provider resolves models against
    // that provider's catalog. Include every non-github worker provider here
    // so cross-provider mid-chat guards do not mis-fire (e.g. Cursor listing
    // a Grok model id must not 409 a Grok-bound conversation).
    const runtimeBoundToExplicitProvider = runtimeProviderType === 'openai'
      || runtimeProviderType === 'claude'
      || runtimeProviderType === 'cursor'
      || runtimeProviderType === 'grok'
      || runtimeProviderType === 'claude-cloud'
      || runtimeProviderType === 'deepseek'
      || runtimeProviderType === 'claude-api';
    const configuredOpenAIModel = String(configuredOpenAI?.model || '').trim();
    const availableOpenAIModels = new Set(
      (Array.isArray(configuredOpenAI?.models) ? configuredOpenAI.models : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    const requestedOpenAIModel = String(model || '').trim();
    const requestedModelLooksOpenAI = !!requestedOpenAIModel && (
      requestedOpenAIModel === configuredOpenAIModel || availableOpenAIModels.has(requestedOpenAIModel)
    );
    const requestedGitHubModelResolution = requestedOpenAIModel
      ? resolveRequestedModel(model)
      : null;
    const requestedModelAvailableInGitHub = requestedGitHubModelResolution?.ok === true;
    const useOpenAIProvider = runtimeUsesOpenAI
      || (shouldCreateConversation && (
        requestedProviderType === 'openai'
        || (requestedProviderType === '' && (
          configuredOpenAI?.enabled === true
          && requestedModelLooksOpenAI
        ))
      ));
    if (
      !shouldCreateConversation
      && !runtimeUsesOpenAI
      && requestedModelLooksOpenAI
      && (
        requestedProviderType === 'openai'
        || (!requestedModelAvailableInGitHub && !runtimeBoundToExplicitProvider)
      )
    ) {
      return res.status(409).json({
        error: 'OpenAI model selection requires creating a new OpenAI conversation',
        code: 'OPENAI_MODEL_REQUIRES_NEW_CONVERSATION',
      });
    }
    if (shouldCreateConversation && requestedProviderType === 'openai' && configuredOpenAI?.configured !== true) {
      return res.status(400).json({
        error: 'OpenAI API key is not configured',
        code: 'OPENAI_NOT_CONFIGURED',
      });
    }
    // This create path can only bind github/openai sessions. Accepting a
    // Cursor, Grok or Claude request here would silently produce a GitHub
    // conversation running a model the caller never asked for.
    const bootstrapOnlyProvider = shouldCreateConversation
      ? BOOTSTRAP_ONLY_PROVIDER_LABELS[requestedProviderType]
      : null;
    if (bootstrapOnlyProvider) {
      // 409 to match its siblings (CURSOR/GROK_MODEL_REQUIRES_NEW_CONVERSATION),
      // which report the same "wrong entry point for this provider" condition.
      return res.status(409).json({
        error: `Creating a ${bootstrapOnlyProvider} conversation requires POST /api/conversation/bootstrap`,
        code: 'PROVIDER_REQUIRES_BOOTSTRAP',
      });
    }
    // A first send that would create a Copilot chat while Copilot is off is
    // refused, as on the bootstrap route; nothing is created.
    if (shouldCreateConversation && !useOpenAIProvider && !isCopilotEnabled()) {
      const named = requestedProviderType === 'github' || requestedModelAvailableInGitHub;
      return res.status(400).json(copilotOffCreateRefusal({ named }));
    }
    const requestedConfiguredOpenAIModel = configuredOpenAI?.enabled
      && String(model || '').trim() === String(configuredOpenAI.model || '').trim();
    if (shouldRequireNewOpenAIConversation({
      shouldCreateConversation,
      runtimeUsesOpenAI,
      requestedConfiguredOpenAIModel,
      githubModelAvailable: requestedConfiguredOpenAIModel && requestedModelAvailableInGitHub,
      runtimeBoundToOtherProvider: runtimeBoundToExplicitProvider && !runtimeUsesOpenAI,
    })) {
      return res.status(409).json({
        error: 'The configured OpenAI model is available only when creating a new conversation',
        code: 'OPENAI_MODEL_REQUIRES_NEW_CONVERSATION',
      });
    }
    // A Copilot conversation is bound too, for the model-id guards below only:
    // Copilot resells Claude and GPT models under ids of its own
    // ("claude-opus-5.5"), so a Claude-form id another provider lists
    // ("claude-opus-5-5") is a model Copilot lacks, answered by the Copilot
    // check further down, never a switch to Cursor, Grok or DeepSeek. (It is
    // not in runtimeBoundToExplicitProvider: that one also picks the catalog.)
    const runtimeBoundForModelGuards = runtimeBoundToExplicitProvider || runtimeProviderType === 'github';
    // Cursor conversations are bootstrap-created only, so an existing
    // github/openai/claude conversation cannot cross to the Cursor provider
    // mid-conversation. Cursor settings are read lazily so the hot path stays
    // untouched for non-Cursor requests.
    const runtimeUsesCursor = runtimeProviderType === 'cursor';
    if (!shouldCreateConversation && !runtimeUsesCursor) {
      let requestTargetsCursor = requestedProviderType === 'cursor';
      if (
        !requestTargetsCursor
        && !runtimeBoundForModelGuards
        && requestedOpenAIModel
        && !requestedModelAvailableInGitHub
      ) {
        const cursorSettings = getCursorProviderSettings();
        const cursorOnlyModels = new Set([
          String(cursorSettings?.model || '').trim(),
          ...(Array.isArray(cursorSettings?.models) ? cursorSettings.models : [])
            .map((value) => String(value || '').trim()),
        ].filter(Boolean));
        requestTargetsCursor = cursorSettings?.enabled === true && cursorOnlyModels.has(requestedOpenAIModel);
      }
      if (requestTargetsCursor) {
        return res.status(409).json({
          error: 'Cursor model selection requires creating a new Cursor conversation',
          code: 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION',
        });
      }
    }
    // Grok conversations are bootstrap-created only (same isolation as Cursor).
    const runtimeUsesGrok = runtimeProviderType === 'grok';
    if (!shouldCreateConversation && !runtimeUsesGrok) {
      let requestTargetsGrok = requestedProviderType === 'grok';
      if (
        !requestTargetsGrok
        && !runtimeBoundForModelGuards
        && requestedOpenAIModel
        && !requestedModelAvailableInGitHub
      ) {
        const grokSettings = getGrokProviderSettings();
        const grokOnlyModels = new Set([
          String(grokSettings?.model || '').trim(),
          ...(Array.isArray(grokSettings?.models) ? grokSettings.models : [])
            .map((value) => String(value || '').trim()),
        ].filter(Boolean));
        requestTargetsGrok = grokSettings?.enabled === true && grokOnlyModels.has(requestedOpenAIModel);
      }
      if (requestTargetsGrok) {
        return res.status(409).json({
          error: 'Grok model selection requires creating a new Grok conversation',
          code: 'GROK_MODEL_REQUIRES_NEW_CONVERSATION',
        });
      }
    }
    // DeepSeek conversations are bootstrap-created only too. Its ids are its
    // own ("deepseek-*"), so an id alone may name it for an unbound session.
    const runtimeUsesDeepSeek = runtimeProviderType === 'deepseek';
    if (!shouldCreateConversation && !runtimeUsesDeepSeek) {
      let requestTargetsDeepSeek = requestedProviderType === 'deepseek';
      if (
        !requestTargetsDeepSeek
        && !runtimeBoundForModelGuards
        && requestedOpenAIModel
        && !requestedModelAvailableInGitHub
      ) {
        const deepseekSettings = getDeepSeekProviderSettings();
        const deepseekOnlyModels = new Set([
          String(deepseekSettings?.model || '').trim(),
          ...(Array.isArray(deepseekSettings?.models) ? deepseekSettings.models : [])
            .map((value) => String(value || '').trim()),
        ].filter(Boolean));
        requestTargetsDeepSeek = deepseekSettings?.enabled === true && deepseekOnlyModels.has(requestedOpenAIModel);
      }
      if (requestTargetsDeepSeek) {
        return res.status(409).json({
          error: 'DeepSeek model selection requires creating a new DeepSeek conversation',
          code: 'DEEPSEEK_MODEL_REQUIRES_NEW_CONVERSATION',
        });
      }
    }
    // Claude Cloud conversations are bootstrap-created only as well: each
    // carries the repository its cloud session clones. Only an explicit
    // provider counts here — the cloud's model ids are the Claude provider's
    // own, so an id alone never means "cloud".
    const runtimeUsesClaudeCloud = runtimeProviderType === 'claude-cloud';
    if (!shouldCreateConversation && !runtimeUsesClaudeCloud && requestedProviderType === 'claude-cloud') {
      return res.status(409).json({
        error: 'Claude Cloud requires creating a new Claude Cloud conversation',
        code: 'CLAUDE_CLOUD_REQUIRES_NEW_CONVERSATION',
      });
    }
    // Claude API conversations are bootstrap-created only as well, and asked
    // for by name only: their model ids are the Claude provider's. Moving a
    // chat between the subscription and the key is not a send's to make here.
    const runtimeUsesClaudeApi = runtimeProviderType === 'claude-api';
    if (!shouldCreateConversation && !runtimeUsesClaudeApi && requestedProviderType === 'claude-api') {
      return res.status(409).json({
        error: 'Claude API requires creating a new Claude API conversation',
        code: 'CLAUDE_API_REQUIRES_NEW_CONVERSATION',
      });
    }
    if (
      useOpenAIProvider
      && requestedOpenAIModel
      && requestedOpenAIModel !== String(existingRuntimeSession?.provider_model || '').trim()
      && requestedOpenAIModel !== configuredOpenAIModel
      && !availableOpenAIModels.has(requestedOpenAIModel)
    ) {
      return res.status(400).json({
        error: `OpenAI model "${requestedOpenAIModel}" is not available`,
        code: 'OPENAI_MODEL_UNAVAILABLE',
      });
    }
    if (
      runtimeUsesOpenAI
      && requestedOpenAIModel
      && requestedOpenAIModel !== String(existingRuntimeSession?.provider_model || '').trim()
    ) {
      if (typeof rebindUnstartedOpenAIConversationModel !== 'function') {
        return res.status(409).json({
          error: 'OpenAI session model cannot be changed after the session starts',
          code: 'OPENAI_SESSION_MODEL_LOCKED',
        });
      }
      try {
        const reboundRuntime = await rebindUnstartedOpenAIConversationModel({
          conversationId,
          model: requestedOpenAIModel,
        });
        existingRuntimeSession.provider_model = reboundRuntime?.provider_model || requestedOpenAIModel;
        existingRuntimeSession.model = reboundRuntime?.model || requestedOpenAIModel;
      } catch (error) {
        return res.status(409).json({
          error: String(error?.message || error || 'Failed to change OpenAI session model'),
          code: 'OPENAI_SESSION_MODEL_REBIND_FAILED',
        });
      }
    }
    const openAIModel = runtimeUsesOpenAI
      ? String(existingRuntimeSession?.provider_model || existingRuntimeSession?.model || '').trim()
      : (
          requestedOpenAIModel === configuredOpenAIModel || availableOpenAIModels.has(requestedOpenAIModel)
            ? requestedOpenAIModel
            : configuredOpenAIModel
        );
    // Claude conversations resolve models against the Claude provider
    // catalog (the Copilot catalog does not know these ids). Per-turn model
    // switching is allowed: each Claude turn is a fresh query() with resume.
    // A Claude API conversation runs the same CLI on an API key: the same
    // rules, against its own model list and efforts.
    const runtimeUsesClaude = runtimeProviderType === 'claude' || runtimeUsesClaudeApi;
    const configuredClaude = runtimeUsesClaude
      ? (runtimeUsesClaudeApi ? getClaudeApiProviderSettings() : getClaudeProviderSettings())
      : null;
    const requestedClaudeModel = runtimeUsesClaude ? String(model || '').trim() : '';
    const availableClaudeModels = new Set([
      String(configuredClaude?.model || '').trim(),
      String(existingRuntimeSession?.provider_model || '').trim(),
      ...(Array.isArray(configuredClaude?.availableModels) ? configuredClaude.availableModels : []),
      ...(Array.isArray(configuredClaude?.models) ? configuredClaude.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean)
      .flatMap((value) => [value, claudeBaseModelId(value)])
      .filter(Boolean));
    // The composer sends the base Claude model id plus a context tier; the
    // "[1m]" long-context variant id is composed here so the worker (and the
    // context-usage accounting) keep seeing the id the Agent SDK expects.
    const applyClaudeContextTier = (modelId) => {
      const requestedTier = String(contextTier || 'default').trim().toLowerCase();
      const baseId = claudeBaseModelId(modelId);
      if (requestedTier === 'long_context') {
        const variantId = claudeLongContextModelId(modelId);
        const variantMatch = Array.from(availableClaudeModels)
          .find((id) => id.toLowerCase() === variantId.toLowerCase());
        return variantMatch || modelId;
      }
      return baseId && (availableClaudeModels.has(baseId) || baseId === modelId) ? baseId : modelId;
    };
    const claudeModel = runtimeUsesClaude
      ? applyClaudeContextTier(
          availableClaudeModels.has(requestedClaudeModel)
            ? requestedClaudeModel
            : (String(existingRuntimeSession?.provider_model || '').trim() || String(configuredClaude?.model || '').trim()),
        )
      : '';
    // Cursor conversations resolve models against the Cursor provider catalog
    // (the Copilot catalog does not know these ids). Per-turn model switching
    // is allowed: each Cursor turn resumes the persisted agent.
    const configuredCursor = runtimeUsesCursor ? getCursorProviderSettings() : null;
    const requestedCursorModel = runtimeUsesCursor ? String(model || '').trim() : '';
    const availableCursorModels = [
      String(configuredCursor?.model || '').trim(),
      String(existingRuntimeSession?.provider_model || '').trim(),
      ...(Array.isArray(configuredCursor?.models) ? configuredCursor.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    // A model the Cursor provider does not offer is refused instead of quietly
    // relabelled: silently answering with the pinned/default model is how a
    // conversation ended up running a different model than the composer showed.
    const cursorModelSelection = runtimeUsesCursor
      ? resolveProviderModelSelection({
          requestedModel: requestedCursorModel,
          configuredModel: String(existingRuntimeSession?.provider_model || '').trim()
            || String(configuredCursor?.model || '').trim(),
          availableModels: availableCursorModels,
        })
      : null;
    if (cursorModelSelection && !cursorModelSelection.ok) {
      return res.status(400).json({
        error: `Cursor model "${cursorModelSelection.requestedModel}" is not available`,
        code: 'CURSOR_MODEL_UNAVAILABLE',
        supportedModels: cursorModelSelection.availableModels || [],
      });
    }
    const cursorModel = cursorModelSelection ? cursorModelSelection.model : '';
    const configuredGrok = runtimeUsesGrok ? getGrokProviderSettings() : null;
    const requestedGrokModel = runtimeUsesGrok ? String(model || '').trim() : '';
    const pinnedGrokModel = runtimeUsesGrok
      ? String(existingRuntimeSession?.provider_model || '').trim()
      : '';
    // The Grok ACP surface has no mid-session model switch (the model rides
    // only on session/new `_meta`), so the model pinned at bootstrap is
    // locked for the conversation's lifetime. A different request is refused
    // rather than silently relabeled.
    if (
      runtimeUsesGrok
      && requestedGrokModel
      && requestedGrokModel.toLowerCase() !== AUTO_MODEL_SENTINEL
      && pinnedGrokModel
      && requestedGrokModel.toLowerCase() !== pinnedGrokModel.toLowerCase()
    ) {
      return res.status(409).json({
        error: 'Grok model switching requires creating a new Grok conversation',
        code: 'GROK_MODEL_REQUIRES_NEW_CONVERSATION',
      });
    }
    const grokModel = runtimeUsesGrok
      ? (pinnedGrokModel || String(configuredGrok?.model || '').trim())
      : '';
    // Claude Cloud conversations resolve models against the cloud provider's
    // own list (plain ids, no "[1m]" tier). The first message creates the
    // cloud session with the conversation's model; a later change is applied
    // by the worker before the next message (see below).
    const configuredClaudeCloud = runtimeUsesClaudeCloud ? getClaudeCloudProviderSettings() : null;
    const pinnedClaudeCloudModel = runtimeUsesClaudeCloud
      ? stripModelTierSuffix(existingRuntimeSession?.provider_model)
      : '';
    const claudeCloudModelSelection = runtimeUsesClaudeCloud
      ? resolveProviderModelSelection({
          requestedModel: stripModelTierSuffix(model),
          configuredModel: pinnedClaudeCloudModel || String(configuredClaudeCloud?.defaultModel || '').trim(),
          availableModels: Array.isArray(configuredClaudeCloud?.models) ? configuredClaudeCloud.models : [],
        })
      : null;
    if (claudeCloudModelSelection && !claudeCloudModelSelection.ok) {
      return res.status(400).json({
        error: `Claude Cloud model "${claudeCloudModelSelection.requestedModel}" is not available`,
        code: 'CLAUDE_CLOUD_MODEL_UNAVAILABLE',
        supportedModels: claudeCloudModelSelection.availableModels || [],
      });
    }
    // A cloud session's model can be switched between turns (the worker
    // sends set_model before the message), so a changed model is taken as
    // for a local Claude chat.
    const claudeCloudModel = claudeCloudModelSelection ? claudeCloudModelSelection.model : '';
    // DeepSeek conversations resolve models against the DeepSeek catalog and
    // may switch between turns, like Claude ones (the worker's CLI switches
    // before the next message). A model DeepSeek does not offer is refused.
    const configuredDeepSeek = runtimeUsesDeepSeek ? getDeepSeekProviderSettings() : null;
    const pinnedDeepSeekModel = runtimeUsesDeepSeek ? String(existingRuntimeSession?.provider_model || '').trim() : '';
    const deepseekModelSelection = runtimeUsesDeepSeek
      ? resolveProviderModelSelection({
          requestedModel: String(model || '').trim(),
          configuredModel: pinnedDeepSeekModel || String(configuredDeepSeek?.model || '').trim(),
          availableModels: [
            String(configuredDeepSeek?.model || '').trim(),
            pinnedDeepSeekModel,
            ...(Array.isArray(configuredDeepSeek?.models) ? configuredDeepSeek.models : []),
          ].map((value) => String(value || '').trim()).filter(Boolean),
        })
      : null;
    if (deepseekModelSelection && !deepseekModelSelection.ok) {
      return res.status(400).json({
        error: `DeepSeek model "${deepseekModelSelection.requestedModel}" is not available`,
        code: 'DEEPSEEK_MODEL_UNAVAILABLE',
        supportedModels: deepseekModelSelection.availableModels || [],
      });
    }
    const deepseekModel = deepseekModelSelection ? deepseekModelSelection.model : '';
    // A model without image input cannot take over a session whose transcript
    // carries images: the resumed history would fail the whole request.
    if (
      runtimeUsesDeepSeek
      && deepseekModel
      && pinnedDeepSeekModel
      && deepseekModel.toLowerCase() !== pinnedDeepSeekModel.toLowerCase()
      && !deepseekModelAcceptsImages(deepseekModel)
      && conversationHasImageAttachment(conversationId)
    ) {
      return res.status(409).json({
        error: `${deepseekModelLabel(deepseekModel)} takes no images, and this conversation already has some. Stay on ${deepseekModelLabel(pinnedDeepSeekModel)}, or start a new DeepSeek conversation for ${deepseekModelLabel(deepseekModel)}.`,
        code: 'DEEPSEEK_MODEL_TEXT_ONLY',
      });
    }
    // What the request itself chose. Only these are saved as the
    // conversation's preference; a value filled in below never is.
    const explicitModelGiven = !!requestedOpenAIModel;
    const conversationReasoningEffort = String(existingConversation?.preferred_reasoning_effort || '').trim().toLowerCase();
    // A Copilot conversation sent no model keeps its own: the saved
    // preference, the runtime session's model, the latest user message's,
    // and the catalog default only when it has none of these. A model the
    // catalog no longer lists is refused rather than swapped for another.
    const usesGitHubCatalog = !useOpenAIProvider && !runtimeBoundToExplicitProvider;
    const inheritedModel = usesGitHubCatalog && !shouldCreateConversation && !explicitModelGiven
      ? inheritedConversationModel({
          conversation: existingConversation,
          runtimeSession: existingRuntimeSession,
          latestUserMessageModel: stmts.getLatestUserMessageModel?.get?.(conversationId)?.model || '',
        })
      : null;
    // Copilot lists image ids its runtime cannot serve: a Copilot chat on one
    // is refused with a pointer to an OpenAI Image chat, whoever sends.
    const copilotModelId = usesGitHubCatalog ? String(inheritedModel ? inheritedModel.model : (model || '')).trim() : '';
    if (copilotModelId && isOpenAIImageModelId(copilotModelId)) {
      return res.status(400).json({
        error: `${openAIImageModelNeedsOpenAIText(copilotModelId)} Nothing was sent.`,
        code: OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE,
        ...(conversationId ? { conversationId } : {}),
      });
    }
    const githubModelResolution = usesGitHubCatalog
      ? resolveRequestedModel(inheritedModel ? inheritedModel.model : model)
      : null;
    if (inheritedModel && !githubModelResolution?.ok) {
      return res.status(409).json({
        error: `This conversation's model "${inheritedModel.model}" is no longer available. Choose a model and send again.`,
        code: 'CONVERSATION_MODEL_UNAVAILABLE',
        conversationId,
        model: inheritedModel.model,
        supportedModels: githubModelResolution?.available || [],
      });
    }
    const modelResolution = useOpenAIProvider
      ? {
          ok: !!openAIModel,
          model: openAIModel,
          modelVariantId: openAIModel,
          reasoningEffort: null,
          error: openAIModel ? null : 'OpenAI model is not configured',
        }
      : (runtimeUsesClaude
        ? {
            ok: !!claudeModel,
            model: claudeModel,
            modelVariantId: claudeModel,
            reasoningEffort: null,
            error: claudeModel ? null : 'Claude model is not configured',
          }
        : (runtimeUsesCursor
          ? {
              ok: !!cursorModel,
              model: cursorModel,
              modelVariantId: cursorModel,
              reasoningEffort: null,
              error: cursorModel ? null : 'Cursor model is not configured',
            }
          : (runtimeUsesGrok
            ? {
                ok: !!grokModel,
                model: grokModel,
                modelVariantId: grokModel,
                reasoningEffort: null,
                error: grokModel ? null : 'Grok model is not configured',
              }
            : (runtimeUsesClaudeCloud
              ? {
                  ok: !!claudeCloudModel,
                  model: claudeCloudModel,
                  modelVariantId: claudeCloudModel,
                  reasoningEffort: null,
                  error: claudeCloudModel ? null : 'Claude Cloud model is not configured',
                }
              : (runtimeUsesDeepSeek
                ? {
                    ok: !!deepseekModel,
                    model: deepseekModel,
                    modelVariantId: deepseekModel,
                    reasoningEffort: null,
                    error: deepseekModel ? null : 'DeepSeek model is not configured',
                  }
                : githubModelResolution)))));
    // A model Copilot does not list is named with its close matches, as the
    // bootstrap names it: "claude-opus-5-5" (the Claude form) gets "did you
    // mean 'claude-opus-5.5'?". Refused before anything is stored.
    if (!modelResolution.ok && modelResolution === githubModelResolution && explicitModelGiven) {
      const copilotCheck = checkRequestedProviderModel({
        requestedModel: requestedOpenAIModel,
        provider: 'github',
        models: Array.isArray(githubModelResolution.available) ? githubModelResolution.available : [],
      });
      if (copilotCheck.status === 'unknown') {
        return res.status(400).json({
          error: unknownProviderModelText({ model: copilotCheck.model, provider: 'github', suggestions: copilotCheck.suggestions, models: copilotCheck.models }),
          code: 'COPILOT_MODEL_UNAVAILABLE',
          supportedModels: copilotCheck.models,
          ...(copilotCheck.suggestions.length ? { suggestedModels: copilotCheck.suggestions } : {}),
        });
      }
    }
    if (!modelResolution.ok) return res.status(400).json({ error: modelResolution.error, supportedModels: modelResolution.available || [] });
    const requestedModel = String(modelResolution.model || '').trim();
    const requestedAutoModel = requestedModel.toLowerCase() === AUTO_MODEL_SENTINEL;
    if (requestedAutoModel && conversationId && !newConversation) {
      const messageCount = Number(stmts.getConversationMessageCount?.get?.(conversationId)?.count || 0);
      const activeQueueCount = Number(stmts.getConversationActiveQueueCount?.get?.(conversationId)?.count || 0);
      if (messageCount > 0 || activeQueueCount > 0) {
        return res.status(409).json({
          error: 'Auto model selection is available only for a new conversation',
          code: 'AUTO_MODEL_REQUIRES_NEW_CONVERSATION',
          conversationId,
        });
      }
    }
    const requestedModelVariantId = String(modelResolution.modelVariantId || model || requestedModel).trim();
    const explicitReasoningEffort = String(reasoningEffort || '').trim();
    const requestedContextTier = String(contextTier || 'default').trim().toLowerCase();
    const openAIImageModel = useOpenAIProvider && isOpenAIImageModelId(requestedModel);
    if (imageTarget && !openAIImageModel) {
      return res.status(400).json({
        error: 'Select an image model before editing a generated image',
        code: 'IMAGE_TARGET_REQUIRES_IMAGE_MODEL',
      });
    }
    if ((imagePathsGiven || imageOptionsGiven) && !openAIImageModel) {
      return refuseImageInput(`Images and image options go to an OpenAI image session; this session runs ${requestedModel || 'no image model'}`);
    }
    // An image turn from another relay's agent takes its images from
    // `imagePaths` alone: an @file: token resolves against this relay's
    // workspace root, not the session's folder, and carries no stored copy.
    let ignoredReferenceAttachments = 0;
    if (remoteRequest.remote && openAIImageModel && referenceResolution.attachments.length) {
      ignoredReferenceAttachments = referenceResolution.attachments.length;
      attachments = mergeMessageAttachments(normalizedAttachments, []);
    }
    // A send that names no effort runs with the conversation's own, clamped
    // to the nearest level the model has. Null when there is nothing to keep
    // or it neither matches nor clamps (an ultracode on a model without it):
    // the provider's own default applies then.
    const conversationEffortFor = (supported) => (
      !explicitReasoningEffort && conversationReasoningEffort
        ? (fallbackReasoningEffort([conversationReasoningEffort], supported, { fallback: '' }) || null)
        : null
    );
    // Claude conversations validate effort against the Claude provider's
    // per-model levels ('none' = SDK default). Effort is per-turn: each Claude
    // turn is a fresh query(), so it can change between messages.
    const resolveClaudeReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const supported = Array.isArray(configuredClaude?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()])
        ? configuredClaude.effortsByModel[String(requestedModel || '').trim().toLowerCase()]
        : [...DEFAULT_CLAUDE_REASONING_EFFORTS];
      const kept = conversationEffortFor(supported);
      if (kept) return { ok: true, effort: kept, supported };
      const effort = supported.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort: effort === 'none' ? 'none' : effort, supported };
    };
    // Cursor conversations validate effort against the discovered per-model
    // tiers ('none' = reasoning/thinking off where the model can express it,
    // model default otherwise). Effort is per-turn: it maps onto model params
    // on each agent.send, so it can change between messages.
    const resolveCursorReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const discovered = configuredCursor?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()];
      if (!Array.isArray(discovered)) {
        // 'auto' / undiscovered model: pass the request through untouched —
        // the worker validates it against the resolved model's live params
        // and falls back to the model default on any mismatch. Clamping to
        // 'none' here would actively disable thinking on the resolved model.
        // The conversation's own effort goes through the same way.
        return { ok: true, effort: requestedEffort || conversationReasoningEffort, supported: [] };
      }
      const kept = conversationEffortFor(discovered);
      if (kept) return { ok: true, effort: kept, supported: discovered };
      const effort = discovered.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort, supported: discovered };
    };
    const resolveGrokReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const supported = Array.isArray(configuredGrok?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()])
        ? configuredGrok.effortsByModel[String(requestedModel || '').trim().toLowerCase()]
        : ['none', 'low', 'medium', 'high'];
      const kept = conversationEffortFor(supported);
      if (kept) return { ok: true, effort: kept, supported };
      const effort = supported.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort, supported };
    };
    // DeepSeek takes none/low/high/max for every model; other names map to
    // what DeepSeek would run ("medium" is high), and no stated effort is the
    // conversation's own, else high, DeepSeek's default.
    const resolveDeepSeekReasoningEffort = () => {
      const supported = [...DEEPSEEK_REASONING_EFFORTS];
      const requestedEffort = deepseekReasoningEffortFor(explicitReasoningEffort);
      if (requestedEffort) return { ok: true, effort: requestedEffort, supported };
      const kept = deepseekReasoningEffortFor(conversationReasoningEffort);
      return { ok: true, effort: kept || DEFAULT_DEEPSEEK_REASONING_EFFORT, supported };
    };
    let reasoningResolution = useOpenAIProvider
      ? resolveOpenAIReasoningEffort(
          explicitReasoningEffort || conversationEffortFor(openAIReasoningEffortsForModel(openAIModel)) || '',
          openAIModel,
        )
      : (runtimeUsesClaude
        ? resolveClaudeReasoningEffort()
        : (runtimeUsesCursor
          ? resolveCursorReasoningEffort()
          : (runtimeUsesGrok
            ? resolveGrokReasoningEffort()
            // A cloud session takes no effort: whatever was asked, it is none.
            : (runtimeUsesClaudeCloud
              ? { ok: true, effort: 'none', supported: ['none'] }
              : (runtimeUsesDeepSeek
                ? resolveDeepSeekReasoningEffort()
                : resolveRequestedReasoningEffort(
                    requestedModel,
                    explicitReasoningEffort || modelResolution.reasoningEffort || null,
                  ))))));
    // No effort sent (or the model's variant carried one it lacks): the
    // conversation's own effort, clamped to the model's levels, else its
    // lowest level that is not 'none'. Some models list 'none' and the API
    // still refuses it, so it is taken only when the conversation chose it or
    // the model has nothing else.
    if (!reasoningResolution?.ok && !explicitReasoningEffort) {
      const supportedEfforts = Array.isArray(reasoningResolution?.supported)
        ? reasoningResolution.supported.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const fallbackEffort = fallbackReasoningEffort(
        [modelResolution.reasoningEffort, conversationReasoningEffort],
        supportedEfforts,
      );
      if (fallbackEffort) {
        reasoningResolution = resolveRequestedReasoningEffort(requestedModel, fallbackEffort);
      }
    }
    if (!reasoningResolution?.ok) {
      return res.status(400).json({
        error: reasoningResolution?.error || 'Unsupported reasoning effort',
        supportedReasoningEfforts: Array.isArray(reasoningResolution?.supported) ? reasoningResolution.supported : [],
      });
    }
    const requestedReasoningEffort = reasoningResolution.effort || null;
    // The request's own effort: sent as such, or carried by the variant id of
    // a model it named.
    const explicitEffortGiven = !!explicitReasoningEffort || (explicitModelGiven && !!modelResolution.reasoningEffort);
    let normalizedContextTier = requestedContextTier;
    if (openAIImageModel) {
      normalizedContextTier = normalizeOpenAIImageSize(requestedContextTier) || 'auto';
      if (!normalizedContextTier) {
        return res.status(400).json({ error: 'Unsupported image size option' });
      }
    } else if (!['default', 'long_context'].includes(requestedContextTier)) {
      return res.status(400).json({ error: 'Unsupported context tier' });
    } else if (runtimeUsesClaudeCloud || runtimeUsesDeepSeek) {
      // The cloud has no long-context tier to pick, and DeepSeek's one window
      // is already 1M.
      normalizedContextTier = 'default';
    }
    // An image turn's options: the session's defaults (update_session
    // `image`), then the preset the turn names (`image.preset`), then the
    // turn's own. The owner's composer names quality and size in the effort
    // and context-tier fields, which are the turn's own; an agent's turn
    // names them in `image`, and its effort counts below the defaults. Only
    // what an agent sent is refused here: the composer's choice goes on as
    // before, checked against the model when it runs. The options are
    // resolved here, at queue time: a preset changed later does not change a
    // queued turn.
    let imageOptions = null;
    if (openAIImageModel) {
      const { preset: presetName, own: ownImageInput } = splitOpenAIImagePreset(rawImageOptions);
      const preset = findOpenAIImagePreset(presetName, parseOwnOpenAIImagePresets(readAppSettingText(OPENAI_IMAGE_PRESETS_SETTING_KEY)));
      if (!preset.ok) return refuseImageInput(`${asSentence(preset.error)} Nothing was sent.`);
      const ownImageOptions = validateOpenAIImageOptions(ownImageInput, { model: requestedModel });
      if (!ownImageOptions.ok) return refuseImageInput(ownImageOptions.error);
      const keptQuality = !explicitReasoningEffort && requestedReasoningEffort && !['auto', 'none'].includes(requestedReasoningEffort)
        ? { quality: requestedReasoningEffort }
        : {};
      const fieldOptions = {
        ...(explicitReasoningEffort ? { quality: requestedReasoningEffort } : {}),
        ...(String(contextTier || '').trim() && !['default', 'long_context'].includes(requestedContextTier) ? { size: normalizedContextTier } : {}),
      };
      let sessionDefaults = {};
      if (!shouldCreateConversation) {
        try {
          sessionDefaults = stmts.readConversationImageDefaults?.(conversationId) || {};
        } catch {}
      }
      const layers = remoteRequest.remote
        ? [keptQuality, fieldOptions, sessionDefaults, preset.values, ownImageOptions.values]
        : [keptQuality, sessionDefaults, preset.values, fieldOptions, ownImageOptions.values];
      const merged = layers.reduce((options, layer) => mergeOpenAIImageOptions(options, layer), {});
      const checked = validateOpenAIImageOptions(merged, { model: requestedModel });
      if (checked.ok) {
        imageOptions = mergeOpenAIImageOptions(checked.values, null);
      } else if (imagePathsGiven || imageOptionsGiven) {
        return refuseImageInput(checked.error);
      } else {
        imageOptions = [keptQuality, fieldOptions].reduce((options, layer) => mergeOpenAIImageOptions(options, layer), {});
      }
      // Today's image spend has reached the daily cap: refused for every
      // sender before anything is stored (the owner's override lifts it).
      let capRefusal = null;
      try {
        capRefusal = imageSpend.sendRefusal();
      } catch (error) {
        capRefusal = { code: OPENAI_IMAGE_DAILY_CAP_REACHED_CODE, error: `The relay could not check the daily cap of OpenAI images (${error?.message || error}). Nothing was sent.` };
      }
      if (capRefusal) {
        return res.status(409).json({ error: capRefusal.error, code: capRefusal.code, ...(conversationId ? { conversationId } : {}) });
      }
    }
    if (!requestedRelayMode) return res.status(400).json({ error: 'Unsupported relay mode' });
    const conversationWorkspaceState = (!shouldCreateConversation && typeof resolveConversationWorkspaceState === 'function')
      ? resolveConversationWorkspaceState({ conversationId })
      : null;
    // Images by path count as attachments: a "cd …" in their prompt moves
    // no folder, and they are checked against the folder the session has now.
    let workspaceRootUpdate = attachments.length === 0 && imagePathList.length === 0
      ? maybeApplyWorkspaceRootFromMessage(
          trimmedText,
          conversationWorkspaceState?.currentWorkspaceRootPath || null,
        )
      : { attempted: false, changed: false };

    if (!shouldCreateConversation) {
      const sessionState = getConversationSessionState(conversationId);
      if (!sessionState.ok) {
        return rejectSessionBinding(res, sessionState.status, sessionState.error);
      }
      conversationSdkSessionId = sessionState.conversationSdkSessionId || null;
      if (!sessionState.conversationSdkSessionId || !sessionState.runtimeSessionSdkSessionId) {
        return rejectSessionBinding(res, 409, 'Conversation is not session-bound yet');
      }
      if (sessionState.conversationSdkSessionId !== sessionState.runtimeSessionSdkSessionId) {
        return rejectSessionBinding(res, 409, 'Conversation session binding mismatch');
      }
    }

    const resend = shouldCreateConversation
      ? null
      : resolveStoppedSteerResend(conversationId, req.body.resendOfMessageId, trimmedText);
    if (resend?.alreadyResentAs) {
      return res.json({
        ok: true,
        duplicate: true,
        queued: false,
        alreadyResent: true,
        duplicateOfMessageId: resend.alreadyResentAs,
        conversationId,
      });
    }
    const resendOriginId = resend?.originId || null;
    // Another relay's agent sends every prompt with a fresh messageId, and a
    // retry of the same send hits the messageId check at insert. The text
    // window below would instead swallow a deliberate repeat ("run the tests
    // again"), which the agent cannot tell from a lost send.
    const exemptFromTextDuplicateCheck = remoteRequest.remote && !!clientMessageId;
    if (!shouldCreateConversation && !exemptFromTextDuplicateCheck) {
      const recentUserMessages = stmts.getRecentMessagesDesc.all(conversationId, 20);
      const recentQueueRows = db.prepare(`
        SELECT id, text, status, timestamp
        FROM queue
        WHERE conversation_id = ?
        ORDER BY timestamp DESC
        LIMIT 20
      `).all(conversationId);
      const duplicateMessage = findRecentDuplicateUserMessage({
        recentUserMessages,
        recentQueueRows,
        text: trimmedText,
        exemptMessageIds: resend?.exemptIds || [],
      });
      if (duplicateMessage) {
        return res.json({
          ok: true,
          duplicate: true,
          // Said outright for a caller that reads only `ok`: nothing new runs.
          queued: false,
          duplicateWindowMs: DUPLICATE_USER_MESSAGE_WINDOW_MS,
          duplicateSource: duplicateMessage.source,
          duplicateOfMessageId: duplicateMessage.messageId,
          duplicateOfTimestamp: duplicateMessage.timestamp,
          conversationId,
        });
      }
    }

    // The images by path: every one checked and read before anything is
    // stored, then kept in the upload store, so each becomes an attachment
    // with its bytes' hash and sniffed type (and an asset of the operation).
    // They come first: the first image is the base of an edit.
    let imageInputs = [];
    let imageInputsDropped = 0;
    if (imagePathsGiven) {
      if (shouldCreateConversation) {
        return refuseImageInput('imagePaths need an existing session: create it first, then send the images to it');
      }
      let sessionStateRoot = '';
      try {
        sessionStateRoot = String(resolveSessionStateRoot?.() || '');
      } catch {}
      const roots = resolveImageInputRoots({
        cwd: conversationWorkspaceState?.currentWorkspaceRootPath || '',
        sessionStateRoot,
        deniedDirs: [...(imageInputDenyPaths?.dirs || []), uploadsDir, ...(uploadReadDirs || [])],
        deniedFiles: imageInputDenyPaths?.files || [],
      });
      const resolvedImages = resolveImageInputs(imagePathList, {
        roots,
        isLiveConversation: (id) => {
          const row = stmts.getConvAnyStatus?.get?.(id) || null;
          return !!row && String(row.status || '').trim() !== 'deleted';
        },
      });
      if (!resolvedImages.ok) return refuseImageInput(resolvedImages.error);
      const resolvedHashes = new Set(resolvedImages.images.map((image) => image.sha256));
      const otherAttachments = attachments.filter((attachment) => !resolvedHashes.has(String(attachment?.sha256 || '').trim().toLowerCase()));
      const total = resolvedImages.images.length + otherAttachments.length;
      if (total > OPENAI_IMAGE_LIMITS.inputImagesMax) {
        return refuseImageInput(`An image turn takes at most ${OPENAI_IMAGE_LIMITS.inputImagesMax} images; this one would have ${total} with the message's other attachments`);
      }
      try {
        imageInputs = resolvedImages.images.map((image) => ({
          ...persistUploadBuffer(image.bytes, { name: image.name, type: image.mime }),
          // The type the bytes are, not the one an earlier upload of the
          // same bytes was stored with.
          type: image.mime,
          width: image.width,
          height: image.height,
        }));
      } catch (error) {
        return res.status(500).json({ code: 'IMAGE_INPUT_STORE_FAILED', error: `The images could not be stored on this relay: ${error?.message || error}` });
      }
      imageInputsDropped = imagePathList.length - imageInputs.length;
      attachments = [...imageInputs, ...otherAttachments];
    }

    const convId = shouldCreateConversation ? uuidv4() : conversationId;
    if (shouldCreateConversation) {
      // An agent's prompt opens with the sending relay's header line, which
      // says who is talking, not what the conversation is about.
      const titleText = remoteRequest.remote ? stripRemotePromptHeader(trimmedText).trim() : trimmedText;
      getOrCreateConversation(convId, titleText || attachmentSummary(attachments) || 'Image');
    }
    let conversationWorkspaceRootState = null;
    if (workspaceRootUpdate.changed && workspaceRootUpdate.resolvedPath) {
      if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
        workspaceRootUpdate = {
          ...workspaceRootUpdate,
          changed: false,
          error: 'Conversation workspace updates are unavailable',
        };
      } else {
        const updateResult = updateConversationConfiguredWorkspaceRoot({
          conversationId: convId,
          rootPath: workspaceRootUpdate.resolvedPath,
        });
        if (!updateResult?.ok) {
          workspaceRootUpdate = {
            ...workspaceRootUpdate,
            changed: false,
            error: updateResult?.error || 'Failed to update conversation workspace root',
          };
        } else {
          conversationWorkspaceRootState = updateResult?.state || null;
          workspaceRootUpdate = {
            ...workspaceRootUpdate,
            changed: true,
            rootPath: conversationWorkspaceRootState?.configuredWorkspaceRootPath || workspaceRootUpdate.resolvedPath,
            rootName: conversationWorkspaceRootState?.configuredWorkspaceRootName || workspaceRootUpdate.rootName || null,
          };
        }
      }
    }
    const convSeed = stmts.getConvSeed.get(convId);
    const shouldApplySeed = Number(convSeed?.seed_pending || 0) > 0 && String(convSeed?.summary_seed || '').trim().length > 0;

    const now   = new Date().toISOString();
    const runtimeSession = ensureRuntimeSessionBinding(
      convId,
      requestedModel,
      now,
      null,
      {
        assignConfiguredProvider: shouldCreateConversation,
        providerType: shouldCreateConversation
          ? (useOpenAIProvider ? 'openai' : 'github')
          : '',
        providerModel: shouldCreateConversation && useOpenAIProvider
          ? requestedModel
          : null,
      },
    );
    const ownerSessionId = resolveInitialQueueOwnerSessionId({
      requesterSessionId,
      runtimeSession,
      conversationSdkSessionId,
      conversationId: convId,
      isNewConversation: shouldCreateConversation,
    });
    const msgId = clientMessageId || uuidv4();
    const promptText = shouldApplySeed
      ? [
          '[Carry-over context from previous compacted conversation]',
          String(convSeed.summary_seed).trim(),
          '',
          '[New user request]',
          trimmedText || '(User sent image attachments only.)',
        ].join('\n')
      : trimmedText;
    // Only what a human typed unlocks a remote relay by mention (decision 19);
    // a prompt from a relay's agent opens that one relay and no other. The hint
    // rides in the queued prompt only, so the stored message and the user's
    // bubble stay exactly what was typed.
    const mentionedRemoteRelays = byAgent
      ? []
      : findMentionedRemoteRelays(remoteRelayInbound, trimmedText);
    // A prompt from another relay's agent opens that relay for this
    // conversation (it may be answered): the agent is told where it came from.
    const remoteRelayHint = remoteRequest.remote
      ? formatRemoteRelayOriginHint(findOriginRemoteRelay(remoteRelayInbound, remoteRequest.origin), remoteRequest.origin)
      : formatRemoteRelayMentionHint(mentionedRemoteRelays);
    const queueText = withRemoteRelayMentionHint(promptText, remoteRelayHint);
    // A Resend never came from the composer, and neither did another relay's
    // agent: whatever the user is typing there stays their draft.
    const keepsComposerDraft = !!resendOriginId || byAgent;

    const requestedModelOrigin = deriveModelOrigin(requestedModelVariantId || requestedModel);
    let conversationPreferences;
    let imageOperation = null;
    // The switch's announcement, made once the send has committed.
    let announceBillingSwitch = null;
    // A send into an archived chat brings it back with the row.
    let unarchived = false;
    const persistMessageAndQueue = db.transaction(() => {
      // First, so the row below is stamped with the new billing; a refused
      // switch undoes the whole send.
      if (billingSwitch) {
        const switched = claudeBillingSwitchService?.switchBilling?.({
          conversationId: convId,
          to: billingSwitch.to,
          by: billingSwitch.by,
          model: claudeModel,
          deferAnnounce: true,
        }) || { ok: false, status: 501, code: 'CLAUDE_BILLING_UNAVAILABLE', error: 'The billing switch is unavailable' };
        if (!switched.ok) throw Object.assign(new Error(switched.error), { billingRefusal: switched });
        announceBillingSwitch = switched.announce || null;
      }
      stmts.insertMsg.run(
        msgId,
        convId,
        'user',
        trimmedText,
        requestedModelVariantId,
        requestedRelayMode,
        attachments.length ? JSON.stringify(attachments) : null,
        now,
        requestedModelVariantId || null,
        null,
        requestedModelOrigin,
      );
      if (remoteRequest.origin) remoteRelayInbound?.repository?.setMessageOrigin?.(msgId, remoteRequest.origin);
      linkUploadReferences(convId, msgId, attachments);
      stmts.updateConvTime.run(now, convId);
      if (resendOriginId) stmts.setMessageResendOf?.run(resendOriginId, msgId);
      if (!keepsComposerDraft) {
        if (typeof stmts.updateConvDraft?.run === 'function') {
          stmts.updateConvDraft.run(null, now, sessionId || null, convId);
        } else {
          db.prepare(`
            UPDATE conversations
            SET draft_text = NULL, draft_updated_at = ?, draft_updated_by_client_id = ?
            WHERE id = ?
          `).run(now, sessionId || null, convId);
        }
        // The message now owns these blobs, so the draft placeholders can go. The
        // sent-message references were just inserted above, so nothing is orphaned.
        if (typeof stmts.updateConvDraftAttachments?.run === 'function') {
          stmts.updateConvDraftAttachments.run(null, now, sessionId || null, convId);
        } else {
          db.prepare(`
            UPDATE conversations
            SET draft_attachments = NULL, draft_updated_at = ?, draft_updated_by_client_id = ?
            WHERE id = ?
          `).run(now, sessionId || null, convId);
        }
        stmts.deleteDraftUploadRefs?.run?.(convId);
      }
      // Cursor allows per-turn model switching, so the pinned provider_model has
      // to follow the accepted model; otherwise the conversation list and the
      // composer keep restoring the model chosen at bootstrap.
      if (
        runtimeUsesCursor
        && cursorModel
        && runtimeSession?.id
        && cursorModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run('cursor', cursorModel, cursorModel, now, runtimeSession.id);
      }
      // Claude switches per turn too, and the worker launch env reads
      // provider_model || model — without this a relaunched worker came up on
      // the model chosen at bootstrap, not the one the composer last used.
      if (
        runtimeUsesClaude
        && claudeModel
        && runtimeSession?.id
        && claudeModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run(runtimeUsesClaudeApi ? 'claude-api' : 'claude', claudeModel, claudeModel, now, runtimeSession.id);
      }
      // DeepSeek follows the composer the same way: a relaunched worker reads
      // provider_model, so it has to be the model last used.
      if (
        runtimeUsesDeepSeek
        && deepseekModel
        && runtimeSession?.id
        && deepseekModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run('deepseek', deepseekModel, deepseekModel, now, runtimeSession.id);
      }
      // A cloud conversation follows the composer like a Claude one: the
      // worker switches the sandbox's model before the message.
      if (
        runtimeUsesClaudeCloud
        && claudeCloudModel
        && runtimeSession?.id
        && claudeCloudModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run('claude-cloud', claudeCloudModel, claudeCloudModel, now, runtimeSession.id);
      }
      // Another relay's agent picks the model and mode of its own turn; the
      // composer keeps restoring the user's choice for this conversation.
      // Any other send to an existing conversation saves only what it named:
      // a model or an effort filled in from a fallback is never written back
      // as the conversation's choice (an empty effort keeps the stored one).
      const savedModel = String(existingConversation?.preferred_model || '').trim();
      if (shouldCreateConversation) {
        conversationPreferences = persistConversationModelPreference(
          convId, requestedRelayMode, requestedModel, requestedReasoningEffort, now,
        );
      } else if (byAgent || (!explicitModelGiven && !(explicitEffortGiven && savedModel))) {
        conversationPreferences = readConversationModelPreference(convId, requestedRelayMode);
      } else {
        conversationPreferences = persistConversationModelPreference(
          convId,
          requestedRelayMode,
          explicitModelGiven ? requestedModel : savedModel,
          explicitEffortGiven ? requestedReasoningEffort : '',
          now,
        );
      }
      ({ unarchived } = queueIntoConversation(db, stmts, [
        msgId,
        convId,
        runtimeSession?.id || null,
        (!conversationId || !!newConversation) ? 1 : 0,
        requestedModel,
        requestedModelVariantId,
        requestedReasoningEffort,
        normalizedContextTier,
        requestedRelayMode,
        queueText,
        attachments.length ? JSON.stringify(attachments) : null,
        now,
        ownerSessionId,
        ownerSessionId ? now : null,
        null,
        null,
        null,
      ]));
      if (imageOptions) stmts.setQueueImageOptions?.run?.(JSON.stringify(imageOptions), msgId);
      if (openAIImageModel) {
        if (!imageOperationService?.createEnqueuedOperation) {
          throw new Error('Image operation service is unavailable');
        }
        imageOperation = imageOperationService.createEnqueuedOperation({
          conversationId: convId,
          sourceMessageId: msgId,
          queueMessageId: msgId,
          prompt: trimmedText,
          selectedImageModel: requestedModel,
          executionMode: 'direct_images',
          parameters: imageOptions || { count: 1 },
          attachments,
          imageTarget,
          createdAt: now,
        });
      }
    });
    try {
      persistMessageAndQueue();
      try { announceBillingSwitch?.(); } catch {}
    } catch (error) {
      if (error?.billingRefusal) {
        const refused = error.billingRefusal;
        return res.status(refused.status || 409).json({
          error: refused.error,
          code: refused.code,
          conversationId: convId,
          ...(refused.model ? { model: refused.model } : {}),
        });
      }
      // A replayed send (Background Sync outbox) with a caller-supplied id hits
      // the messages.id primary key. Surface it as a clean 409 so the replay
      // can treat "already accepted" as success instead of retrying forever.
      const constraintViolation = String(error?.code || '').startsWith('SQLITE_CONSTRAINT');
      if (clientMessageId && constraintViolation && stmts.getMessageByConversation?.get?.(msgId, convId)) {
        return res.status(409).json({
          error: 'Message already exists',
          code: 'DUPLICATE_MESSAGE_ID',
          messageId: msgId,
          conversationId: convId,
        });
      }
      throw error;
    }
    if (unarchived) {
      io.emit(...unarchivedConversationEvent(convId));
      // As the unarchive route does: the cloud session comes back too.
      try {
        claudeCloudSessionService?.unarchiveSessionInBackground?.({
          conversationId: convId,
          runtimeSession: stmts.getRuntimeSessionByConversation?.get?.(convId) || null,
        });
      } catch (error) {
        console.warn(`[archive] Cloud session unarchive not started for ${convId}: ${error?.message || error}`);
      }
    }
    recordRemoteRelayUnlocks(remoteRelayInbound, {
      conversationId: convId,
      messageId: msgId,
      relays: mentionedRemoteRelays,
    });
    if (!keepsComposerDraft) {
      io.emit('conversation_draft_updated', {
        conversationId: convId,
        draftText: '',
        draftAttachments: [],
        draftUpdatedAt: now,
        draftUpdatedByClientId: sessionId || null,
        senderClientId: sessionId || null,
      });
    }
    if (ownerSessionId) {
      const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
      sessionWorkerRegistry?.upsertWorker?.({
        ...(existingWorker || {}),
        sdkSessionId: ownerSessionId,
        conversationId: convId,
        runtimeSessionId: runtimeSession?.id || null,
        status: existingWorker?.status || 'new',
      });
      const pendingDepth = Number(queueCounts?.().pendingCount || 0);
      sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
      emitSessionWorkerTelemetry('queue.message.queued', {
        sessionId: ownerSessionId,
        workerId: existingWorker?.workerId || null,
        conversationId: convId,
        messageId: msgId,
        continuationId: null,
        state: existingWorker?.status || 'new',
        retry: 0,
        pid: existingWorker?.pid || null,
      });
      if (typeof sessionWorkerSupervisor?.ensureWorker === 'function') {
        sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
        void sessionWorkerSupervisor.ensureWorker(ownerSessionId).then((result) => {
          if (!result?.ok) {
            emitSessionWorkerTelemetry('worker.prime.failed', {
              sessionId: ownerSessionId,
              workerId: result?.worker?.workerId || null,
              conversationId: convId,
              messageId: msgId,
              continuationId: null,
              state: result?.worker?.status || 'error',
              retry: result?.lifecycle?.retryCount || 0,
              pid: result?.worker?.pid || null,
              level: 'warn',
              extra: { blockedReason: String(result?.error || 'worker-prime-failed') },
            });
          }
        }).catch((error) => {
          emitSessionWorkerTelemetry('worker.prime.failed', {
            sessionId: ownerSessionId,
            workerId: null,
            conversationId: convId,
            messageId: msgId,
            continuationId: null,
            state: 'error',
            retry: 0,
            pid: null,
            level: 'warn',
            extra: { error: String(error?.message || error || 'worker-prime-failed') },
          });
        });
      }
    }
    if (shouldApplySeed) {
      stmts.clearConvSeed.run(now, convId);
    }

    console.log(`[${ts()}] QUEUED    ${msgId.slice(0,8)} conv=${convId.slice(0,8)} rs=${String(runtimeSession?.id || 'none').slice(0,8)} owner=${String(ownerSessionId || 'none').slice(0,8)} new=${!conversationId || !!newConversation} model=${requestedModel} variant=${requestedModelVariantId}${requestedReasoningEffort ? ` effort=${requestedReasoningEffort}` : ''} mode=${requestedRelayMode} text="${trimmedText.slice(0,60)}"${shouldApplySeed ? ' seeded=1' : ''}${attachments.length ? ` attachments=${attachments.length}` : ''}${remoteRequest.remote ? ` remote=${remoteRequest.origin?.relayName || remoteRequest.origin?.relayId || 'unknown'} hops=${remoteRequest.origin?.hops ?? '?'}` : ''}${mentionedRemoteRelays.length ? ` mentions=${mentionedRemoteRelays.length}` : ''}`);

    emitToClientsExceptSessionId(
      'user_message',
      {
        conversationId: convId,
        messageId: msgId,
        senderClientId: sessionId,
        message: {
          role: 'user',
          text: trimmedText,
          model: requestedModelVariantId,
          modelOrigin: requestedModelOrigin || undefined,
          mode: requestedRelayMode,
          timestamp: now,
          attachments,
          ...(remoteRequest.origin ? { origin: remoteRequest.origin } : {}),
        },
      },
      sessionId,
    );
    io.emit('message_status', { messageId: msgId, conversationId: convId, status: 'pending' });
    if (conversationWorkspaceRootState?.conversationId) {
      const workspaceHints = workspaceRootPayload();
      io.emit('conversation_workspace_root_updated', {
        conversationId: conversationWorkspaceRootState.conversationId,
        sdkSessionId: conversationWorkspaceRootState.sdkSessionId || null,
        configuredWorkspaceRootPath: conversationWorkspaceRootState.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: conversationWorkspaceRootState.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: conversationWorkspaceRootState.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: conversationWorkspaceRootState.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: conversationWorkspaceRootState.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: conversationWorkspaceRootState.currentWorkspaceRootName || null,
        recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
      });
    }
    res.json({
      ok: true,
      ...remoteOriginAnswerFields(remoteRequest),
      messageId: msgId,
      conversationId: convId,
      runtimeSessionId: runtimeSession?.id || null,
      runtimeProviderType: billingSwitch?.to
        || String(runtimeSession?.provider_type || (useOpenAIProvider ? 'openai' : 'github')).trim().toLowerCase(),
      ...(billingSwitch ? { billingSwitched: true } : {}),
      runtimeProviderModel: runtimeSession?.provider_model || (useOpenAIProvider ? openAIModel : null),
      ownerSessionId: ownerSessionId || null,
      preferredRelayMode: conversationPreferences.preferredRelayMode,
      preferredModel: conversationPreferences.preferredModel,
      preferredReasoningEffort: conversationPreferences.preferredReasoningEffort,
      warning: modelResolution.warning || null,
      selectedModelVariantId: requestedModelVariantId,
      selectedBaseModel: requestedModel,
      selectedReasoningEffort: requestedReasoningEffort,
      workspaceRootWarning: workspaceRootUpdate.error || null,
      workspaceRootChanged: !!workspaceRootUpdate.changed,
      ...workspaceRootPayload(),
      referenceAttachmentCount: referenceResolution.attachments.length - ignoredReferenceAttachments,
      skippedReferenceAttachments: referenceResolution.skipped,
      ...(ignoredReferenceAttachments ? { ignoredReferenceAttachments } : {}),
      // How many images from imagePaths the turn has, and how many named
      // twice (the same file, or the same bytes) were kept once.
      ...(imagePathsGiven ? { imageInputs: imageInputs.length } : {}),
      ...(imageInputsDropped > 0 ? {
        imageInputsDropped,
        imageInputsNote: `${imageInputsDropped} of the ${imagePathList.length} image paths named an image already attached; it was attached once.`,
      } : {}),
      ...(imageOptions ? { imageOptions } : {}),
      // Attachment references that no longer resolve (a deleted upload) are
      // dropped silently by normalizeAttachments; the sender is told how many.
      droppedAttachmentCount: Math.max(0, requestedAttachmentCount - normalizedAttachments.length),
      imageOperation: imageOperation
        ? {
            id: imageOperation.id,
            mode: imageOperation.mode,
            kind: imageOperation.kind,
          }
        : null,
    });
  };
  app.post('/api/message', auth, handleSendMessage);

  // POST /api/conversation/:id/billing — move a Claude chat between the
  // subscription and the saved API key (`to`: "claude" | "claude-api"): the
  // composer's toggle, the usage-limit note's button (`by: "usage-limit"`)
  // and an agent's `send` with a provider (`by: "agent"`). With `message`
  // (the body /api/message takes), the switch and the enqueue are one
  // transaction: a send that is refused leaves the billing as it was, and a
  // refused switch sends nothing. Applies from the next turn; a running one
  // finishes on its billing.
  app.post('/api/conversation/:id/billing', auth, async (req, res) => {
    if (!claudeBillingSwitchService) {
      return res.status(501).json({ ok: false, error: 'The billing switch is unavailable', code: 'CLAUDE_BILLING_UNAVAILABLE' });
    }
    const conversationId = String(req.params?.id || '').trim();
    const to = normalizeClaudeBilling(req.body?.to ?? req.body?.provider);
    const byValue = String(req.body?.by || '').trim().toLowerCase();
    const by = ['user', 'agent', 'usage-limit'].includes(byValue) ? byValue : 'user';
    const message = req.body?.message && typeof req.body.message === 'object' && !Array.isArray(req.body.message)
      ? req.body.message
      : null;
    // Checked first, so a refusal names the switch's reason before the send's.
    const check = claudeBillingSwitchService.checkSwitch({ conversationId, to, model: message?.model || '' });
    if (!check.ok) {
      return res.status(check.status || 409).json({
        ok: false,
        error: check.error,
        code: check.code,
        conversationId,
        ...(check.model ? { model: check.model } : {}),
      });
    }
    if (message) {
      const sendRequest = Object.create(req);
      sendRequest.body = {
        ...message,
        conversationId,
        newConversation: false,
        provider: undefined,
        providerType: undefined,
        billing: undefined,
      };
      sendRequest.oarBillingSwitch = { to: check.to, by };
      return handleSendMessage(sendRequest, res);
    }
    if (by === 'usage-limit' && check.to !== 'claude-api') {
      return res.status(400).json({ ok: false, error: 'The usage-limit note switches to the API key only', code: 'CLAUDE_BILLING_INVALID' });
    }
    const result = claudeBillingSwitchService.switchBilling({ conversationId, to: check.to, by });
    if (!result?.ok) {
      return res.status(result?.status || 409).json({
        ok: false,
        error: result?.error || 'The billing switch failed',
        code: result?.code || null,
        conversationId,
        ...(result?.model ? { model: result.model } : {}),
      });
    }
    return res.json({
      ok: true,
      conversationId,
      changed: result.changed,
      provider: result.provider,
      released: !!result.released,
      billing: claudeBillingSwitchService.billingState(conversationId),
    });
  });
}
