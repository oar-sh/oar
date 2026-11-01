import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Renders against the real index.html so the ids and the panel's place stay honest.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
// jsdom lays nothing out: a node counts as rendered unless it, or a parent, is hidden.
dom.window.Element.prototype.getClientRects = function getClientRects() {
  for (let node = this; node; node = node.parentElement) {
    if (node.hidden) return [];
  }
  return [{}];
};

const ui = await import('./composer-settings-ui.js');

const el = (id) => document.getElementById(id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let contextOpened = 0;
let shared = false;

function setOptions(id, options, value) {
  const select = el(id);
  select.replaceChildren(...options.map(([optionValue, label]) => {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    return option;
  }));
  select.value = value;
  select.disabled = false;
}

function fillComposer() {
  setOptions('mode-select', [['agent', 'Agent'], ['autopilot', 'Autopilot']], 'autopilot');
  setOptions('model-select', [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5', 'Sonnet 5']], 'claude-opus-5-5');
  setOptions('reasoning-effort-select', [['medium', 'medium'], ['high', 'high']], 'high');
  setOptions('context-tier-select', [['default', '200K'], ['long_context', '1M']], 'default');
  el('model-lock-note').hidden = true;
  el('model-lock-note').textContent = '';
  el('claude-billing-toggle').hidden = true;
  delete el('claude-billing-toggle').dataset.billing;
  document.body.classList.remove('claude-cloud-conversation', 'shared-reader-mode');
}

const label = () => el('composer-settings-label').textContent;
const panel = () => el('composer-settings');

test.before(() => {
  fillComposer();
  ui.initComposerSettings({ isSharedReaderMode: () => shared, showContext: () => { contextOpened += 1; } });
});

test.beforeEach(async () => {
  ui.closeComposerSettings();
  shared = false;
  fillComposer();
  ui.syncComposerSettings();
  await flush();
});

test('the selects sit in the panel, inside the composer area, with their ids', () => {
  for (const id of ['mode-select', 'model-select', 'reasoning-effort-select', 'context-tier-select', 'claude-billing-toggle', 'model-lock-note']) {
    assert.ok(panel().contains(el(id)), `${id} is in the panel`);
  }
  assert.ok(el('input-area').contains(panel()));
  assert.equal(document.querySelectorAll('#mode-select').length, 1);
  assert.equal(panel().hidden, true);
});

test('the label reads the shown option texts', () => {
  assert.equal(label(), 'Opus 5.5 · high · Auto');
  const parts = [...el('composer-settings-label').querySelectorAll('.composer-settings-part')];
  assert.deepEqual(parts.map((part) => part.dataset.field), ['model', 'effort', 'mode']);
});

test('the label follows a change, an option rebuild and the lock note', async () => {
  el('context-tier-select').value = 'long_context';
  el('context-tier-select').dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(label(), 'Opus 5.5 · high · Auto · 1M');

  setOptions('reasoning-effort-select', [['', 'Unavailable']], '');
  await flush();
  assert.equal(label(), 'Opus 5.5 · Auto · 1M');

  el('model-lock-note').textContent = '🔒 Session locked to Claude SDK models.';
  el('model-lock-note').hidden = false;
  await flush();
  assert.equal(label(), '🔒 Opus 5.5 · Auto · 1M');
});

test('a cloud chat shows only the model', async () => {
  document.body.classList.add('claude-cloud-conversation');
  await flush();
  assert.equal(label(), 'Opus 5.5');
});

test('the context-window field is named Image size for an image model', async () => {
  el('context-tier-select').title = 'Image size';
  el('reasoning-effort-select').title = 'Quality';
  await flush();
  assert.equal(el('context-tier-label').textContent, 'Image size');
  assert.equal(el('reasoning-effort-label').textContent, 'Quality');
  el('context-tier-select').title = 'Context window';
  el('reasoning-effort-select').title = 'Reasoning effort';
  await flush();
  assert.equal(el('context-tier-label').textContent, 'Context window');
  assert.equal(el('reasoning-effort-label').textContent, 'Effort');
});

test('the ⚙ opens and closes the panel and keeps aria-expanded in step', () => {
  el('composer-settings-btn').click();
  assert.equal(panel().hidden, false);
  assert.equal(el('composer-settings-btn').getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, el('mode-select'), 'desktop focuses the first field');
  el('composer-settings-btn').click();
  assert.equal(panel().hidden, true);
  assert.equal(el('composer-settings-btn').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, el('composer-settings-btn'));
});

test('a tap on a part of the label opens the panel at that field', () => {
  el('composer-settings-label').querySelector('[data-field="effort"]').click();
  assert.equal(panel().hidden, false);
  assert.equal(document.activeElement, el('reasoning-effort-select'));
  el('composer-settings-label').querySelector('[data-field="model"]').click();
  assert.equal(panel().hidden, false, 'a second tap keeps it open');
  assert.equal(document.activeElement, el('model-select'));
});

test('Escape and a press outside close the panel; a press inside does not', () => {
  ui.openComposerSettings();
  el('model-select').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(panel().hidden, false);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel().hidden, true);
  assert.equal(document.activeElement, el('composer-settings-btn'));

  ui.openComposerSettings();
  el('messages').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(panel().hidden, true);
});

test('Context usage closes the panel and opens the context view', () => {
  const before = contextOpened;
  ui.openComposerSettings();
  el('composer-settings-context-btn').click();
  assert.equal(panel().hidden, true);
  assert.equal(contextOpened, before + 1);
});

test('the billing pill follows the toggle and opens the panel at Billing', async () => {
  assert.equal(el('composer-billing-pill').hidden, true);
  const toggle = el('claude-billing-toggle');
  const option = document.createElement('button');
  option.className = 'claude-billing-option';
  option.dataset.billing = 'claude';
  option.setAttribute('aria-pressed', 'true');
  toggle.replaceChildren(option);
  toggle.dataset.billing = 'claude';
  toggle.hidden = false;
  await flush();
  assert.equal(el('composer-billing-pill').hidden, false);
  assert.equal(el('composer-billing-pill').textContent, 'Subscription');
  assert.equal(el('composer-billing-pill').dataset.billing, 'claude');

  toggle.dataset.billing = 'claude-api';
  await flush();
  assert.equal(el('composer-billing-pill').textContent, 'API key');

  el('composer-billing-pill').click();
  assert.equal(panel().hidden, false);
  assert.equal(document.activeElement, option);

  toggle.hidden = true;
  await flush();
  assert.equal(el('composer-billing-pill').hidden, true);
});

test('a shared reader gets no panel and no pill', async () => {
  shared = true;
  document.body.classList.add('shared-reader-mode');
  el('claude-billing-toggle').dataset.billing = 'claude';
  el('claude-billing-toggle').hidden = false;
  await flush();
  assert.equal(el('composer-billing-pill').hidden, true);
  ui.openComposerSettings();
  assert.equal(panel().hidden, true);
});

test('in typing mode ✕ hands the focus to the message box, not the folded-away ⚙', () => {
  document.body.classList.add('phone-typing');
  try {
    ui.openComposerSettings();
    el('composer-settings-close').click();
    assert.equal(panel().hidden, true);
    assert.equal(document.activeElement, el('msg-input'));
  } finally {
    document.body.classList.remove('phone-typing');
  }
});

test('the popover is no wider than the room right of where it starts', () => {
  const box = panel();
  const realRect = box.getBoundingClientRect;
  const realWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 844 });
  // Zoomed: the label row starts at 379 and the CSS width says 510.
  box.getBoundingClientRect = () => ({ left: 379, right: 889, width: 510, top: 0, bottom: 300, height: 300 });
  try {
    ui.openComposerSettings();
    assert.equal(box.style.maxWidth, `${844 - 379 - 8}px`);
    ui.closeComposerSettings();
    // With room enough, no cap.
    box.getBoundingClientRect = () => ({ left: 20, right: 360, width: 340, top: 0, bottom: 300, height: 300 });
    ui.openComposerSettings();
    assert.equal(box.style.maxWidth, '');
  } finally {
    box.getBoundingClientRect = realRect;
    if (realWidth) Object.defineProperty(document.documentElement, 'clientWidth', realWidth);
    else delete document.documentElement.clientWidth;
  }
});
