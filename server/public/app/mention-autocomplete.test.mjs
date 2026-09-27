import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// The popup builds real DOM nodes and reads caret positions, so it gets a real
// document; one JSDOM instance for the file since init binds document-level
// listeners once. The slash popup is there too: the two must never both open.
const dom = new JSDOM(`<!doctype html><html><body>
  <textarea id="msg-input"></textarea>
  <div id="slash-autocomplete-popup" aria-hidden="true" role="listbox"></div>
  <div id="mention-autocomplete-popup" aria-hidden="true" role="listbox"></div>
</body></html>`, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.Event = dom.window.Event;

// GET /api/remote-relays, answered from whatever a test puts here.
const fetchLog = [];
let relaysPayload = { relays: [], self: { name: 'win-test' } };
let releaseFetch = null;
globalThis.fetch = async (url) => {
  fetchLog.push(String(url));
  if (releaseFetch) await releaseFetch;
  if (String(url).endsWith('/api/remote-relays')) {
    return { ok: true, status: 200, json: async () => relaysPayload };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { setPreviews } = await import('./preview-cards.mjs');
const slash = await import('./slash-autocomplete.mjs');
const store = await import('./remote-relays-store.mjs');
const {
  closeMentionAutocomplete,
  handleMentionAutocompleteKey,
  initMentionAutocomplete,
  isMentionAutocompleteOpen,
  mentionCandidates,
  updateMentionAutocomplete,
} = await import('./mention-autocomplete.mjs');

slash.initSlashAutocomplete();
initMentionAutocomplete();

const input = document.getElementById('msg-input');
const popup = document.getElementById('mention-autocomplete-popup');
const slashPopup = document.getElementById('slash-autocomplete-popup');

const LINUX = {
  id: 'rr-1', relayId: 'relay-b', name: 'linux-test', url: 'https://relay-b.example.test', host: 'relay-b.example.test',
  permission: 'full', addedBy: 'user', lastStatus: 'online',
};
const WIN = {
  id: 'rr-2', relayId: 'relay-c', name: 'win-test-2', url: 'http://127.0.0.1:3351', host: '127.0.0.1',
  permission: 'read', addedBy: 'pairing', lastStatus: 'offline', lastError: 'connect ECONNREFUSED',
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The composer's own input pipeline: slash first, then mentions.
function composerUpdate() {
  slash.updateSlashAutocomplete(input, { conversationId: 'conv-1' });
  updateMentionAutocomplete(input);
}

function type(text, caret = text.length) {
  input.value = text;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  composerUpdate();
}

// The composer's handleKey order: slash menu first, then mentions.
function key(name, modifiers = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key: name, cancelable: true, ...modifiers });
  const handled = slash.handleSlashAutocompleteKey(event, input) || handleMentionAutocompleteKey(event, input);
  return { handled, defaultPrevented: event.defaultPrevented };
}

const rows = () => [...popup.querySelectorAll('.mention-item')];
const rowNames = () => rows().map((row) => row.querySelector('.slash-item-name').textContent);
const selectedRow = () => popup.querySelector('.slash-item-selected');

// Keep the Tab-accept's re-fired input event flowing through the pipeline,
// exactly as the textarea's inline oninput does in the app.
input.addEventListener('input', () => composerUpdate());

test.beforeEach(() => {
  setPreviews([]);
  slash.closeSlashAutocomplete();
  closeMentionAutocomplete();
  store.resetRemoteRelaysStoreForTests();
  store.setRemoteRelaysSnapshot({ relays: [LINUX, WIN], self: { name: 'win-test' } });
  input.value = '';
  input.focus();
});

test('"@" lists every remote relay with its dot, name and host', () => {
  type('@');
  assert.equal(isMentionAutocompleteOpen(), true);
  assert.equal(popup.classList.contains('visible'), true);
  assert.equal(popup.getAttribute('aria-hidden'), 'false');
  assert.deepEqual(rowNames(), ['linux-test', 'win-test-2']);
  const [first, second] = rows();
  assert.equal(first.getAttribute('role'), 'option');
  assert.equal(first.querySelector('.remote-relay-dot').dataset.status, 'online');
  assert.equal(second.querySelector('.remote-relay-dot').dataset.status, 'offline');
  assert.equal(first.querySelector('.slash-item-desc').textContent, 'relay-b.example.test');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(input.getAttribute('aria-controls'), 'mention-autocomplete-popup');
});

test('works at any token start, filtered by name or host prefix', () => {
  type('please ask @lin');
  assert.deepEqual(rowNames(), ['linux-test']);
  type('(@relay-b');
  assert.deepEqual(rowNames(), ['linux-test']);
  type('see @127');
  assert.deepEqual(rowNames(), ['win-test-2']);
  type('@WIN');
  assert.deepEqual(rowNames(), ['win-test-2']);
  // Mid-word "@" is an e-mail address, not a mention.
  type('mail me at dev@lin');
  assert.equal(isMentionAutocompleteOpen(), false);
});

test('closes when nothing matches, so @file: tokens are never disturbed', () => {
  type('look at @fi');
  assert.equal(isMentionAutocompleteOpen(), false);
  type('look at @file:');
  assert.equal(isMentionAutocompleteOpen(), false);
  type('look at @file:src/app.js');
  assert.equal(isMentionAutocompleteOpen(), false);
  for (const name of ['Tab', 'Enter', 'ArrowDown', 'Escape']) {
    assert.equal(key(name).handled, false, `${name} must pass through`);
  }
  assert.equal(input.value, 'look at @file:src/app.js');
});

test('Tab inserts "@name " for the top match and closes', () => {
  type('ask @li');
  const tab = key('Tab');
  assert.equal(tab.handled, true);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(input.value, 'ask @linux-test ');
  assert.equal(input.selectionStart, 'ask @linux-test '.length);
  assert.equal(isMentionAutocompleteOpen(), false);
});

test('a pick in the middle of a word replaces the whole word and reuses a following space', () => {
  type('ask @li now', 7);
  key('Tab');
  assert.equal(input.value, 'ask @linux-test now');
  assert.equal(input.selectionStart, 'ask @linux-test '.length);
  type('@linxx', 3);
  key('Tab');
  assert.equal(input.value, '@linux-test ');
});

test('plain Enter falls through until a row is arrow-selected; Ctrl+Enter never is consumed', () => {
  type('@');
  assert.equal(selectedRow(), null);
  assert.equal(key('Enter').handled, false);
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, 'win-test-2');
  assert.equal(input.getAttribute('aria-activedescendant'), selectedRow().id);
  assert.equal(key('Enter', { ctrlKey: true }).handled, false);
  assert.equal(key('Enter', { metaKey: true }).handled, false);
  const enter = key('Enter');
  assert.equal(enter.handled, true);
  assert.equal(input.value, '@win-test-2 ');
});

test('arrows wrap down and return to no selection going up', () => {
  type('@');
  key('ArrowDown');
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, 'linux-test');
  key('ArrowUp');
  assert.equal(selectedRow(), null);
  assert.equal(input.hasAttribute('aria-activedescendant'), false);
});

