// Pure helpers for turning clipboard/drag payloads into composer attachments.
// Kept free of DOM globals so the logic is unit-testable in Node.

const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['image/heic', 'heic'],
  ['image/bmp', 'bmp'],
  ['image/svg+xml', 'svg'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['application/json', 'json'],
]);

// Chrome hands every clipboard bitmap over as "image.png" regardless of origin, so
// these names carry no information worth keeping and get replaced with a timestamp.
const GENERIC_CLIPBOARD_NAMES = new Set(['image.png', 'image.jpeg', 'image.jpg', 'image', 'blob', 'unknown']);

export function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase().split(';')[0];
  return MIME_EXTENSIONS.get(normalized) || 'bin';
}

export function isGenericClipboardName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return true;
  return GENERIC_CLIPBOARD_NAMES.has(normalized);
}

export function pastedFileName(mimeType, now = new Date(), index = 0) {
  const date = now instanceof Date ? now : new Date(now);
  const stamp = (Number.isNaN(date.getTime()) ? new Date(0) : date)
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[:.]/g, '-');
  const suffix = Number(index) > 0 ? `-${Number(index) + 1}` : '';
  return `pasted-${stamp}${suffix}.${extensionForMimeType(mimeType)}`;
}

function collectFilesFromItems(items) {
  const files = [];
  let hadText = false;
  for (const item of Array.from(items || [])) {
    if (!item) continue;
    const kind = String(item.kind || '').toLowerCase();
    if (kind === 'string') {
      hadText = true;
      continue;
    }
    if (kind !== 'file') continue;
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (file) files.push(file);
  }
  return { files, hadText };
}

/**
 * Reads a paste payload. Files win over text: when the clipboard carries both
 * (copying from Word or a browser produces exactly this), the caller attaches the
 * file and suppresses the text insert. When no file is present we report nothing
 * so the browser's native text paste is left completely untouched.
 */
export function extractPastedFiles(clipboardData) {
  if (!clipboardData) return { files: [], hadText: false };

  const types = Array.from(clipboardData.types || []).map((type) => String(type || '').toLowerCase());
  const hadTextType = types.some((type) => type === 'text/plain' || type === 'text/html');

  const direct = Array.from(clipboardData.files || []).filter(Boolean);
  if (direct.length) return { files: direct, hadText: hadTextType };

  // Safari and older Firefox expose pasted images only through `items`.
  const fromItems = collectFilesFromItems(clipboardData.items);
  return { files: fromItems.files, hadText: hadTextType || fromItems.hadText };
}

/**
 * Reads a drop payload. Dragging selected text or a link also fires `drop`, so we
 * only claim the event when the transfer actually advertises files.
 */
export function extractDroppedFiles(dataTransfer) {
  if (!dataTransfer) return { files: [], hadText: false };

  const types = Array.from(dataTransfer.types || []).map((type) => String(type || '').toLowerCase());
  const hadText = types.some((type) => type === 'text/plain' || type === 'text/html' || type === 'text/uri-list');
  if (types.length && !types.includes('files')) return { files: [], hadText };

  const direct = Array.from(dataTransfer.files || []).filter(Boolean);
  if (direct.length) return { files: direct, hadText };

  const fromItems = collectFilesFromItems(dataTransfer.items);
  return { files: fromItems.files, hadText };
}

export function dataTransferHasFiles(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []).map((type) => String(type || '').toLowerCase());
  if (types.includes('files')) return true;
  return Array.from(dataTransfer.items || []).some((item) => String(item?.kind || '').toLowerCase() === 'file');
}

/**
 * Applies the attachment cap without silently discarding the overflow, so callers
 * can tell the user what was dropped.
 */
export function planAttachmentMerge(existing = [], incoming = [], max = 6) {
  const current = Array.isArray(existing) ? existing.filter(Boolean) : [];
  const additions = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  const limit = Math.max(0, Number(max) || 0);

  const remaining = Math.max(0, limit - current.length);
  const acceptedAdditions = additions.slice(0, remaining);
  const droppedCount = additions.length - acceptedAdditions.length;

  return {
    accepted: current.concat(acceptedAdditions),
    acceptedAdditions,
    droppedCount,
  };
}

export function overCapNoticeText(droppedCount, max = 6) {
  const dropped = Math.max(0, Number(droppedCount) || 0);
  if (!dropped) return '';
  const noun = dropped === 1 ? 'file was' : 'files were';
  return `Only ${max} attachments allowed — ${dropped} ${noun} dropped.`;
}
