import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The wiring on the real index.html: the floating buttons, the body classes,
// the ⚙ panel keeping the message box's focus, the task overlay, and the
// list collapsing after a pick.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.MutationObserver = window.MutationObserver;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
// jsdom lays nothing out: a node counts as rendered unless it, or a parent, is hidden.
window.Element.prototype.getClientRects = function getClientRects() {
  for (let node = this; node; node = node.parentElement) {
    if (node.hidden) return [];
  }
  return [{}];
};

// A phone on its side, 915 x 412, its keyboard 220px tall.
const env = { coarse: true, narrow: false, orientation: 'landscape-primary', visualHeight: 412 };
window.matchMedia = (query) => ({
  get matches() {
    if (query === '(pointer: coarse)') return env.coarse;
    if (query === '(max-width: 680px)') return env.narrow;
    return false;
  },
  addEventListener() {},
  removeEventListener() {},
});
const landscape = () => env.orientation.startsWith('landscape');
Object.defineProperty(window.screen, 'width', { configurable: true, get: () => (landscape() ? 915 : 412) });
Object.defineProperty(window.screen, 'height', { configurable: true, get: () => (landscape() ? 412 : 915) });
Object.defineProperty(window.screen, 'orientation', { configurable: true, get: () => ({ type: env.orientation }) });
Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => (landscape() ? 915 : 412) });
// Android shrinks the layout with the keyboard (interactive-widget=resizes-content).
Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => env.visualHeight });
const visualViewport = new window.EventTarget();
Object.defineProperty(visualViewport, 'height', { get: () => env.visualHeight });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });

const settingsUi = await import('./composer-settings-ui.js');
const ui = await import('./phone-landscape-ui.js');
const store = await import('./store.js');

const el = (id) => document.getElementById(id);
const body = () => document.body;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const typing = () => body().classList.contains('phone-typing');
const press = (node) => {
  const event = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  node.dispatchEvent(event);
  return event;
};

async function keyboard(up) {
  env.visualHeight = up ? 192 : 412;
  visualViewport.dispatchEvent(new window.Event('resize'));
  await flush();
}

settingsUi.initComposerSettings({ isSharedReaderMode: () => false, showContext: () => {} });
ui.initPhoneLandscape({ isSharedReaderMode: () => false });

test.beforeEach(async () => {
  settingsUi.closeComposerSettings();
  el('msg-input').blur();
  await keyboard(false);
  env.orientation = 'landscape-primary';
  env.coarse = true;
  el('background-tasks-panel').hidden = true;
  body().classList.remove('shared-reader-mode', 'sidebar-collapsed');
  ui.syncPhoneTyping();
  await flush();
});

test('the floating buttons are in the composer area, hidden outside typing mode', () => {
  assert.ok(el('input-area').contains(el('composer-floats')));
  assert.ok(el('composer-floats').contains(el('composer-float-settings')));
  assert.ok(el('composer-floats').contains(el('background-tasks-float')));
  assert.equal(document.documentElement.hasAttribute('data-phone-landscape'), true);
  assert.equal(typing(), false);
  assert.equal(el('composer-float-settings').hidden, true);
  assert.equal(el('background-tasks-float').hidden, true);
});

test('typing mode comes with the keyboard and goes with it', async () => {
  el('msg-input').focus();
  await flush();
  assert.equal(typing(), false, 'focused, the keyboard not up yet');
  await keyboard(true);
  assert.equal(typing(), true);
  assert.equal(el('composer-float-settings').hidden, false);
  // Android's back key hides the keyboard and leaves the focus.
  await keyboard(false);
  assert.equal(typing(), false);
  await keyboard(true);
  assert.equal(typing(), true);
  el('msg-input').blur();
  await flush();
  assert.equal(typing(), false);
});

test('no typing mode in portrait, on a desktop, or for a shared reader', async () => {
  env.orientation = 'portrait-primary';
  el('msg-input').focus();
  await keyboard(true);
  assert.equal(document.documentElement.hasAttribute('data-phone-landscape'), false);
  assert.equal(typing(), false);
  env.orientation = 'landscape-primary';
  env.coarse = false;
  ui.syncPhoneTyping();
  assert.equal(typing(), false);
  env.coarse = true;
  body().classList.add('shared-reader-mode');
  ui.syncPhoneTyping();
  assert.equal(typing(), false);
  body().classList.remove('shared-reader-mode');
  ui.syncPhoneTyping();
  assert.equal(typing(), true);
});

