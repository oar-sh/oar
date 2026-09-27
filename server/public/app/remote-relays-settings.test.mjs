import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Relays renders into markup that lives in index.html, so this runs
// against the real file: a renamed or dropped id fails here, not in the
// browser. JSDOM does not execute the page's scripts or inline handlers, so the
// handlers bootstrap.js exposes are called directly.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.Event = dom.window.Event;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer?.unref?.();
  return timer;
};

let confirmAnswer = true;
const confirmPrompts = [];
const alerts = [];
globalThis.confirm = (text) => { confirmPrompts.push(String(text)); return confirmAnswer; };
globalThis.alert = (text) => { alerts.push(String(text)); };
window.confirm = globalThis.confirm;
window.alert = globalThis.alert;

const MINUTE = 60 * 1000;
const LINUX = {
  id: 'rr-1',
  relayId: 'relay-b',
  name: 'linux-test',
  url: 'https://relay-b.example.test',
  host: 'relay-b.example.test',
  permission: 'full',
  addedBy: 'user',
  addedAt: '2026-09-27T08:00:00.000Z',
  version: '0.9.4',
  platform: 'linux',
  lastSeenAt: new Date(Date.now() - 5 * MINUTE).toISOString(),
  lastStatus: 'online',
  lastError: null,
  protocol: 1,
  tokenMode: 'own',
  httpWarning: null,
};
const WIN = {
  id: 'rr-2',
  relayId: 'relay-c',
  name: 'win-test-2',
  url: 'http://127.0.0.1:3351',
  host: '127.0.0.1',
  permission: 'prompt',
  addedBy: 'pairing',
  addedAt: '2026-09-27T08:00:00.000Z',
  version: '0.9.4',
  platform: 'win32',
  lastSeenAt: null,
  lastStatus: 'offline',
  lastError: 'connect ECONNREFUSED 127.0.0.1:3351',
  protocol: 1,
  tokenMode: 'custom',
  httpWarning: 'Plain http on loopback (for example an SSH port forward).',
};
const SELF = { relayId: 'relay-a', name: 'win-test', version: '0.9.4', platform: 'win32', publicUrl: 'https://relay-a.example.test', inboundEnabled: true };

// ─── A scripted relay ────────────────────────────────────────────────────────
const requests = [];
let listPayload = { relays: [LINUX, WIN], self: SELF };
let relaySettings = { publicUrl: 'https://relay-a.example.test', inboundEnabled: true };
const addAnswers = [];

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (rawUrl, opts = {}) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  const method = String(opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ method, path: url.pathname, body });
  if (url.pathname === '/api/remote-relays' && method === 'GET') return reply(200, listPayload);
  if (url.pathname === '/api/remote-relays' && method === 'POST') {
    const [status, answer] = addAnswers.shift() || [500, { ok: false, error: 'no scripted answer' }];
    return reply(status, answer);
  }
  if (url.pathname === '/api/settings/remote-relays' && method === 'GET') return reply(200, relaySettings);
  if (url.pathname === '/api/settings/remote-relays' && method === 'POST') {
    if (body?.publicUrl && !/^https?:\/\//.test(body.publicUrl)) {
      return reply(400, { ok: false, error: 'Only https:// (or http:// on loopback and private networks) is supported' });
    }
    relaySettings = { ...relaySettings, ...body };
    return reply(200, { ok: true, ...relaySettings });
  }
  const rowMatch = /^\/api\/remote-relays\/([^/]+)(\/check)?$/.exec(url.pathname);
  if (rowMatch) {
    const id = decodeURIComponent(rowMatch[1]);
    const relay = listPayload.relays.find((entry) => entry.id === id);
    if (!relay) return reply(404, { ok: false, error: 'Unknown remote relay' });
    if (rowMatch[2] && method === 'POST') {
      const checked = { ...relay, lastStatus: 'online', lastError: null, lastSeenAt: new Date().toISOString() };
      listPayload = { ...listPayload, relays: listPayload.relays.map((entry) => (entry.id === id ? checked : entry)) };
      return reply(200, { ok: true, relay: checked });
    }
    if (method === 'PATCH') {
      const patched = { ...relay, ...body };
      listPayload = { ...listPayload, relays: listPayload.relays.map((entry) => (entry.id === id ? patched : entry)) };
      return reply(200, { ok: true, relay: patched });
    }
    if (method === 'DELETE') {
      listPayload = { ...listPayload, relays: listPayload.relays.filter((entry) => entry.id !== id) };
      return reply(200, { ok: true });
    }
  }
  return reply(200, {});
};

