// Per-conversation record of the server draft this client's composer last
// agreed with. The composer text is local state that changes on every
// keystroke; this record changes only when the server acknowledges a save or
// the composer adopts a remote draft. Its updatedAt is the base version every
// draft save is checked against, so it must never be touched by a local edit.

import { serializeDraftAttachments } from './composer-attachment-cache.mjs';

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
 * for saves that carry attachments, exactly these attachments).
 */
export function isDraftSaveNoop({ synced = null, text = '', attachmentsKey = null } = {}) {
  if (!synced) return false;
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
 * Whether an incoming remote draft may replace the composer text of the
 * conversation on screen. An unmodified composer (text still equal to the last
 * synced draft) always adopts, focused or not — an idle focused composer must
 * never hold on to stale text it would later save back. A modified one keeps
 * its text while focused or while its own save is pending; that save's
 * version check then resolves the conflict.
 */
export function shouldApplyIncomingDraftToComposer({
  isFocused = false,
  inputText = '',
  incomingText = '',
  syncedText = null,
  savePending = false,
} = {}) {
  const current = String(inputText || '');
  if (current === String(incomingText || '')) return true;
  if (syncedText !== null && current === syncedText) return true;
  if (isFocused) return false;
  return !savePending;
}
