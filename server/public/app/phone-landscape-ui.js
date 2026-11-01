// A phone turned sideways: keeps :root[data-phone-landscape] in step
// (phone-landscape.mjs) and runs its typing mode (phone-typing-state.mjs).
//
// While the keyboard is up (body.phone-typing):
// - the label row folds into a floating ⚙ (#composer-float-settings) that
//   opens the ⚙ panel and leaves the focus in the message box;
// - the background-task line folds into a floating 🤖
//   (#background-tasks-float), shown only while the panel would show; a tap
//   shows the panel as an overlay above the composer
//   (body.phone-typing-tasks-open), a second tap or a tap elsewhere hides it.
// Both buttons sit on the composer's top edge on the right (index.html).
// Everything comes back when the keyboard goes down; an open ⚙ panel holds
// typing mode until it closes (phone-typing-state.mjs).

import {
  closeComposerSettings,
  isComposerSettingsOpen,
  openComposerSettings,
  repositionComposerSettings,
} from './composer-settings-ui.js';
import { PHONE_LANDSCAPE_CHANGE_EVENT, syncPhoneLandscapeAttribute } from './phone-landscape.mjs';
import { createPhoneTypingBaseline, resolvePhoneTyping } from './phone-typing-state.mjs';

export const PHONE_TYPING_CLASS = 'phone-typing';
export const PHONE_TYPING_TASKS_OPEN_CLASS = 'phone-typing-tasks-open';

let deps = {};
let bound = false;
let typing = false;
let taskOverlayOpen = false;
let baseline = createPhoneTypingBaseline();

function el(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function isShared() {
  try {
    if (deps.isSharedReaderMode?.() === true) return true;
  } catch {}
  return document.body?.classList?.contains('shared-reader-mode') === true;
}

// The visible height, and the tallest seen at this width (the layout height
// with no keyboard under it; a turn of the phone starts from the old one).
function measureViewport() {
  const innerHeight = Number(window.innerHeight) || 0;
  const visualHeight = Number(window.visualViewport?.height) || innerHeight;
  const layoutHeight = baseline.note(Number(window.innerWidth) || 0, Math.max(innerHeight, visualHeight));
  return { layoutHeight, visualHeight };
}

function syncFloats() {
  const gear = el('composer-float-settings');
  if (gear) {
    gear.hidden = !typing;
    gear.setAttribute('aria-expanded', isComposerSettingsOpen() ? 'true' : 'false');
  }
  const robot = el('background-tasks-float');
  const panel = el('background-tasks-panel');
  const panelShows = !!panel && !panel.hidden;
  if (taskOverlayOpen && !(typing && panelShows)) setTaskOverlayOpen(false);
  if (robot) {
    robot.hidden = !(typing && panelShows);
    robot.setAttribute('aria-expanded', taskOverlayOpen ? 'true' : 'false');
    const summary = String(el('background-tasks-summary')?.textContent || '').trim();
    const label = summary ? `Background tasks: ${summary}` : 'Background tasks';
    if (robot.title !== label) robot.title = label;
    if (robot.getAttribute('aria-label') !== label) robot.setAttribute('aria-label', label);
  }
}

function setTaskOverlayOpen(open) {
  taskOverlayOpen = !!open && typing;
  document.body?.classList?.toggle(PHONE_TYPING_TASKS_OPEN_CLASS, taskOverlayOpen);
  el('background-tasks-float')?.setAttribute('aria-expanded', taskOverlayOpen ? 'true' : 'false');
}

function setTyping(next) {
  if (next === typing) return;
  typing = next;
  document.body?.classList?.toggle(PHONE_TYPING_CLASS, typing);
  if (!typing) setTaskOverlayOpen(false);
  // An open ⚙ panel moves between the label row and the floating ⚙.
  syncFloats();
  repositionComposerSettings();
}

/** Recomputes phone landscape and typing mode; returns whether typing mode is on. */
export function syncPhoneTyping() {
  if (typeof document === 'undefined' || !document.body) return false;
  const phoneLandscape = syncPhoneLandscapeAttribute(window);
  const input = el('msg-input');
  const inputFocused = !!input && document.activeElement === input;
  const { layoutHeight, visualHeight } = measureViewport();
  // Only the ⚙ panel holds: its selects take the focus (the keyboard goes),
  // while a press in the task overlay keeps it (bindEvents).
  const held = typing && isComposerSettingsOpen();
  setTyping(!isShared() && resolvePhoneTyping({ phoneLandscape, inputFocused, layoutHeight, visualHeight, held }));
  syncFloats();
  return typing;
}

export function isPhoneTypingActive() {
  return typing;
}

export function isPhoneTypingTaskOverlayOpen() {
  return taskOverlayOpen;
}

/** The floating 🤖's tap: shows or hides the task panel over the composer. */
export function togglePhoneTypingTaskOverlay() {
  setTaskOverlayOpen(!taskOverlayOpen);
  syncPhoneTyping();
}

/** The floating ⚙'s tap: opens the ⚙ panel, the message box keeping the focus. */
export function togglePhoneTypingSettings() {
  if (isComposerSettingsOpen()) closeComposerSettings();
  else openComposerSettings({ keepComposerFocus: true });
  syncPhoneTyping();
}

function eventPath(event) {
  return typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
}

// A press that would take the focus from the message box (and the keyboard
// with it) is cancelled; the click still comes.
function keepComposerFocus(event) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
}