const store = await import('./remote-relays-store.mjs');
const { selectSettingsTab } = await import('./settings-tabs.js');
const settings = await import('./remote-relays-settings.js');

const el = (id) => document.getElementById(id);
const rows = () => [...el('remote-relays-list').querySelectorAll('.remote-relay-row')];
const row = (id) => rows().find((node) => node.dataset.relayId === id);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function freshSection() {
  store.resetRemoteRelaysStoreForTests();
  settings.resetRemoteRelaysSettingsForTests();
  listPayload = { relays: [LINUX, WIN], self: SELF };
  relaySettings = { publicUrl: 'https://relay-a.example.test', inboundEnabled: true };
  addAnswers.length = 0;
  requests.length = 0;
  alerts.length = 0;
  confirmPrompts.length = 0;
  confirmAnswer = true;
  el('remote-relays-add-url-input').value = '';
  el('remote-relays-add-token-input').value = '';
  el('remote-relays-add-token-row').hidden = true;
  el('remote-relays-use-token-btn').hidden = false;
  el('remote-relays-pair-back-toggle').checked = true;
  await settings.refreshRemoteRelaysSection();
}

test('the Relays tab is a deep-linkable settings tab', () => {
  const { tab } = selectSettingsTab('relays');
  assert.equal(tab, 'relays');
  assert.equal(el('settings-tab-relays').getAttribute('aria-selected'), 'true');
  assert.equal(el('settings-panel-relays').hidden, false);
  assert.equal(el('settings-panel-general').hidden, true);
  assert.equal(el('settings-tab-relays').textContent.trim(), 'Relays');
});

test('General shows the PWA app name as "Relay name", ids unchanged', () => {
  const label = document.querySelector('label[for="pwa-app-name-input"]');
  assert.equal(label.textContent.trim(), 'Relay name');
  const input = el('pwa-app-name-input');
  assert.equal(input.getAttribute('aria-label'), 'Relay name');
  assert.match(input.parentElement.querySelector('.settings-help').textContent, /^Shown to other relays and used as the installed app's name\./);
});

test('"This relay" shows the name, the public address and the inbound switch', async () => {
  await freshSection();
  assert.equal(el('remote-relays-self-name').textContent, 'win-test');
  assert.match(el('remote-relays-self-name').parentElement.textContent, /Change it under General → Relay name/);
  assert.equal(el('remote-relays-public-url-input').value, 'https://relay-a.example.test');
  // Opened on localhost: no useful default to offer another relay.
  assert.equal(el('remote-relays-public-url-input').placeholder, 'https://…');
  assert.equal(el('remote-relays-inbound-toggle').checked, true);
  assert.equal(el('remote-relays-inbound-toggle').disabled, false);
  assert.equal(document.querySelector('label[for="remote-relays-inbound-toggle"]').textContent.trim(), 'Accept prompts from other relays\' agents');
});

test('each remote renders its dot, name, host, version, last seen and controls', async () => {
  await freshSection();
  assert.deepEqual(rows().map((node) => node.dataset.relayId), ['rr-1', 'rr-2']);
  assert.equal(el('remote-relays-empty').hidden, true);

  const linux = row('rr-1');
  assert.equal(linux.querySelector('.remote-relay-dot').dataset.status, 'online');
  assert.equal(linux.querySelector('.remote-relay-dot').title, 'Online');
  assert.equal(linux.querySelector('.remote-relay-name').textContent, 'linux-test');
  assert.equal(linux.querySelector('.remote-relay-tag'), null);
  assert.equal(linux.querySelector('.remote-relay-detail').textContent, 'relay-b.example.test · OAR 0.9.4 · seen 5 min ago');
  assert.equal(linux.querySelector('.remote-relay-http-warning'), null);
  const select = linux.querySelector('select.remote-relay-permission-select');
  assert.equal(select.value, 'full');
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [
    ['read', 'Read only'],
    ['prompt', 'Read and prompt'],
    ['full', 'Full'],
  ]);
  assert.match(linux.querySelector('.remote-relay-permission').textContent, /^Agents may/);
  const open = linux.querySelector('a.remote-relay-open');
  assert.equal(open.getAttribute('href'), 'https://relay-b.example.test');
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener');
  assert.equal(linux.querySelector('.remote-relay-check').textContent, 'Check');
  assert.equal(linux.querySelector('.remote-relay-remove').textContent, 'Remove');

  const win = row('rr-2');
  const dot = win.querySelector('.remote-relay-dot');
  assert.equal(dot.dataset.status, 'offline');
  assert.equal(dot.title, 'connect ECONNREFUSED 127.0.0.1:3351');
  assert.equal(win.querySelector('.remote-relay-tag').textContent, 'Paired automatically');
  assert.equal(win.querySelector('.remote-relay-detail').textContent, '127.0.0.1 · OAR 0.9.4 · not reached yet');
  assert.equal(win.querySelector('.remote-relay-error').textContent, 'connect ECONNREFUSED 127.0.0.1:3351');
  assert.match(win.querySelector('.remote-relay-http-warning').textContent, /Plain http on loopback/);
  assert.equal(win.querySelector('select').value, 'prompt');
});

