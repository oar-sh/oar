import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stand-in (same pattern as background-tasks-view.test.mjs): the
// header button, the summary modal's parts and the toast, by id; the bubbles
// of the transcript, by what the tests put on the page.
class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const name of names) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : !!force;
    if (on) this.names.add(name); else this.names.delete(name);
    return on;
  }
  contains(name) { return this.names.has(name); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.children = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  querySelector(selector) { return this.children[selector] || null; }
  querySelectorAll() { return []; }
  remove() {}
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
}
const headerButton = el('hidden-messages-btn');
headerButton.hidden = true;
headerButton.children['.header-icon-count'] = new FakeElement();
const countEl = headerButton.children['.header-icon-count'];

// What is "on the page": message ids with a bubble.
const page = { bubbles: new Set() };

globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0, style: { setProperty() {} } },
  addEventListener() {},
  getElementById: (id) => el(id),
  createElement: () => new FakeElement(),
  querySelector(selector) {
    const bubble = selector.match(/^#messages \.msg\[data-message-id="(.+)"\]$/);
    if (bubble) return page.bubbles.has(bubble[1]) ? new FakeElement() : null;
    if (selector === '#messages .msg[data-message-id]') return page.bubbles.size ? new FakeElement() : null;
    return null;
  },
};
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };
globalThis.CSS = { escape: (value) => String(value) };
globalThis.Element = FakeElement;
// The toast hides itself on a timer; a real one would outlive the tests.
globalThis.setTimeout = () => 0;

let fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({}) });
const fetchCalls = [];
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
  return fetchHandler(url, options);
};

const { summaryModalState, closeSummaryModal } = await import('./store.js');
const { initPinnedMessagesView, setPinsConversation } = await import('./pinned-messages-view.mjs');
const {
  HIDDEN_MESSAGES_MODAL_KIND,
  getConversationHiddenMessages,
  hiddenCountLabel,
  initHiddenMessagesView,
  isMessageHiddenFromShares,
  openHiddenMessagesModal,
  renderHiddenListHtml,
  setConversationHiddenMessages,
  setHiddenMessagesConversation,
  unhideAllHiddenMessages,
} = await import('./hidden-messages-view.mjs');

const syncedHiddenSets = [];
const focusCalls = [];
const openCalls = [];
// The jump is the pin list's: its handlers are the page's.
initPinnedMessagesView({
  openConversation: async (id, options) => { openCalls.push({ id, options }); },
  focusMessage: (id) => { focusCalls.push(id); return true; },
  syncRenderedPinState: () => {},
});
initHiddenMessagesView({
  syncRenderedShareVisibility: (ids) => { syncedHiddenSets.push([...ids].sort()); },
});

function hidden(messageId, overrides = {}) {
  return {
    messageId,
    role: 'assistant',
    preview: `preview of ${messageId}`,
    timestamp: '2026-10-16T10:00:00.000Z',
    hiddenAt: '2026-10-16T11:00:00.000Z',
    attachmentCount: 0,
    ...overrides,
  };
}

function openConversation(id) {
  setPinsConversation(id);
  setHiddenMessagesConversation(id);
}

function resetPage() {
  page.bubbles.clear();
  fetchCalls.length = 0;
  syncedHiddenSets.length = 0;
  focusCalls.length = 0;
  openCalls.length = 0;
  closeSummaryModal();
  el('relay-toast').textContent = '';
}

