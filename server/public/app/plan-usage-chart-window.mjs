/**
 * The Check Usage charts' window (7, 30 or 90 days): one choice for every
 * tab, remembered in this browser. The server sends the charts of all three
 * windows with the report (plan-usage-token-charts.mjs); the renderer
 * (plan-usage-view.mjs) marks each chart with its window and hides the
 * others, and a change of the picker here only shows and hides them: no
 * re-render, no fetch.
 *
 * Kept importable in Node for the renderer's tests: the change listener is
 * installed only where there is a `document`.
 */

export const CHART_WINDOWS = Object.freeze([7, 30, 90]);
export const DEFAULT_CHART_WINDOW = 30;
export const CHART_WINDOW_STORAGE_KEY = 'oar.usage.chartWindow.v1';

/** 7, 30 or 90 from a number or its text; null for anything else. */
export function normalizeChartWindow(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return CHART_WINDOWS.includes(days) ? days : null;
}

// Private mode, a blocked or full storage, or Node: no storage, never an error.
function defaultStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// The window last picked on this page: what a redraw shows when the storage
// is missing, refuses to be read, or did not take that pick (a full quota
// keeps the value before it).
let lastPicked = null;
let lastPickStored = false;

/**
 * The stored window, else the one last picked on this page, else 30. A pick
 * the storage did not take wins over what it holds.
 */
export function readChartWindow(storage = defaultStorage()) {
  if (lastPicked !== null && !lastPickStored) return lastPicked;
  let stored = null;
  try {
    stored = normalizeChartWindow(storage?.getItem(CHART_WINDOW_STORAGE_KEY));
  } catch {
    stored = null;
  }
  return stored ?? lastPicked ?? DEFAULT_CHART_WINDOW;
}

/**
 * Remember `days` (7, 30 or 90; anything else is ignored): on this page,
 * and in the storage when there is one. True when stored.
 */
export function storeChartWindow(days, storage = defaultStorage()) {
  const value = normalizeChartWindow(days);
  if (value === null) return false;
  lastPicked = value;
  lastPickStored = false;
  if (!storage) return false;
  try {
    storage.setItem(CHART_WINDOW_STORAGE_KEY, String(value));
    lastPickStored = true;
  } catch {
    lastPickStored = false;
  }
  return lastPickStored;
}

/**
 * Show `days`' charts in every chart block under `root`: its radio checked,
 * the charts and the "no turns" line of another window hidden. Charts
 * without a window (DeepSeek's all-time split) stay as they are.
 */
export function applyChartWindow(root, days) {
  const value = normalizeChartWindow(days) ?? DEFAULT_CHART_WINDOW;
  if (!root || typeof root.querySelectorAll !== 'function') return value;
  for (const block of root.querySelectorAll('.plan-usage-charts')) {
    block.setAttribute('data-chart-window', String(value));
    for (const input of block.querySelectorAll('.plan-usage-chart-window input')) {
      input.checked = normalizeChartWindow(input.value) === value;
    }
    for (const element of block.querySelectorAll('[data-window]')) {
      element.hidden = normalizeChartWindow(element.getAttribute('data-window')) !== value;
    }
  }
  return value;
}

function onChange(event) {
  const input = event?.target;
  if (!input || typeof input.closest !== 'function' || !input.closest('.plan-usage-chart-window')) return;
  const value = normalizeChartWindow(input.value);
  if (value === null) return;
  storeChartWindow(value);
  applyChartWindow(input.ownerDocument || document, value);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('change', onChange);
}
