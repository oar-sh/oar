import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The image turn's placeholder in the live bubble and the composer's image
// options on a real DOM: the app's index.html in JSDOM (scripts not run),
// conversation-view.js and the image modules imported on top.

const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer?.unref?.();
  return timer;
};

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLDetailsElement = window.HTMLDetailsElement;
globalThis.NodeFilter = window.NodeFilter;
globalThis.MutationObserver = window.MutationObserver;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.Event = window.Event;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

const fetchLog = [];
// The live bubble asks for the turn's boards; nothing else is expected.
let fetchHandler = async (url) => {
  if (url.includes('/api/relay-boards')) return { boards: [] };
  throw new Error(`unexpected fetch: ${url}`);
};
globalThis.fetch = async (url, opts = {}) => {
  const entry = { url: String(url), method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  fetchLog.push(entry);
  const payload = await fetchHandler(entry.url, entry);
  return { ok: true, status: 200, json: async () => payload };
};

const store = await import('./store.js');
const view = await import('./conversation-view.js');
const placeholder = await import('./image-turn-placeholder.mjs');
const composer = await import('./image-composer-ui.js');
const { CHAT_MEDIA_SELECTOR } = await import('./viewer-chat-gallery.mjs');
const { IMAGE_COMPOSER_STORAGE_KEY } = await import('./openai-image-composer.mjs');
const { conversations, setCurrentConv } = store;

const messagesEl = document.getElementById('messages');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const el = (id) => document.getElementById(id);

let seq = 0;
function openImageConversation(model = 'gpt-image-2') {
  seq += 1;
  const id = `conv-img-${seq}`;
  conversations[id] = { id, title: 'Pictures', runtimeProviderType: 'openai', runtimeProviderModel: model, preferredModel: model };
  setCurrentConv(id);
  return id;
}

function resetView() {
  view.removeThinking();
  messagesEl.innerHTML = '';
  fetchLog.length = 0;
  localStorage.clear();
}

const node = () => document.querySelector('[data-image-placeholder]');
const previews = () => [...document.querySelectorAll('[data-image-placeholder] img[data-image-placeholder-preview]')];

test('image_started puts a placeholder with timer, size, quality and model into the live bubble', () => {
  resetView();
  const conv = openImageConversation();
  view.renderMessages([{ id: 'u1', role: 'user', text: 'a lighthouse', timestamp: new Date().toISOString() }], false, { conversationId: conv });
  view.showThinking('u1', false);
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  placeholder.handleImageStarted({
    conversationId: conv, messageId: 'u1', attempt: 1, size: '1536x1024', quality: 'high', count: 1, model: 'gpt-image-2', startedAt,
  });
  const shown = node();
  assert.ok(shown, 'the placeholder is up');
  assert.equal(shown.dataset.messageId, 'u1');
  assert.ok(shown.closest('#thinking-indicator'), 'inside the live bubble');
  assert.match(shown.querySelector('[data-image-placeholder-timer]').textContent, /^1:0[5-6]$/);
  assert.equal(shown.querySelector('[data-image-placeholder-details]').textContent, '1536x1024 · high · gpt-image-2');
  const tile = shown.querySelector('.image-turn-placeholder-tile');
  assert.equal(tile.style.aspectRatio, '1536 / 1024', 'the image area is reserved by the size');
  assert.equal(previews().length, 0);
});

test('previews show the newest partial per image, retry drops them, done removes the placeholder', () => {
  resetView();
  const conv = openImageConversation();
  view.renderMessages([{ id: 'u2', role: 'user', text: 'two cats', timestamp: new Date().toISOString() }], false, { conversationId: conv });
  view.showThinking('u2', false);
  const base = { conversationId: conv, messageId: 'u2', attempt: 1 };
  placeholder.handleImageStarted({ ...base, size: '1024x1024', quality: 'low', count: 2, model: 'gpt-image-2', startedAt: new Date().toISOString() });
  assert.equal(document.querySelectorAll('[data-image-placeholder] .image-turn-placeholder-tile').length, 2, 'a grid for two');
  assert.equal(node().querySelector('[data-image-placeholder-details]').textContent, '1024x1024 · low · 2 images · gpt-image-2');

  placeholder.handleImagePreview({ ...base, imageIndex: 0, partialIndex: 0, contentUrl: '/api/files/a-0.png', mime: 'image/png' });
  placeholder.handleImagePreview({ ...base, imageIndex: 0, partialIndex: 1, contentUrl: '/api/files/a-1.png', mime: 'image/png' });
  placeholder.handleImagePreview({ ...base, imageIndex: 1, partialIndex: 0, contentUrl: '/api/files/b-0.png', mime: 'image/png' });
  assert.deepEqual(previews().map((img) => [img.dataset.imageIndex, img.getAttribute('src')]), [
    ['0', '/api/files/a-1.png'],
    ['1', '/api/files/b-0.png'],
  ]);
  // Not a chat medium: the gallery and the click-to-open read `.msg-bubble img`.
  assert.equal(messagesEl.querySelectorAll(CHAT_MEDIA_SELECTOR).length, 0);

  // Events of another conversation do nothing here.
  placeholder.handleImagePreview({ conversationId: 'conv-elsewhere', messageId: 'u2', attempt: 1, imageIndex: 0, partialIndex: 2, contentUrl: '/api/files/x.png' });
  assert.equal(previews()[0].getAttribute('src'), '/api/files/a-1.png');

  placeholder.handleImagePreviewReset({ ...base, reason: 'retry' });
  assert.equal(previews().length, 0, 'the first try\'s partials go');
  assert.equal(node().querySelector('[data-image-placeholder-retry]').hidden, false, 'trying again');
  assert.ok(node(), 'the timer placeholder stays');

  placeholder.handleImageStarted({ ...base, attempt: 2, size: '1024x1024', quality: 'low', count: 2, model: 'gpt-image-2' });
  placeholder.handleImagePreview({ ...base, attempt: 2, imageIndex: 0, partialIndex: 0, contentUrl: '/api/files/c-0.png' });
  assert.equal(previews().length, 1);
  assert.equal(node().querySelector('[data-image-placeholder-retry]').hidden, true);
  assert.equal(node().dataset.attempt, '2');

  placeholder.handleImagePreviewReset({ ...base, attempt: 2, reason: 'done' });
  assert.equal(node(), null, 'done: the final message renders as usual');
  assert.ok(document.getElementById('thinking-indicator'), 'the live bubble itself is left to the turn status');
});

test('failed removes the placeholder, and so does the end of the turn', () => {
  resetView();
  const conv = openImageConversation();
  view.showThinking('u3', false);
  const base = { conversationId: conv, messageId: 'u3', attempt: 1 };
  placeholder.handleImageStarted({ ...base, size: 'auto', quality: 'auto', count: 1, model: 'gpt-image-2' });
  assert.ok(node());
  placeholder.handleImagePreviewReset({ ...base, reason: 'failed' });
  assert.equal(node(), null);

  placeholder.handleImageStarted({ ...base, size: 'auto', quality: 'auto', count: 1, model: 'gpt-image-2' });
  assert.ok(node());
  view.removeThinking();
  assert.equal(node(), null);
  assert.equal(placeholder.imageTurnPlaceholderState(), null);
});

test('a placeholder for a conversation that is not open is never drawn', () => {
  resetView();
  const conv = openImageConversation();
  view.showThinking('u4', false);
  placeholder.handleImageStarted({ conversationId: `${conv}-other`, messageId: 'u4', attempt: 1, size: 'auto', model: 'gpt-image-2' });
  assert.equal(node(), null);
  assert.equal(placeholder.imageTurnPlaceholderState(), null);
});

test('the live bubble rebuilt (or shown late) takes the placeholder back', () => {
  resetView();
  const conv = openImageConversation();
  placeholder.handleImageStarted({ conversationId: conv, messageId: 'u5', attempt: 1, size: '1024x1536', quality: 'medium', count: 1, model: 'gpt-image-2' });
  assert.equal(node(), null, 'no bubble yet');
  view.showThinking('u5', false);
  assert.ok(node(), 'drawn with the bubble');
  placeholder.handleImagePreview({ conversationId: conv, messageId: 'u5', attempt: 1, imageIndex: 0, partialIndex: 0, contentUrl: '/api/files/p.png' });
  document.getElementById('thinking-indicator').remove();
  view.showThinking('u5', false);
  assert.equal(previews()[0]?.getAttribute('src'), '/api/files/p.png');
});

test('a running image turn seen on load gets a placeholder timed from the turn\'s own start', () => {
  resetView();
  const conv = openImageConversation('gpt-image-2');
  const processingAt = new Date(Date.now() - 125_000).toISOString();
  view.restoreInFlightThinking({ messageId: 'u6', status: 'processing', processingAt, timestamp: processingAt, activities: [], thoughts: [] }, false);
  const shown = node();
  assert.ok(shown);
  assert.equal(shown.dataset.messageId, 'u6');
  assert.match(shown.querySelector('[data-image-placeholder-timer]').textContent, /^2:0[5-6]$/);
  assert.equal(shown.querySelector('[data-image-placeholder-details]').textContent, 'gpt-image-2');

  // An `image` block in the snapshot fills in size, quality and partials.
  resetView();
  const conv2 = openImageConversation('gpt-image-2');
  view.restoreInFlightThinking({
    messageId: 'u7',
    status: 'processing',
    processingAt,
    activities: [],
    thoughts: [],
    image: {
      size: '1536x1024', quality: 'high', count: 1, model: 'gpt-image-2', attempt: 1, startedAt: processingAt,
      previews: [{ imageIndex: 0, partialIndex: 1, contentUrl: '/api/files/q.png' }],
    },
  }, false);
  assert.equal(node().querySelector('[data-image-placeholder-details]').textContent, '1536x1024 · high · gpt-image-2');
  assert.equal(previews()[0].getAttribute('src'), '/api/files/q.png');
  assert.ok(conv2 !== conv);

  // A text model's turn gets none.
  resetView();
  seq += 1;
  conversations[`conv-text-${seq}`] = { id: `conv-text-${seq}`, runtimeProviderModel: 'gpt-5' };
  setCurrentConv(`conv-text-${seq}`);
  view.restoreInFlightThinking({ messageId: 'u8', status: 'processing', processingAt, activities: [], thoughts: [] }, false);
  assert.ok(document.getElementById('thinking-indicator'));
  assert.equal(node(), null);
});

// ---------------------------------------------------------------------------
// Composer: Size with Custom…, Count, Format, Background, and the send body.
// ---------------------------------------------------------------------------

function selectModel(model, effort = 'high') {
  const set = (id, value) => {
    const select = el(id);
    select.innerHTML = `<option value="${value}">${value}</option>`;
    select.value = value;
  };
  set('model-select', model);
  set('reasoning-effort-select', effort);
  set('mode-select', 'agent');
}

test('gpt-image: Size gets Custom…, Count 1..4, Format and Background', () => {
  resetView();
  const conv = openImageConversation();
  composer.syncImageComposerControls('gpt-image-2', conv);
  const sizes = [...el('context-tier-select').options].map((option) => option.value);
  assert.deepEqual(sizes, ['auto', '1024x1024', '1536x1024', '1024x1536', '__custom__']);
  assert.equal(el('context-tier-select').value, 'auto');
  assert.deepEqual([...el('image-count-select').options].map((option) => option.value), ['1', '2', '3', '4']);
  assert.deepEqual([...el('image-format-select').options].map((option) => option.value), ['png', 'webp', 'jpeg']);
  assert.deepEqual([...el('image-background-select').options].map((option) => option.value), ['auto', 'transparent', 'opaque']);
  assert.equal(el('image-options-row').hidden, false);
  assert.equal(el('image-size-custom-row').hidden, true);

  // JPEG has no transparency.
  el('image-background-select').value = 'transparent';
  el('image-format-select').value = 'jpeg';
  el('image-format-select').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(el('image-background-select').value, 'auto');
  assert.equal(el('image-background-select').querySelector('option[value="transparent"]').disabled, true);
});

test('dall-e-3 keeps its fixed sizes, no Custom…, no Count, no Format', () => {
  resetView();
  const conv = openImageConversation('dall-e-3');
  composer.syncImageComposerControls('dall-e-3', conv);
  assert.deepEqual([...el('context-tier-select').options].map((option) => option.value), ['1024x1024', '1792x1024', '1024x1792']);
  assert.equal(el('context-tier-select').value, '1024x1024');
  assert.equal(el('image-options-row').hidden, true);
  composer.hideImageComposerControls();
});

test('Custom… validates W×H live and keeps the size per conversation', () => {
  resetView();
  const conv = openImageConversation();
  composer.syncImageComposerControls('gpt-image-2', conv);
  const select = el('context-tier-select');
  const input = el('image-size-custom-input');
  const error = el('image-size-custom-error');
  select.value = '__custom__';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(el('image-size-custom-row').hidden, false);
  assert.equal(error.hidden, false, 'asks for a size');

  input.value = '2050x1152';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(select.value, '__custom__', 'nothing valid to send yet');
  assert.match(error.textContent, /multiples of 16/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');

  input.value = '2048x1152';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(select.value, '2048x1152');
  assert.equal(error.hidden, true);
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(JSON.parse(localStorage.getItem(IMAGE_COMPOSER_STORAGE_KEY))[conv].size, '2048x1152');

  el('image-count-select').value = '3';
  el('image-count-select').dispatchEvent(new window.Event('change', { bubbles: true }));

  // Another conversation starts from its own (none: the defaults) …
  const other = openImageConversation();
  composer.syncImageComposerControls('gpt-image-2', other);
  assert.equal(select.value, 'auto');
  assert.equal(el('image-count-select').value, '1');
  // … and coming back restores this one's.
  setCurrentConv(conv);
  composer.syncImageComposerControls('gpt-image-2', conv);
  assert.equal(select.value, '2048x1152');
  assert.equal(el('image-count-select').value, '3');
  assert.equal(el('image-size-custom-row').hidden, false);
});

test('the send carries the image options; an invalid custom size sends nothing', async () => {
  resetView();
  const conv = openImageConversation();
  selectModel('gpt-image-2', 'high');
  composer.syncImageComposerControls('gpt-image-2', conv);
  el('context-tier-select').value = '1536x1024';
  el('image-count-select').value = '2';
  el('image-format-select').value = 'webp';
  el('image-background-select').value = 'opaque';
  fetchHandler = async (url, { method }) => {
    if (method === 'GET' && url.includes(`/api/conversation/${conv}?`)) {
      return { sdkSessionId: 'sess-img', runtimeSession: { sdkSessionId: 'sess-img', id: 'rt-img' }, title: 'Pictures' };
    }
    if (method === 'POST' && url.endsWith('/api/message')) return { conversationId: conv, messageId: 'm-sent' };
    if (url.includes(`/api/conversation/${conv}/draft`)) return { ok: true, draftText: '' };
    return {};
  };
  el('msg-input').value = 'a red kite';
  await view.sendMessage();
  await settle();
  const post = fetchLog.find((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message'));
  assert.ok(post, 'sent');
  assert.equal(post.body.model, 'gpt-image-2');
  assert.equal(post.body.reasoningEffort, 'high');
  assert.equal(post.body.contextTier, '1536x1024');
  assert.deepEqual(post.body.image, { size: '1536x1024', quality: 'high', count: 2, output_format: 'webp', background: 'opaque' });

  // Custom… with nothing valid typed: refused before any request.
  fetchLog.length = 0;
  el('context-tier-select').value = '__custom__';
  el('image-size-custom-input').value = '99x99';
  el('msg-input').value = 'another kite';
  await view.sendMessage();
  await settle();
  assert.equal(fetchLog.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message')).length, 0);
  assert.equal(el('image-size-custom-row').hidden, false);
  assert.equal(el('image-size-custom-error').hidden, false);
  assert.equal(el('msg-input').value, 'another kite', 'the draft stays');
});