function json(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function clickInModal(attribute, value = '1') {
  const target = new FakeElement();
  target.closest = (selector) => (selector === `[${attribute}]` ? target : null);
  target.setAttribute(attribute, value);
  for (const handler of el('summary-modal-body').listeners.click || []) {
    handler({ target, preventDefault() {} });
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the list shows role, attachments and preview, an Unhide per row and Unhide all above', () => {
  const html = renderHiddenListHtml([
    hidden('msg-1', { role: 'user', preview: 'The staging token is in the vault.', attachmentCount: 2 }),
    hidden('msg-2', { preview: '<b>x</b> & y' }),
  ]);

  assert.ok(html.indexOf('data-hidden-unhide-all="1"') < html.indexOf('data-hidden-jump="msg-1"'));
  assert.ok(html.indexOf('data-hidden-jump="msg-1"') < html.indexOf('data-hidden-jump="msg-2"'));
  assert.match(html, /<span class="pinned-row-meta">You · [^<]*📎 2<\/span>/);
  assert.match(html, /class="hidden-row-unhide" data-hidden-unhide="msg-2"[^>]*>Unhide<\/button>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
  assert.doesNotMatch(html, /<b>x/);
});

test('an empty list says so and offers no Unhide all', () => {
  const html = renderHiddenListHtml([]);
  assert.match(html, /No hidden messages\./);
  assert.doesNotMatch(html, /data-hidden-unhide-all/);
  assert.equal(hiddenCountLabel(0), '');
  assert.equal(hiddenCountLabel(2), '2 hidden from shared viewers');
});

test('the header button shows only with hidden messages, and carries their count', () => {
  resetPage();
  openConversation('conv-a');
  assert.equal(headerButton.hidden, true);
  assert.equal(isMessageHiddenFromShares('conv-a', 'msg-1'), null, 'not known before the list arrives');

  setConversationHiddenMessages('conv-a', [hidden('msg-1'), hidden('msg-2')]);
  assert.equal(headerButton.hidden, false);
  assert.equal(countEl.textContent, '2');
  assert.equal(headerButton.getAttribute('aria-label'), 'Hidden from shared viewers (2)');
  assert.deepEqual(syncedHiddenSets.at(-1), ['msg-1', 'msg-2']);
  assert.equal(isMessageHiddenFromShares('conv-a', 'msg-2'), true);
  assert.equal(isMessageHiddenFromShares('conv-a', 'msg-9'), false);

  setConversationHiddenMessages('conv-a', []);
  assert.equal(headerButton.hidden, true);
  assert.equal(countEl.textContent, '');
  assert.deepEqual(syncedHiddenSets.at(-1), []);
  assert.equal(isMessageHiddenFromShares('conv-a', 'msg-1'), false, 'an empty list is known too');
});

test('lists are kept per conversation, and an older one never replaces a newer one', () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1')], 1700000000500);
  syncedHiddenSets.length = 0;

  setConversationHiddenMessages('conv-b', [hidden('other-1'), hidden('other-2')]);
  assert.equal(countEl.textContent, '1');
  assert.equal(syncedHiddenSets.length, 0, 'the open transcript was not touched');

  // A load that left before the change arrives after the change's own event.
  setConversationHiddenMessages('conv-a', [], 1700000000100);
  assert.equal(countEl.textContent, '1');
  setConversationHiddenMessages('conv-a', [], 1700000000900);
  assert.equal(headerButton.hidden, true);

  openConversation('conv-b');
  assert.equal(countEl.textContent, '2');
});

test('an unchanged list does not redraw the open modal (it arrives with every poll)', () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1')]);
  openHiddenMessagesModal();
  assert.equal(summaryModalState.kind, HIDDEN_MESSAGES_MODAL_KIND);
  assert.equal(el('summary-modal-title').textContent, '🙈 Hidden messages');
  assert.equal(el('summary-modal-subtitle').textContent, '1 hidden from shared viewers');

  el('summary-modal-body').innerHTML = 'untouched';
  setConversationHiddenMessages('conv-a', [hidden('msg-1')]);
  assert.equal(el('summary-modal-body').innerHTML, 'untouched');

  setConversationHiddenMessages('conv-a', [hidden('msg-1'), hidden('msg-2')]);
  assert.match(el('summary-modal-body').innerHTML, /data-hidden-jump="msg-2"/);
});

test('Unhide in a row sends the change and applies the answer; the list stays open', async () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1'), hidden('msg-2')]);
  openHiddenMessagesModal();
  let bodyWhileInFlight = '';
  fetchHandler = async () => {
    bodyWhileInFlight = el('summary-modal-body').innerHTML;
    return json(200, { ok: true, hiddenFromShares: false, hiddenMessages: [hidden('msg-2')], hiddenMessagesRevision: 1800000000000 })();
  };

  clickInModal('data-hidden-unhide', 'msg-1');
  await settle();

  assert.match(fetchCalls[0].url, /\/api\/conversation\/conv-a\/message\/msg-1\/share-visibility$/);
  assert.equal(fetchCalls[0].method, 'PATCH');
  assert.deepEqual(fetchCalls[0].body, { hiddenFromShares: false });
  assert.match(bodyWhileInFlight, /data-hidden-unhide="msg-1"[^>]* disabled>Unhiding…/);
  assert.doesNotMatch(el('summary-modal-body').innerHTML, /data-hidden-jump="msg-1"/);
  assert.equal(summaryModalState.kind, HIDDEN_MESSAGES_MODAL_KIND);
  assert.equal(countEl.textContent, '1');
  assert.equal(el('relay-toast').textContent, 'Message visible to shared viewers.');
});

