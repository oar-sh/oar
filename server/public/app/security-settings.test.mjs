import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Security and the security notices banner, against the real
// index.html (a renamed or dropped id fails here) and a scripted relay. The
// token and code values are made up and too short to be real ones.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Event = dom.window.Event;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
const copied = [];
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: async (text) => { copied.push(String(text)); } },
  configurable: true,
});

const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer?.unref?.();
  return timer;
};
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const timer = nativeSetTimeout(...args);
  timer?.unref?.();
  return timer;
};

// jsdom draws no canvas: a 2D context that records the dark modules.
const drawn = [];
dom.window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== '2d') return null;
  const canvas = this;
  return {
    fillStyle: '',
    fillRect(x, y, w, h) { drawn.push({ canvas, style: this.fillStyle, x, y, w, h }); },
    clearRect() {},
  };
};
// A made-up 21×21 matrix (not a real code): every other module dark.
const FAKE_QR = { size: 21, bits: Buffer.alloc(56, 0xaa).toString('base64') };
window.__COPILOT_APP_CONFIG = { basePath: '', relayName: 'bench-relay' };

const FAKE_TOKEN = 'oaro1_FAKE-test-value';
const FAKE_LINK = 'http://localhost/?signin=oarc1_FAKE-test-value';
const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const THIS = {
  id: 'bs_this', label: 'Chrome on Windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140', deviceId: 'dev-1',
  authMethod: 'token', createdAt: ago(3 * 24 * 60 * MINUTE), lastSeenAt: ago(5_000), lastIp: '127.0.0.1', current: true,
};
const PHONE = {
  id: 'bs_phone', label: 'Chrome on Android', userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', deviceId: 'dev-2',
  authMethod: 'code', createdAt: ago(60 * MINUTE), lastSeenAt: ago(20 * MINUTE), lastIp: '192.168.1.20', current: false,
};
const OLD = {
  id: 'bs_old', label: 'Firefox on Linux', userAgent: '', deviceId: null,
  authMethod: 'upgrade', createdAt: ago(9 * 24 * 60 * MINUTE), lastSeenAt: ago(2 * 24 * 60 * MINUTE), lastIp: null, current: false,
};

// ─── A scripted relay ────────────────────────────────────────────────────────
const requests = [];
let sessionRows = [];
let ownerToken = {};
let pairedRelays = 0;
let notices = [];
let signins = [];
let recommendations = [];
let failNext = null;
// `{ path, release }`: the answer to that path is made when the request
// comes in, as the relay makes it, and handed back once `release` settles.
let holdNext = null;

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (rawUrl, opts = {}) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  if (holdNext && holdNext.path === url.pathname) {
    const { release } = holdNext;
    holdNext = null;
    const answer = await answerOf(rawUrl, opts);
    await release;
    return answer;
  }
  return answerOf(rawUrl, opts);
};

async function answerOf(rawUrl, opts = {}) {
  const url = new URL(String(rawUrl), 'http://localhost/');
  const method = String(opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ method, path: url.pathname, body });
  if (failNext && failNext.path === url.pathname) {
    const { status, payload } = failNext;
    failNext = null;
    return reply(status, payload);
  }
  if (url.pathname === '/api/auth/sessions' && method === 'GET') return reply(200, { sessions: sessionRows, currentId: 'bs_this' });
  if (url.pathname === '/api/auth/sessions' && method === 'DELETE') {
    const revoked = sessionRows.filter((row) => !row.current).length;
    sessionRows = sessionRows.filter((row) => row.current);
    return reply(200, { ok: true, revoked, kept: 'bs_this', effects: { sockets: revoked, pushDevices: 0 } });
  }
  const one = /^\/api\/auth\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const id = decodeURIComponent(one[1]);
    const row = sessionRows.find((entry) => entry.id === id);
    if (!row) return reply(404, { error: 'No signed-in browser with that id.' });
    if (method === 'PATCH') {
      const next = { ...row, label: body.label || row.label };
      sessionRows = sessionRows.map((entry) => (entry.id === id ? next : entry));
      return reply(200, { session: next });
    }
    if (method === 'DELETE') {
      sessionRows = sessionRows.filter((entry) => entry.id !== id);
      return reply(200, { ok: true, id, current: row.current, effects: { sockets: 1, pushDevices: 1 } });
    }
  }
  if (url.pathname === '/api/auth/session' && method === 'DELETE') return reply(200, { ok: true, id: 'bs_this' });
  if (url.pathname === '/api/auth/signin-codes' && method === 'POST') {
    return reply(200, { code: 'oarc1_FAKE-test-value', link: FAKE_LINK, expiresAt: new Date(Date.now() + 10 * MINUTE).toISOString(), qr: FAKE_QR });
  }
  if (url.pathname === '/api/auth/owner-token' && method === 'GET') {
    return reply(200, { ownerToken, pairedRelays, lastNonBrowserUse: null, previousLastNonBrowserUse: null, lastNonBrowserUseSince: '2026-11-01T09:00:00.000Z' });
  }
  if (url.pathname === '/api/auth/owner-token/rotate' && method === 'POST') {
    ownerToken = { ...ownerToken, rotatedAt: new Date().toISOString(), legacyPlaintext: false };
    notices = notices.filter((notice) => notice.id !== 'rotate-after-upgrade');
    recommendations = [];
    return reply(200, {
      lastNonBrowserUse: { at: new Date(Date.now() - 5 * MINUTE).toISOString(), address: '192.168.1.30' },
      token: FAKE_TOKEN,
      pairingLink: `http://localhost/?token=${FAKE_TOKEN}`,
      affectedRelays: [{ id: 'rr-1', name: 'linux-test', url: 'https://relay-b.example.test' }, { id: 'rr-2', name: '<b>odd</b>', url: null }],
      rotatedAt: ownerToken.rotatedAt,
    });
  }
  if (url.pathname === '/api/auth/notices' && method === 'GET') return reply(200, { notices, signins, recommendations });
  if (url.pathname === '/api/auth/notices/dismiss-signins' && method === 'POST') {
    const ids = new Set(body.ids || []);
    const before = signins.length;
    signins = signins.filter((notice) => !ids.has(notice.id));
    return reply(200, { ok: true, dismissed: before - signins.length, notices, signins, recommendations });
  }
  const dismiss = /^\/api\/auth\/notices\/([^/]+)\/dismiss$/.exec(url.pathname);
  if (dismiss && method === 'POST') {
    const id = decodeURIComponent(dismiss[1]);
    notices = notices.filter((notice) => notice.id !== id);
    signins = signins.filter((notice) => notice.id !== id);
    return reply(200, { ok: true, notices, signins, recommendations });
  }
  return reply(200, {});
}

