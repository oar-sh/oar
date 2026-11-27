// The base path the app takes from the address stays a path on this origin,
// and index.html's inline copy of the function is this module's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appBaseFromPathname, escapeHtmlAttribute } from './app-base.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));

function between(text, file) {
  const match = text.match(/\/\/ app-base:start\n([\s\S]*?)\n\s*\/\/ app-base:end/);
  assert.ok(match, `${file} has the app-base:start/end block`);
  return match[1].split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

test('index.html runs the same functions as app-base.mjs', () => {
  const moduleText = fs.readFileSync(path.join(appDir, 'app-base.mjs'), 'utf8');
  const pageText = fs.readFileSync(path.join(appDir, '..', 'index.html'), 'utf8');
  assert.equal(between(pageText, 'index.html'), between(moduleText, 'app-base.mjs'));
});

test('a base path from the address', () => {
  assert.equal(appBaseFromPathname('/'), '');
  assert.equal(appBaseFromPathname(''), '');
  assert.equal(appBaseFromPathname('/relay'), '/relay');
  assert.equal(appBaseFromPathname('/relay/'), '/relay');
  assert.equal(appBaseFromPathname('/a/b/'), '/a/b');
  assert.equal(appBaseFromPathname('/relay/shared/0123abcd'), '/relay');
  assert.equal(appBaseFromPathname('/shared/0123abcd'), '');
  assert.equal(appBaseFromPathname('/relay/share-preview/c1'), '/relay');
  assert.equal(appBaseFromPathname('/relay/shared/x/share-preview/y'), '/relay');
});

test('a base path that would point at another host is dropped', () => {
  for (const pathname of [
    '//elsewhere.test/..%2Findex.html',
    '//elsewhere.test',
    '///elsewhere.test/x',
    '/relay//elsewhere.test',
    '/\\elsewhere.test',
    '/%5Celsewhere.test',
    '/%2F%2Felsewhere.test',
    '/%2Felsewhere.test',
    '/%E0%A4%A',
    '//elsewhere.test/shared/0123abcd',
    // The page writes the base into HTML, where the parser decodes these.
    '/&sol;elsewhere.test/x',
    '/&bsol;elsewhere.test/x',
    '/&#47;elsewhere.test/x',
    '/&#x2F;elsewhere.test/x',
    '/a&amp;b',
    '/<x',
    '/"x',
    "/'x",
    '/a;b',
    '/a b',
    '/a\tb',
  ]) {
    assert.equal(appBaseFromPathname(pathname), '', pathname);
  }
});

test('a base keeps plain URL path characters', () => {
  assert.equal(appBaseFromPathname('/relay-1/a.b_c~d'), '/relay-1/a.b_c~d');
  assert.equal(appBaseFromPathname('/caf%C3%A9'), '/caf%C3%A9');
});

test('the base goes into an HTML attribute escaped', () => {
  assert.equal(escapeHtmlAttribute('/relay'), '/relay');
  assert.equal(escapeHtmlAttribute('/&sol;x'), '/&#38;sol;x');
  assert.equal(escapeHtmlAttribute('"><script>x</script>'), '&#34;&#62;&#60;script&#62;x&#60;/script&#62;');
  assert.equal(escapeHtmlAttribute("a'b"), 'a&#39;b');
  assert.equal(escapeHtmlAttribute(''), '');
});
