'use strict';

// The share routes: a conversation's share link (create, renew, stop, the
// list and the access log), the public shared view with its sub-agent,
// presence and file reads, the owner's preview as shared, and which
// messages a share hides, registered by registerSessionsRoutes.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { serveFileWithRangeSupport } from '../services/file-serving.mjs';
import { normalizeConversationHistoryLimit } from '../services/conversation-history-page.mjs';
import { mapUsageSnapshotRow } from '../services/usage-snapshot-helpers.mjs';
import { redactPreviewTokens } from '../services/preview-registry-service.mjs';
import { createSharePathRedactor } from '../services/share-path-redaction.mjs';
import { createSubagentTimelineService, TIMELINE_READ_DEFAULT_LIMIT } from '../services/subagent-timeline-service.mjs';
import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';
import { createFixedWindowRateLimiter } from '../services/rate-limit-service.mjs';
import { requestHostOf } from '../services/request-boundary.mjs';
import { createShareAccessLog, readShareRequestViewer } from '../services/share-access-log-service.mjs';
import { publicRemoteRelayOrigin } from '../services/remote-relay-inbound.mjs';
import { DEFAULT_SHARE_PATH_PRIVACY_MODE } from '../../shared/share-path-privacy.mjs';
import {
  buildConversationMessages,
  resolveConversationTitle,
  selectConversationHistoryPage,
} from './sessions-helpers.mjs';

// A shared attachment's URL names its bytes (sha256 or a fixed generated-image
// path), so a kept answer stays right.
const SHARED_CONTENT_CACHE_CONTROL = 'private, max-age=31536000, immutable';

export function normalizeShareToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(token)) return '';
  return token;
}