test('a refused Unhide keeps the row and shows the relay\'s reason', async () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1')]);
  openHiddenMessagesModal();
  fetchHandler = json(409, { error: 'Message visibility can only change after the turn finishes' });

  clickInModal('data-hidden-unhide', 'msg-1');
  await settle();

  assert.match(el('summary-modal-body').innerHTML, /data-hidden-unhide="msg-1"[^>]*>Unhide<\/button>/);
  assert.equal(countEl.textContent, '1');
  assert.equal(el('relay-toast').textContent, 'Message visibility can only change after the turn finishes');
});

test('Unhide all asks first; Cancel goes back to the list without a request', () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1'), hidden('msg-2')]);
  openHiddenMessagesModal();

  clickInModal('data-hidden-unhide-all');
  assert.match(el('summary-modal-body').innerHTML, /Show all 2 messages to shared viewers again\?/);
  assert.match(el('summary-modal-body').innerHTML, /data-hidden-unhide-all-confirm/);

  clickInModal('data-hidden-unhide-all-cancel');
  assert.doesNotMatch(el('summary-modal-body').innerHTML, /data-hidden-unhide-all-confirm/);
  assert.equal(fetchCalls.length, 0);
});

test('Unhide all confirmed: one request, the list empties, the button goes', async () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1'), hidden('msg-2')]);
  openHiddenMessagesModal();
  fetchHandler = json(200, { ok: true, unhidden: ['msg-1', 'msg-2'], skipped: [], hiddenMessages: [], hiddenMessagesRevision: 1900000000000 });

  clickInModal('data-hidden-unhide-all');
  clickInModal('data-hidden-unhide-all-confirm');
  await settle();

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/conversation\/conv-a\/share-visibility\/unhide-all$/);
  assert.equal(fetchCalls[0].method, 'POST');
  assert.equal(headerButton.hidden, true);
  assert.match(el('summary-modal-body').innerHTML, /No hidden messages\./);
  assert.equal(el('relay-toast').textContent, '2 messages visible to shared viewers.');
});

test('Unhide all with a running turn unhides the rest and names the one that stayed', async () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [
    hidden('msg-1'),
    hidden('msg-2', { preview: 'Deploying the report builder now' }),
  ]);
  fetchHandler = json(200, {
    ok: true,
    unhidden: ['msg-1'],
    skipped: [{ messageId: 'msg-2', reason: 'active-turn' }],
    hiddenMessages: [hidden('msg-2', { preview: 'Deploying the report builder now' })],
    hiddenMessagesRevision: 2000000000000,
  });

  await unhideAllHiddenMessages('conv-a');

  assert.equal(countEl.textContent, '1');
  assert.deepEqual(getConversationHiddenMessages('conv-a').map((item) => item.messageId), ['msg-2']);
  assert.equal(el('relay-toast').textContent, '1 message unhidden. Still hidden until its turn finishes: “Deploying the report builder now”.');
});

test('a row jumps like a pin row: the list closes and the page scrolls there', async () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1')]);
  openHiddenMessagesModal();

  clickInModal('data-hidden-jump', 'msg-1');
  await settle();

  assert.equal(summaryModalState.kind, '');
  assert.deepEqual(focusCalls, ['msg-1']);
});

test('a click in another modal\'s body is none of this module\'s business', () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1')]);
  summaryModalState.kind = 'pinned-messages';

  clickInModal('data-hidden-unhide', 'msg-1');
  clickInModal('data-hidden-unhide-all-confirm');

  assert.equal(fetchCalls.length, 0);
  summaryModalState.kind = '';
});

test('closing the conversation closes its list and hides the button', () => {
  resetPage();
  openConversation('conv-a');
  setConversationHiddenMessages('conv-a', [hidden('msg-1')]);
  openHiddenMessagesModal();

  openConversation(null);

  assert.equal(summaryModalState.kind, '');
  assert.equal(headerButton.hidden, true);
  assert.equal(getConversationHiddenMessages('conv-a').length, 1, 'kept for when it is opened again');
});
