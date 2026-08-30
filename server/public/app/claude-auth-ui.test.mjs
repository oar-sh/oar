import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The auth UI writes into markup that lives in index.html, so the smoke test
// renders against the real file rather than a hand-rolled fixture: a renamed
// or dropped element id fails here instead of in the browser. JSDOM does not
// execute the page's <script> tags, so this is pure markup + module.
const indexHtml = await readFile(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8',
);
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const LOGGED_IN_STATUS = {
  ok: true,
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'user@example.com',
  orgId: 'org_1',
  orgName: 'Org',
  subscriptionType: 'max',
  error: null,
  checkedAt: '2026-08-30T00:00:00.000Z',
};

const IDLE_LOGIN = {
  state: 'idle', authUrl: null, error: null, startedAt: null, active: false,
};

function payload(status, login, runningClaudeWorkers = 0) {
  return { status, login: { ...IDLE_LOGIN, ...login }, runningClaudeWorkers };
}

// Only the success transition refreshes on its own; keep it a no-op echo.
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => payload(LOGGED_IN_STATUS, { state: 'success' }),
});

const { applyClaudeAuthState } = await import('./claude-auth-ui.js');

const el = (id) => document.getElementById(id);

test('logged-in idle state shows the account row and hides the login area', () => {
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'idle' }, 1));
  assert.equal(el('claude-auth-account').textContent, 'Account: user@example.com · Max plan');
  assert.equal(el('claude-auth-account').dataset.state, 'active');
  assert.equal(el('claude-auth-login-area').hidden, true);
  assert.equal(el('claude-auth-relogin-btn').disabled, false);
  assert.equal(el('claude-auth-logout-btn').disabled, false);
});

test('logged-out state disables Logout', () => {
  applyClaudeAuthState(payload({ ok: true, loggedIn: false, error: null }, { state: 'idle' }));
  assert.equal(el('claude-auth-account').textContent, 'Not logged in');
  assert.equal(el('claude-auth-logout-btn').disabled, true);
  assert.equal(el('claude-auth-relogin-btn').disabled, false);
});

test('awaiting_code exposes the auth URL, the copy button and the code input', () => {
  const authUrl = 'https://claude.com/oauth/authorize?code=true&state=abc';
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'awaiting_code', authUrl, active: true }));
  assert.equal(el('claude-auth-login-area').hidden, false);
  assert.equal(el('claude-auth-url-row').hidden, false);
  assert.equal(el('claude-auth-url-link').href, authUrl);
  assert.equal(el('claude-auth-url-link').target, '_blank');
  assert.equal(el('claude-auth-code-row').hidden, false);
  assert.equal(el('claude-auth-code-input').disabled, false);
  // A login owns the CLI: neither Relogin nor Logout may fire underneath it.
  assert.equal(el('claude-auth-relogin-btn').disabled, true);
  assert.equal(el('claude-auth-logout-btn').disabled, true);
});

test('a late "starting" snapshot cannot regress awaiting_code from the same login', () => {
  const startedAt = '2026-08-30T19:10:00.000Z';
  const authUrl = 'https://claude.com/oauth/authorize?code=true&state=race';
  // Socket broadcast (with the URL) outran the HTTP response for login/start.
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'awaiting_code', authUrl, startedAt, active: true }));
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'starting', authUrl: null, startedAt, active: true }));
  assert.equal(el('claude-auth-url-row').hidden, false);
  assert.equal(el('claude-auth-url-link').href, authUrl);
  assert.equal(el('claude-auth-code-input').disabled, false);
  // A genuinely NEW login session (different startedAt) must still apply.
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'starting', authUrl: null, startedAt: '2026-08-30T19:11:00.000Z', active: true }));
  assert.equal(el('claude-auth-url-row').hidden, true);
});

test('exchanging freezes the code input and drops the one-shot URL', () => {
  el('claude-auth-code-input').value = 'typed-code';
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'exchanging', active: true }));
  assert.equal(el('claude-auth-code-input').disabled, true);
  assert.equal(el('claude-auth-submit-btn').disabled, true);
  assert.equal(el('claude-auth-url-row').hidden, true);
  assert.equal(el('claude-auth-code-row').hidden, false);
});

test('error keeps the area open, shows the reason and re-enables Relogin', () => {
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'error', error: 'Invalid code.' }));
  assert.equal(el('claude-auth-login-area').hidden, false);
  assert.equal(el('claude-auth-login-status').textContent, 'Invalid code.');
  assert.equal(el('claude-auth-login-status').dataset.state, 'error');
  assert.equal(el('claude-auth-relogin-btn').disabled, false);
  // Leaving the code states must not leave the pasted code sitting in the DOM.
  assert.equal(el('claude-auth-code-input').value, '');
});

test('success reports the account in green and schedules the collapse', async () => {
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'success' }));
  assert.equal(el('claude-auth-login-status').textContent, 'Logged in as user@example.com.');
  assert.equal(el('claude-auth-login-status').dataset.state, 'active');
  assert.equal(el('claude-auth-login-area').hidden, false);
  assert.equal(el('claude-auth-relogin-btn').disabled, false);
  // Rendering again from the same sticky payload must not restart anything.
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'success' }));
  assert.equal(el('claude-auth-login-area').hidden, false);
});

test('an unknown login state degrades to idle instead of throwing', () => {
  applyClaudeAuthState(payload(LOGGED_IN_STATUS, { state: 'who-knows' }));
  assert.equal(el('claude-auth-login-area').hidden, true);
  applyClaudeAuthState(null);
  assert.equal(el('claude-auth-login-area').hidden, true);
});
