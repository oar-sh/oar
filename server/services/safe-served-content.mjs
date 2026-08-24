// Safe headers for streaming stored bytes (workspace files, uploads, shared
// attachments) back to the browser.
//
// The threat: a semi-trusted producer (an AI worker writing a workspace file, or
// an uploaded attachment) can supply content whose MIME type the browser will
// execute as markup/script on THIS origin — `text/html`, `image/svg+xml`, XML
// with embedded script. Served inline, that is stored XSS against the app (and,
// via the unauthenticated /api/shared/* routes, against share viewers). We
// neutralize such types to `text/plain` and always send `nosniff`, and we attach
// a locked-down CSP + `sandbox` so anything that still reaches the browser as a
// document can neither run script nor navigate.

// Types the browser renders as active documents on this origin.
const ACTIVE_MARKUP_PATTERN = /^text\/html\b|svg|xhtml|(^|\/)xml\b|\+xml\b/i;

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
  if (ACTIVE_MARKUP_PATTERN.test(type)) {
    // Render markup/script content as its own source text instead of executing it.
    return { contentType: 'text/plain; charset=utf-8', inlineSafe: false, neutralized: true };
  }
  const inlineSafe = INLINE_SAFE_PREFIXES.some((prefix) => type.startsWith(prefix))
    || INLINE_SAFE_EXACT.has(type);
  return { contentType: type, inlineSafe, neutralized: false };
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
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
  const safeName = String(fileName || '').replace(/[\r\n"\\]/g, '').slice(0, 255);
  const disposition = resolved.inlineSafe ? 'inline' : 'attachment';
  res.setHeader(
    'Content-Disposition',
    safeName ? `${disposition}; filename="${safeName}"` : disposition,
  );
  return resolved;
}
