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

const SIGNED_IN_STATUS = {
  ok: true,
  loggedIn: true,
  expiresAt: '2026-08-31T23:00:00.000Z',
  expired: false,
  plan: 'GrokBuild',
  usagePercent: 23.4,
  periodType: 'weekly',
  periodEnd: '2026-09-07T00:00:00.000Z',
  error: null,
  checkedAt: '2026-08-31T12:00:00.000Z',
};

// The frozen stand-in the relay broadcasts before the first auth-store read.
const UNKNOWN_STATUS = {
  ok: false,
  loggedIn: false,
  expiresAt: null,
  expired: false,
  plan: null,
  usagePercent: null,
  periodType: null,
  periodEnd: null,
  error: null,
  checkedAt: null,
};

const IDLE_LOGIN = {
  state: 'idle', authUrl: null, userCode: null, error: null, startedAt: null, active: false,
};

function payload(status, login, runningGrokWorkers = 0) {
  return { status, login: { ...IDLE_LOGIN, ...login }, runningGrokWorkers };
}

// Routed rather than fixed: the ordering case below needs the status read and
// the login start to resolve independently. The defaults are no-op echoes —
// only the success transition refreshes on its own.
let statusResponder = async () => payload(SIGNED_IN_STATUS, { state: 'success' });
let loginStartResponder = async () => payload(SIGNED_IN_STATUS, { state: 'starting' });

globalThis.fetch = async (url) => {
  const body = String(url).includes('/login/start')
    ? await loginStartResponder()
    : await statusResponder();
  return { ok: true, status: 200, json: async () => body };
};

const { applyGrokAuthState, grokAccountLineText, refreshGrokAuthSection, startGrokSignIn } = await import('./grok-auth-ui.js');

const el = (id) => document.getElementById(id);

test('the pre-read placeholder reads as "checking", not as signed out', () => {
  applyGrokAuthState(payload(UNKNOWN_STATUS, { state: 'idle' }));
  assert.equal(el('grok-auth-account').textContent, 'Checking the Grok account…');
  assert.equal(el('grok-auth-account').dataset.state, 'pending');
  assert.equal(el('grok-auth-logout-btn').disabled, true);
  assert.equal(el('grok-auth-signin-btn').disabled, false);
});

test('a signed-in account composes plan · usage · period', () => {
  applyGrokAuthState(payload(SIGNED_IN_STATUS, { state: 'idle' }, 2));
  assert.equal(el('grok-auth-account').textContent, 'GrokBuild · 23% of weekly quota used');
  assert.equal(el('grok-auth-account').dataset.state, 'active');
  assert.equal(el('grok-auth-login-area').hidden, true);
  assert.equal(el('grok-auth-logout-btn').disabled, false);
});

test('the account line degrades one field at a time', () => {
  // plan is a billing product name and is often null; usage may be missing too.
  assert.equal(
    grokAccountLineText({ ...SIGNED_IN_STATUS, plan: null }),
    '23% of weekly quota used',
  );
  assert.equal(
    grokAccountLineText({ ...SIGNED_IN_STATUS, usagePercent: null, periodType: null }),
    'GrokBuild',
  );
  assert.equal(
    grokAccountLineText({ ...SIGNED_IN_STATUS, plan: null, usagePercent: null }),
    'Signed in',
  );
  assert.equal(
    grokAccountLineText({ ...SIGNED_IN_STATUS, periodType: null }),
    'GrokBuild · 23% of quota used',
  );
  // Exactly 0% is real data and must render; only absent/NaN drops the segment.
  assert.equal(
    grokAccountLineText({ ...SIGNED_IN_STATUS, usagePercent: 0 }),
    'GrokBuild · 0% of weekly quota used',
  );
  assert.equal(grokAccountLineText(null), 'Grok account status unavailable.');
});

