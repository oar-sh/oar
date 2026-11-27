import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APP_SHELL_CSP } from './app-shell-csp.mjs';

const EXPECTED = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data: blob:; worker-src 'self'; "
  + "manifest-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; "
  + "frame-ancestors 'self'";

function directives(policy) {
  return new Map(policy.split(';').map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
}

test('the app shell policy is the Stage A policy', () => {
  assert.equal(APP_SHELL_CSP, EXPECTED);
});

test('the policy allows no remote origin and holds no hostname, IP address or port', () => {
  for (const [name, sources] of directives(APP_SHELL_CSP)) {
    for (const source of sources) {
      // Keywords and the three local schemes only: nothing that names a place.
      assert.ok(
        ["'self'", "'unsafe-inline'", "'none'", 'data:', 'blob:'].includes(source),
        `${name} lists ${source}`,
      );
    }
  }
  assert.doesNotMatch(APP_SHELL_CSP, /https?:|wss?:|\*|\/\//i);
  // No dotted name, IPv4/IPv6 address or :port anywhere.
  assert.doesNotMatch(APP_SHELL_CSP, /\w\.\w/);
  assert.doesNotMatch(APP_SHELL_CSP, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  assert.doesNotMatch(APP_SHELL_CSP, /:\d/);
  assert.doesNotMatch(APP_SHELL_CSP, /localhost|\[[0-9a-f:]+\]/i);
});

test('the policy keeps the script rules Stage A promises, and the frame rules the shell had', () => {
  const policy = directives(APP_SHELL_CSP);
  assert.deepEqual(policy.get('script-src'), ["'self'", "'unsafe-inline'"]);
  assert.ok(!policy.get('script-src').includes("'unsafe-eval'"));
  assert.deepEqual(policy.get('frame-ancestors'), ["'self'"]);
  assert.deepEqual(policy.get('object-src'), ["'none'"]);
  assert.deepEqual(policy.get('default-src'), ["'self'"]);
  assert.equal(policy.has('frame-src'), false, 'the UI frames nothing');
});

test('the policy is built from nothing a request or a setting supplies', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./app-shell-csp.mjs', import.meta.url)), 'utf8');
  // A constant: no function, no config, no request in the module.
  assert.doesNotMatch(source.replace(/^\/\/.*$/gm, ''), /\b(?:config|req|process\.env|location|host)\b/);
});

test('every route that renders the shell sets it through applyAppShellHeaders', () => {
  const runtime = fs.readFileSync(fileURLToPath(new URL('../server-runtime.mjs', import.meta.url)), 'utf8');
  assert.match(runtime, /function applyAppShellHeaders\(res\) \{\s*res\.setHeader\('Content-Security-Policy', APP_SHELL_CSP\);\s*\}/);
  for (const route of [
    "app.get(['/', '/index.html']",
    "app.get(['/shared/:token', '/shared/:token/']",
    "app.get(['/share-preview/:conversationId', '/share-preview/:conversationId/']",
  ]) {
    const start = runtime.indexOf(route);
    assert.notEqual(start, -1, route);
    const body = runtime.slice(start, runtime.indexOf('\n});\n', start));
    assert.match(body, /applyAppShellHeaders\(res\);/, route);
  }
});
