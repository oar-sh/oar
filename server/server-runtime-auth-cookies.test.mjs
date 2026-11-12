import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');
const authSource = fs.readFileSync(fileURLToPath(new URL('./services/relay-auth.mjs', import.meta.url)), 'utf8');

test('server runtime scopes auth/session cookies to the configured remote path', () => {
  assert.match(source, /const COOKIE_PATH = remotePath \|\| '\/';/);
  assert.match(source, /\$\{SESSION_COOKIE\}=\$\{encodeURIComponent\(sessionId\)\}; Path=\$\{COOKIE_PATH\}; SameSite=Lax/);
  assert.match(source, /cookieName: AUTH_COOKIE,\s*cookiePath: COOKIE_PATH,/);
  // The cookie holds a browser session secret, never the owner token. Host-only
  // (never a Domain attribute): sibling hosts of one domain share no cookie.
  // Max-Age runs to the session's idle or absolute expiry, whichever is first.
  assert.match(authSource, /\$\{cookieName\}=\$\{secret\}; Path=\$\{cookiePath\}; Max-Age=\$\{maxAge\}; SameSite=Lax; HttpOnly\$\{secureAttr\}/);
  assert.match(authSource, /const maxAge = browserSessions\?\.cookieMaxAgeSeconds\?\.\(row\) \?\? 0;/);
  assert.doesNotMatch(authSource, /issueOwnerCookie/);
  assert.doesNotMatch(authSource, /Domain=/i);
  assert.match(authSource, /\$\{cookieName\}=; Path=\$\{cookiePath\}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly/);
});

test('cookie parsing: the runtime uses the shared parser (first duplicate kept, a malformed % skipped)', () => {
  assert.match(source, /import \{ parseCookies \} from '\.\/services\/cookie-header\.mjs';/);
  assert.doesNotMatch(source, /function parseCookies\(/);
});

test('shared viewer tracking enforces bounded caps', () => {
  assert.match(source, /const SHARED_VIEWER_MAX_PER_CONVERSATION = Number\.isFinite\(Number\(config\.sharedPresenceMaxPerConversation\)\)/);
  assert.match(source, /const SHARED_VIEWER_MAX_GLOBAL = Number\.isFinite\(Number\(config\.sharedPresenceMaxGlobal\)\)/);
  assert.match(source, /while \(viewers\.size >= SHARED_VIEWER_MAX_PER_CONVERSATION\)/);
  assert.match(source, /while \(countSharedViewerEntries\(\) >= SHARED_VIEWER_MAX_GLOBAL\)/);
});
