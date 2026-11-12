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

test('the owner token is checked against its hash, agent tokens against the agent key, both in constant time (L1)', () => {
  assert.match(authSource, /export function tokensMatch\(/);
  assert.match(authSource, /crypto\.timingSafeEqual\(/);
  // The runtime hands the store's checks to auth; no plain owner token is kept.
  assert.match(source, /verifyOwnerToken: \(value\) => ownerSecretStore\.verifyOwnerToken\(value\)/);
  assert.match(source, /verifyAgentToken: \(value\) => ownerSecretStore\.verifyAgentToken\(value\)/);
  assert.doesNotMatch(source, /config\.authToken(?!;)/, 'nothing reads a plain owner token from the config');
  assert.doesNotMatch(authSource, /token === /);
  const credentials = fs.readFileSync(fileURLToPath(new URL('../shared/relay-credentials.mjs', import.meta.url)), 'utf8');
  assert.match(credentials, /crypto\.timingSafeEqual\(a, b\)/);
  assert.match(credentials, /crypto\.timingSafeEqual\(expected, parsed\.mac\)/);
});

test('the auth token is read from neither the request body nor the query (M4)', () => {
  assert.match(authSource, /const bearer = bearerToken\(req\?\.headers\);/);
  assert.match(authSource, /const values = \[\.\.\.new Set\(cookieValues\(headers\?\.cookie, cookieName\)/);
  assert.doesNotMatch(authSource, /req\.body\?\.token/);
  assert.doesNotMatch(authSource, /req\.query\.token/);
  assert.doesNotMatch(authSource, /handshake\?*\.query\?*\.token/);
});

test('a recovered socket re-validates the auth token (H2)', () => {
  assert.match(source, /if \(socket\.recovered\) \{\s*const principal = relayAuth\.socketPrincipal\(socket\);\s*if \(!principal\) \{/);
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

test('the app shell carries CSP frame-ancestors \'self\': the page, a shared link\'s reader and "Preview as shared" (§13.4)', () => {
  assert.match(source, /const APP_SHELL_CSP = "frame-ancestors 'self'";/);
  assert.match(source, /res\.setHeader\('Content-Security-Policy', APP_SHELL_CSP\)/);
  // Every response that renders the shell sets it.
  const shellRenders = source.match(/renderIndexHtmlWithPwaVersion\([^)]*\);[\s\S]{0,240}?res\.type\('html'\)\.send\(html\)/g) || [];
  assert.equal(shellRenders.length, 3);
  for (const block of shellRenders) assert.match(block, /applyAppShellHeaders\(res\);/);
  for (const route of ["app.get(['/', '/index.html']", "app.get(['/shared/:token', '/shared/:token/']", "app.get(['/share-preview/:conversationId', '/share-preview/:conversationId/']"]) {
    assert.ok(source.includes(route), route);
  }
  // A served file keeps its own CSP: a PDF may be framed by this origin.
  const served = fs.readFileSync(fileURLToPath(new URL('./services/safe-served-content.mjs', import.meta.url)), 'utf8');
  assert.match(served, /"default-src 'none'; frame-ancestors 'self'"/);
  assert.match(served, /"default-src 'none'; sandbox; frame-ancestors 'none'"/);
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