test('an elapsed token expiry is a hint, not a logged-out verdict', () => {
  applyGrokAuthState(payload({ ...SIGNED_IN_STATUS, expired: true }, { state: 'idle' }));
  assert.equal(el('grok-auth-account').dataset.state, 'active');
  assert.match(el('grok-auth-account').textContent, /token expired, may need a new sign-in$/);
  assert.equal(el('grok-auth-logout-btn').disabled, false);
});

test('signed out disables Sign out and surfaces the reason', () => {
  applyGrokAuthState(payload(
    { ...UNKNOWN_STATUS, ok: true, error: 'auth store unreadable', checkedAt: '2026-08-31T12:00:00.000Z' },
    { state: 'idle' },
  ));
  assert.equal(el('grok-auth-account').textContent, 'Not signed in — auth store unreadable');
  assert.equal(el('grok-auth-account').dataset.state, 'error');
  assert.equal(el('grok-auth-logout-btn').disabled, true);
  assert.equal(el('grok-auth-signin-btn').disabled, false);
});

test('awaiting_authorization exposes the device URL, Copy, and the code to confirm', () => {
  const authUrl = 'https://accounts.x.ai/oauth2/device?user_code=D7SV-M4TR';
  applyGrokAuthState(payload(SIGNED_IN_STATUS, {
    state: 'awaiting_authorization',
    authUrl,
    userCode: 'D7SV-M4TR',
    startedAt: '2026-08-31T12:20:00.000Z',
    active: true,
  }));
  assert.equal(el('grok-auth-login-area').hidden, false);
  assert.equal(el('grok-auth-url-row').hidden, false);
  assert.equal(el('grok-auth-url-link').href, authUrl);
  assert.equal(el('grok-auth-url-link').target, '_blank');
  assert.equal(el('grok-auth-code-row').hidden, false);
  assert.equal(el('grok-auth-user-code').textContent, 'D7SV-M4TR');
  assert.equal(el('grok-auth-actions-row').hidden, false);
  assert.equal(el('grok-auth-cancel-btn').textContent, 'Cancel');
  // A login owns the CLI: neither Sign in nor Sign out may fire underneath it.
  assert.equal(el('grok-auth-signin-btn').disabled, true);
  assert.equal(el('grok-auth-logout-btn').disabled, true);
});

test('a scrape that never found the code still leaves the session cancellable', () => {
  applyGrokAuthState(payload(SIGNED_IN_STATUS, {
    state: 'awaiting_authorization',
    authUrl: 'https://accounts.x.ai/oauth2/device?user_code=ZZZZ-ZZZZ',
    userCode: null,
    startedAt: '2026-08-31T12:22:00.000Z',
    active: true,
  }));
  assert.equal(el('grok-auth-code-row').hidden, true);
  assert.equal(el('grok-auth-actions-row').hidden, false);
  assert.equal(el('grok-auth-cancel-btn').disabled, false);
});

test('a late "starting" snapshot cannot regress awaiting_authorization from the same login', () => {
  const startedAt = '2026-08-31T12:30:00.000Z';
  const authUrl = 'https://accounts.x.ai/oauth2/device?user_code=RACE-CODE';
  // Socket broadcast (with the URL) outran the HTTP response for login/start.
  applyGrokAuthState(payload(SIGNED_IN_STATUS, {
    state: 'awaiting_authorization', authUrl, userCode: 'RACE-CODE', startedAt, active: true,
  }));
  applyGrokAuthState(payload(SIGNED_IN_STATUS, {
    state: 'starting', authUrl: null, userCode: null, startedAt, active: true,
  }));
  assert.equal(el('grok-auth-url-row').hidden, false);
  assert.equal(el('grok-auth-url-link').href, authUrl);
  // A genuinely NEW login session (different startedAt) must still apply.
  applyGrokAuthState(payload(SIGNED_IN_STATUS, {
    state: 'starting', authUrl: null, startedAt: '2026-08-31T12:31:00.000Z', active: true,
  }));
  assert.equal(el('grok-auth-url-row').hidden, true);
  assert.equal(el('grok-auth-code-row').hidden, true);
  assert.equal(el('grok-auth-actions-row').hidden, false);
});

