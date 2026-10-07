import test from 'node:test';
import assert from 'node:assert/strict';

import { safeServedContentType, applySafeServedContentHeaders, contentDispositionValue } from './safe-served-content.mjs';

// Node's own rule for a header value: no control characters, nothing outside
// Latin-1. The fake refuses the same values so a test cannot pass with a
// header the real response would throw on.
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

function makeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      if (INVALID_HEADER_CHAR.test(String(value))) {
        throw Object.assign(new TypeError(`Invalid character in header content ["${name}"]`), { code: 'ERR_INVALID_CHAR' });
      }
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) { return headers[name.toLowerCase()]; },
  };
}

test('active markup types are neutralized to text/plain', () => {
  for (const type of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'application/xml', 'text/xml', 'application/rss+xml']) {
    const resolved = safeServedContentType(type);
    assert.equal(resolved.contentType, 'text/plain; charset=utf-8', `${type} must be neutralized`);
    assert.equal(resolved.inlineSafe, false);
    assert.equal(resolved.neutralized, true);
  }
});

test('an SVG keeps its type, inline, and still carries the sandbox so it cannot run as a page', () => {
  // As text/plain an <img> refused it, so no SVG could be previewed; as a
  // document the sandbox CSP still denies it script and an origin.
  const resolved = safeServedContentType('image/svg+xml; charset=utf-8');
  assert.deepEqual(resolved, { contentType: 'image/svg+xml', inlineSafe: true, neutralized: false });
  const res = makeRes();
  applySafeServedContentHeaders(res, 'image/svg+xml', { fileName: 'logo.svg' });
  assert.equal(res.getHeader('Content-Type'), 'image/svg+xml');
  assert.equal(res.getHeader('Content-Disposition'), 'inline; filename="logo.svg"');
  assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  assert.match(String(res.getHeader('Content-Security-Policy')), /default-src 'none'; sandbox; frame-ancestors 'none'/);
});

test('media types keep their real type and stay inline-safe', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'video/mp4', 'audio/wav', 'application/pdf']) {
    const resolved = safeServedContentType(type);
    assert.equal(resolved.contentType, type);
    assert.equal(resolved.inlineSafe, true);
    assert.equal(resolved.neutralized, false);
  }
});

test('unknown/other types are preserved but not inline-safe', () => {
  const resolved = safeServedContentType('application/octet-stream');
  assert.equal(resolved.contentType, 'application/octet-stream');
  assert.equal(resolved.inlineSafe, false);
  const missing = safeServedContentType('');
  assert.equal(missing.contentType, 'application/octet-stream');
});