export function buildConversationShareToken() {
  return `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

export function normalizeSharedViewerId(value) {
  const viewerId = String(value || '').trim().replace(/[^a-zA-Z0-9:_-]+/g, '');
  if (!viewerId) return '';
  return viewerId.slice(0, 128);
}

export function filterMessagesVisibleToSharedView(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => Number(message?.hidden_from_shares || 0) !== 1);
}

export function registerShareRoutes(app, deps, shared) {
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
    inFlightStateForConversation,
    listConversationPreviews,
    listKnownPreviewTokens,
    resolveConversationWorkspaceState,
    DEFAULT_RELAY_MODE,
    remotePath,
    resolveSessionStateRoot,
    markSharedViewerPresence,
    getSharedWatcherCount,
    statusEventService,
    isSha256,
    uploadPathForSha,
  } = deps;
  const {
    getSharePathPrivacyMode,
    sharePathKnownRoots,
    workspaceRootAllowList,
    shares,
    extractClientIp,
    listConversationPins,
    listConversationHiddenMessages,
    conversationHiddenMessagesRevision,
    bumpConversationPinRevision,
    hiddenMessageRevisions,
    selectConversationHistoryPageRows,
    usageSnapshotsForPage,
    resendIndexForPage,
  } = shared;

  // Built on first use, over the same share repository.
  let shareAccessLogInstance = null;
  const shareAccessLog = () => (shareAccessLogInstance ||= createShareAccessLog({ repository: shares() }));

  const getActiveQueueForMessage = db.prepare(`
    SELECT id
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'processing', 'parked')
      AND (id = ? OR response_message_id = ?)
    LIMIT 1
  `);
  // Every open owner page follows a share-visibility change without a reload:
  // the 🙈 list and count, the bubbles' Hide / Unhide, and the pin list's
  // "hidden from shared" chip when a pinned message changed.
  function broadcastShareVisibilityChange(conversationId, { pinnedChanged = false } = {}) {
    const hiddenMessages = listConversationHiddenMessages(conversationId);
    const revision = hiddenMessageRevisions.bump(conversationId);
    io?.emit?.('conversation_hidden_messages_updated', { conversationId, hiddenMessages, revision });
    if (pinnedChanged) {
      io?.emit?.('conversation_pins_updated', {
        conversationId,
        pins: listConversationPins(conversationId),
        revision: bumpConversationPinRevision(conversationId),
      });
    }
    return { hiddenMessages, revision };
  }
  const sharedPresenceRateLimiter = createFixedWindowRateLimiter({
    windowMs: 10_000,
    limit: 24,
    bucketTtlMs: 60_000,
    maxBuckets: 4_096,
  });

  function consumeSharedPresenceRateLimit(token, req, nowMs = Date.now()) {
    const shareToken = String(token || '').trim();
    if (!shareToken) return { ok: false, retryAfterSeconds: 1 };
    return sharedPresenceRateLimiter.consume(`${shareToken}:${extractClientIp(req)}`, nowMs);
  }

  function buildShareUrl(req, token) {
    const shareToken = String(token || '').trim();
    if (!shareToken) return '';
    // Host and scheme follow `trust proxy`: X-Forwarded-Host/-Proto only
    // from a trusted proxy, so a direct client cannot mint links elsewhere.
    const host = requestHostOf(req);
    const protocol = String(req.protocol || 'http').toLowerCase();
    const basePath = String(remotePath || '').trim().replace(/\/+$/, '');
    const relative = `${basePath}/shared/${shareToken}`.replace(/\/{2,}/g, '/');
    if (!host) return relative;
    return `${protocol}://${host}${relative}`;
  }

  function buildSharedUploadContentUrl(token, sha256) {
    const shareToken = normalizeShareToken(token);
    const normalizedSha = String(sha256 || '').trim().toLowerCase();
    if (!shareToken || !isSha256(normalizedSha)) return '';
    return `${String(remotePath || '').replace(/\/+$/, '')}/api/shared/${shareToken}/upload/${normalizedSha}/content`.replace(/\/{2,}/g, '/');
  }

  function buildSharedGeneratedImageContentUrl(token, messageId, imageId) {
    const shareToken = normalizeShareToken(token);
    const normalizedMessageId = String(messageId || '').trim();
    const normalizedImageId = String(imageId || '').trim();
    if (!shareToken || !normalizedMessageId || !normalizedImageId) return '';
    return `${String(remotePath || '').replace(/\/+$/, '')}/api/shared/${shareToken}/generated-image/${encodeURIComponent(normalizedMessageId)}/${encodeURIComponent(normalizedImageId)}/content`.replace(/\/{2,}/g, '/');
  }

  function conversationReferencesUploadSha(conversationId, sha256) {
    const convId = String(conversationId || '').trim();
    const normalizedSha = String(sha256 || '').trim().toLowerCase();
    if (!convId || !isSha256(normalizedSha)) return false;
    const rows = filterMessagesVisibleToSharedView(
      (stmts.getSharedMessages || stmts.getMessages).all(convId),
    );
    for (const row of rows) {
      const attachments = parseAttachments(row?.attachments);
      for (const attachment of attachments) {
        if (String(attachment?.sha256 || '').trim().toLowerCase() === normalizedSha) {
          return true;
        }
      }
    }
    return false;
  }

  function rewriteSharedAttachmentContentUrl(attachment, shareToken) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const normalizedSha = String(attachment.sha256 || '').trim().toLowerCase();
    if (!isSha256(normalizedSha)) return attachment;
    const contentUrl = buildSharedUploadContentUrl(shareToken, normalizedSha);
    if (!contentUrl) return attachment;
    return {
      ...attachment,
      contentUrl,
    };
  }

  function rewriteSharedGeneratedImageAttachmentContentUrl(attachment, shareToken) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const generatedImage = attachment.generatedImage && typeof attachment.generatedImage === 'object'
      ? attachment.generatedImage
      : null;
    const messageId = String(generatedImage?.messageId || generatedImage?.responseMessageId || generatedImage?.parentMessageId || '').trim();
    const imageId = String(generatedImage?.imageId || '').trim();
    if (!messageId || !imageId) return attachment;
    const contentUrl = buildSharedGeneratedImageContentUrl(shareToken, messageId, imageId);
    if (!contentUrl) return attachment;
    return {
      ...attachment,
      contentUrl,
    };
  }

  // A shared attachment is served by its share URL: the host path it is
  // stored at (and the `@path` reference built from it) stays on the relay.
  function shareSafeAttachment(attachment, shareToken) {
    const rewritten = rewriteSharedGeneratedImageAttachmentContentUrl(rewriteSharedAttachmentContentUrl(attachment, shareToken), shareToken);
    if (!rewritten || typeof rewritten !== 'object') return rewritten;
    const { path: _path, reference: _reference, ...rest } = rewritten;
    return rest;
  }

  function buildConversationPayloadForShare({
    conv,
    shareToken = '',
    limit = 120,
    beforeMessageId = '',
    beforeTimestamp = '',
    afterMessageId = '',
    afterTimestamp = '',
    aroundMessageId = '',
    // Filled with the tokens of the transcript's preview cards, for the route
    // to redact wherever a reply or tool line quotes them.
    previewTokens = null,
  } = {}) {
    const resolvedConversationId = String(conv?.id || '').trim();
    if (!resolvedConversationId) return null;
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
    });
    const inFlight = inFlightStateForConversation(resolvedConversationId);
    const historyCursor = { limit, beforeMessageId, beforeTimestamp, afterMessageId, afterTimestamp, aroundMessageId };
    const sqlPage = selectConversationHistoryPageRows(resolvedConversationId, historyCursor, { sharedOnly: true });
    const dbMessages = filterMessagesVisibleToSharedView(sqlPage
      ? sqlPage.rows
      : (stmts.getSharedMessages || stmts.getMessages).all(resolvedConversationId));
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
    // The page hydrates only its own cards, but the tokens to redact are the
    // whole conversation's: a reply on this page can quote a card's link from
    // outside it. The page's cards below add theirs too (a relay without the
    // statement still redacts what it shows).
    if (previewTokens) {
      for (const row of stmts.listPreviewCardJsonByConversation?.all(resolvedConversationId) || []) {
        try {
          const token = JSON.parse(String(row?.preview_json || ''))?.token;
          if (token) previewTokens.add?.(String(token));
        } catch {
          // An unreadable snapshot renders no card, so it has no link to quote.
        }
      }
    }
    // A preview link is a capability that now outlives the turn and the
    // restart: a public transcript keeps only the label, never token or link.
    const previewCardsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, (previewCardsForResponse ? previewCardsForResponse(m.id) : [])
          .filter((card) => card && typeof card === 'object')
          .map((card) => {
            if (card.token) previewTokens?.add?.(String(card.token));
            return card;
          })
          .map((card) => ({
            label: String(card.label || '').trim().slice(0, 120) || 'Preview',
            mode: card.mode === 'static' ? 'static' : 'port',
            redacted: true,
          }))]),
    );
    const usageByResponseMessageId = sqlPage ? usageSnapshotsForPage(conv.id, dbMessages) : new Map(
      (stmts.listMessageUsageSnapshotsByConversation?.all(conv.id) || [])
        .map((row) => [String(row?.response_message_id || '').trim(), mapUsageSnapshotRow(row)])
        .filter(([messageId, usage]) => !!messageId && !!usage),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments)
          .map(hydrateAttachment)
          .filter(Boolean)
          .map((attachment) => shareSafeAttachment(attachment, shareToken)),
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
      resendIndexMessages: sqlPage ? resendIndexForPage(resolvedConversationId, dbMessages, { sharedOnly: true }) : null,
    });
    messages = messages.map((message) => {
      const sourceMessageId = responseMessageToSourceId.get(String(message.id || '').trim()) || message.sourceMessageId || undefined;
      // Pins are the owner's bookmarks: a public share never learns of them.
      const { pinned: _pinned, ...unpinnedMessage } = message;
      const withSource = sourceMessageId ? { ...unpinnedMessage, sourceMessageId } : unpinnedMessage;
      // A public share never shows another relay's address or ids.
      const nextMessage = withSource.origin
        ? { ...withSource, origin: publicRemoteRelayOrigin(withSource.origin) }
        : withSource;
      const attachments = Array.isArray(nextMessage?.attachments)
        ? nextMessage.attachments.map((attachment) => shareSafeAttachment(attachment, shareToken))
        : nextMessage?.attachments;
      return attachments === nextMessage?.attachments
        ? nextMessage
        : { ...nextMessage, attachments };
    });
    const history = sqlPage
      ? { messages, pageInfo: sqlPage.pageInfo }
      : selectConversationHistoryPage(messages, historyCursor);
    return {
      id: resolvedConversationId,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: null,
      // The provider alone, null when the conversation has none bound: the
      // view tells a reply that ran elsewhere from one that ran here by it.
      // Not private, the model chip names it as well.
      runtimeProviderType: String(stmts.getRuntimeSessionByConversation?.get?.(resolvedConversationId)?.provider_type || '').trim().toLowerCase() || null,
      sessionRootPath: null,
      sessionRootName: resolvedTitle || 'Session',
      configuredWorkspaceRootPath: null,
      configuredWorkspaceRootName: null,
      runtimeWorkspaceRootPath: null,
      runtimeWorkspaceRootName: null,
      currentWorkspaceRootPath: null,
      currentWorkspaceRootName: null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      sessionUsageSummary: null,
      inFlight,
      preferredRelayMode: DEFAULT_RELAY_MODE,
      preferredModel: '',
      preferredReasoningEffort: '',
      draftText: '',
      draftUpdatedAt: null,
      draftUpdatedByClientId: null,
      messages: history.messages,
      pageInfo: history.pageInfo,
    };
  }

  function shareLinkPayload(req, share) {
    const token = String(share?.token || '').trim();
    return {
      token,
      shareUrl: buildShareUrl(req, token),
      path: `${String(remotePath || '').replace(/\/+$/, '')}/shared/${token}`.replace(/\/{2,}/g, '/'),
    };
  }

  function findShareableConversation(conversationId) {
    const conv = conversationId ? stmts.getConvAnyStatus.get(conversationId) || null : null;
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') return null;
    return conv;
  }

  // Get-or-create: a conversation has one active share, and asking again
  // returns its link.
  app.post('/api/conversation/:id/share', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    if (!findShareableConversation(conversationId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const { share, created } = shares().getOrCreateShare(conversationId, buildConversationShareToken, new Date().toISOString());
    if (!share?.token) return res.status(500).json({ error: 'Failed to create share token' });
    if (created) io.emit('share_created', { conversationId });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, conversationId, created, ...shareLinkPayload(req, share) });
  });

  // A new link for the active share: the old token answers 404 from now on,
  // the access log carries over.
  app.post('/api/conversation/:id/share/renew', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    if (!findShareableConversation(conversationId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const renewed = shares().renewShare(conversationId, buildConversationShareToken, new Date().toISOString());
    if (!renewed?.share?.token) return res.status(404).json({ error: 'No active share to renew' });
    io.emit('share_renewed', { conversationId });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, conversationId, renewed: true, ...shareLinkPayload(req, renewed.share) });
  });

  // Stop sharing: every token of the conversation is revoked and its access
  // log deleted. An open shared page gets a 404 at its next poll.
  app.delete('/api/conversation/:id/share', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    if (!shares().findActiveShare(conversationId)) {
      return res.status(404).json({ error: 'No active share to revoke' });
    }
    const now = new Date().toISOString();
    const result = shares().stopSharing(conversationId, now);
    io.emit('share_revoked', { conversationId });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, conversationId, revokedAt: now, revokedCount: result.revokedCount, opensDeleted: result.opensDeleted });
  });

  // Every active share, for Settings → Sharing.
  app.get('/api/shares', auth, (req, res) => {
    const list = shares().listActiveShares().map((share) => ({
      conversationId: share.conversationId,
      title: share.title,
      archived: share.archived,
      sharedSince: share.sharedSince,
      // The current link's date, when it is a renewed one.
      renewedAt: share.createdAt && share.createdAt !== share.sharedSince ? share.createdAt : null,
      lastOpenedAt: share.lastOpenedAt,
      openCount: share.openCount,
      viewerCount: share.viewerCount,
      ...shareLinkPayload(req, share),
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ shares: list, storeViewerIp: shares().readStoreViewerIp(), accessLog: shares().logAvailable });
  });

  // The access log of a conversation's active share, newest first.
  app.get('/api/conversation/:id/share/opens', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const share = conversationId ? shares().findActiveShare(conversationId) : null;
    if (!share) return res.status(404).json({ error: 'No active share' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ conversationId, ...shares().listOpens(share.lineageId, { limit: req.query.limit }) });
  });

  // ─── Path privacy for shared views ─────────────────────────────────────────
  // A share is served through one redactor per response
  // (services/share-path-redaction.mjs): the relay's own roots, the
  // conversation's workspace roots and the OS user name are what it knows to
  // look for. The owner's own routes never pass through it.
  function sharePathRedactorFor(conv, { annotate = false } = {}) {
    let known = null;
    try { known = sharePathKnownRoots?.() || null; } catch { known = null; }
    const roots = [...(Array.isArray(known?.roots) ? known.roots : [])];
    const conversationId = String(conv?.id || '').trim();
    try {
      const state = typeof resolveConversationWorkspaceState === 'function'
        ? resolveConversationWorkspaceState({
          conversationId,
          sdkSessionId: conv?.sdk_session_id || conversationId,
          discoveredWorkspaceRootPath: '',
        })
        : null;
      roots.push(state?.configuredWorkspaceRootPath, state?.runtimeWorkspaceRootPath, state?.currentWorkspaceRootPath);
    } catch {}
    roots.push(...(Array.isArray(workspaceRootAllowList) ? workspaceRootAllowList : []));
    let mode = DEFAULT_SHARE_PATH_PRIVACY_MODE;
    try { mode = getSharePathPrivacyMode(); } catch {}
    return createSharePathRedactor({
      mode,
      roots: roots.filter(Boolean),
      userNames: Array.isArray(known?.userNames) ? known.userNames : [],
      relayPathPrefix: remotePath,
      annotate,
    });
  }

  // Every preview token a shared response must not carry: the relay's known
  // previews and the conversation's own. Null when the list cannot be read;
  // then nothing is shared.
  function collectSharePreviewTokens(conversationId) {
    const tokens = new Set();
    // Every preview of the relay, not only this conversation's: a reply may
    // quote any token its agent got hold of — one the user pasted from
    // Settings → Previews, or a relay-wide list fetched by hand with the relay
    // token (the preview tool's own list is scoped to its conversation).
    try {
      for (const knownToken of listKnownPreviewTokens?.() || []) tokens.add(String(knownToken));
    } catch {
      return null;
    }
    for (const preview of listConversationPreviews?.(conversationId) || []) {
      if (preview?.token) tokens.add(String(preview.token));
    }
    return tokens;
  }

  function sharedHistoryPageQuery(query = {}) {
    return {
      limit: normalizeConversationHistoryLimit(query.limit, 120),
      beforeMessageId: String(query.beforeMessageId || '').trim(),
      beforeTimestamp: String(query.beforeTimestamp || '').trim(),
      afterMessageId: String(query.afterMessageId || '').trim(),
      afterTimestamp: String(query.afterTimestamp || '').trim(),
      aroundMessageId: String(query.aroundMessageId || '').trim(),
    };
  }

  // A revoked or renewed token is a plain 404, like one that never existed.
  function resolveActiveShare(rawToken) {
    const token = normalizeShareToken(rawToken);
    if (!token) return null;
    const share = shares().findLiveShare(token);
    const conversationId = String(share?.conversationId || '').trim();
    if (!conversationId) return null;
    return { token, share, conversationId };
  }

  function resolveShareableConversation(conversationId) {
    const conv = stmts.getConvAnyStatus.get(conversationId) || null;
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') return null;
    return conv;
  }

  app.get('/api/shared/:token', (req, res) => {
    const active = resolveActiveShare(req.params.token);
    if (!active) return res.status(404).json({ error: 'Shared conversation not found' });
    const { token, share, conversationId: convId } = active;
    const conv = resolveShareableConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Shared conversation not found' });
    const previewTokens = collectSharePreviewTokens(convId);
    if (!previewTokens) {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({ error: 'Shared conversation is not available right now' });
    }
    const payload = buildConversationPayloadForShare({
      conv,
      shareToken: token,
      ...sharedHistoryPageQuery(req.query),
      previewTokens,
    });
    if (!payload) return res.status(404).json({ error: 'Shared conversation not found' });
    // The access log: one row per open, not per poll (the page's first fetch
    // says `open=1`; see share-access-log-service.mjs). A failing log never
    // keeps a reader out.
    const viewer = readShareRequestViewer(req);
    const storeIp = shares().readStoreViewerIp();
    let viewerKey = '';
    try {
      const noted = shareAccessLog().noteFetch({ share, viewer, opened: String(req.query.open || '') === '1', storeIp });
      viewerKey = noted.viewerKey;
      if (noted.recorded) io.emit('share_opened', { conversationId: convId });
    } catch (error) {
      console.warn(`[shares] could not log a shared read: ${error?.message || error}`);
    }
    const sharedAccess = statusEventService.recordSharedAccess({
      shareToken: token,
      viewerIp: storeIp ? viewer.ip : null,
      viewerKey,
      conversationId: convId,
    });
    if (sharedAccess.event) {
      const details = sharedAccess.event.details;
      console.log(`SHARED ACCESS shareId=${details.shareId} ip=${storeIp ? details.viewerIp || 'unknown' : 'not stored'}`);
      io.emit('shared_access', sharedAccess.event);
    }
    const now = new Date().toISOString();
    stmts.touchConversationShare?.run(now, token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    // A preview link is a public capability that outlives the turn: no string
    // of a shared transcript (reply text, thoughts, tool lines, sub-agent runs)
    // carries one. One pass over the whole response, not a list of fields;
    // then the host's paths, by the relay's path privacy setting.
    const redactor = sharePathRedactorFor(conv);
    res.json(redactor.payload(redactPreviewTokens({
      ...payload,
      shared: {
        token,
        readOnly: true,
        watcherCount: Number(getSharedWatcherCount?.(convId) || 0),
      },
    }, { tokens: [...previewTokens] })));
  });

  // The owner's "Preview as shared": the payload a share link would serve, with
  // every redaction and every leftover that still looks like a path marked
  // (SHARE_PREVIEW_MARKS). Works without a share link and never creates one;
  // records no access. Content URLs stay the owner's.
  app.get('/api/conversation/:id/share-preview', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const conv = conversationId ? resolveShareableConversation(conversationId) : null;
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const previewTokens = collectSharePreviewTokens(conversationId);
    if (!previewTokens) {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({ error: 'The preview is not available right now' });
    }
    const payload = buildConversationPayloadForShare({
      conv,
      shareToken: '',
      ...sharedHistoryPageQuery(req.query),
      previewTokens,
    });
    if (!payload) return res.status(404).json({ error: 'Conversation not found' });
    const redactor = sharePathRedactorFor(conv, { annotate: true });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...redactor.payload(redactPreviewTokens(payload, { tokens: [...previewTokens] })),
      shared: {
        token: null,
        readOnly: true,
        preview: true,
        pathPrivacy: redactor.mode,
        watcherCount: 0,
      },
    });
  });

  // ─── Sub-agent records in a shared view ────────────────────────────────────
  const sharedSubagentTimeline = createSubagentTimelineService({ db, stmts });

  // The runs a shared view shows a row for: those of the replies it shows,
  // and those of the turn in flight.
  function sharedConversationRunIds(conversationId) {
    const ids = new Set();
    const add = (run) => {
      const id = String(run?.subagentRunId || run?.id || '').trim();
      if (id) ids.add(id);
    };
    const rows = filterMessagesVisibleToSharedView(
      (stmts.getSharedMessages || stmts.getMessages).all(conversationId),
    );
    for (const row of rows) {
      if (row?.role !== 'assistant') continue;
      for (const run of (subagentRunsForResponse ? subagentRunsForResponse(row.id) : []) || []) add(run);
    }
    for (const run of inFlightStateForConversation(conversationId)?.subagentRuns || []) add(run);
    return ids;
  }

  // A run of the conversation whose row the shared view shows, or a child of
  // one: a share never opens a run of another conversation or of a reply the
  // owner hid from shares.
  function shareMayReadSubagentRun(conversationId, run) {
    if (!run || String(run.conversation_id || '') !== conversationId) return false;
    const visible = sharedConversationRunIds(conversationId);
    let current = run;
    for (let depth = 0; current && depth < 16; depth += 1) {
      if (visible.has(String(current.id || ''))) return true;
      const parentId = String(current.parent_subagent_id || '').trim();
      if (!parentId) return false;
      current = stmts.getSubagentRun?.get?.(parentId) || null;
      if (current && String(current.conversation_id || '') !== conversationId) return false;
    }
    return false;
  }

  // A reader cannot stop a run: no stop flag, no task handle.
  function readerRunHeader(header) {
    if (!header || typeof header !== 'object') return header;
    const { taskId: _taskId, ...rest } = header;
    return { ...rest, stoppable: false };
  }

  function sharedSubagentRecord(req, res, { conv, conversationId, annotate }) {
    const runId = sanitizeSubagentRunId(req.params.subagentRunId);
    const run = runId ? stmts.getSubagentRun?.get?.(runId) || null : null;
    if (!run || !shareMayReadSubagentRun(conversationId, run)) {
      return res.status(404).json({ error: 'Sub-agent run not found' });
    }
    const previewTokens = collectSharePreviewTokens(conversationId);
    if (!previewTokens) {
      res.setHeader('Retry-After', '15');
      return res.status(503).json({ error: 'Shared conversation is not available right now' });
    }
    const page = sharedSubagentTimeline.readTimeline(run, {
      afterSeq: Number(req.query?.after) || 0,
      limit: Number(req.query?.limit) || TIMELINE_READ_DEFAULT_LIMIT,
      isStoppable: () => false,
    });
    const readerPage = {
      ...page,
      run: readerRunHeader(page.run),
      children: (Array.isArray(page.children) ? page.children : []).map(readerRunHeader),
    };
    const redactor = sharePathRedactorFor(conv, { annotate });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.json(redactor.payload(redactPreviewTokens(readerPage, { tokens: [...previewTokens] })));
  }

  app.get('/api/shared/:token/subagent/:subagentRunId', (req, res) => {
    const active = resolveActiveShare(req.params.token);
    const conv = active ? resolveShareableConversation(active.conversationId) : null;
    if (!conv) return res.status(404).json({ error: 'Sub-agent run not found' });
    return sharedSubagentRecord(req, res, { conv, conversationId: active.conversationId, annotate: false });
  });

  app.get('/api/conversation/:id/share-preview/subagent/:subagentRunId', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const conv = conversationId ? resolveShareableConversation(conversationId) : null;
    if (!conv) return res.status(404).json({ error: 'Sub-agent run not found' });
    return sharedSubagentRecord(req, res, { conv, conversationId, annotate: true });
  });

  app.post('/api/shared/:token/presence', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    if (!token) return res.status(404).json({ error: 'Shared conversation not found' });
    const share = shares().findLiveShare(token);
    if (!share) return res.status(404).json({ error: 'Shared conversation not found' });
    const conversationId = share.conversationId;
    const rateLimit = consumeSharedPresenceRateLimit(token, req);
    if (!rateLimit.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds || 1));
      return res.status(429).json({
        error: 'Too many presence updates; retry shortly.',
        retryAfterSeconds: Number(rateLimit.retryAfterSeconds || 1),
      });
    }
    const viewerId = normalizeSharedViewerId(req.body?.viewerId || req.query?.viewerId);
    if (!viewerId) return res.status(400).json({ error: 'Missing viewer id' });
    const presence = typeof markSharedViewerPresence === 'function'
      ? markSharedViewerPresence({ conversationId, token, viewerId })
      : { ok: false, watcherCount: 0 };
    const now = new Date().toISOString();
    stmts.touchConversationShare?.run(now, token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.json({
      ok: presence?.ok !== false,
      conversationId,
      watcherCount: Number(presence?.watcherCount || 0),
      capped: presence?.capped === true,
    });
  });

  // The download name of a shared file: with names hidden, only its type.
  function sharedDownloadName(fileName) {
    let mode = DEFAULT_SHARE_PATH_PRIVACY_MODE;
    try { mode = getSharePathPrivacyMode(); } catch {}
    if (mode !== 'hide' || !fileName) return fileName;
    const extension = path.extname(fileName).replace(/[^.A-Za-z0-9]/g, '').slice(0, 12);
    return `attachment${extension}`;
  }

  app.get('/api/shared/:token/upload/:sha256/content', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!token || !isSha256(sha256)) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const share = shares().findLiveShare(token);
    if (!share) return res.status(404).json({ error: 'Shared attachment not found' });
    const conversationId = share.conversationId;
    if (!conversationId || !conversationReferencesUploadSha(conversationId, sha256)) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const file = stmts.getUploadFile.get(sha256);
    if (!file) return res.status(404).json({ error: 'Shared attachment not found' });
    const filePath = uploadPathForSha(sha256);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Missing file on disk' });
    // Unauthenticated share viewers: the serving helper neutralizes executable
    // types (HTML/SVG) and forces nosniff + sandbox so an attachment can't run
    // as script on this origin; ranges let a shared video seek.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    serveFileWithRangeSupport(req, res, filePath, { contentType: file.mime_type }, {
      safeName: sharedDownloadName(String(file.name || file.file_name || '').replace(/"/g, '')),
      cacheControl: SHARED_CONTENT_CACHE_CONTROL,
    });
  });

  app.get('/api/shared/:token/generated-image/:messageId/:imageId/content', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    const messageId = String(req.params.messageId || '').trim();
    const imageId = String(req.params.imageId || '').trim();
    if (!token || !messageId || !imageId) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const share = shares().findLiveShare(token);
    if (!share) return res.status(404).json({ error: 'Shared attachment not found' });
    const conversationId = share.conversationId;
    if (!conversationId) return res.status(404).json({ error: 'Shared attachment not found' });
    const rows = filterMessagesVisibleToSharedView(
      (stmts.getSharedMessages || stmts.getMessages).all(conversationId),
    );
    const messageRow = rows.find((row) => String(row?.id || '').trim() === messageId);
    if (!messageRow) return res.status(404).json({ error: 'Shared attachment not found' });
    const attachments = parseAttachments(messageRow?.attachments).map(hydrateAttachment).filter(Boolean);
    const attachment = attachments.find((entry) => String(entry?.generatedImage?.imageId || '').trim() === imageId);
    if (!attachment) return res.status(404).json({ error: 'Shared attachment not found' });

    const sessionId = String(attachment?.generatedImage?.sessionId || '').trim();
    const relativePath = String(attachment?.generatedImage?.relativePath || '').replace(/\\/g, '/').trim();
    const root = typeof resolveSessionStateRoot === 'function'
      ? String(resolveSessionStateRoot() || '').trim()
      : '';
    if (!root || !sessionId || !relativePath) return res.status(404).json({ error: 'Shared attachment not found' });
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const normalizedRelative = path.posix.normalize(relativePath).replace(/^\/+/, '');
    if (!safeSession || !normalizedRelative || normalizedRelative.startsWith('..') || normalizedRelative.includes('/../')) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const baseDir = path.resolve(path.join(root, safeSession, 'generated-images'));
    const filePath = path.resolve(path.join(baseDir, normalizedRelative));
    if (!(filePath === baseDir || filePath.startsWith(`${baseDir}${path.sep}`))) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Shared attachment not found' });
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    serveFileWithRangeSupport(req, res, filePath, { contentType: attachment.type }, {
      cacheControl: SHARED_CONTENT_CACHE_CONTROL,
    });
  });

  app.patch('/api/conversation/:id/message/:messageId/share-visibility', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const messageId = String(req.params.messageId || '').trim();
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: 'Missing conversation or message id' });
    }
    if (typeof req.body?.hiddenFromShares !== 'boolean') {
      return res.status(400).json({ error: 'hiddenFromShares must be a boolean' });
    }

    const conv = stmts.getConvAnyStatus.get(conversationId);
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const message = stmts.getMessageByConversation?.get(messageId, conversationId) || null;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (getActiveQueueForMessage.get(conversationId, messageId, messageId)) {
      return res.status(409).json({ error: 'Message visibility can only change after the turn finishes' });
    }

    const hiddenFromShares = req.body.hiddenFromShares === true;
    const currentlyHidden = Number(message.hidden_from_shares || 0) === 1;
    let change = null;
    if (currentlyHidden !== hiddenFromShares) {
      if (!stmts.setMessageShareVisibility) {
        return res.status(503).json({ error: 'Message share visibility is unavailable until the relay restarts' });
      }
      const now = new Date().toISOString();
      stmts.setMessageShareVisibility.run(
        hiddenFromShares ? 1 : 0,
        hiddenFromShares ? now : null,
        messageId,
        conversationId,
      );
      change = broadcastShareVisibilityChange(conversationId, { pinnedChanged: !!message.pinned_at });
    }

    return res.json({
      ok: true,
      conversationId,
      messageId,
      hiddenFromShares,
      hiddenMessages: change?.hiddenMessages || listConversationHiddenMessages(conversationId),
      hiddenMessagesRevision: change?.revision || conversationHiddenMessagesRevision(conversationId),
    });
  });

  // Shows every hidden message to shared viewers again. A message whose turn
  // is still running stays hidden (the single route refuses it the same way)
  // and is named in `skipped`; the rest are unhidden.
  app.post('/api/conversation/:id/share-visibility/unhide-all', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const conv = stmts.getConvAnyStatus.get(conversationId);
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const hiddenRows = stmts.listHiddenMessages?.all?.(conversationId) || [];
    if (hiddenRows.length && !stmts.setMessageShareVisibility) {
      return res.status(503).json({ error: 'Message share visibility is unavailable until the relay restarts' });
    }
    const unhidden = [];
    const skipped = [];
    const unhideRows = db.transaction((rows) => {
      for (const row of rows) {
        const messageId = String(row?.id || '').trim();
        if (!messageId) continue;
        if (getActiveQueueForMessage.get(conversationId, messageId, messageId)) {
          skipped.push({ messageId, reason: 'active-turn' });
          continue;
        }
        stmts.setMessageShareVisibility.run(0, null, messageId, conversationId);
        unhidden.push(messageId);
      }
    });
    unhideRows(hiddenRows);
    let change = null;
    if (unhidden.length) {
      const pinnedChanged = unhidden.some((messageId) => !!stmts.getMessageByConversation?.get(messageId, conversationId)?.pinned_at);
      change = broadcastShareVisibilityChange(conversationId, { pinnedChanged });
    }
    return res.json({
      ok: true,
      conversationId,
      unhidden,
      skipped,
      hiddenMessages: change?.hiddenMessages || listConversationHiddenMessages(conversationId),
      hiddenMessagesRevision: change?.revision || conversationHiddenMessagesRevision(conversationId),
    });
  });
}