const apiClient = await import('./api-client.js');
const { selectSettingsTab } = await import('./settings-tabs.js');
const store = await import('./store.js');
const security = await import('./security-settings.js');

const signedOut = [];
apiClient.onSignedOut((url, options) => { signedOut.push({ url, message: options?.message || '' }); });

const el = (id) => document.getElementById(id);
const rows = () => [...el('security-session-list').querySelectorAll('.security-session-row')];
const row = (id) => rows().find((node) => node.dataset.sessionId === id);
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => nativeSetTimeout(resolve, 0));
};
const modalBody = () => el('summary-modal-body');
const modalVisible = () => el('summary-modal').classList.contains('visible');
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

async function freshSection() {
  security.resetSecuritySettingsForTests();
  store.closeSummaryModal();
  sessionRows = [THIS, PHONE, OLD];
  ownerToken = { set: true, hashed: true, persisted: true, createdAt: ago(30 * 24 * 60 * MINUTE), rotatedAt: null, legacyPlaintext: true };
  pairedRelays = 2;
  notices = [];
  signins = [];
  recommendations = [];
  failNext = null;
  holdNext = null;
  drawn.length = 0;
  requests.length = 0;
  copied.length = 0;
  signedOut.length = 0;
  await security.refreshSecuritySection();
}

test('Security is a deep-linkable settings tab after Relays', () => {
  const tabs = [...document.querySelectorAll('#settings-modal [data-settings-tab]')].map((tab) => tab.dataset.settingsTab);
  assert.equal(tabs[tabs.indexOf('relays') + 1], 'security');
  const { tab } = selectSettingsTab('security');
  assert.equal(tab, 'security');
  assert.equal(el('settings-tab-security').textContent.trim(), 'Security');
  assert.equal(el('settings-tab-security').getAttribute('aria-controls'), 'settings-panel-security');
  assert.equal(el('settings-panel-security').hidden, false);
  assert.equal(el('settings-panel-relays').hidden, true);
  const titles = [...el('settings-panel-security').querySelectorAll('.settings-section-title')].map((node) => node.textContent);
  assert.deepEqual(titles, ['Browsers signed in', 'Sign in another device', 'Relay token']);
});

test('the browsers signed in: this one first and tagged, created, last seen, address and how it signed in', async () => {
  await freshSection();
  assert.deepEqual(rows().map((node) => node.dataset.sessionId), ['bs_this', 'bs_phone', 'bs_old']);
  const mine = row('bs_this');
  assert.equal(mine.dataset.current, 'true');
  assert.equal(mine.querySelector('.security-current-tag').textContent, 'this browser');
  assert.match(mine.querySelector('.security-session-name').textContent, /^Chrome on Windows this browser$/);
  const meta = mine.querySelector('.security-session-meta').textContent;
  assert.match(meta, /^Signed in .+ with the relay token · last seen just now · from 127\.0\.0\.1$/);
  assert.equal(mine.querySelector('.security-session-meta').title, THIS.userAgent);
  assert.match(row('bs_phone').querySelector('.security-session-meta').textContent, /with a sign-in link · last seen 20 min ago · from 192\.168\.1\.20$/);
  assert.match(row('bs_old').querySelector('.security-session-meta').textContent, /before browser sessions \(carried over\) · last seen 2 d ago$/);
  assert.equal(row('bs_phone').querySelector('.security-current-tag'), null);
  assert.deepEqual([...row('bs_phone').querySelectorAll('button')].map((node) => node.textContent), ['Rename', 'Sign out']);
  assert.equal(el('security-sessions-status').hidden, true);
  assert.equal(el('security-signout-others-btn').disabled, false);
  assert.equal(el('security-signout-others-btn').textContent, 'Sign out all other browsers');
  assert.equal(el('security-signout-self-btn').textContent, 'Sign out this browser');
});

test('a label is text, never markup', async () => {
  await freshSection();
  sessionRows = [{ ...PHONE, label: '<img src=x onerror="alert(1)">' }];
  await security.refreshSecuritySection();
  assert.equal(rows()[0].querySelector('.security-session-name').textContent, '<img src=x onerror="alert(1)">');
  assert.equal(el('security-session-list').querySelectorAll('img').length, 0);
});

test('Rename asks for a name in a dialog and saves it', async () => {
  await freshSection();
  click(row('bs_phone').querySelector('.security-rename-btn'));
  assert.equal(modalVisible(), true);
  assert.equal(el('summary-modal-title').textContent, 'Rename browser');
  const input = el('security-rename-input');
  assert.equal(input.value, 'Chrome on Android');
  input.value = '  Work phone  ';
  click(el('security-rename-save'));
  await settle();
  const patch = requests.find((entry) => entry.method === 'PATCH');
  assert.deepEqual(patch, { method: 'PATCH', path: '/api/auth/sessions/bs_phone', body: { label: 'Work phone' } });
  assert.equal(modalVisible(), false);
  assert.match(row('bs_phone').querySelector('.security-session-name').textContent, /^Work phone$/);
});

test('Sign out on another browser\'s row confirms first, then that row goes', async () => {
  await freshSection();
  click(row('bs_phone').querySelector('.security-signout-btn'));
  assert.equal(el('summary-modal-title').textContent, 'Sign out browser');
  assert.match(modalBody().textContent, /Sign out Chrome on Android\?/);
  // Cancel: nothing sent.
  click(el('security-cancel-btn'));
  assert.equal(modalVisible(), false);
  assert.equal(requests.filter((entry) => entry.method === 'DELETE').length, 0);
  click(row('bs_phone').querySelector('.security-signout-btn'));
  click(el('security-confirm-btn'));
  await settle();
  assert.deepEqual(requests.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path), ['/api/auth/sessions/bs_phone']);
  assert.equal(row('bs_phone'), undefined);
  assert.equal(modalVisible(), false);
  assert.match(el('relay-toast').textContent, /Signed out Chrome on Android\. Its push notifications stopped\./);
  assert.equal(signedOut.length, 0, 'this browser stays signed in');
});