function isTextEntry(node) {
  return !!node && typeof node.closest === 'function'
    && !!node.closest('input, textarea, select, [contenteditable="true"]');
}

function bindEvents() {
  if (bound) return;
  bound = true;
  const sync = () => { syncPhoneTyping(); };
  const gear = el('composer-float-settings');
  if (gear) {
    gear.addEventListener('pointerdown', keepComposerFocus);
    gear.addEventListener('mousedown', keepComposerFocus);
    gear.addEventListener('click', (event) => {
      event.preventDefault();
      togglePhoneTypingSettings();
    });
  }
  const robot = el('background-tasks-float');
  if (robot) {
    robot.addEventListener('pointerdown', keepComposerFocus);
    robot.addEventListener('mousedown', keepComposerFocus);
    robot.addEventListener('click', (event) => {
      event.preventDefault();
      togglePhoneTypingTaskOverlay();
    });
  }
  const panel = el('background-tasks-panel');
  if (panel) {
    // In the overlay the summary and the rows keep the keyboard up, so the
    // panel does not move under the finger; a text field still takes the focus.
    const holdFocus = (event) => {
      if (!taskOverlayOpen || isTextEntry(event.target)) return;
      keepComposerFocus(event);
    };
    panel.addEventListener('pointerdown', holdFocus);
    panel.addEventListener('mousedown', holdFocus);
  }
  // A press anywhere but the overlay and its 🤖 hides the overlay. Capture
  // phase, so a control that stops the event still counts.
  document.addEventListener('pointerdown', (event) => {
    if (!taskOverlayOpen) return;
    const path = eventPath(event);
    if ((panel && path.includes(panel)) || (robot && path.includes(robot))) return;
    setTaskOverlayOpen(false);
    syncPhoneTyping();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!taskOverlayOpen || event.key !== 'Escape') return;
    setTaskOverlayOpen(false);
    syncPhoneTyping();
  }, true);

  const input = el('msg-input');
  input?.addEventListener('focus', sync);
  input?.addEventListener('blur', sync);
  window.addEventListener('resize', sync, { passive: true });
  window.addEventListener('orientationchange', sync, { passive: true });
  window.visualViewport?.addEventListener?.('resize', sync, { passive: true });
  // store.js flips the attribute on its own viewport pass too.
  window.addEventListener(PHONE_LANDSCAPE_CHANGE_EVENT, sync);
  try {
    window.matchMedia?.('(pointer: coarse)')?.addEventListener?.('change', sync);
  } catch {}
  if (typeof MutationObserver === 'function') {
    // The ⚙ panel closing ends a hold; the task panel showing or going
    // shows or hides the 🤖; the summary names it.
    const settings = el('composer-settings');
    if (settings) new MutationObserver(sync).observe(settings, { attributes: true, attributeFilter: ['hidden'] });
    if (panel) new MutationObserver(() => syncFloats()).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    const summary = el('background-tasks-summary');
    if (summary) new MutationObserver(() => syncFloats()).observe(summary, { childList: true, characterData: true, subtree: true });
  }
}

export function initPhoneLandscape(options = {}) {
  if (typeof document === 'undefined') return;
  deps = options && typeof options === 'object' ? options : {};
  bindEvents();
  syncPhoneTyping();
}

export function __resetPhoneLandscapeForTests() {
  deps = {};
  bound = false;
  typing = false;
  taskOverlayOpen = false;
  baseline = createPhoneTypingBaseline();
  document.body?.classList?.remove(PHONE_TYPING_CLASS, PHONE_TYPING_TASKS_OPEN_CLASS);
}
