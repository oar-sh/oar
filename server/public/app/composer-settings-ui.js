// The composer's ⚙ settings: a label row above the message box
// ("⚙ 🔒 Opus 5.5 · high · Autopilot  [Subscription]  🗂 📎") and a panel
// that holds Mode, Model (with the lock note), Effort, Context window,
// Billing and Context usage. A popover above the label row on desktop, a
// bottom sheet on a phone (max-width 680px).
//
// The selects live in the panel's markup with their old ids; their change
// listeners stay in bootstrap.js. This module only reads them: the label is
// redrawn whenever a select, the lock note or the billing toggle changes,
// and on the body's chat-kind classes (cloud chat, shared reader).

import {
  composerBillingPill,
  composerSettingsLabelParts,
  composerSettingsLabelText,
} from './composer-settings-label.mjs';
import { FONT_SCALE_CHANGE_EVENT, getUiScale } from './font-scaling.js';

const PANEL_ID = 'composer-settings';
const PHONE_QUERY = '(max-width: 680px)';
// The panel field a label part (or the pill) opens, and its control.
const FIELD_CONTROL_IDS = Object.freeze({
  mode: 'mode-select',
  model: 'model-select',
  effort: 'reasoning-effort-select',
  tier: 'context-tier-select',
  billing: 'claude-billing-toggle',
});
// Gap between the label row and the popover, and the room kept free above it.
const POPOVER_GAP_PX = 6;
const POPOVER_EDGE_PX = 8;
const POPOVER_MIN_HEIGHT_PX = 160;
const POPOVER_TYPING_MIN_HEIGHT_PX = 64;
const POPOVER_MIN_WIDTH_PX = 200;

let deps = {};
let panelOpen = false;
let syncQueued = false;
let bound = false;
let repositionBound = false;

function el(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function isPhone() {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return false; }
}

function isShared() {
  try {
    if (deps.isSharedReaderMode?.() === true) return true;
  } catch {}
  return document.body?.classList?.contains('shared-reader-mode') === true;
}