test('"Sign out all other browsers" confirms, keeps this one, and disables itself when alone', async () => {
  await freshSection();
  click(el('security-signout-others-btn'));
  assert.match(modalBody().textContent, /Sign out all 2 other browsers\? This one stays signed in\./);
  click(el('security-confirm-btn'));
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'DELETE' && entry.path === '/api/auth/sessions'));
  assert.deepEqual(rows().map((node) => node.dataset.sessionId), ['bs_this']);
  assert.equal(el('security-signout-others-btn').disabled, true);
  assert.match(el('relay-toast').textContent, /Signed out 2 other browsers\./);
});

test('"Sign out this browser" confirms, signs out, and opens the sign-in gate', async () => {
  await freshSection();
  click(el('security-signout-self-btn'));
  assert.equal(el('summary-modal-title').textContent, 'Sign out this browser');
  click(el('security-confirm-btn'));
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'DELETE' && entry.path === '/api/auth/session'));
  assert.deepEqual(signedOut, [{ url: null, message: security.SELF_SIGNED_OUT_MESSAGE }]);
  assert.equal(modalVisible(), false);
  // The row of this browser does the same.
  signedOut.length = 0;
  click(row('bs_this').querySelector('.security-signout-btn'));
  assert.equal(el('summary-modal-title').textContent, 'Sign out this browser');
  store.closeSummaryModal();
});

