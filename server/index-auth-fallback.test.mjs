import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const source = fs.readFileSync(indexPath, 'utf8');

test('index auth gate uses resilient connect handler', () => {
  assert.match(source, /window\.__copilotAuthConnect = async \(event\) => \{/);
  assert.match(source, /if \(typeof window\.doAuth === 'function'\) \{/);
  // The sign-in exchange: the token for a browser session in the HttpOnly cookie.
  assert.match(source, /fetch\(`\$\{__APP_BASE\}\/api\/auth\/session`, \{\s*method: 'POST',/);
  assert.doesNotMatch(source, /fetch\(`\$\{__APP_BASE\}\/api\/status`/);
  assert.match(source, /await window\.__loadCopilotApp\(\{ recover: true \}\);/);
  assert.doesNotMatch(source, /localStorage\.setItem\(__AUTH_TOKEN_STORAGE_KEY/);
  assert.doesNotMatch(source, /document\.cookie = `\$\{__AUTH_COOKIE_NAME\}=\$\{encodeURIComponent\(token\)\}/);
  assert.match(source, /document\.cookie = `copilot_auth=; Path=\$\{cookiePath\}; Max-Age=0;/);
  // A form (password managers): Enter and the Connect button submit it, and
  // its submit listener stops the submit and calls the connect handler.
  assert.match(source, /<form id="auth-form" method="post" action="#" autocomplete="on">/);
  assert.match(source, /<button id="auth-connect-btn" type="submit">Connect<\/button>/);
  assert.match(source, /form\.addEventListener\('submit', \(event\) => \{\s*event\.preventDefault\(\);\s*void window\.__copilotAuthConnect\?\.\(event\);/);
  assert.doesNotMatch(source, /<input id="token-input"[^>]*\sname=/, 'the token field has no name');
});

test('index keeps the auth gate hidden until bootstrap needs it', () => {
  assert.match(source, /#auth-gate \{\s*display: none;/);
  assert.match(source, /<div id="startup-loading" role="status" aria-live="polite"><div class="brand-logo" aria-hidden="true"><\/div><div class="startup-label">Connecting to OAR…<\/div><\/div>/);
  assert.match(source, /void window\.__startupSplash\.toAuth\(\);/);
  assert.match(source, /document\.getElementById\('auth-gate'\)\.style\.display = 'flex';/);
});