test('applySafeServedContentHeaders sets nosniff + sandbox CSP and attachment for markup', () => {
  const res = makeRes();
  const resolved = applySafeServedContentHeaders(res, 'text/html', { fileName: 'report.html' });
  assert.equal(res.getHeader('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  assert.match(res.getHeader('Content-Security-Policy'), /default-src 'none'/);
  assert.match(res.getHeader('Content-Security-Policy'), /sandbox/);
  assert.equal(res.getHeader('Content-Disposition'), 'attachment; filename="report.html"');
  assert.equal(resolved.neutralized, true);
});

test('applySafeServedContentHeaders keeps images inline', () => {
  const res = makeRes();
  applySafeServedContentHeaders(res, 'image/png', { fileName: 'pic.png' });
  assert.equal(res.getHeader('Content-Type'), 'image/png');
  assert.equal(res.getHeader('Content-Disposition'), 'inline; filename="pic.png"');
});

test('a PDF is inline without the sandbox, so the browser viewer may show it', () => {
  // Browsers refuse to render a sandboxed PDF in their built-in viewer, which
  // made "open in a new tab" a download. Everything else keeps the sandbox.
  const res = makeRes();
  applySafeServedContentHeaders(res, 'application/pdf', { fileName: 'letter.pdf' });
  assert.equal(res.getHeader('Content-Type'), 'application/pdf');
  assert.equal(res.getHeader('Content-Disposition'), 'inline; filename="letter.pdf"');
  assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  const csp = String(res.getHeader('Content-Security-Policy'));
  assert.doesNotMatch(csp, /sandbox/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);

  for (const type of ['image/png', 'video/mp4', 'audio/mpeg', 'application/octet-stream', 'text/html']) {
    const other = makeRes();
    applySafeServedContentHeaders(other, type, { fileName: 'x' });
    assert.match(String(other.getHeader('Content-Security-Policy')), /sandbox; frame-ancestors 'none'/, `${type} keeps the sandbox`);
  }
});

test('filenames cannot inject header CRLF or quotes', () => {
  const res = makeRes();
  applySafeServedContentHeaders(res, 'image/png', { fileName: 'a"\r\nSet-Cookie: x=1\\.png' });
  const disposition = String(res.getHeader('Content-Disposition'));
  // No control chars, and the only quotes are the two wrapping the filename.
  assert.doesNotMatch(disposition, /[\r\n]/);
  assert.equal(disposition, 'inline; filename="aSet-Cookie: x=1.png"');
});

test('a name with characters outside Latin-1 is sent as filename* with an ASCII fallback', () => {
  // The regression: `filename="レポート.pdf"` made setHeader throw
  // ERR_INVALID_CHAR, so such a file could not be served at all.
  const res = makeRes();
  applySafeServedContentHeaders(res, 'application/pdf', { fileName: 'レポート.pdf' });
  assert.equal(
    res.getHeader('Content-Disposition'),
    `inline; filename="file.pdf"; filename*=UTF-8''%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.pdf`,
  );

  // Latin-1 letters pass setHeader, but the quoted form is not reliably read
  // as UTF-8 by every client, so they also get filename*.
  assert.equal(
    contentDispositionValue('attachment', 'Übersicht 2026.txt'),
    `attachment; filename="bersicht 2026.txt"; filename*=UTF-8''%C3%9Cbersicht%202026.txt`,
  );

  // An emoji is two UTF-16 code units: both go, and the stem keeps its ASCII.
  assert.equal(
    contentDispositionValue('attachment', 'demo 🎉 notes.md'),
    `attachment; filename="demo  notes.md"; filename*=UTF-8''demo%20%F0%9F%8E%89%20notes.md`,
  );

  // A plain ASCII name is unchanged, with no filename* at all.
  assert.equal(contentDispositionValue('attachment', 'report.pdf'), 'attachment; filename="report.pdf"');
  assert.equal(contentDispositionValue('inline', ''), 'inline');
});

test('the fallback name is never empty and the header never holds a refused character', () => {
  // Nothing ASCII left at all: a name, not an empty string or a bare extension.
  assert.equal(contentDispositionValue('attachment', '報告書'), `attachment; filename="file"; filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8`);
  assert.equal(contentDispositionValue('attachment', '.日本'), `attachment; filename="file"; filename*=UTF-8''.%E6%97%A5%E6%9C%AC`);
  // RFC 5987 does not allow these bare in an ext-value; encodeURIComponent keeps them.
  assert.equal(contentDispositionValue('attachment', "it's (1)*ü.txt"), `attachment; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A%C3%BC.txt`);
  // Quotes, backslashes and control characters go before anything else.
  assert.equal(contentDispositionValue('attachment', 'a"\r\n\\ü\u0000.txt'), `attachment; filename="a.txt"; filename*=UTF-8''a%C3%BC.txt`);
  // A lone surrogate would make encodeURIComponent throw; it is dropped.
  assert.equal(contentDispositionValue('attachment', 'x\uD83Dy.bin'), 'attachment; filename="xy.bin"');

  for (const name of ['レポート.pdf', '報告書', 'demo 🎉 notes.md', 'Übersicht.txt', 'a"\r\n\\ü.txt', 'x\uD83Dy.bin']) {
    const res = makeRes();
    assert.doesNotThrow(() => applySafeServedContentHeaders(res, 'application/octet-stream', { fileName: name }), name);
    assert.doesNotMatch(String(res.getHeader('Content-Disposition')), /[^\x20-\x7e]/, `${name}: ASCII only`);
  }
});
