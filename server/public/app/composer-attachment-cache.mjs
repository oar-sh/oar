// Serialization rules for the per-conversation composer attachment cache.
// Only already-uploaded attachments are persisted: the draft row stores content
// hashes, never file bytes, so switching conversations is cheap and reload-safe.

import { normalizeDraftTimestampMs, isIncomingDraftTimestampStale } from './conversation-draft-timestamp-utils.mjs';

// Attachments added before a conversation exists live under this key and are
// migrated onto the real conversation id the first time a message is sent.
export const PENDING_CONVERSATION_KEY = '__new__';

export const DRAFT_UPLOAD_MESSAGE_ID = '__draft__';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function isSha256(value) {
  return SHA256_PATTERN.test(String(value || '').trim().toLowerCase());
}

export function isUploadedAttachment(attachment) {
  if (!attachment) return false;
  if (attachment.uploadState && attachment.uploadState !== 'uploaded') return false;
  return isSha256(attachment.sha256 || attachment.uploaded?.sha256);
}

function attachmentSha(attachment) {
  return String(attachment?.sha256 || attachment?.uploaded?.sha256 || '').trim().toLowerCase();
}

/**
 * Reduces composer attachments to the minimal persistable descriptor. Anything
 * still uploading or failed is skipped, because a draft must only ever reference
 * blobs that actually exist on the server.
 */
export function serializeDraftAttachments(attachments = [], { max = 6 } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  const limit = Math.max(0, Number(max) || 0);
  const seen = new Set();
  const rows = [];

  for (const attachment of list) {
    if (rows.length >= limit) break;
    if (!isUploadedAttachment(attachment)) continue;
    const sha256 = attachmentSha(attachment);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const source = attachment.uploaded && typeof attachment.uploaded === 'object' ? attachment.uploaded : attachment;
    rows.push({
      sha256,
      name: String(source.name || attachment.name || '').trim().slice(0, 255) || `upload-${sha256.slice(0, 12)}`,
      type: String(source.type || attachment.type || 'application/octet-stream').trim().toLowerCase().slice(0, 127),
      size: Math.max(0, Number(source.size || attachment.size || 0) || 0),
    });
  }

  return rows;
}

/**
 * Rebuilds composer records from persisted rows. The server already serves the
 * bytes, so previews point at the content URL instead of an object URL that
 * would have to be revoked.
 */
export function hydrateDraftAttachments(rows = [], { contentUrlFor } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const resolveUrl = typeof contentUrlFor === 'function'
    ? contentUrlFor
    : (sha256) => `/api/upload/${sha256}/content`;

  const seen = new Set();
  const hydrated = [];

  for (const row of list) {
    const sha256 = String(row?.sha256 || '').trim().toLowerCase();
    if (!isSha256(sha256) || seen.has(sha256)) continue;
    seen.add(sha256);

    const type = String(row?.type || 'application/octet-stream').trim().toLowerCase();
    const name = String(row?.name || '').trim() || `upload-${sha256.slice(0, 12)}`;
    const size = Math.max(0, Number(row?.size || 0) || 0);
    const contentUrl = resolveUrl(sha256);
    const isImage = type.startsWith('image/');

    hydrated.push({
      id: `draft-${sha256}`,
      name,
      type,
      size,
      sha256,
      file: null,
      isImage,
      // Server-hosted, so there is no object URL to revoke on removal.
      previewUrl: isImage ? contentUrl : '',
      previewUrlIsObjectUrl: false,
      uploadState: 'uploaded',
      uploaded: { sha256, name, type, size, contentUrl },
      error: '',
    });
  }

  return hydrated;
}

export function draftAttachmentsEqual(a = [], b = []) {
  const left = serializeDraftAttachments(a, { max: Number.MAX_SAFE_INTEGER });
  const right = serializeDraftAttachments(b, { max: Number.MAX_SAFE_INTEGER });
  if (left.length !== right.length) return false;
  return left.every((row, index) => row.sha256 === right[index].sha256);
}

/**
 * Decides whether a pushed draft update should replace local composer state.
 * Local echoes and out-of-order updates are ignored so a slow broadcast cannot
 * resurrect an attachment the user just removed.
 */
export function mergeDraftAttachmentUpdate({
  existing = [],
  incoming = [],
  existingUpdatedAt = null,
  incomingUpdatedAt = null,
  isLocalEcho = false,
} = {}) {
  if (isLocalEcho) {
    return { attachments: existing, changed: false, reason: 'local-echo' };
  }

  const stale = isIncomingDraftTimestampStale({
    existingMs: normalizeDraftTimestampMs(existingUpdatedAt),
    incomingMs: normalizeDraftTimestampMs(incomingUpdatedAt),
  });
  if (stale) {
    return { attachments: existing, changed: false, reason: 'stale' };
  }

  if (draftAttachmentsEqual(existing, incoming)) {
    return { attachments: existing, changed: false, reason: 'unchanged' };
  }

  return { attachments: incoming, changed: true, reason: 'applied' };
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