function shownOptionText(select) {
  if (!select) return '';
  const option = select.options?.[select.selectedIndex];
  return option ? option.textContent : '';
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function readLabelInput() {
  const mode = el('mode-select');
  const model = el('model-select');
  const effort = el('reasoning-effort-select');
  const tier = el('context-tier-select');
  const note = el('model-lock-note');
  const noteLocked = !!note && !note.hidden && String(note.textContent || '').trim() !== '';
  return {
    model: shownOptionText(model),
    locked: noteLocked || model?.dataset?.runtimeModelLocked === '1',
    effort: shownOptionText(effort),
    effortValue: effort ? String(effort.value || '') : '',
    mode: shownOptionText(mode),
    tier: shownOptionText(tier),
    tierValue: tier ? String(tier.value || '') : '',
    cloud: document.body?.classList?.contains('claude-cloud-conversation') === true,
    hidden: {
      model: !!model?.hidden,
      effort: !!effort?.hidden,
      mode: !!mode?.hidden,
      tier: !!tier?.hidden,
    },
  };
}

function renderLabel() {
  const label = el('composer-settings-label');
  if (!label) return;
  const parts = composerSettingsLabelParts(readLabelInput());
  const key = JSON.stringify(parts);
  if (label.dataset.renderKey !== key) {
    const nodes = [];
    parts.forEach((part, index) => {
      if (index) {
        const separator = document.createElement('span');
        separator.className = 'composer-settings-sep';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = ' · ';
        nodes.push(separator);
      }
      const node = document.createElement('span');
      node.className = 'composer-settings-part';
      node.dataset.field = part.field;
      if (part.field === 'model' && part.locked) {
        const lock = document.createElement('span');
        lock.className = 'composer-settings-lock';
        lock.textContent = '🔒';
        lock.setAttribute('aria-label', 'locked');
        node.append(lock, ' ');
      }
      node.append(part.text);
      nodes.push(node);
    });
    if (!nodes.length) {
      const empty = document.createElement('span');
      empty.className = 'composer-settings-part composer-settings-empty';
      empty.textContent = 'Chat settings';
      nodes.push(empty);
    }
    label.replaceChildren(...nodes);
    label.dataset.renderKey = key;
  }
  const text = composerSettingsLabelText(parts);
  const title = text ? `Chat settings: ${text}` : 'Chat settings';
  if (label.title !== title) label.title = title;
  if (label.getAttribute('aria-label') !== title) label.setAttribute('aria-label', title);
}

// Image models turn the effort select into Quality and the context-window
// select into the image size (bootstrap.js sets their titles).
function renderFieldLabels() {
  const effort = el('reasoning-effort-select');
  const tier = el('context-tier-select');
  setText(el('reasoning-effort-label'), effort?.title === 'Quality' ? 'Quality' : 'Effort');
  setText(el('context-tier-label'), tier?.title === 'Image size' ? 'Image size' : 'Context window');
}

function renderBillingPill() {
  const pill = el('composer-billing-pill');
  if (!pill) return;
  const toggle = el('claude-billing-toggle');
  const model = composerBillingPill({
    toggleVisible: !!toggle && !toggle.hidden,
    billing: toggle?.dataset?.billing || '',
  });
  const visible = model.visible && !isShared();
  if (pill.hidden !== !visible) pill.hidden = !visible;
  setText(pill, model.text);
  if (model.billing) {
    if (pill.dataset.billing !== model.billing) pill.dataset.billing = model.billing;
  } else if ('billing' in pill.dataset) {
    delete pill.dataset.billing;
  }
  const title = visible ? `Billing: ${model.text}` : '';
  if (pill.title !== title) pill.title = title;
}

/** Redraws the label, the field names and the billing pill now. */
export function syncComposerSettings() {
  if (typeof document === 'undefined') return;
  syncQueued = false;
  renderFieldLabels();
  renderLabel();
  renderBillingPill();
  if (panelOpen && isShared()) closeComposerSettings();
}

/** Redraws once after the current task: callers may set several values in a row. */
export function scheduleComposerSettingsSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(syncComposerSettings);
}

function isRendered(node) {
  return !!node && !node.hidden && node.getClientRects().length > 0;
}

function fieldFocusTarget(field) {
  const control = el(FIELD_CONTROL_IDS[field] || '');
  if (!isRendered(control)) return null;
  if (field === 'billing') {
    return control.querySelector('.claude-billing-option[aria-pressed="true"]')
      || control.querySelector('.claude-billing-option');
  }
  return control.disabled ? null : control;
}

function firstFocusableField() {
  for (const field of ['mode', 'model', 'effort', 'tier', 'billing']) {
    const target = fieldFocusTarget(field);
    if (target) return target;
  }
  return null;
}

// `moveFocus` false: the field is marked but the focus stays where it is (the
// message box, whose keyboard stays up in a phone's typing mode).
function focusField(field, { moveFocus = true } = {}) {
  const panel = el(PANEL_ID);
  if (!panel) return;
  for (const node of panel.querySelectorAll('.composer-settings-field-focus')) {
    node.classList.remove('composer-settings-field-focus');
  }
  let target = field ? fieldFocusTarget(field) : null;
  if (field) {
    const wrapper = el(FIELD_CONTROL_IDS[field] || '')?.closest?.('.composer-settings-field');
    wrapper?.classList?.add('composer-settings-field-focus');
    wrapper?.scrollIntoView?.({ block: 'nearest' });
  }
  if (!moveFocus) return;
  // A phone gets no select focused by itself: the sheet is for the thumb,
  // and a focused select there reads as an open picker.
  if (!target && !field && !isPhone()) target = firstFocusableField();
  try { (target || panel).focus({ preventScroll: true }); } catch {}
}

