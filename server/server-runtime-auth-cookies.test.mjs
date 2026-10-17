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
  assert.match(authSource, /\$\{cookieName\}=\$\{encodeURIComponent\(expected\)\}; Path=\$\{cookiePath\}; Max-Age=2592000; SameSite=Lax; HttpOnly/);
  assert.match(authSource, /\$\{cookieName\}=; Path=\$\{cookiePath\}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly/);
});

test('cookie parsing keeps the first duplicate cookie value', () => {
  assert.match(source, /if \(!key \|\| Object\.prototype\.hasOwnProperty\.call\(cookies, key\)\) continue;/);
});

test('shared viewer tracking enforces bounded caps', () => {
  assert.match(source, /const SHARED_VIEWER_MAX_PER_CONVERSATION = Number\.isFinite\(Number\(config\.sharedPresenceMaxPerConversation\)\)/);
  assert.match(source, /const SHARED_VIEWER_MAX_GLOBAL = Number\.isFinite\(Number\(config\.sharedPresenceMaxGlobal\)\)/);
  assert.match(source, /while \(viewers\.size >= SHARED_VIEWER_MAX_PER_CONVERSATION\)/);
  assert.match(source, /while \(countSharedViewerEntries\(\) >= SHARED_VIEWER_MAX_GLOBAL\)/);
});
