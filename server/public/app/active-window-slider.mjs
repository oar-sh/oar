// The 🔥 controls in the sidebar's filter row: the toggle's attributes and
// count, and the window slider in the row under it. journal-view.js owns the
// list and its filter state and hands that in; this module owns the window,
// kept per browser (copilot_conv_active_window, in minutes).

import {
  ACTIVE_FILTER_LABEL,
  ACTIVE_WINDOW_STOPS_MIN,
  activeFilterBadgeText,
  activeWindowMsAtStop,
  activeWindowStopIndex,
  describeActiveFilterTitle,
  describeActiveWindow,
  readActiveWindowMs,
  writeActiveWindowMs,
} from './conversation-list-filter.mjs';

let windowMs = readActiveWindowMs();

/** The 🔥 window in ms, as last chosen in this browser. */
export function activeWindowMs() {
  return windowMs;
}

function syncSlider(input, output) {
  const index = String(activeWindowStopIndex(windowMs));
  const label = describeActiveWindow(windowMs);
  if (input) {
    if (input.value !== index) input.value = index;
    if (input.getAttribute('aria-valuetext') !== label) input.setAttribute('aria-valuetext', label);
  }
  if (output && output.textContent !== label) output.textContent = label;
}

/**
 * Binds the slider (#conv-active-window and its <output>). Moving it updates
 * the label and stores the window at once; the list (onChange(windowMs))
 * follows once per frame, so a drag across many stops repaints and restarts
 * the page drain once a frame, not at every stop. Letting go ('change')
 * repaints at once if a frame is still pending.
 */
export function initActiveWindowSlider({ onChange = () => {}, store = globalThis.localStorage } = {}) {
  const input = document.getElementById('conv-active-window');
  const output = document.getElementById('conv-active-window-label');
  if (!input || input.dataset.windowBound === '1') return;
  input.dataset.windowBound = '1';
  input.min = '0';
  input.max = String(ACTIVE_WINDOW_STOPS_MIN.length - 1);
  input.step = '1';
  syncSlider(input, output);
  let frame = 0;
  let painted = windowMs;
  const paint = () => {
    frame = 0;
    if (painted === windowMs) return;
    painted = windowMs;
    onChange(windowMs);
  };
  input.addEventListener('input', () => {
    const next = activeWindowMsAtStop(input.value);
    if (next === windowMs) return;
    windowMs = next;
    syncSlider(input, output);
    writeActiveWindowMs(next, store);
    if (typeof requestAnimationFrame !== 'function') return paint();
    if (!frame) frame = requestAnimationFrame(paint);
  });
  input.addEventListener('change', () => {
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    paint();
  });
}

/**
 * The toggle's pressed state, name, tooltip and count, and the slider row,
 * which shows only while 🔥 applies (on, and not the Archived view).
 */
export function syncActiveFilterControls({ activeOnly = false, archivedView = false, count = 0, firstPageLoaded = false } = {}) {
  const on = activeOnly && !archivedView;
  const row = document.getElementById('conv-active-window-row');
  if (row && row.hidden !== !on) row.hidden = !on;
  const button = document.getElementById('conv-active-toggle');
  if (!button) return;
  const pressed = activeOnly ? 'true' : 'false';
  if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
  if (button.disabled !== archivedView) button.disabled = archivedView;
  if (button.getAttribute('aria-label') !== ACTIVE_FILTER_LABEL) button.setAttribute('aria-label', ACTIVE_FILTER_LABEL);
  const title = archivedView
    ? 'The 🔥 filter applies to the live list, not the Archived view'
    : describeActiveFilterTitle(on, count, windowMs);
  if (button.title !== title) button.title = title;
  const badge = button.querySelector('.conv-active-count');
  if (badge) {
    // No count before the list has arrived.
    const text = firstPageLoaded ? activeFilterBadgeText(on, count) : '';
    if (badge.textContent !== text) badge.textContent = text;
    badge.hidden = !text;
  }
}