function positionPanel() {
  const panel = el(PANEL_ID);
  const backdrop = el('composer-settings-backdrop');
  if (!panel || panel.hidden) return;
  const phone = isPhone();
  if (backdrop) backdrop.hidden = !phone;
  if (phone) {
    // The bottom sheet comes from the media query alone.
    panel.style.removeProperty('max-height');
    panel.style.removeProperty('max-width');
    return;
  }
  // The popover sits above the label row (CSS) and must not run off the
  // top of the transcript. In a phone's typing mode (body.phone-typing,
  // phone-landscape-ui.js) the row is folded away: the popover sits above
  // the floating ⚙ and may cover the header, the keyboard leaves so little.
  const typing = document.body?.classList?.contains('phone-typing') === true;
  const floatGear = typing ? el('composer-float-settings') : null;
  const anchor = floatGear && !floatGear.hidden ? floatGear : el('composer-label-row');
  const messages = el('messages');
  const rowTop = anchor?.getBoundingClientRect?.().top ?? 0;
  const ceiling = typing ? 0 : Math.max(0, messages?.getBoundingClientRect?.().top ?? 0);
  // The gap, the edge and the floor are design sizes at 100 %; the zoom
  // scales them like the stylesheet does (the CSS gap is 6px * --ui-scale).
  const scale = getUiScale();
  const room = Math.round(rowTop - ceiling - (POPOVER_GAP_PX + POPOVER_EDGE_PX) * scale);
  // With the keyboard up the usual floor would push the popover off the
  // top: it takes the room there is and scrolls.
  const floor = typing ? POPOVER_TYPING_MIN_HEIGHT_PX : POPOVER_MIN_HEIGHT_PX;
  panel.style.maxHeight = `${Math.max(Math.round(floor * scale), room)}px`;
  // The CSS width counts from the screen's left edge, but the popover starts
  // at the label row (or, in typing mode, ends at the floating ⚙): under
  // zoom it would run off the screen with its ✕. The width it may take is
  // the room from where it is pinned to the far edge, less the edge gap.
  panel.style.removeProperty('max-width');
  const viewportWidth = Number(document.documentElement?.clientWidth) || Number(window.innerWidth) || 0;
  const box = panel.getBoundingClientRect?.();
  if (!(viewportWidth > 0) || !box || !(box.width > 0)) return;
  const edge = POPOVER_EDGE_PX * scale;
  const widthRoom = typing ? box.right - edge : viewportWidth - box.left - edge;
  if (box.width > widthRoom) {
    panel.style.maxWidth = `${Math.max(Math.round(POPOVER_MIN_WIDTH_PX * scale), Math.floor(widthRoom))}px`;
  }
}

/** Fits an open panel to where it now sits (typing mode came or went). */
export function repositionComposerSettings() {
  if (panelOpen) positionPanel();
}

function bindReposition() {
  if (repositionBound) return;
  repositionBound = true;
  window.addEventListener('resize', positionPanel);
  // A zoom moves the label row and rescales the popover's gap and floor.
  window.addEventListener(FONT_SCALE_CHANGE_EVENT, positionPanel);
  window.visualViewport?.addEventListener?.('resize', positionPanel);
}

function unbindReposition() {
  if (!repositionBound) return;
  repositionBound = false;
  window.removeEventListener('resize', positionPanel);
  window.removeEventListener(FONT_SCALE_CHANGE_EVENT, positionPanel);
  window.visualViewport?.removeEventListener?.('resize', positionPanel);
}

