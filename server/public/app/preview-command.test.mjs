import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// api-client.js reads window/localStorage at import time, so the DOM globals
// must exist before the module graph loads.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

// The command runner goes through apiFetch → global fetch; intercepting fetch
// keeps the real module graph (no loader mocks).
const fetchCalls = [];
let fetchRoutes = {};
globalThis.fetch = async (url, options = {}) => {
  const path = String(url);
  const method = options.method || 'GET';
  fetchCalls.push({ path, method, body: options.body ? JSON.parse(options.body) : null });
  const key = `${method} ${path.split('?')[0]}`;
  const handler = fetchRoutes[key];
  if (!handler) return { ok: false, status: 404, json: async () => ({}) };
  const payload = typeof handler === 'function' ? handler() : handler;
  return { ok: true, status: 200, json: async () => payload };
};

const { setNetworkRequestsEnabled } = await import('./api-client.js');
setNetworkRequestsEnabled(true);

const {
  PREVIEW_COMMAND_HELP,
  parsePreviewCommand,
  runPreviewCommand,
} = await import('./preview-command.mjs');

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

test.beforeEach(() => {
  fetchCalls.length = 0;
  fetchRoutes = {};
});

// ─── parsing ──────────────────────────────────────────────────────────────────

test('non-/preview text is not intercepted', () => {
  for (const text of ['hello', '/compact', 'preview 5173', '/previews 1', '']) {
    assert.equal(parsePreviewCommand(text), null, `${JSON.stringify(text)} must pass through`);
  }
});

test('port, dir, list, close and help parse as documented', () => {
  assert.deepEqual(parsePreviewCommand('/preview 5173'), { kind: 'create-port', port: 5173, label: null });
  assert.deepEqual(parsePreviewCommand('/preview 5173 web app (vite)'), { kind: 'create-port', port: 5173, label: 'web app (vite)' });
  assert.deepEqual(parsePreviewCommand('/preview ./dist built site'), { kind: 'create-dir', dir: './dist', label: 'built site' });
  assert.deepEqual(parsePreviewCommand('/preview list'), { kind: 'list' });
  assert.deepEqual(parsePreviewCommand('/preview close'), { kind: 'close', tokenPrefix: null });
  assert.deepEqual(parsePreviewCommand('/preview close ab12'), { kind: 'close', tokenPrefix: 'ab12' });
  assert.deepEqual(parsePreviewCommand('/preview'), { kind: 'help' });
  assert.deepEqual(parsePreviewCommand('/PREVIEW LIST'), { kind: 'list' });
});

test('junk stays a help response, never a message to the model', () => {
  assert.deepEqual(parsePreviewCommand('/preview 99999999'), { kind: 'help' });
  assert.deepEqual(parsePreviewCommand('/preview close not-hex!'), { kind: 'help' });
});

// ─── execution ────────────────────────────────────────────────────────────────

test('create-port posts and reports the URL', async () => {
  fetchRoutes['POST /api/previews'] = { ok: true, url: `https://p/test_${TOKEN_A}/` };
  const result = await runPreviewCommand(
    { kind: 'create-port', port: 5173, label: 'app' },
    { conversationId: 'conv-1' },
  );
  assert.equal(result.ok, true);
  assert.match(result.notice, /https:\/\/p\/test_a+\//);
  assert.deepEqual(fetchCalls[0].body, { conversationId: 'conv-1', label: 'app', port: 5173 });
});

test('create-dir posts dir', async () => {
  fetchRoutes['POST /api/previews'] = { ok: true, url: 'https://p/x/' };
  await runPreviewCommand({ kind: 'create-dir', dir: './dist', label: null }, { conversationId: 'conv-1' });
  // label is undefined → dropped by JSON serialization; only dir travels.
  assert.deepEqual(fetchCalls[0].body, { conversationId: 'conv-1', dir: './dist' });
});

test('a failed create points at the visible states instead of vanishing', async () => {
  const result = await runPreviewCommand({ kind: 'create-port', port: 3333 }, {});
  assert.equal(result.ok, false);
  assert.match(result.notice, /Settings → Live previews/);
});

test('list renders one line per preview with offline flag', async () => {
  fetchRoutes['GET /api/previews'] = {
    enabled: true,
    previews: [
      { token: TOKEN_A, label: 'app', mode: 'port', targetPort: 5173, online: false, url: 'https://p/a/' },
      { token: TOKEN_B, label: 'site', mode: 'static', rootDir: '/repo/dist', online: true, url: 'https://p/b/' },
    ],
  };
  const result = await runPreviewCommand({ kind: 'list' }, {});
  const lines = result.notice.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /aaaaaaaa · app \(:5173\) — offline/);
  assert.match(lines[1], /site \(\/repo\/dist\)/);
});

test('list reports a disabled lane and an empty registry distinctly', async () => {
  fetchRoutes['GET /api/previews'] = { enabled: false, previews: [] };
  assert.match((await runPreviewCommand({ kind: 'list' }, {})).notice, /disabled/);

  fetchRoutes['GET /api/previews'] = { enabled: true, previews: [] };
  assert.match((await runPreviewCommand({ kind: 'list' }, {})).notice, /No live previews/);
});

test('close with no prefix closes the single conversation preview', async () => {
  fetchRoutes['GET /api/previews'] = { previews: [{ token: TOKEN_A, label: 'app' }] };
  fetchRoutes[`DELETE /api/previews/${TOKEN_A}`] = { ok: true };
  const result = await runPreviewCommand({ kind: 'close', tokenPrefix: null }, { conversationId: 'conv-1' });
  assert.equal(result.ok, true);
  assert.match(result.notice, /closed: app/);
  assert.match(fetchCalls[0].path, /conversationId=conv-1/);
});

test('close disambiguates on prefix collisions', async () => {
  fetchRoutes['GET /api/previews'] = {
    previews: [
      { token: 'abc1' + 'a'.repeat(28), label: 'one' },
      { token: 'abc2' + 'a'.repeat(28), label: 'two' },
    ],
  };
  const result = await runPreviewCommand({ kind: 'close', tokenPrefix: 'abc' }, {});
  assert.equal(result.ok, false);
  assert.match(result.notice, /Ambiguous/);

  fetchRoutes[`DELETE /api/previews/abc1${'a'.repeat(28)}`] = { ok: true };
  const exact = await runPreviewCommand({ kind: 'close', tokenPrefix: 'abc1' }, {});
  assert.equal(exact.ok, true);
});

test('close on no match says so', async () => {
  fetchRoutes['GET /api/previews'] = { previews: [] };
  const byPrefix = await runPreviewCommand({ kind: 'close', tokenPrefix: 'dead' }, {});
  assert.match(byPrefix.notice, /No preview matches/);
  const bare = await runPreviewCommand({ kind: 'close', tokenPrefix: null }, { conversationId: 'c' });
  assert.match(bare.notice, /No live previews in this conversation/);
});

test('help executes without touching the network', async () => {
  const result = await runPreviewCommand({ kind: 'help' }, {});
  assert.equal(result.notice, PREVIEW_COMMAND_HELP);
  assert.equal(fetchCalls.length, 0);
});
