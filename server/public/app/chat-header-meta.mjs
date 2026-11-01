// The lines under the chat title (origin, relay chips, folder) come with a
// long and a short label. On a desktop the long one shows; on a phone the
// meta lines share one row that scrolls sideways and show the short one. CSS
// picks (index.html, .chat-meta-long / .chat-meta-short). DOM-free.

export const CHAT_META_LONG_CLASS = 'chat-meta-long';
export const CHAT_META_SHORT_CLASS = 'chat-meta-short';

/** Both labels; the arguments are HTML the caller already escaped. */
export function chatMetaLabelHtml(longHtml, shortHtml) {
  return `<span class="${CHAT_META_LONG_CLASS}">${longHtml}</span><span class="${CHAT_META_SHORT_CLASS}">${shortHtml}</span>`;
}

/**
 * The last folder name of a path, for the phone's folder chip:
 * "/home/dev/sample-repo/" → "sample-repo", "C:\\work\\api" → "api". A root
 * ("/", "C:\\") is kept whole; '' for nothing.
 */
export function cwdFolderName(path) {
  const raw = String(path ?? '').trim();
  if (!raw) return '';
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return raw.slice(0, 1);
  if (/^[A-Za-z]:$/.test(trimmed)) return raw;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw;
}
