import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./public/app/bootstrap.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

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