test('the floating ⚙ opens the panel and the message box keeps the focus', async () => {
  el('msg-input').focus();
  await keyboard(true);
  const gear = el('composer-float-settings');
  const down = press(gear);
  assert.equal(down.defaultPrevented, true, 'the press does not take the focus');
  gear.click();
  await flush();
  assert.equal(settingsUi.isComposerSettingsOpen(), true);
  assert.equal(el('composer-settings').hidden, false);
  assert.equal(document.activeElement, el('msg-input'));
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  // A second tap closes it; the press on the button is no outside press.
  press(gear);
  gear.click();
  await flush();
  assert.equal(settingsUi.isComposerSettingsOpen(), false);
  assert.equal(gear.getAttribute('aria-expanded'), 'false');
});

test('typing mode holds while the panel it opened is open, then ends', async () => {
  el('msg-input').focus();
  await keyboard(true);
  el('composer-float-settings').click();
  await flush();
  // A select in the panel takes the focus; the keyboard goes down.
  el('mode-select').focus();
  await keyboard(false);
  assert.equal(typing(), true, 'the panel stays where it opened');
  settingsUi.closeComposerSettings();
  await flush();
  assert.equal(typing(), false);
});

test('the 🤖 shows only while the task panel would, and opens it as an overlay', async () => {
  el('msg-input').focus();
  await keyboard(true);
  const robot = el('background-tasks-float');
  assert.equal(robot.hidden, true, 'no tasks, no 🤖');
  el('background-tasks-summary').textContent = '2 background tasks running';
  el('background-tasks-panel').hidden = false;
  await flush();
  assert.equal(robot.hidden, false);
  assert.equal(robot.getAttribute('aria-label'), 'Background tasks: 2 background tasks running');
  assert.equal(press(robot).defaultPrevented, true);
  robot.click();
  assert.equal(body().classList.contains('phone-typing-tasks-open'), true);
  assert.equal(robot.getAttribute('aria-expanded'), 'true');
  // A press inside the overlay keeps it and the focus.
  assert.equal(press(el('background-tasks-summary')).defaultPrevented, true);
  assert.equal(body().classList.contains('phone-typing-tasks-open'), true);
  // A second tap hides it.
  press(robot);
  robot.click();
  assert.equal(body().classList.contains('phone-typing-tasks-open'), false);
  // A press elsewhere hides it too.
  robot.click();
  assert.equal(body().classList.contains('phone-typing-tasks-open'), true);
  press(el('messages'));
  assert.equal(body().classList.contains('phone-typing-tasks-open'), false);
  // The panel going hides the 🤖 and the overlay.
  robot.click();
  el('background-tasks-panel').hidden = true;
  await flush();
  assert.equal(robot.hidden, true);
  assert.equal(body().classList.contains('phone-typing-tasks-open'), false);
});

test('the keyboard going down brings the task line and the label row back', async () => {
  el('background-tasks-panel').hidden = false;
  el('msg-input').focus();
  await keyboard(true);
  el('background-tasks-float').click();
  assert.equal(body().classList.contains('phone-typing-tasks-open'), true);
  await keyboard(false);
  assert.equal(typing(), false, 'the overlay does not hold typing mode');
  assert.equal(body().classList.contains('phone-typing-tasks-open'), false);
  assert.equal(el('background-tasks-float').hidden, true);
  assert.equal(el('composer-float-settings').hidden, true);
});

test('a phone on its side focuses no message box on a pick; its list collapses after one', () => {
  assert.equal(store.isPhoneComposerViewport(), true);
  assert.equal(store.collapseSidebarAfterListPick(), true);
  assert.equal(body().classList.contains('sidebar-collapsed'), true);
  // Already collapsed: nothing to do.
  assert.equal(store.collapseSidebarAfterListPick(), false);
  body().classList.remove('sidebar-collapsed');
  // A desktop keeps both: the focus and the list.
  env.coarse = false;
  ui.syncPhoneTyping();
  assert.equal(store.isPhoneComposerViewport(), false);
  assert.equal(store.collapseSidebarAfterListPick(), false);
  assert.equal(body().classList.contains('sidebar-collapsed'), false);
  // A narrow phone's list is the overlay openConversation closes.
  env.coarse = true;
  env.narrow = true;
  ui.syncPhoneTyping();
  assert.equal(store.isPhoneComposerViewport(), true);
  assert.equal(store.collapseSidebarAfterListPick(), false);
  env.narrow = false;
});
