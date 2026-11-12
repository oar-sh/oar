import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./public/app/bootstrap.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');
const apiClient = fs.readFileSync(fileURLToPath(new URL('./public/app/api-client.js', import.meta.url)), 'utf8');
const serviceWorker = fs.readFileSync(fileURLToPath(new URL('./public/sw.js', import.meta.url)), 'utf8');

test('migrates legacy browser tokens without recreating script-readable credentials', () => {
  assert.match(source, /function consumeLegacyPersistedAuthToken\(\)/);
  assert.match(source, /sessionStorage\.removeItem\(AUTH_TOKEN_STORAGE_KEY\)/);
  assert.match(source, /localStorage\.removeItem\(AUTH_TOKEN_STORAGE_KEY\)/);
  assert.match(source, /clearLegacyClientAuthCookie\(\);/);
  assert.doesNotMatch(source, /sessionStorage\.setItem\(AUTH_TOKEN_STORAGE_KEY/);
  assert.doesNotMatch(source, /localStorage\.setItem\(AUTH_TOKEN_STORAGE_KEY/);
  assert.doesNotMatch(source, /document\.cookie = `\$\{AUTH_COOKIE_NAME\}=\$\{encodeURIComponent/);
  assert.doesNotMatch(source, /setToken\((?:val|urlToken|persistedToken|bootstrapToken)\)/);
  assert.match(source, /if \(result\?\.ok\) \{\s*setToken\(''\);\s*tokenInput\.value = '';/);
  assert.match(source, /const existingSession = await verifyExistingSession\(bootstrapToken\);/);
  assert.match(source, /if \(bootstrapToken\) \{\s*setToken\(''\);\s*document\.getElementById\('token-input'\)\.value = '';\s*showAuthGate\(resolveAuthErrorMessage\(existingSession\)\);/);
});

test('sign-in goes through the session exchange; ?token= and ?signin= leave the address; a 401 opens the gate', () => {
  // The token (or a sign-in code) is exchanged once for the HttpOnly session cookie.
  assert.match(apiClient, /fetch\(`\$\{BASE\}\/api\/auth\/session`, \{\s*method: 'POST',/);
  assert.match(apiClient, /body: JSON\.stringify\(\{ deviceId: DEVICE_ID \}\)/);
  assert.doesNotMatch(apiClient, /localStorage\.setItem|sessionStorage\.setItem/);
  assert.match(source, /const urlToken = getTokenFromUrl\(\) \|\| getSignInCodeFromUrl\(\);\s*if \(urlToken\) stripTokenFromUrl\(\);/);
  assert.match(source, /url\.searchParams\.delete\('token'\);\s*url\.searchParams\.delete\('signin'\);/);
  // A 401 later on: "This browser was signed out".
  assert.match(apiClient, /await noteAuthRefusal\(response, url, sentProof\);/);
  assert.match(apiClient, /if \(response\.status === 401\) return true;/);
  assert.match(source, /onSignedOut\(handleSignedOut\);/);
  assert.match(source, /const SIGNED_OUT_MESSAGE = 'This browser was signed out';/);
  // A notification answer that gets 401 says so.
  assert.match(serviceWorker, /if \(answered\.signedOut\) \{\s*await showSignedOutNotification\(data\.conversationId\);/);
  assert.match(serviceWorker, /body: 'Signed out, open OAR'/);
});

test('the session key: kept per origin (localStorage and IndexedDB), sent by the page, the socket and the service worker, never the token', () => {
  const proofModule = fs.readFileSync(fileURLToPath(new URL('./public/app/session-proof.mjs', import.meta.url)), 'utf8');
  const store = fs.readFileSync(fileURLToPath(new URL('./public/app/store.js', import.meta.url)), 'utf8');
  const sockets = fs.readFileSync(fileURLToPath(new URL('./public/app/socket-handlers.js', import.meta.url)), 'utf8');
  const index = fs.readFileSync(fileURLToPath(new URL('./public/index.html', import.meta.url)), 'utf8');
  assert.match(proofModule, /export const SESSION_PROOF_HEADER = 'X-OAR-Session-Proof';/);
  assert.match(proofModule, /localStorage|storage\(\)\?\.setItem\(SESSION_PROOF_STORAGE_KEY, proof\)/);
  // The names the service worker reads are the ones the page writes.
  for (const name of ["'oar-session-proof'", "'proof'", "'current'"]) {
    assert.ok(proofModule.includes(name) && serviceWorker.includes(name), name);
  }
  // Only to this relay's own API (`url` checked first; none, nothing).
  assert.match(store, /export function authHeaders\(url\) \{\s*if \(!isRelayApiUrl\(url, BASE\)\) return \{\};\s*return TOKEN \? \{ Authorization: `Bearer \$\{TOKEN\}` \} : sessionProofHeaders\(url, BASE\);/);
  assert.match(sockets, /deliver\(TOKEN \? \{ token: TOKEN, clientId: CLIENT_ID \} : \{ clientId: CLIENT_ID, \.\.\.\(proof \? \{ proof \} : \{\}\) \}\);/);
  assert.match(apiClient, /if \(payload\?\.proof\) \{[\s\S]{0,400}?const stored = storeSessionProof\(payload\.proof\);[\s\S]{0,200}?await stored;/);
  // A refused handshake drops the key it sent, never one another tab stored
  // since: with a newer key the socket tries again.
  assert.match(sockets, /handshakeProof = TOKEN \? '' : proof;/);
  assert.match(sockets, /if \(storedProof && storedProof !== sentProof\) \{\s*socket\.connect\(\);\s*\} else \{[\s\S]*?reportSignedOut\('', \{ sentProof \}\);/);
  // The inline sign-in keeps the key, never the token.
  assert.match(index, /localStorage\.setItem\('oar_session_proof', String\(answer\.proof\)\)/);
  assert.doesNotMatch(index, /localStorage\.setItem\([^)]*token/i);
});
