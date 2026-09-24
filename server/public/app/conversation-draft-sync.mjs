// Per-conversation record of the server draft this client's composer last
// agreed with. The composer text is local state that changes on every
// keystroke; this record changes only when the server acknowledges a save or
// the composer adopts a remote draft. Its updatedAt is the base version every
// draft save is checked against, so it must never be touched by a local edit.

import { serializeDraftAttachments } from './composer-attachment-cache.mjs';
import { normalizeDraftTimestampMs } from './conversation-draft-timestamp-utils.mjs';

// Sent with every draft save. It is what lets the server conflict-check an
// explicit null base: clients from before this protocol also send null (JSON
// keeps it), and for them null has to keep meaning "unconditional".
export const DRAFT_SYNC_PROTOCOL_VERSION = 2;

// Must equal the server's MAX_CONVERSATION_DRAFT_LENGTH (a test pins it). The
// server truncates longer drafts, so the client saves and compares only this
// prefix; otherwise a long composer never matches its acknowledged draft and
// is re-saved on every refresh. The composer itself (and the message) is not
// limited — only what survives as a draft.
export const MAX_DRAFT_TEXT_LENGTH = 20_000;

export function draftTextForSync(text) {
  return String(text || '').slice(0, MAX_DRAFT_TEXT_LENGTH);
}

const syncedDraftsByConversation = new Map();

function conversationKey(conversationId) {
  return String(conversationId || '').trim();
}

/** Order-sensitive fingerprint of a draft attachment list; null when absent. */
export function draftAttachmentsKey(attachments) {
  if (attachments === undefined || attachments === null) return null;
  return serializeDraftAttachments(Array.isArray(attachments) ? attachments : [], { max: Number.MAX_SAFE_INTEGER })
    .map((row) => row.sha256)
    .join(',');
}

export function getSyncedDraft(conversationId) {
  return syncedDraftsByConversation.get(conversationKey(conversationId)) || null;
}

export function recordSyncedDraft(conversationId, {
  text = '',
  attachments = undefined,
  updatedAt = null,
} = {}) {
  const id = conversationKey(conversationId);
  if (!id) return null;
  const previous = syncedDraftsByConversation.get(id) || null;
  const incomingKey = draftAttachmentsKey(attachments);
  const record = {
    text: String(text || ''),
    attachmentsKey: incomingKey === null ? (previous?.attachmentsKey ?? null) : incomingKey,
    updatedAt: updatedAt || null,
  };
  syncedDraftsByConversation.set(id, record);
  return record;
}

export function forgetSyncedDraft(conversationId) {
  syncedDraftsByConversation.delete(conversationKey(conversationId));
}

/**
 * A save is a no-op when the server already holds exactly this text (and,
 * for saves that carry attachments, exactly these attachments) — but only
 * while no newer server version is known. If one is (a remote draft deferred
 * while the user typed), the save must still go out so its version check
 * surfaces that draft instead of silently keeping a stale base.
 */
export function isDraftSaveNoop({ synced = null, text = '', attachmentsKey = null, knownUpdatedAt = null } = {}) {
  if (!synced) return false;
  if (normalizeDraftTimestampMs(knownUpdatedAt) > normalizeDraftTimestampMs(synced.updatedAt)) return false;
  if (String(text || '') !== synced.text) return false;
  if (attachmentsKey === null) return true;
  return synced.attachmentsKey !== null && attachmentsKey === synced.attachmentsKey;
}

/**
 * Decides a 409 draft conflict.
 * - converged: the server already holds what we wanted to save.
 * - adopt: the local text is unchanged since the last sync, so the remote
 *   draft simply wins.
 * - keep-local: both sides edited; the local (newest) keystroke wins and the
 *   remote text becomes the one offered for restore.
 */
export function resolveDraftConflict({
  localText = '',
  localAttachmentsKey = null,
  baseText = null,
  baseAttachmentsKey = null,
  serverText = '',
  serverAttachmentsKey = null,
} = {}) {
  const local = String(localText || '');
  const attachmentsMatch = (other) => localAttachmentsKey === null || localAttachmentsKey === other;
  if (local === String(serverText || '') && attachmentsMatch(serverAttachmentsKey)) return 'converged';
  if (baseText !== null && local === baseText && attachmentsMatch(baseAttachmentsKey)) return 'adopt';
  return 'keep-local';
}

/**
 * Whether an incoming remote draft may replace the composer of the
 * conversation on screen. Only an unmodified composer (text and attachments
 * still equal to the last synced draft) adopts it, focused or not. A modified
 * one never does — not even for an equal or newer version: its edit is unsaved
 * (a failed flush leaves exactly this state), and the caller re-saves it so the
 * version check decides. An upload still in flight counts as a modification.
 * With nothing synced yet there is no saved edit to protect.
 * Attachment keys are null when unknown and then do not take part.
 */
export function shouldApplyIncomingDraftToComposer({
  inputText = '',
  incomingText = '',
  syncedText = null,
  inputAttachmentsKey = null,
  incomingAttachmentsKey = null,
  syncedAttachmentsKey = null,
  attachmentsUploading = false,
} = {}) {
  if (attachmentsUploading) return false;
  const current = draftTextForSync(inputText);
  const sameAttachments = (other) => inputAttachmentsKey === null || other === null || inputAttachmentsKey === other;
  if (current === String(incomingText || '') && sameAttachments(incomingAttachmentsKey)) return true;
  if (syncedText === null) return true;
  return current === syncedText && sameAttachments(syncedAttachmentsKey);
}

/**
 * PATCH body for the pagehide Background Sync copy of a draft flush, or null
 * when the composer holds nothing unsaved. Compared against the synced draft,
 * not the local text (which every keystroke updates).
 */
export function draftFlushRequestBody({
  inputText = '',
  synced = null,
  fallbackText = '',
  fallbackUpdatedAt = null,
  clientId = null,
} = {}) {
  const draftText = draftTextForSync(inputText);
  const serverText = synced ? synced.text : draftTextForSync(fallbackText);
  if (draftText === serverText) return null;
  return {
    draftText,
    clientId,
    draftSyncVersion: DRAFT_SYNC_PROTOCOL_VERSION,
    baseDraftUpdatedAt: (synced ? synced.updatedAt : fallbackUpdatedAt) || null,
  };
}