test('unknown and error states get grey and red dots with the reason as tooltip', async () => {
  await freshSection();
  store.setRemoteRelaysSnapshot({
    relays: [
      { ...LINUX, lastStatus: 'unknown', lastSeenAt: null },
      { ...WIN, lastStatus: 'unauthorized', lastError: 'The other relay rejected the token (401)' },
    ],
  });
  assert.equal(row('rr-1').querySelector('.remote-relay-dot').dataset.status, 'unknown');
  assert.equal(row('rr-1').querySelector('.remote-relay-dot').title, 'Not checked yet');
  assert.equal(row('rr-2').querySelector('.remote-relay-dot').dataset.status, 'unauthorized');
  assert.equal(row('rr-2').querySelector('.remote-relay-dot').title, 'The other relay rejected the token (401)');
  // The socket snapshot kept "self" from the earlier load.
  assert.equal(el('remote-relays-self-name').textContent, 'win-test');
});

test('an empty list says so', async () => {
  await freshSection();
  store.setRemoteRelaysSnapshot({ relays: [], self: SELF });
  assert.equal(rows().length, 0);
  assert.equal(el('remote-relays-empty').hidden, false);
  assert.match(el('remote-relays-empty').textContent, /No remote relays yet/);
});

test('"Agents may" saves the permission', async () => {
  await freshSection();
  const select = row('rr-1').querySelector('select');
  select.value = 'read';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();
  const patch = requests.find((entry) => entry.method === 'PATCH');
  assert.deepEqual(patch, { method: 'PATCH', path: '/api/remote-relays/rr-1', body: { permission: 'read' } });
  assert.equal(row('rr-1').querySelector('select').value, 'read');
  assert.deepEqual(alerts, []);
});

test('Check re-probes the relay and repaints its dot', async () => {
  await freshSection();
  row('rr-2').querySelector('.remote-relay-check').click();
  assert.equal(row('rr-2').querySelector('.remote-relay-check').textContent, 'Checking…');
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/remote-relays/rr-2/check'));
  assert.equal(row('rr-2').querySelector('.remote-relay-dot').dataset.status, 'online');
  assert.equal(row('rr-2').querySelector('.remote-relay-check').textContent, 'Check');
});

