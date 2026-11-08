import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The image presets in the composer, the image cap section of Settings →
// Providers → OpenAI, the image chat's banner and the chat menu's cost line,
// on the app's index.html in JSDOM (scripts not run).

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
globalThis.MutationObserver = window.MutationObserver;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.Event = window.Event;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

let prompts = [];
let confirms = [];
globalThis.prompt = (text, value) => { prompts.push({ text, value }); return prompts.answer ?? null; };
globalThis.confirm = (text) => { confirms.push(text); return confirms.answer ?? true; };

const fetchLog = [];
let fetchHandler = async () => ({ status: 404, body: { error: 'not here' } });
globalThis.fetch = async (url, opts = {}) => {
  const entry = { url: String(url), method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  fetchLog.push(entry);
  const { status = 200, body = {} } = (await fetchHandler(entry)) || {};
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const store = await import('./store.js');
const composer = await import('./image-composer-ui.js');
const cost = await import('./openai-image-cost-ui.js');
const { buildImageSendOptions } = await import('./openai-image-composer.mjs');
const { OPENAI_IMAGE_BUILTIN_PRESETS } = await import('./openai-image-spend.mjs');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const el = (id) => document.getElementById(id);
const BUILT_INS = OPENAI_IMAGE_BUILTIN_PRESETS.map((preset) => ({ ...preset, builtIn: true }));
const OWN = { name: 'Night', size: '2048x1152', quality: 'high', count: 2, builtIn: false };

function setEfforts(values, value) {
  const select = el('reasoning-effort-select');
  select.innerHTML = values.map((entry) => `<option value="${entry}">${entry}</option>`).join('');
  select.value = value;
}

let seq = 0;
function reset() {
  cost.__resetOpenAIImageCostUiForTests();
  localStorage.clear();
  fetchLog.length = 0;
  prompts = [];
  confirms = [];
  seq += 1;
  const id = `conv-img-${seq}`;
  store.setCurrentConv(id);
  return id;
}

test('the composer lists the presets; a pick fills the selects and the send names it', async () => {
  const conv = reset();
  fetchHandler = async ({ url }) => (url.endsWith('/api/openai-image-presets') ? { body: { presets: [...BUILT_INS, OWN] } } : { status: 404 });
  setEfforts(['auto', 'low', 'medium', 'high'], 'auto');
  composer.syncImageComposerControls('gpt-image-2', conv);
  assert.equal(el('image-preset-field').hidden, false);
  await settle();
  await settle();
  const names = [...el('image-preset-select').options].map((option) => option.value);
  assert.deepEqual(names, ['', ...BUILT_INS.map((preset) => preset.name), 'Night']);

  el('image-preset-select').value = 'Wallpaper 4K';
  el('image-preset-select').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(el('context-tier-select').value, '3840x2160');
  assert.equal(el('reasoning-effort-select').value, 'high');
  assert.match(el('image-preset-note').textContent, /^Wallpaper 4K: 3840x2160 · high$/);

  // A field changed afterwards stays explicit; the preset still goes along.
  el('image-count-select').value = '3';
  const input = composer.readImageComposerSendInput();
  assert.equal(input.preset, 'Wallpaper 4K');
  const built = buildImageSendOptions({ model: 'gpt-image-2', ...input });
  assert.deepEqual(built.image, { size: '3840x2160', quality: 'high', count: 3, output_format: 'png', background: 'auto', preset: 'Wallpaper 4K' });

  // The pick is the conversation's: another chat starts at None, this one gets it back.
  composer.syncImageComposerControls('gpt-image-2', 'conv-other');
  assert.equal(el('image-preset-select').value, '');
  composer.syncImageComposerControls('gpt-image-2', conv);
  assert.equal(el('image-preset-select').value, 'Wallpaper 4K');

  composer.hideImageComposerControls();
  assert.equal(el('image-preset-field').hidden, true);
  assert.equal(composer.readImageComposerSendInput().preset, '');
});

test('a preset the model cannot take says what it skipped', async () => {
  const conv = reset();
  fetchHandler = async () => ({ status: 404 });
  setEfforts(['auto', 'standard', 'hd'], 'hd');
  composer.syncImageComposerControls('dall-e-3', conv);
  await settle();
  el('image-preset-select').value = 'Photo landscape';
  el('image-preset-select').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(el('reasoning-effort-select').value, 'hd');
  assert.match(el('image-preset-note').textContent, /^Not for dall-e-3: size 1536x1024, quality medium\./);
});

test('Save as preset: a name asked for, a replace asked before, refusals inline', async () => {
  const conv = reset();
  const puts = [];
  let refuseFirst = false;
  fetchHandler = async ({ url, method, body }) => {
    if (!url.endsWith('/api/openai-image-presets')) return { status: 404 };
    if (method === 'GET') return { body: { presets: [...BUILT_INS, OWN] } };
    puts.push(body);
    if (refuseFirst && !body.replace) {
      return { status: 400, body: { error: `a preset "${body.preset.name}" exists; save with replace to change it`, code: 'OPENAI_IMAGE_PRESET_REFUSED' } };
    }
    return { body: { presets: [...BUILT_INS, OWN, { ...body.preset, builtIn: false }] } };
  };
  setEfforts(['auto', 'low', 'medium', 'high'], 'medium');
  composer.syncImageComposerControls('gpt-image-2', conv);
  await settle();
  await settle();
  el('context-tier-select').value = '1536x1024';

  prompts.answer = '  Wide   one ';
  await composer.saveImageComposerPreset();
  assert.deepEqual(puts.at(-1), { preset: { name: 'Wide one', size: '1536x1024', quality: 'medium', count: 1, output_format: 'png', background: 'auto' } });
  assert.equal(el('image-preset-select').value, 'Wide one');
  assert.equal(el('image-preset-note').textContent, 'Saved as preset "Wide one".');
  assert.equal(confirms.length, 0);

  // An own name known here: asked first, saved with replace.
  prompts.answer = 'night';
  await composer.saveImageComposerPreset();
  assert.equal(confirms.length, 1);
  assert.equal(puts.at(-1).replace, true);

  // Saved elsewhere in the meantime: the relay's refusal asks once more.
  refuseFirst = true;
  prompts.answer = 'Fresh';
  await composer.saveImageComposerPreset();
  assert.equal(confirms.length, 2);
  assert.deepEqual(puts.slice(-2).map((entry) => !!entry.replace), [false, true]);

  // A built-in's name never leaves the page.
  const before = puts.length;
  prompts.answer = 'Sticker';
  await composer.saveImageComposerPreset();
  assert.equal(puts.length, before);
  assert.equal(el('image-preset-note').dataset.state, 'error');
  assert.match(el('image-preset-note').textContent, /built-in/);

  // Cancelled: nothing.
  prompts.answer = null;
  await composer.saveImageComposerPreset();
  assert.equal(puts.length, before);
});

const STATE = {
  day: '2026-11-08', capUsd: 5, spentUsd: 4, reservedUsd: 0.1, estimatedUsd: 0, unknownPriceUsd: 0,
  monthUsd: 7.8, ratio: 0.82, warning: true, reached: false, allowedToday: false, allowedAt: null,
};

test('the banner shows in image chats only, live from the state', () => {
  reset();
  cost.syncOpenAIImageSpendBanner({ imageChat: true });
  cost.applyOpenAIImageSpendState(STATE);
  const banner = el('openai-image-spend-banner');
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, "Today's OpenAI image spend: USD 4.10 of 5.00");
  cost.applyOpenAIImageSpendState({ ...STATE, spentUsd: 5, reached: true });
  assert.equal(banner.dataset.kind, 'reached');
  assert.match(banner.textContent, /^Daily image cap reached/);
  cost.syncOpenAIImageSpendBanner({ imageChat: false });
  assert.equal(banner.hidden, true);
});

test('the chat menu line asks the relay for this chat', async () => {
  reset();
  fetchHandler = async ({ url }) => (url.includes('/api/image-usage?conversationId=conv-x')
    ? { body: { ...STATE, conversation: { costUsd: 0.42, estimatedUsd: 0.02, images: 3, tries: 3 } } }
    : { status: 404 });
  await cost.syncChatMenuImageCost({ conversationId: 'conv-x', imageChat: true });
  assert.equal(el('chat-menu-image-cost').hidden, false);
  assert.equal(el('chat-menu-image-cost-value').textContent, 'OpenAI images: USD 0.42 in this chat (3 images, USD 0.02 of it estimated)');
  await cost.syncChatMenuImageCost({ conversationId: 'conv-x', imageChat: false });
  assert.equal(el('chat-menu-image-cost').hidden, true);
});

test('Settings: the cap, the spend line, Allow and Stop allowing, a refusal shown, presets with Delete', async () => {
  reset();
  const posts = [];
  let refuse = false;
  fetchHandler = async ({ url, method, body }) => {
    if (url.endsWith('/api/settings/openai') && method === 'POST') {
      posts.push(body);
      if (refuse) return { status: 403, body: { error: 'A paired relay may not change the image cap.' } };
      return { body: { ok: true, imageDailyCapUsd: body.imageDailyCapUsd ?? 5 } };
    }
    if (url.endsWith('/api/image-usage')) return { body: { ...STATE, spentUsd: 5, reached: true, allowedToday: posts.at(-1)?.allowImagesToday === true } };
    if (url.endsWith('/api/openai-image-presets') && method === 'GET') return { body: { presets: [...BUILT_INS, OWN] } };
    if (url.endsWith('/api/openai-image-presets/Night') && method === 'DELETE') return { body: { presets: BUILT_INS } };
    return { status: 404 };
  };
  cost.applyOpenAIImageSpendSettings({ configured: true });
  assert.equal(el('openai-image-cap-input').value, '5', 'the default while the relay names none');
  await cost.syncOpenAIImageSpendSettings();
  assert.equal(el('openai-image-spend-line').textContent, 'Today USD 5.10 of 5.00 · USD 0.10 of it in flight · this month USD 7.80 · cap reached');
  assert.equal(el('openai-image-allow-today-btn').hidden, false);
  assert.equal(el('openai-image-allow-today-btn').textContent, 'Allow for today');
  assert.equal(el('openai-image-stop-allowing-btn').hidden, true);

  const rows = [...el('openai-image-presets-list').querySelectorAll('li')];
  assert.equal(rows.length, BUILT_INS.length + 1);
  assert.equal(el('openai-image-presets-list').querySelectorAll('[data-testid="openai-image-preset-delete"]').length, 1);

  el('openai-image-allow-today-btn').click();
  await settle();
  await settle();
  await settle();
  assert.deepEqual(posts.at(-1), { allowImagesToday: true });
  assert.equal(el('openai-image-allow-today-btn').hidden, true);
  assert.equal(el('openai-image-stop-allowing-btn').hidden, false);

  el('openai-image-cap-input').value = '12.5';
  el('openai-image-cap-input').dispatchEvent(new window.Event('input'));
  await cost.saveOpenAIImageCap();
  assert.deepEqual(posts.at(-1), { imageDailyCapUsd: 12.5 });

  el('openai-image-cap-input').value = '1.234';
  await cost.saveOpenAIImageCap();
  assert.equal(el('openai-image-spend-error').hidden, false);
  assert.equal(el('openai-image-cap-input').getAttribute('aria-invalid'), 'true');

  refuse = true;
  el('openai-image-cap-input').value = '3';
  await cost.saveOpenAIImageCap();
  assert.equal(el('openai-image-spend-error').textContent, 'A paired relay may not change the image cap.');

  el('openai-image-presets-list').querySelector('[data-testid="openai-image-preset-delete"]').click();
  await settle();
  await settle();
  // platform-agnostic: a route URL, never a file path.
  assert.ok(fetchLog.some((entry) => entry.method === 'DELETE' && entry.url.endsWith('/api/openai-image-presets/Night')));
  assert.equal(el('openai-image-presets-list').querySelectorAll('[data-testid="openai-image-preset-delete"]').length, 0);
});
