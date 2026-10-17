import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// server-runtime.mjs boots a server on import, so — matching the sibling
// server-runtime-auth-cookies.test.mjs — these assert the hardening is present
// in the source rather than exercising a live app.
const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');
// The token check itself lives in services/relay-auth.mjs (exercised over
// HTTP in relay-auth.test.mjs); the runtime wires it in.
const authSource = fs.readFileSync(fileURLToPath(new URL('./services/relay-auth.mjs', import.meta.url)), 'utf8');

test('the auth token is compared in constant time (L1)', () => {
  assert.match(authSource, /export function tokensMatch\(/);
  assert.match(authSource, /crypto\.timingSafeEqual\(/);
  // The HTTP and socket auth paths use the constant-time helper, not `===`.
  assert.match(authSource, /if \(tokensMatch\(token, expected\)\)/);
  assert.match(authSource, /return tokensMatch\(socketAuthToken\(socket\), getAuthToken\(\)\)/);
  assert.doesNotMatch(authSource, /token === /);
  assert.match(source, /getAuthToken: \(\) => config\.authToken/);
});

test('the auth token is read from neither the request body nor the query (M4)', () => {
  assert.match(authSource, /const token = bearerToken\(req\.headers\) \|\| cookies\[cookieName\];/);
  assert.doesNotMatch(authSource, /req\.body\?\.token/);
  assert.doesNotMatch(authSource, /req\.query\.token/);
  assert.doesNotMatch(authSource, /handshake\?*\.query\?*\.token/);
});

test('a recovered socket re-validates the auth token (H2)', () => {
  assert.match(source, /socket\.recovered && !relayAuth\.socketTokenValid\(socket\)/);
  assert.match(source, /socket\.disconnect\(true\)/);
  assert.match(source, /io\.use\(relayAuth\.socketMiddleware\)/);
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
  assert.match(authSource, /const secureAttr = req\.secure \? '; Secure' : '';/);
});

test('marker headers from config and environment are merged, so an empty config list keeps the env ones', () => {
  assert.match(source, /resolveTunnelMarkerHeaders\(\s*config\.tunnelMarkerHeaders,\s*process\.env\.COPILOT_TUNNEL_MARKER_HEADERS,\s*\)/);
  assert.doesNotMatch(source, /config\.tunnelMarkerHeaders\s*\|\|/);
  // One check serves the worker path guard, the image-operation route and the lockout exemption.
  assert.match(source, /createTunnelWorkerPathGuard\(\{\s*pathPrefix: remotePath,\s*localRequestCheck,/);
  assert.match(source, /isTrulyLocalRequest: localRequestCheck\.isTrulyLocal,/);
});

test('socket.io accepts same-origin handshakes only', () => {
  assert.doesNotMatch(source, /cors: \{ origin: '\*' \}/);
  assert.match(source, /allowRequest: \(req, callback\) => \{\s*if \(isSameOriginRequest\(expressRequestView\(app, req\), \{ allowedOrigins: socketAllowedOrigins \}\)\)/);
});