test('Escape closes and swallows the key', () => {
  type('@');
  const esc = key('Escape');
  assert.equal(esc.handled, true);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(isMentionAutocompleteOpen(), false);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(key('Escape').handled, false);
});

test('tapping a row inserts it', () => {
  type('hi @');
  rows()[1].dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(input.value, 'hi @win-test-2 ');
});

test('names render inertly', () => {
  store.setRemoteRelaysSnapshot({ relays: [{ ...LINUX, name: '<img src=x onerror=alert(1)>' }] });
  type('@');
  assert.equal(rowNames()[0], '<img src=x onerror=alert(1)>');
  assert.equal(popup.querySelector('img'), null);
});

test('hidden entirely when there are no remotes', () => {
  store.setRemoteRelaysSnapshot({ relays: [], self: { name: 'win-test' } });
  type('@');
  assert.equal(isMentionAutocompleteOpen(), false);
  assert.equal(popup.classList.contains('visible'), false);
  assert.equal(key('Tab').handled, false);
});

test('the slash menu and the mention popup are never open together', () => {
  type('/');
  assert.equal(slash.isSlashAutocompleteOpen(), true);
  assert.equal(isMentionAutocompleteOpen(), false);
  // Keys go to the slash menu.
  const tab = key('Tab');
  assert.equal(tab.handled, true);
  assert.equal(input.value, '/compact ');
  // A mention after a command the slash menu has nothing more for.
  type('/compact @li');
  assert.equal(slash.isSlashAutocompleteOpen(), false);
  assert.equal(isMentionAutocompleteOpen(), true);
  key('Tab');
  assert.equal(input.value, '/compact @linux-test ');
  // Going back to a bare "/" hands the keys to the slash menu again.
  type('@');
  assert.equal(isMentionAutocompleteOpen(), true);
  type('/');
  assert.equal(isMentionAutocompleteOpen(), false);
  assert.equal(slashPopup.classList.contains('visible'), true);
  assert.equal(popup.classList.contains('visible'), false);
});

test('a relay name shared by two relays inserts the host instead', () => {
  const twin = { ...WIN, name: 'linux-test', host: 'relay-c.example.test', url: 'https://relay-c.example.test' };
  const items = mentionCandidates([LINUX, twin], 'lin');
  assert.deepEqual(items.map((item) => item.insert), ['@relay-b.example.test', '@relay-c.example.test']);
  assert.deepEqual(mentionCandidates([LINUX], '').map((item) => item.insert), ['@linux-test']);
});

test('the first "@" loads the list lazily and opens once it arrives', async () => {
  store.resetRemoteRelaysStoreForTests();
  relaysPayload = { relays: [LINUX], self: { name: 'win-test' } };
  let release;
  releaseFetch = new Promise((resolve) => { release = resolve; });
  fetchLog.length = 0;
  try {
    type('@');
    assert.equal(isMentionAutocompleteOpen(), false);
    assert.deepEqual(fetchLog.filter((url) => url.endsWith('/api/remote-relays')).length, 1);
    // More typing while the request is in flight does not ask again.
    type('@l');
    assert.deepEqual(fetchLog.filter((url) => url.endsWith('/api/remote-relays')).length, 1);
    release();
    await settle();
    await settle();
    assert.equal(isMentionAutocompleteOpen(), true);
    assert.deepEqual(rowNames(), ['linux-test']);
  } finally {
    releaseFetch = null;
  }
});

test('a remote_relays_updated snapshot redraws the open popup', () => {
  type('@');
  assert.deepEqual(rowNames(), ['linux-test', 'win-test-2']);
  store.setRemoteRelaysSnapshot({ relays: [{ ...LINUX, lastStatus: 'offline' }] });
  assert.deepEqual(rowNames(), ['linux-test']);
  assert.equal(rows()[0].querySelector('.remote-relay-dot').dataset.status, 'offline');
  store.setRemoteRelaysSnapshot({ relays: [] });
  assert.equal(isMentionAutocompleteOpen(), false);
});

test('a stale caret never overwrites unrelated text', () => {
  type('ask @li');
  // The caret moved away without an input event (a click elsewhere).
  input.value = 'ask @li and more';
  input.selectionStart = input.selectionEnd = input.value.length;
  key('Tab');
  assert.equal(input.value, 'ask @li and more');
  assert.equal(isMentionAutocompleteOpen(), false);
});