test('Remove asks first and only deletes when confirmed', async () => {
  await freshSection();
  confirmAnswer = false;
  row('rr-1').querySelector('.remote-relay-remove').click();
  await settle();
  assert.equal(confirmPrompts.length, 1);
  assert.match(confirmPrompts[0], /Remove linux-test\?/);
  assert.equal(requests.some((entry) => entry.method === 'DELETE'), false);
  assert.ok(row('rr-1'));

  confirmAnswer = true;
  row('rr-1').querySelector('.remote-relay-remove').click();
  await settle();
  assert.ok(requests.some((entry) => entry.method === 'DELETE' && entry.path === '/api/remote-relays/rr-1'));
  assert.equal(row('rr-1'), undefined);
  assert.ok(row('rr-2'));
});

test('a remote_relays_updated snapshot repaints the list live', async () => {
  await freshSection();
  store.setRemoteRelaysSnapshot({ relays: [LINUX, WIN, { ...LINUX, id: 'rr-3', name: 'report-box', host: 'relay-d.example.test', url: 'https://relay-d.example.test' }] });
  assert.deepEqual(rows().map((node) => node.dataset.relayId), ['rr-1', 'rr-2', 'rr-3']);
});

test('the add form: a 401 brings up the token field, the retry sends it once', async () => {
  await freshSection();
  const status = el('remote-relays-add-status');
  // Nothing pasted yet.
  await settings.addRemoteRelayFromForm();
  assert.equal(status.dataset.state, 'error');
  assert.equal(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/remote-relays'), false);

  el('remote-relays-add-url-input').value = 'https://relay-d.example.test/?token=from-link';
  addAnswers.push([401, { ok: false, needsToken: true, error: 'The other relay needs its token' }]);
  const first = await settings.addRemoteRelayFromForm();
  assert.equal(first.state, 'needs-token');
  assert.equal(status.dataset.state, 'needs-token');
  assert.equal(status.hidden, false);
  assert.equal(el('remote-relays-add-token-row').hidden, false);
  assert.equal(el('remote-relays-use-token-btn').hidden, true);
  const firstPost = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/remote-relays')[0];
  // Opened on localhost: no selfUrl a remote could use is sent.
  assert.deepEqual(firstPost.body, { url: 'https://relay-d.example.test/?token=from-link', pairBack: true });
  assert.equal(el('remote-relays-add-token-input').type, 'password');
  assert.equal(el('remote-relays-add-token-input').getAttribute('autocomplete'), 'off');

  // A wrong token: still refused, and the field is empty again for the next try.
  el('remote-relays-add-token-input').value = 'wrong-token';
  addAnswers.push([401, { ok: false, needsToken: true }]);
  const second = await settings.addRemoteRelayFromForm();
  assert.equal(second.state, 'needs-token');
  assert.match(status.textContent, /did not accept that token either/);
  assert.equal(el('remote-relays-add-token-input').value, '');

  el('remote-relays-add-token-input').value = 'right-token';
  const added = { ...LINUX, id: 'rr-4', name: 'report-box', url: 'https://relay-d.example.test', host: 'relay-d.example.test' };
  addAnswers.push([200, { ok: true, relay: added, pairedBack: true }]);
  listPayload = { ...listPayload, relays: [...listPayload.relays, added] };
  const third = await settings.addRemoteRelayFromForm();
  await settle();
  assert.equal(third.state, 'paired');
  assert.equal(status.dataset.state, 'paired');
  assert.equal(status.textContent, 'Added report-box. It added this relay too.');
  const posts = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/remote-relays');
  assert.equal(posts[2].body.token, 'right-token');
  // The token never stays in the page; the form is ready for the next relay.
  assert.equal(el('remote-relays-add-token-input').value, '');
  assert.equal(el('remote-relays-add-token-row').hidden, true);
  assert.equal(el('remote-relays-add-url-input').value, '');
  assert.ok(row('rr-4'));
});

test('the add form reports a failed pair-back, a plain add, self and errors', async () => {
  await freshSection();
  const status = el('remote-relays-add-status');
  const url = el('remote-relays-add-url-input');

  url.value = 'https://relay-d.example.test';
  addAnswers.push([200, { ok: true, relay: { ...LINUX, id: 'rr-5', name: 'report-box' }, pairedBack: false, pairBackError: 'this relay has no public address yet' }]);
  await settings.addRemoteRelayFromForm();
  assert.equal(status.dataset.state, 'pair-failed');
  assert.equal(status.textContent, 'Added report-box, but adding this relay there failed: this relay has no public address yet');

  url.value = 'https://relay-d.example.test';
  el('remote-relays-pair-back-toggle').checked = false;
  addAnswers.push([200, { ok: true, relay: { ...LINUX, id: 'rr-5', name: 'report-box' }, pairedBack: false, warning: 'Plain http: the token crosses your network unencrypted.' }]);
  await settings.addRemoteRelayFromForm();
  assert.equal(status.dataset.state, 'added');
  assert.equal(status.textContent, 'Added report-box. Plain http: the token crosses your network unencrypted.');
  assert.equal(requests.filter((entry) => entry.path === '/api/remote-relays' && entry.method === 'POST').at(-1).body.pairBack, false);

  url.value = 'http://localhost:3333/';
  addAnswers.push([409, { ok: false, code: 'SELF', error: 'That is this relay' }]);
  await settings.addRemoteRelayFromForm();
  assert.equal(status.dataset.state, 'self');
  assert.match(status.textContent, /That address is this relay/);
  // A refused add keeps the address so it can be corrected.
  assert.equal(url.value, 'http://localhost:3333/');

  url.value = 'http://relay-b.example.test';
  addAnswers.push([400, { ok: false, code: 'INVALID_URL', error: 'Plain http is only allowed for loopback and private network addresses; use https://' }]);
  await settings.addRemoteRelayFromForm();
  assert.equal(status.dataset.state, 'error');
  assert.equal(status.textContent, 'Plain http is only allowed for loopback and private network addresses; use https://');
});

test('"Use a different token" reveals the token field before any failure', async () => {
  await freshSection();
  settings.showRemoteRelayTokenField();
  assert.equal(el('remote-relays-add-token-row').hidden, false);
  el('remote-relays-add-url-input').value = 'https://relay-d.example.test';
  el('remote-relays-add-token-input').value = 'other-token';
  addAnswers.push([200, { ok: true, relay: { ...LINUX, id: 'rr-6', name: 'report-box' }, pairedBack: true }]);
  await settings.addRemoteRelayFromForm();
  const post = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/remote-relays').at(-1);
  assert.equal(post.body.token, 'other-token');
  assert.equal(el('remote-relays-add-token-input').value, '');
});

test('the public address and the inbound switch save to the relay', async () => {
  await freshSection();
  await settings.saveRemoteRelayPublicUrl(' https://relay-a2.example.test ');
  const save = requests.find((entry) => entry.method === 'POST' && entry.path === '/api/settings/remote-relays');
  assert.deepEqual(save.body, { publicUrl: 'https://relay-a2.example.test' });
  assert.equal(el('remote-relays-self-status').dataset.state, 'active');
  assert.equal(el('remote-relays-public-url-input').value, 'https://relay-a2.example.test');

  await settings.toggleRemoteRelayInbound(false);
  const toggle = requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/settings/remote-relays').at(-1);
  assert.deepEqual(toggle.body, { inboundEnabled: false });
  assert.equal(el('remote-relays-inbound-toggle').checked, false);
});

test('a refused public address stays in the field with the reason, until the modal reopens', async () => {
  await freshSection();
  const input = el('remote-relays-public-url-input');
  input.value = 'ftp://relay-a.example.test';
  await settings.saveRemoteRelayPublicUrl(input.value);
  assert.equal(el('remote-relays-self-status').dataset.state, 'error');
  assert.match(el('remote-relays-self-status').textContent, /Only https:\/\//);
  assert.equal(input.value, 'ftp://relay-a.example.test');
  // A live list update does not wipe it either.
  store.setRemoteRelaysSnapshot({ relays: [LINUX], self: SELF });
  assert.equal(input.value, 'ftp://relay-a.example.test');
  await settings.refreshRemoteRelaysSection();
  assert.equal(input.value, 'https://relay-a.example.test');
  assert.equal(el('remote-relays-self-status').hidden, true);
});

test('a change made on another device arrives with the live list', async () => {
  await freshSection();
  store.setRemoteRelaysSnapshot({ relays: [LINUX, WIN], self: { ...SELF, publicUrl: 'https://relay-a3.example.test', inboundEnabled: false } });
  assert.equal(el('remote-relays-public-url-input').value, 'https://relay-a3.example.test');
  assert.equal(el('remote-relays-inbound-toggle').checked, false);
});

test('a relay without the endpoint shows a load error instead of a spinner', async () => {
  store.resetRemoteRelaysStoreForTests();
  settings.resetRemoteRelaysSettingsForTests();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => reply(404, { error: 'Not found' });
  try {
    await settings.refreshRemoteRelaysSection();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(el('remote-relays-status').dataset.state, 'error');
  assert.equal(el('remote-relays-empty').textContent, 'Could not load the remote relays.');
});

test('describeAddRemoteRelayResult covers every outcome', () => {
  const describe = settings.describeAddRemoteRelayResult;
  assert.equal(describe(null).state, 'error');
  assert.deepEqual(
    [describe({ ok: false, needsToken: true }).state, describe({ ok: false, needsToken: true }).showToken],
    ['needs-token', true],
  );
  assert.equal(describe({ ok: true, relay: { name: 'x' }, pairedBack: true }).state, 'paired');
  assert.equal(describe({ ok: true, relay: { name: 'x' }, pairedBack: false }).state, 'pair-failed');
  assert.match(describe({ ok: true, relay: { name: 'x' }, pairedBack: false }).text, /the other relay did not confirm/);
  assert.equal(describe({ ok: true, relay: { name: 'x' } }, { pairBack: false }).state, 'added');
  assert.equal(describe({ ok: false, code: 'SELF' }).state, 'self');
  assert.equal(describe({ ok: false, code: 'NETWORK', error: 'Failed to fetch' }).text, 'Failed to fetch');
  assert.equal(describe({ ok: true, updated: true, relay: { name: 'x' } }, { pairBack: false }).text, 'Updated x.');
});

test('browserSelfUrl offers the page address only when another relay could use it', () => {
  assert.equal(settings.browserSelfUrl({ origin: 'http://localhost:3333', hostname: 'localhost' }, ''), '');
  assert.equal(settings.browserSelfUrl({ origin: 'http://127.0.0.1:3333', hostname: '127.0.0.1' }, ''), '');
  assert.equal(settings.browserSelfUrl({ origin: 'http://[::1]:3333', hostname: '[::1]' }, ''), '');
  assert.equal(settings.browserSelfUrl({ origin: 'https://relay-a.example.test', hostname: 'relay-a.example.test' }, '/oar'), 'https://relay-a.example.test/oar');
  assert.equal(settings.browserSelfUrl({ origin: 'http://192.168.1.20:3333', hostname: '192.168.1.20' }, ''), 'http://192.168.1.20:3333');
});

test('formatRelativeTime', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(settings.formatRelativeTime(null, now), 'never');
  assert.equal(settings.formatRelativeTime('garbage', now), 'unknown');
  assert.equal(settings.formatRelativeTime(ago(10 * 1000), now), 'just now');
  assert.equal(settings.formatRelativeTime(ago(5 * MINUTE), now), '5 min ago');
  assert.equal(settings.formatRelativeTime(ago(3 * 60 * MINUTE), now), '3 h ago');
  assert.equal(settings.formatRelativeTime(ago(2 * 24 * 60 * MINUTE), now), '2 d ago');
});