test('success arrives twice and renders the same both times', () => {
  const startedAt = '2026-08-31T12:40:00.000Z';
  // First emit rides the cached (still signed-out) status; the confirming read
  // follows. Neither may reopen or restart anything.
  applyGrokAuthState(payload(UNKNOWN_STATUS, { state: 'success', startedAt }));
  assert.equal(el('grok-auth-login-status').textContent, 'Signed in to Grok.');
  assert.equal(el('grok-auth-login-status').dataset.state, 'active');
  assert.equal(el('grok-auth-login-area').hidden, false);
  applyGrokAuthState(payload(SIGNED_IN_STATUS, { state: 'success', startedAt }));
  assert.equal(el('grok-auth-login-status').textContent, 'Signed in to Grok (GrokBuild).');
  assert.equal(el('grok-auth-login-area').hidden, false);
  assert.equal(el('grok-auth-signin-btn').disabled, false);
  assert.equal(el('grok-auth-actions-row').hidden, true);
});

test('error keeps the area open with a Dismiss and re-enables Sign in', () => {
  applyGrokAuthState(payload(SIGNED_IN_STATUS, {
    state: 'error',
    error: 'grok login exited with code 1',
    startedAt: '2026-08-31T12:50:00.000Z',
  }));
  assert.equal(el('grok-auth-login-area').hidden, false);
  assert.equal(el('grok-auth-login-status').textContent, 'grok login exited with code 1');
  assert.equal(el('grok-auth-login-status').dataset.state, 'error');
  assert.equal(el('grok-auth-actions-row').hidden, false);
  assert.equal(el('grok-auth-cancel-btn').textContent, 'Dismiss');
  assert.equal(el('grok-auth-signin-btn').disabled, false);
});

test('a status read that predates a sign-in cannot rewind the login area', async () => {
  applyGrokAuthState(payload(SIGNED_IN_STATUS, { state: 'idle' }));
  // The chat "Sign in to Grok" CTA opens the settings modal (which refreshes
  // the account row) and starts the login in the same tick, so a status read
  // that snapshotted the idle login routinely lands after the login started.
  let releaseStatus = () => {};
  const parked = new Promise((resolve) => {
    releaseStatus = () => resolve(payload(SIGNED_IN_STATUS, { state: 'idle' }));
  });
  statusResponder = () => parked;
  loginStartResponder = async () => payload(SIGNED_IN_STATUS, {
    state: 'awaiting_authorization',
    authUrl: 'https://accounts.x.ai/oauth2/device?user_code=LATE-READ',
    userCode: 'LATE-READ',
    startedAt: '2026-08-31T13:00:00.000Z',
    active: true,
  });

  const refreshing = refreshGrokAuthSection();
  await startGrokSignIn();
  assert.equal(el('grok-auth-url-row').hidden, false);

  releaseStatus();
  await refreshing;
  // The account half of the late read still applies; the login half does not.
  assert.equal(el('grok-auth-url-row').hidden, false);
  assert.equal(el('grok-auth-user-code').textContent, 'LATE-READ');
  assert.equal(el('grok-auth-account').textContent, 'GrokBuild · 23% of weekly quota used');

  statusResponder = async () => payload(SIGNED_IN_STATUS, { state: 'success' });
  loginStartResponder = async () => payload(SIGNED_IN_STATUS, { state: 'starting' });
});

test('an unknown login state degrades to idle instead of throwing', () => {
  applyGrokAuthState(payload(SIGNED_IN_STATUS, { state: 'exchanging' }));
  assert.equal(el('grok-auth-login-area').hidden, true);
  applyGrokAuthState(null);
  assert.equal(el('grok-auth-login-area').hidden, true);
});