function setExpanded(expanded) {
  for (const id of ['composer-settings-btn', 'composer-settings-label', 'composer-float-settings']) {
    el(id)?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

export function isComposerSettingsOpen() {
  return panelOpen;
}

/**
 * Opens the panel; `field` ('mode' | 'model' | 'effort' | 'tier' | 'billing')
 * gets the focus. `keepComposerFocus`: the message box keeps the focus (the
 * floating ⚙ of a phone's typing mode), except where the bottom sheet takes
 * the whole screen and the keyboard has to go anyway.
 */
export function openComposerSettings({ field = '', keepComposerFocus = false } = {}) {
  if (isShared()) return;
  const panel = el(PANEL_ID);
  if (!panel) return;
  if (!panelOpen) {
    panelOpen = true;
    syncComposerSettings();
    panel.hidden = false;
    setExpanded(true);
    document.body.classList.add('composer-settings-open');
    // The keyboard would resize the viewport under the sheet.
    if (isPhone()) el('msg-input')?.blur?.();
    positionPanel();
    bindReposition();
  }
  focusField(String(field || ''), { moveFocus: !keepComposerFocus || isPhone() });
}

export function closeComposerSettings({ focusButton = false } = {}) {
  if (!panelOpen) return;
  panelOpen = false;
  const panel = el(PANEL_ID);
  const backdrop = el('composer-settings-backdrop');
  const hadFocus = !!panel && panel.contains(document.activeElement);
  if (panel) panel.hidden = true;
  if (backdrop) backdrop.hidden = true;
  setExpanded(false);
  document.body.classList.remove('composer-settings-open');
  unbindReposition();
  if (focusButton || hadFocus) {
    try { closeFocusTarget()?.focus({ preventScroll: true }); } catch {}
  }
}

// Where the focus goes when the panel closes: its ⚙. In a phone's typing
// mode the label row with that ⚙ is folded away: the message box then, so
// the keyboard (and with it typing mode and the floating ⚙) stays.
function closeFocusTarget() {
  if (document.body?.classList?.contains('phone-typing') === true) {
    const input = el('msg-input');
    if (input && !input.disabled) return input;
    const floatGear = el('composer-float-settings');
    if (floatGear && !floatGear.hidden) return floatGear;
  }
  return el('composer-settings-btn');
}

export function toggleComposerSettings() {
  if (panelOpen) closeComposerSettings({ focusButton: true });
  else openComposerSettings();
}

function isPanelTrigger(node) {
  return node instanceof Element
    && (node.id === 'composer-settings-btn'
      || node.id === 'composer-settings-label'
      || node.id === 'composer-billing-pill'
      || node.id === 'composer-float-settings');
}

function bindEvents() {
  if (bound) return;
  bound = true;
  el('composer-settings-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    toggleComposerSettings();
  });
  el('composer-settings-label')?.addEventListener('click', (event) => {
    event.preventDefault();
    const part = event.target instanceof Element ? event.target.closest('[data-field]') : null;
    openComposerSettings({ field: part?.dataset?.field || '' });
  });
  el('composer-billing-pill')?.addEventListener('click', (event) => {
    event.preventDefault();
    openComposerSettings({ field: 'billing' });
  });
  el('composer-settings-close')?.addEventListener('click', (event) => {
    event.preventDefault();
    closeComposerSettings({ focusButton: true });
  });
  el('composer-settings-backdrop')?.addEventListener('click', () => closeComposerSettings());
  el('composer-settings-context-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    closeComposerSettings();
    try { void deps.showContext?.(); } catch {}
  });
  const panel = el(PANEL_ID);
  panel?.addEventListener('change', () => scheduleComposerSettingsSync());
  // Outside the panel and its triggers: close. Capture phase, so a control
  // that stops the event still counts.
  document.addEventListener('pointerdown', (event) => {
    if (!panelOpen) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const current = el(PANEL_ID);
    if (current && path.includes(current)) return;
    if (path.some(isPanelTrigger)) return;
    closeComposerSettings();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!panelOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    closeComposerSettings({ focusButton: true });
  }, true);
  // Option rebuilds, the lock note, the billing toggle and the selects'
  // titles all change inside the panel; the chat kind changes on <body>.
  if (typeof MutationObserver === 'function') {
    if (panel) {
      new MutationObserver(() => scheduleComposerSettingsSync()).observe(panel, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['hidden', 'title', 'disabled', 'data-billing', 'data-runtime-model-locked', 'data-plan-only'],
      });
    }
    new MutationObserver(() => scheduleComposerSettingsSync()).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}

export function initComposerSettings(options = {}) {
  if (typeof document === 'undefined') return;
  deps = options && typeof options === 'object' ? options : {};
  bindEvents();
  syncComposerSettings();
}

export function __resetComposerSettingsForTests() {
  deps = {};
  panelOpen = false;
  syncQueued = false;
  bound = false;
  repositionBound = false;
}
