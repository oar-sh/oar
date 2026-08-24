import test from 'node:test';
import assert from 'node:assert/strict';

import { safeServedContentType, applySafeServedContentHeaders } from './safe-served-content.mjs';

function makeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
  };
}

test('active markup types are neutralized to text/plain', () => {
  for (const type of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'application/xml', 'text/xml']) {
    const resolved = safeServedContentType(type);
    assert.equal(resolved.contentType, 'text/plain; charset=utf-8', `${type} must be neutralized`);
    assert.equal(resolved.inlineSafe, false);
    assert.equal(resolved.neutralized, true);
  }
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

test('filenames cannot inject header CRLF or quotes', () => {
  const res = makeRes();
  applySafeServedContentHeaders(res, 'image/png', { fileName: 'a"\r\nSet-Cookie: x=1\\.png' });
  const disposition = String(res.getHeader('Content-Disposition'));
  // No control chars, and the only quotes are the two wrapping the filename.
  assert.doesNotMatch(disposition, /[\r\n]/);
  assert.equal(disposition, 'inline; filename="aSet-Cookie: x=1.png"');
});