test('"Sign out this browser" empties the outbox here and tells the service worker; signing out another browser does not', async () => {
  // A page store with queued sends, and a service worker that takes messages.
  const queued = new Map([[1, { kind: 'message', path: '/api/message', body: '{}' }], [2, { kind: 'draft-flush', path: '/api/conversation/c1/draft', body: '{}' }]]);
  const stores = new Map([['outbox', queued]]);
  globalThis.indexedDB = {
    open() {
      const request = {};
      nativeSetTimeout(() => {
        request.result = {
          objectStoreNames: { contains: (name) => stores.has(name) },
          createObjectStore: (name) => stores.set(name, new Map()),
          transaction: (name) => {
            const tx = {};
            tx.objectStore = () => ({ clear: () => { stores.get(name).clear(); nativeSetTimeout(() => tx.oncomplete?.(), 0); return {}; } });
            return tx;
          },
          close() {},
        };
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  const toWorker = [];
  Object.defineProperty(dom.window.navigator, 'serviceWorker', {
    value: { controller: { postMessage: (message) => toWorker.push(message) } },
    configurable: true,
  });
  try {
    await freshSection();
    click(row('bs_phone').querySelector('.security-signout-btn'));
    click(el('security-confirm-btn'));
    await settle();
    assert.equal(queued.size, 2, 'another browser signed out: this one keeps its outbox');
    assert.deepEqual(toWorker, []);

    await freshSection();
    click(el('security-signout-self-btn'));
    click(el('security-confirm-btn'));
    await settle();
    assert.equal(queued.size, 0, 'the page store is empty');
    assert.deepEqual(toWorker, [{ type: 'oar-clear-outbox' }]);
  } finally {
    delete globalThis.indexedDB;
    delete dom.window.navigator.serviceWorker;
  }
});

test('a 401 while loading shows why and reports the signed-out browser', async () => {
  await freshSection();
  failNext = { path: '/api/auth/sessions', status: 401, payload: { error: 'This browser was signed out.', code: 'AUTH_SIGNED_OUT' } };
  await security.refreshSecuritySection();
  assert.match(el('security-sessions-status').textContent, /^Could not load the signed-in browsers: This browser was signed out\./);
  assert.equal(el('security-sessions-status').dataset.state, 'error');
  assert.deepEqual(signedOut.map((entry) => entry.url), ['/api/auth/sessions']);
});

test('a sign-in link: shown with its expiry and Copy, and gone once it expires', async () => {
  await freshSection();
  assert.equal(el('security-signin-code').hidden, true);
  click(el('security-signin-code-btn'));
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/auth/signin-codes'));
  assert.equal(el('security-signin-code').hidden, false);
  assert.equal(el('security-signin-link').value, FAKE_LINK);
  assert.equal(el('security-signin-link').readOnly, true);
  assert.match(el('security-signin-expiry').textContent, /^Works once, until .+ \(10 min left\)\.$/);
  assert.equal(el('security-signin-code-btn').textContent, 'Make a new sign-in link');
  assert.match(el('security-signin-code').textContent, /or scan the QR code/);
  click(el('security-signin-copy-btn'));
  await settle();
  assert.deepEqual(copied, [FAKE_LINK]);
  assert.equal(el('security-signin-copy-btn').textContent, '✓ Copied');
  // Ten minutes on: the link leaves the page.
  security.renderSigninLink(Date.now() + 10 * MINUTE + 1000);
  assert.equal(el('security-signin-code').hidden, true);
  assert.equal(el('security-signin-link').value, '');
  assert.equal(el('security-signin-code-btn').textContent, 'Make a sign-in link');
});

test('expiry, token and notice texts', () => {
  const now = Date.parse('2026-11-11T12:00:00.000Z');
  assert.match(security.describeSigninExpiry('2026-11-11T12:10:00.000Z', now), /\(10 min left\)\.$/);
  assert.match(security.describeSigninExpiry('2026-11-11T12:00:30.000Z', now), /\(30 s left\)\.$/);
  assert.equal(security.describeSigninExpiry('2026-11-11T11:59:00.000Z', now), '');
  assert.deepEqual(
    security.describeOwnerToken({ set: true, hashed: true, persisted: true, createdAt: '2026-11-01T12:00:00.000Z', rotatedAt: '2026-11-08T12:00:00.000Z' }, { pairedRelays: 1, now }),
    { state: 'active', text: 'Set, stored as a hash. Last replaced 3 d ago. 1 paired relay uses it.' },
  );
  assert.deepEqual(security.describeOwnerToken({ set: false }), { state: 'error', text: 'No relay token is set.' });
  assert.equal(security.rePairHint('linux-test'), 'On linux-test: Settings → Relays → Add a relay, paste the pairing link; it updates the existing entry.');
  assert.equal(security.securityNoticeText({ id: 'rotate-after-upgrade' }), 'Your relay token was readable by agents until this version. Generate a new one.');
  assert.equal(
    security.securityNoticeText({ id: 'changed-outside', reason: 'config', at: '2026-11-11T11:55:00.000Z' }, now),
    'The relay token was changed outside OAR (config.json held a new token, 5 min ago). If that was not you, generate a new one.',
  );
});

test('the relay token\'s status line says it is hashed, never replaced, read by agents before', async () => {
  await freshSection();
  const line = el('security-token-status');
  assert.equal(line.textContent, 'Set, stored as a hash. Made 30 d ago, never replaced. 2 paired relays use it. Agents could read it until this version: generate a new one.');
  assert.equal(line.dataset.state, 'error');
  assert.equal(el('security-rotate-btn').textContent, 'Generate new relay token');
});

test('Generate new relay token: confirm, a one-time dialog with Copy and the re-pair hints; closing drops the token', async () => {
  await freshSection();
  click(el('security-rotate-btn'));
  assert.equal(el('summary-modal-title').textContent, 'Generate new relay token');
  assert.match(modalBody().textContent, /The current token stops working at once\. Signed-in browsers stay signed in; agents keep working\./);
  assert.match(modalBody().textContent, /The 2 paired relays need the new token/);
  assert.equal(requests.filter((entry) => entry.path === '/api/auth/owner-token/rotate').length, 0, 'nothing before the confirmation');
  click(el('security-confirm-btn'));
  await settle();
  assert.equal(requests.filter((entry) => entry.path === '/api/auth/owner-token/rotate').length, 1);
  assert.equal(el('summary-modal-title').textContent, 'New relay token');
  const tokenField = el('security-new-token');
  const linkField = el('security-pairing-link');
  assert.equal(tokenField.value, FAKE_TOKEN);
  assert.equal(tokenField.readOnly, false, 'some password managers skip read-only fields');
  assert.equal(tokenField.type, 'password');
  assert.equal(linkField.hidden, true, 'the pairing link is copied, not shown');
  assert.match(modalBody().textContent, /Shown once\. Keep it in your password manager\./);
  const hints = [...modalBody().querySelectorAll('.security-affected-relays .security-affected-hint')].map((node) => node.textContent);
  assert.deepEqual(hints, [
    'On linux-test: Settings → Relays → Add a relay, paste the pairing link; it updates the existing entry.',
    'On <b>odd</b>: Settings → Relays → Add a relay, paste the pairing link; it updates the existing entry.',
  ]);
  assert.equal(modalBody().querySelectorAll('b').length, 0, 'a relay name is text');
  assert.equal(modalBody().innerHTML.includes(FAKE_TOKEN), false, 'the token is a field value, not markup');
  click(el('security-copy-token-btn'));
  click(el('security-copy-pairing-btn'));
  await settle();
  assert.deepEqual(copied, [FAKE_TOKEN, `http://localhost/?token=${FAKE_TOKEN}`]);
  assert.equal(el('security-copy-pairing-btn').textContent, '✓ Copied');
  // The status line and the banner follow.
  await settle();
  assert.match(el('security-token-status').textContent, /^Set, stored as a hash\. Last replaced just now\./);
  assert.equal(el('security-token-status').dataset.state, 'active');

  click(el('security-token-done-btn'));
  assert.equal(modalVisible(), false);
  assert.equal(tokenField.value, '', 'the field was emptied');
  assert.equal(linkField.value, '');
  assert.equal(el('security-new-token'), null, 'the dialog is gone');
  assert.equal(document.documentElement.outerHTML.includes(FAKE_TOKEN), false);
  assert.equal([...document.querySelectorAll('input')].some((input) => input.value.includes(FAKE_TOKEN)), false);
});

test('the token dialog closed another way (another dialog replacing it) also empties its fields', async () => {
  await freshSection();
  click(el('security-rotate-btn'));
  click(el('security-confirm-btn'));
  await settle();
  const tokenField = el('security-new-token');
  assert.equal(tokenField.value, FAKE_TOKEN);
  store.openSummaryModal({ title: 'Something else', kind: 'other', bodyHtml: '<p>other</p>' });
  assert.equal(tokenField.value, '');
  assert.equal(el('security-new-token'), null);
  store.closeSummaryModal();
  assert.equal([...document.querySelectorAll('input')].some((input) => input.value.includes(FAKE_TOKEN)), false);
});

test('a refused rotation says the current token still works and shows no dialog', async () => {
  await freshSection();
  failNext = { path: '/api/auth/owner-token/rotate', status: 500, payload: { error: 'The new relay token could not be stored; the current one still works. See the relay log.' } };
  click(el('security-rotate-btn'));
  click(el('security-confirm-btn'));
  await settle();
  assert.equal(modalVisible(), false);
  assert.match(el('relay-toast').textContent, /could not be stored; the current one still works/);
});

test('the notices banner: both notices with their actions; Dismiss and the Generate button work', async () => {
  await freshSection();
  notices = [
    { id: 'rotate-after-upgrade', message: 'server text', action: 'rotate' },
    { id: 'changed-outside', message: 'server text', reason: 'file', at: ago(5 * MINUTE), action: 'rotate' },
  ];
  await security.startSecurityNotices();
  const banner = el('security-notice-banner');
  assert.equal(banner.hidden, false);
  assert.equal(banner.classList.contains('visible'), true);
  const bannerRows = [...banner.querySelectorAll('.security-notice-row')];
  assert.deepEqual(bannerRows.map((node) => node.dataset.noticeId), ['rotate-after-upgrade', 'changed-outside']);
  assert.equal(bannerRows[0].querySelector('.security-notice-text').textContent, 'Your relay token was readable by agents until this version. Generate a new one.');
  assert.equal(bannerRows[1].querySelector('.security-notice-text').textContent, 'The relay token was changed outside OAR (the relay\'s secrets file holds another token, 5 min ago). If that was not you, generate a new one.');
  assert.deepEqual([...bannerRows[0].querySelectorAll('button')].map((node) => node.textContent), ['Generate new token', 'Dismiss']);

  // Generate: Settings → Security, at its confirmation.
  const opened = [];
  window.openSettingsModal = (tab) => { opened.push(tab); };
  click(bannerRows[0].querySelector('.security-notice-rotate'));
  await settle();
  assert.deepEqual(opened, ['security']);
  assert.equal(el('summary-modal-title').textContent, 'Generate new relay token');
  store.closeSummaryModal();

  click(bannerRows[1].querySelector('.security-notice-dismiss'));
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/auth/notices/changed-outside/dismiss'));
  assert.deepEqual([...banner.querySelectorAll('.security-notice-row')].map((node) => node.dataset.noticeId), ['rotate-after-upgrade']);

  // Signed out: the banner goes.
  security.hideSecurityNotices();
  assert.equal(banner.hidden, true);
  assert.equal(banner.children.length, 0);
});

test('no notices, no banner; a rotation clears the post-upgrade notice', async () => {
  await freshSection();
  notices = [{ id: 'rotate-after-upgrade', message: 'x', action: 'rotate' }];
  await security.refreshSecurityNotices();
  assert.equal(el('security-notice-banner').hidden, false);
  click(el('security-rotate-btn'));
  click(el('security-confirm-btn'));
  await settle();
  assert.equal(el('security-notice-banner').hidden, true);
  store.closeSummaryModal();
});

// ─── 2a: the forms a password manager saves from ────────────────────────────

test('the token dialog is a form: username = relay name, the token field has no name, the submit never leaves', async () => {
  await freshSection();
  click(el('security-rotate-btn'));
  click(el('security-confirm-btn'));
  await settle();
  const form = el('security-token-form');
  assert.equal(form.tagName, 'FORM');
  assert.equal(form.getAttribute('method'), 'post');
  assert.equal(form.getAttribute('action'), '#');
  assert.equal(form.getAttribute('autocomplete'), 'on');
  const user = el('security-token-user');
  assert.equal(user.type, 'text', 'not type=hidden: a manager skips those');
  assert.equal(user.getAttribute('autocomplete'), 'username');
  assert.equal(user.value, 'bench-relay');
  assert.equal(user.hasAttribute('name'), false);
  const field = el('security-new-token');
  assert.equal(field.hasAttribute('name'), false, 'a native submit would carry no token');
  assert.equal(field.getAttribute('autocomplete'), 'new-password');
  assert.equal(el('security-save-token-btn').type, 'submit');
  assert.equal(el('security-save-token-btn').textContent, 'Save in password manager');
  assert.equal([...form.querySelectorAll('[name]')].length, 0, 'no field of the form has a name');

  // An edit of the field is put back.
  field.value = 'something else';
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(field.value, FAKE_TOKEN);
  // Show / Hide.
  click(el('security-show-token-btn'));
  assert.equal(field.type, 'text');
  assert.equal(el('security-show-token-btn').getAttribute('aria-pressed'), 'true');
  click(el('security-show-token-btn'));
  assert.equal(field.type, 'password');

  // "Save in password manager": the submit is stopped, the dialog closes and its fields are empty.
  const submit = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(modalVisible(), false);
  assert.equal(field.value, '');
  assert.equal(el('security-token-form'), null, 'the form left the page');
  assert.equal(window.location.href, 'http://localhost/', 'nothing in the address');
  assert.equal(JSON.stringify({ ...localStorage }).includes(FAKE_TOKEN), false);
  assert.equal(JSON.stringify({ ...sessionStorage }).includes(FAKE_TOKEN), false);
});

test('the sign-in gate is a form the same way, and its submit is always stopped', async () => {
  const form = el('auth-form');
  assert.equal(form.getAttribute('method'), 'post');
  assert.equal(form.getAttribute('action'), '#');
  assert.equal(form.getAttribute('autocomplete'), 'on');
  const user = el('auth-username');
  assert.equal(user.type, 'text');
  assert.equal(user.getAttribute('autocomplete'), 'username');
  assert.equal(user.classList.contains('credential-username'), true);
  const token = el('token-input');
  assert.equal(token.type, 'password');
  assert.equal(token.getAttribute('autocomplete'), 'current-password');
  assert.equal(token.hasAttribute('name'), false);
  assert.equal(el('auth-connect-btn').type, 'submit');
  assert.equal(form.contains(token), true);

  // Its inline script, run against this page: the submit goes to the
  // connect function and never anywhere else; the username is the relay's name.
  const vm = await import('node:vm');
  const script = [...document.querySelectorAll('script')].map((node) => node.textContent).find((text) => text.includes("getElementById('auth-form')"));
  assert.ok(script, 'the gate binds its form');
  const calls = [];
  window.__copilotAuthConnect = (event) => { calls.push(event.type); };
  vm.runInNewContext(script, { document, window });
  assert.equal(user.value, 'bench-relay');
  const submit = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.deepEqual(calls, ['submit']);
  delete window.__copilotAuthConnect;
  assert.equal(security.relayAccountName({ relayName: '' }, 'relay.example.test:3333'), 'OAR (relay.example.test:3333)');
});

// ─── 2b: the QR code behind a tap ───────────────────────────────────────────

test('the QR code shows only after a tap, on a canvas with a 4-module quiet zone', async () => {
  await freshSection();
  click(el('security-signin-code-btn'));
  await settle();
  const button = el('security-signin-qr-btn');
  assert.equal(button.hidden, false);
  assert.equal(el('security-signin-qr').hidden, true, 'hidden until tapped');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(drawn.length, 0, 'nothing drawn before the tap');
  click(button);
  assert.equal(el('security-signin-qr').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.textContent, 'Hide QR code');
  const canvas = el('security-signin-qr-canvas');
  assert.equal(canvas.width, (21 + 8) * 6, 'the code plus 4 modules each side');
  const white = drawn.find((entry) => entry.style === '#ffffff');
  assert.deepEqual([white.x, white.y, white.w, white.h], [0, 0, canvas.width, canvas.height]);
  const dark = drawn.filter((entry) => entry.style === '#000000');
  assert.ok(dark.length > 0);
  assert.equal(Math.min(...dark.map((entry) => entry.x)), 4 * 6, 'no dark module in the quiet zone');
  // Hide.
  click(button);
  assert.equal(el('security-signin-qr').hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(canvas.width, 0, 'the canvas is emptied');
});

test('the QR code hides after a minute, on a tab switch, when the link is used, and when it expires', async (t) => {
  await freshSection();
  click(el('security-signin-code-btn'));
  await settle();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  click(el('security-signin-qr-btn'));
  assert.equal(el('security-signin-qr').hidden, false);
  t.mock.timers.tick(security.SIGNIN_QR_SHOW_MS - 1);
  assert.equal(el('security-signin-qr').hidden, false);
  t.mock.timers.tick(1);
  assert.equal(el('security-signin-qr').hidden, true, 'gone after 60 s');
  t.mock.timers.reset();

  // Another tab or app.
  click(el('security-signin-qr-btn'));
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  delete document.visibilityState;
  assert.equal(el('security-signin-qr').hidden, true);

  // Used: a new sign-in by a link arrives, the link and its code leave.
  click(el('security-signin-qr-btn'));
  security.noteNewSignIn({ notice: { id: 'signin-n1', sessionId: 'bs_new', label: 'Safari on iPhone', address: '192.168.1.40', via: 'code', at: new Date().toISOString(), dismissible: true } });
  assert.equal(el('security-signin-qr').hidden, true);
  assert.equal(el('security-signin-code').hidden, true);
  assert.equal(el('security-signin-link').value, '');

  // Expired.
  click(el('security-signin-code-btn'));
  await settle();
  click(el('security-signin-qr-btn'));
  security.renderSigninLink(Date.now() + 11 * MINUTE);
  assert.equal(el('security-signin-qr').hidden, true);
  assert.equal(el('security-signin-qr-canvas').width, 0);
});

test('a relay that sends no matrix: no QR button', async () => {
  await freshSection();
  failNext = { path: '/api/auth/signin-codes', status: 200, payload: { code: 'oarc1_FAKE-test-value', link: FAKE_LINK, expiresAt: new Date(Date.now() + 10 * MINUTE).toISOString(), qr: null } };
  click(el('security-signin-code-btn'));
  await settle();
  assert.equal(el('security-signin-code').hidden, false);
  assert.equal(el('security-signin-qr-btn').hidden, true);
});

// ─── 2d: new sign-ins ───────────────────────────────────────────────────────

const NEW_SIGNIN = {
  id: 'signin-ev1', sessionId: 'bs_phone', label: 'Chrome on Android', userAgent: 'Mozilla/5.0 (Linux; Android 15)', address: '192.168.1.20',
  via: 'code', viaLabel: 'a sign-in link', at: ago(2 * MINUTE), signedOut: false, dismissible: true,
};

test('one new sign-in is the banner row: who, from where, how; Sign it out signs it out, Got it acknowledges', async () => {
  await freshSection();
  signins = [NEW_SIGNIN];
  await security.refreshSecurityNotices();
  const banner = el('security-notice-banner');
  assert.equal(banner.hidden, false);
  const rows = () => [...el('security-notice-banner').querySelectorAll('.security-signin-notice')];
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].dataset.count, '1');
  assert.equal(rows()[0].dataset.noticeId, 'signin-ev1');
  assert.equal(rows()[0].querySelector('.security-notice-text').textContent, 'New browser signed in: Chrome on Android, 192.168.1.20, via a sign-in link');
  assert.deepEqual([...rows()[0].querySelectorAll('button')].map((node) => node.textContent), ['Sign it out', 'Got it']);

  click(rows()[0].querySelector('.security-signin-signout'));
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'DELETE' && entry.path === '/api/auth/sessions/bs_phone'));
  assert.equal(rows()[0].querySelector('.security-notice-text').textContent, 'New browser signed in: Chrome on Android, 192.168.1.20, via a sign-in link (signed out)');
  assert.deepEqual([...rows()[0].querySelectorAll('button')].map((node) => node.textContent), ['Got it']);
  assert.match(el('relay-toast').textContent, /Signed out Chrome on Android/);

  click(rows()[0].querySelector('.security-notice-dismiss'));
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/auth/notices/dismiss-signins'));
  assert.equal(rows().length, 0);
  assert.equal(banner.hidden, true);
  assert.equal(signedOut.length, 0);
});

test('several new sign-ins stay one row: "N new browsers signed in (latest: …)", a list behind Show all, one Got it for all', async () => {
  await freshSection();
  signins = [
    NEW_SIGNIN,
    { ...NEW_SIGNIN, id: 'signin-ev2', sessionId: 'bs_gone', label: 'Firefox on Linux', address: '10.0.0.9', via: 'terminal', viaLabel: 'the terminal' },
    { ...NEW_SIGNIN, id: 'signin-ev3', sessionId: 'bs_tab', label: 'Safari on iPad', address: '10.0.0.12', via: 'token', viaLabel: 'the relay token' },
  ];
  await security.refreshSecurityNotices();
  const banner = el('security-notice-banner');
  const rows = () => [...banner.querySelectorAll('.security-notice-row')];
  const list = () => banner.querySelector('#security-signin-list');
  assert.equal(rows().length, 1, 'one row, however many');
  const row = () => rows()[0];
  assert.equal(row().dataset.count, '3');
  assert.equal(row().querySelector('.security-notice-text').textContent, '3 new browsers signed in (latest: Chrome on Android, 192.168.1.20, via a sign-in link)');
  assert.deepEqual([...row().querySelectorAll('button')].map((node) => node.textContent), ['Show all', 'Got it']);
  assert.equal(row().querySelector('.security-signin-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(row().querySelector('.security-notice-dismiss').getAttribute('aria-label'), 'Dismiss these 3 notices');
  assert.equal(list(), null);

  click(row().querySelector('.security-signin-toggle'));
  assert.equal(row().querySelector('.security-signin-toggle').textContent, 'Hide');
  assert.equal(row().querySelector('.security-signin-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(row().querySelector('.security-signin-toggle').getAttribute('aria-controls'), 'security-signin-list');
  const entries = () => [...list().querySelectorAll('.security-signin-entry')];
  // Each with how and when, so two that read alike can be told apart.
  assert.deepEqual(entries().map((node) => node.querySelector('.security-notice-text').textContent), [
    'Chrome on Android, 192.168.1.20, via a sign-in link · 2 min ago',
    'Firefox on Linux, 10.0.0.9, via the terminal · 2 min ago',
    'Safari on iPad, 10.0.0.12, via the relay token · 2 min ago',
  ]);
  assert.match(entries()[0].querySelector('.security-notice-text').title, /^Mozilla\/5\.0 \(Linux; Android 15\)\n.+/);
  assert.deepEqual(entries().map((node) => node.dataset.via), ['code', 'terminal', 'token']);

  // Sign it out per entry; one gone already says so.
  click(entries()[1].querySelector('.security-signin-signout'));
  await settle();
  assert.match(entries()[1].querySelector('.security-notice-text').textContent, /\(already signed out\)$/);
  assert.equal(entries()[1].querySelector('button'), null);
  assert.match(el('relay-toast').textContent, /was already signed out/);
  click(entries()[0].querySelector('.security-signin-signout'));
  await settle();
  assert.match(entries()[0].querySelector('.security-notice-text').textContent, /\(signed out\)$/);

  // A fourth arrives live: still one row, the count follows, the list stays open.
  security.noteNewSignIn({ notice: { ...NEW_SIGNIN, id: 'signin-ev4', sessionId: 'bs_four', label: 'Edge on Windows', address: '10.0.0.20', via: 'token' } });
  assert.equal(rows().length, 1);
  assert.equal(row().querySelector('.security-notice-text').textContent, '4 new browsers signed in (latest: Edge on Windows, 10.0.0.20, via the relay token)');
  assert.equal(entries().length, 4);

  // Got it: all four, for this browser, in one call.
  const before = requests.length;
  click(row().querySelector('.security-notice-dismiss'));
  await settle();
  const sent = requests.slice(before).filter((entry) => entry.method === 'POST');
  assert.deepEqual(sent.map((entry) => entry.path), ['/api/auth/notices/dismiss-signins']);
  assert.equal(banner.hidden, true);
  assert.equal(list(), null);
});

test('a sign-in that arrives while Got it is on its way stays: the answer made before it does not take it off', async () => {
  await freshSection();
  signins = [{ ...NEW_SIGNIN, via: 'terminal', viaLabel: 'the terminal' }];
  await security.refreshSecurityNotices();
  const banner = el('security-notice-banner');
  const summary = () => banner.querySelectorAll('.security-signin-notice');
  assert.equal(summary().length, 1);
  let release;
  holdNext = { path: '/api/auth/notices/dismiss-signins', release: new Promise((resolve) => { release = resolve; }) };
  click(banner.querySelector('.security-notice-dismiss'));
  await settle();
  assert.equal(summary().length, 0);
  // The relay answered the Got it before the next browser signed in; the
  // socket brings that sign-in before the answer is read.
  const next = { ...NEW_SIGNIN, id: 'signin-ev5', sessionId: 'bs_five', label: 'Firefox on Linux', address: '127.0.0.1', via: 'token', viaLabel: 'the relay token' };
  signins = [next];
  security.noteNewSignIn({ notice: next });
  assert.equal(summary().length, 1);
  release();
  await settle();
  assert.equal(summary().length, 1, 'still there after the answer');
  assert.equal(summary()[0].dataset.count, '1');
  assert.equal(summary()[0].dataset.noticeId, 'signin-ev5');

  // Its own Got it takes it off, and a later answer does not bring it back.
  click(banner.querySelector('.security-notice-dismiss'));
  await settle();
  assert.equal(summary().length, 0);
  await security.refreshSecurityNotices();
  assert.equal(summary().length, 0);
  assert.equal(banner.hidden, true);
});

test('a sign-in dismissed here stays off when a notices answer made before the dismissal comes in after it', async () => {
  await freshSection();
  signins = [NEW_SIGNIN];
  await security.refreshSecurityNotices();
  const banner = el('security-notice-banner');
  const summary = () => banner.querySelectorAll('.security-signin-notice');
  assert.equal(summary().length, 1);
  let release;
  holdNext = { path: '/api/auth/notices', release: new Promise((resolve) => { release = resolve; }) };
  const refreshing = security.refreshSecurityNotices();
  await settle();
  click(banner.querySelector('.security-notice-dismiss'));
  await settle();
  assert.equal(summary().length, 0);
  assert.deepEqual(signins, []);
  // The held answer was made before Got it and still lists it.
  release();
  await refreshing;
  await settle();
  assert.equal(summary().length, 0, 'not back');
  assert.equal(banner.hidden, true);
});

test('two dismissals on their way, the first answering last: nothing dismissed comes back', async () => {
  await freshSection();
  const other = { ...NEW_SIGNIN, id: 'signin-ev2', sessionId: 'bs_two', label: 'Firefox on Linux', address: '10.0.0.9' };
  signins = [NEW_SIGNIN, other];
  await security.refreshSecurityNotices();
  const banner = el('security-notice-banner');
  const summary = () => banner.querySelectorAll('.security-signin-notice');
  assert.equal(summary()[0].dataset.count, '2');
  let release;
  holdNext = { path: '/api/auth/notices/dismiss-signins', release: new Promise((resolve) => { release = resolve; }) };
  const first = security.dismissSignins(['signin-ev1']);
  await settle();
  assert.equal(summary()[0].dataset.count, '1');
  // The second answers at once; the first (which still lists ev2) last.
  assert.equal(await security.dismissSecurityNotice('signin-ev2'), true);
  assert.equal(summary().length, 0);
  release();
  assert.equal(await first, true);
  await settle();
  assert.equal(summary().length, 0, 'neither is back');
  await security.refreshSecurityNotices();
  assert.equal(summary().length, 0);
});

test('a refused dismissal restores the sign-in, a later answer still shows it, and Got it takes it off again', async () => {
  await freshSection();
  signins = [NEW_SIGNIN];
  await security.refreshSecurityNotices();
  const banner = el('security-notice-banner');
  const summary = () => banner.querySelectorAll('.security-signin-notice');
  failNext = { path: '/api/auth/notices/dismiss-signins', status: 500, payload: { error: 'nope' } };
  click(banner.querySelector('.security-notice-dismiss'));
  await settle();
  assert.equal(summary().length, 1, 'restored');
  assert.match(el('relay-toast').textContent, /could not be dismissed/);
  await security.refreshSecurityNotices();
  assert.equal(summary().length, 1, 'no longer counted as dismissed here');
  failNext = { path: `/api/auth/notices/${NEW_SIGNIN.id}/dismiss`, status: 500, payload: { error: 'nope' } };
  assert.equal(await security.dismissSecurityNotice(NEW_SIGNIN.id), false);
  assert.equal(summary().length, 1, 'restored after the single dismissal too');
  await security.refreshSecurityNotices();
  assert.equal(summary().length, 1);
  click(banner.querySelector('.security-notice-dismiss'));
  await settle();
  assert.equal(summary().length, 0);
  await security.refreshSecurityNotices();
  assert.equal(summary().length, 0);
  assert.equal(banner.hidden, true);
});

test('a refused Got it brings the row back and says so', async () => {
  await freshSection();
  signins = [NEW_SIGNIN, { ...NEW_SIGNIN, id: 'signin-ev2', sessionId: 'bs_two' }];
  await security.refreshSecurityNotices();
  failNext = { path: '/api/auth/notices/dismiss-signins', status: 500, payload: { error: 'nope' } };
  click(el('security-notice-banner').querySelector('.security-notice-dismiss'));
  await settle();
  assert.equal(el('security-notice-banner').querySelector('.security-signin-notice').dataset.count, '2');
  assert.match(el('relay-toast').textContent, /could not be dismissed/);
});

test('a notice arrives live (socket), the owner token\'s relay-wide view has no Got it, a gone session no Sign it out', async () => {
  await freshSection();
  await security.refreshSecurityNotices();
  assert.equal(el('security-notice-banner').hidden, true);
  assert.equal(security.noteNewSignIn({ notice: { ...NEW_SIGNIN, id: 'not-a-signin' } }), false);
  assert.equal(security.noteNewSignIn({ notice: { ...NEW_SIGNIN, label: '<img src=x onerror=alert(1)>' } }), true);
  const row = el('security-notice-banner').querySelector('.security-signin-notice');
  assert.match(row.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(el('security-notice-banner').querySelectorAll('img').length, 0);
  signins = [{ ...NEW_SIGNIN, dismissible: false, signedOut: true }];
  await security.refreshSecurityNotices();
  const only = el('security-notice-banner').querySelector('.security-signin-notice');
  assert.equal(only.querySelectorAll('button').length, 0);
  assert.match(only.textContent, /\(already signed out\)$/);
  assert.equal(security.SIGNIN_NOTICE_SOCKET_EVENT, 'auth_new_signin');
});

test('the sign-in row is one line that never wraps; the list lies over the page in a bounded box', () => {
  const css = indexHtml;
  assert.match(css, /\.security-notice-row\.security-signin-notice \{ flex-wrap: nowrap; \}/);
  assert.match(css, /\.security-signin-notice > \.security-notice-text \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  const list = /\.security-signin-list \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(list, /position: absolute;/);
  assert.match(list, /max-height: min\(40vh, 18em\);/);
  assert.match(list, /overflow-y: auto;/);
  const banner = /#security-notice-banner \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(banner, /position: relative;/);
});

test('Security\'s dialogs over Settings have a backdrop and a box of their own', async () => {
  await freshSection();
  click(el('security-rotate-btn'));
  assert.match(el('summary-modal').dataset.kind, /^security-/);
  store.closeSummaryModal();
  assert.match(indexHtml, /#summary-modal\[data-kind\^="security-"\] \{ background: rgba\(0, 0, 0, 0\.82\); \}/);
  const box = /#summary-modal\[data-kind\^="security-"\] \.summary-dialog \{([^}]*)\}/.exec(indexHtml)?.[1] || '';
  assert.match(box, /width: min\(calc\(620px \* var\(--ui-scale\)\), 100%\);/);
  assert.match(box, /box-shadow:/);
});

test('each signed-in browser says how it signed in, the terminal included', async () => {
  await freshSection();
  sessionRows = [THIS, { ...PHONE, authMethod: 'terminal' }];
  await security.refreshSecuritySection();
  assert.equal(row('bs_phone').dataset.via, 'terminal');
  assert.match(row('bs_phone').querySelector('.security-session-meta').textContent, /from the terminal \(oar url --sign-in\) · last seen/);
  assert.equal(row('bs_this').dataset.via, 'token');
});

// ─── 3a, 3b ─────────────────────────────────────────────────────────────────

test('the rotation dialog: the old token\'s last non-browser use, Open there per relay without the token, the clipboard hint', async () => {
  await freshSection();
  click(el('security-rotate-btn'));
  click(el('security-confirm-btn'));
  await settle();
  assert.equal(modalBody().querySelector('.security-token-last-use').textContent, 'Owner token last used by a non-browser client: 5 min ago, from 192.168.1.30.');
  const items = [...modalBody().querySelectorAll('.security-affected-relays li')];
  const open = items[0].querySelector('.security-affected-open');
  assert.equal(open.textContent, 'Open there');
  assert.equal(open.getAttribute('href'), 'https://relay-b.example.test/?settings=relays&add-relay=1');
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener noreferrer');
  assert.equal(open.getAttribute('href').includes(FAKE_TOKEN), false, 'no prefill');
  assert.equal(items[1].querySelector('.security-affected-open'), null, 'no address, no link');
  assert.equal(modalBody().querySelector('.security-clipboard-hint').textContent, security.CLIPBOARD_HINT_TEXT);
  store.closeSummaryModal();
});

test('the last-use line: a use, none since the record began, nothing known', () => {
  const now = Date.parse('2026-11-11T12:00:00.000Z');
  assert.equal(security.describeLastNonBrowserUse({ at: '2026-11-11T09:00:00.000Z', address: '10.0.0.4' }, null, now), 'Owner token last used by a non-browser client: 3 h ago, from 10.0.0.4.');
  assert.equal(security.describeLastNonBrowserUse({ at: '2026-11-11T11:59:50.000Z', address: null }, null, now), 'Owner token last used by a non-browser client: just now.');
  assert.match(security.describeLastNonBrowserUse(null, '2026-11-01T09:00:00.000Z', now), /^Owner token last used by a non-browser client: not since .+\.$/);
  assert.equal(security.describeLastNonBrowserUse(null, null, now), 'Owner token last used by a non-browser client: not that this relay knows of.');
  assert.equal(security.describeSigninNotice({ label: '', address: '', via: 'terminal' }), 'New browser signed in: Browser, via the terminal');
  assert.equal(security.describeSigninEntry({ label: 'Chrome on Android', address: '127.0.0.1', via: 'token', at: '2026-11-11T09:00:00.000Z' }, now), 'Chrome on Android, 127.0.0.1, via the relay token · 3 h ago');
  assert.equal(security.describeSigninEntry({ label: 'Chrome on Android', via: 'code' }, now), 'Chrome on Android, via a sign-in link');
  assert.equal(security.describeSigninSummary([]), '');
});

test('3b: a quiet dot on the Security tab and a tag on the token row while a new token is recommended, gone after a rotation', async () => {
  await freshSection();
  const dot = () => el('settings-tab-security').querySelector('.settings-tab-dot');
  assert.equal(dot(), null);
  recommendations = [{ id: 'rotate-owner-token', tab: 'security' }];
  await security.refreshSecurityNotices();
  assert.equal(dot().getAttribute('aria-label'), 'Recommended');
  assert.equal(dot().getAttribute('role'), 'img');
  assert.equal(el('security-token-recommended').hidden, false);
  assert.equal(el('settings-tab-security').textContent.trim(), 'Security', 'no count, no text');
  click(el('security-rotate-btn'));
  click(el('security-confirm-btn'));
  await settle();
  store.closeSummaryModal();
  await settle();
  assert.equal(dot(), null);
  assert.equal(el('security-token-recommended').hidden, true);
});
