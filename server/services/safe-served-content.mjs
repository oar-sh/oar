// Safe headers for streaming stored bytes (workspace files, uploads, shared
// attachments) back to the browser.
//
// The threat: a semi-trusted producer (an AI worker writing a workspace file, or
// an uploaded attachment) can supply content whose MIME type the browser will
// execute as markup/script on THIS origin — `text/html`, XML with embedded
// script. Served inline, that is stored XSS against the app (and, via the
// unauthenticated /api/shared/* routes, against share viewers). We neutralize
// such types to `text/plain` and always send `nosniff`, and we attach a
// locked-down CSP + `sandbox` so anything that still reaches the browser as a
// document can neither run script nor navigate.
//
// SVG keeps its type: as an `<img>` it never runs script, and opened as a
// document the `sandbox` CSP denies it script and an origin, so the viewer
// and the file browser's thumbnails can show it.

// Types the browser renders as active documents on this origin.
const ACTIVE_MARKUP_PATTERN = /^text\/html\b|xhtml|(^|\/)xml\b|\+xml\b/i;
const SVG_TYPE = 'image/svg+xml';

// Types safe to preview inline with their real Content-Type.
const INLINE_SAFE_PREFIXES = ['image/', 'video/', 'audio/'];
const INLINE_SAFE_EXACT = new Set(['application/pdf']);

/**
 * Resolve the Content-Type to send for stored bytes, neutralizing types the
 * browser would execute. Returns the (possibly coerced) type plus whether it is
 * safe to display inline.
 */
export function safeServedContentType(mimeType) {
  const type = String(mimeType || '').trim().toLowerCase().split(';')[0].slice(0, 127)
    || 'application/octet-stream';
  if (type !== SVG_TYPE && ACTIVE_MARKUP_PATTERN.test(type)) {
    // Render markup/script content as its own source text instead of executing it.
    return { contentType: 'text/plain; charset=utf-8', inlineSafe: false, neutralized: true };
  }
  const inlineSafe = INLINE_SAFE_PREFIXES.some((prefix) => type.startsWith(prefix))
    || INLINE_SAFE_EXACT.has(type);
  return { contentType: type, inlineSafe, neutralized: false };
}

// Printable ASCII, the only characters a quoted `filename="…"` may hold once
// quotes and backslashes are gone. Anything else goes into `filename*`.
const NON_ASCII_PATTERN = /[^\x20-\x7e]/g;
// A surrogate without its partner: not a character, and encodeURIComponent
// throws on it.
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** RFC 5987 `ext-value` encoding: UTF-8 percent-encoded, attr-char kept. */
function encodeRfc5987(value) {
  return encodeURIComponent(value)
    // encodeURIComponent leaves these alone, but RFC 5987 does not allow them bare.
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The `Content-Disposition` value for `fileName`, RFC 6266 style: a quoted
 * `filename` every client can read, built from the name's ASCII characters
 * (never empty: `file` plus the extension when nothing is left), and, when the
 * name has characters outside ASCII, `filename*=UTF-8''…` carrying the whole
 * name percent-encoded. The result holds nothing a header may not: no
 * control characters, no quotes inside the quoted string, and no character
 * outside Latin-1, which Node's `setHeader` rejects (and which used to make a
 * file with a Japanese or emoji name unservable).
 */
export function contentDispositionValue(disposition, fileName) {
  const name = String(fileName || '')
    .replace(LONE_SURROGATE_PATTERN, '')
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .slice(0, 255);
  if (!name) return disposition;
  const ascii = name.replace(NON_ASCII_PATTERN, '').trim();
  if (ascii === name) return `${disposition}; filename="${name}"`;
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(NON_ASCII_PATTERN, '').replace(/^[\s.]+|[\s.]+$/g, '') || 'file';
  const ext = (dot > 0 ? name.slice(dot) : '').replace(NON_ASCII_PATTERN, '').trim();
  const fallback = `${stem}${ext.length > 1 ? ext : ''}`;
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/**
 * Apply the safe Content-Type plus the hardening headers to a response that is
 * about to stream stored bytes. Returns the resolved descriptor so callers can
 * choose an inline vs. attachment disposition.
 */
export function applySafeServedContentHeaders(res, mimeType, { fileName = '' } = {}) {
  const resolved = safeServedContentType(mimeType);
  res.setHeader('Content-Type', resolved.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Belt-and-braces: a served file is never part of the app UI, so forbid it
  // from loading anything or being framed, and sandbox it so it cannot run
  // script or navigate even if a browser would otherwise treat it as active.
  // A PDF is the exception: browsers refuse to show a sandboxed PDF in their
  // built-in viewer, so it gets no `sandbox` and may be framed by this origin.
  // PDF viewers do not run document script, so the sandbox bought nothing there.
  res.setHeader(
    'Content-Security-Policy',
    resolved.contentType === 'application/pdf'
      ? "default-src 'none'; frame-ancestors 'self'"
      : "default-src 'none'; sandbox; frame-ancestors 'none'",
  );
  res.setHeader(
    'Content-Disposition',
    contentDispositionValue(resolved.inlineSafe ? 'inline' : 'attachment', fileName),
  );
  return resolved;
}
