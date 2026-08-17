import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// server-runtime.mjs boots a server on import, so — matching the sibling
// server-runtime-auth-cookies.test.mjs — these assert the hardening is present
// in the source rather than exercising a live app.
const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

test('the auth token is compared in constant time (L1)', () => {
  assert.match(source, /function tokensMatch\(/);
  assert.match(source, /crypto\.timingSafeEqual\(/);
  // The HTTP and socket auth paths use the constant-time helper, not `===`.
  assert.match(source, /if \(tokensMatch\(token, config\.authToken\)\)/);
  assert.doesNotMatch(source, /if \(token === config\.authToken\)/);
});

test('the auth token is no longer read from the request body (M4)', () => {
  // The bootstrap sources remain (header, query, cookie) but not req.body.
  assert.match(source, /req\.query\.token \|\|\s*cookies\[AUTH_COOKIE\]/);
  assert.doesNotMatch(source, /req\.body\?\.token \|\|\s*cookies\[AUTH_COOKIE\]/);
});

test('a recovered socket re-validates the auth token (H2)', () => {
  assert.match(source, /socket\.recovered && !tokensMatch\(socketAuthToken\(socket\), config\.authToken\)/);
  assert.match(source, /socket\.disconnect\(true\)/);
  // Socket auth uses the constant-time helper too.
  assert.match(source, /tokensMatch\(socketAuthToken\(socket\), config\.authToken\)/);
});

test('config.json is written and kept owner-only (M3)', () => {
  assert.match(source, /fs\.writeFileSync\(CONFIG_PATH, JSON\.stringify\(config, null, 2\), \{ mode: 0o600 \}\)/);
  assert.match(source, /fs\.chmodSync\(CONFIG_PATH, 0o600\)/);
});

test('baseline security headers are set on every response (M7)', () => {
  assert.match(source, /res\.setHeader\('X-Content-Type-Options', 'nosniff'\)/);
  assert.match(source, /res\.setHeader\('X-Frame-Options', 'SAMEORIGIN'\)/);
  assert.match(source, /res\.setHeader\('Referrer-Policy', 'no-referrer'\)/);
});

test('the workspace serve path enforces real-path containment (M1)', () => {
  assert.match(source, /isRealPathWithinRoot\(absolutePath, activeWorkspaceRoot\)/);
});

test('a trust-proxy boundary is set and the Secure cookie derives from req.secure (L2)', () => {
  assert.match(source, /app\.set\('trust proxy', config\.trustProxy \?\? 'loopback'\)/);
  assert.match(source, /const secureAttr = req\.secure \? '; Secure' : '';/);
});
