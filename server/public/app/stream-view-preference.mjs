// "Stream view" (Settings › General › Appearance, and its mirror in the 🧠
// modal): an agent turn's thoughts, tool calls and reply as one list in the
// order they happened, live and in the finished message. A setting of this
// browser, kept in localStorage like the thoughts one; off unless switched
// on. Turns recorded before the relay numbered their rows keep the grouped
// layout either way (turn-stream-view.mjs). The document, the storage and
// the event target are passed in by the tests.

export const STREAM_VIEW_STORAGE_KEY = 'copilot_stream_view';
export const STREAM_VIEW_TOGGLE_ID = 'stream-view-toggle';
// The page re-renders its transcript and the live bubble on this.
export const STREAM_VIEW_CHANGE_EVENT = 'oar:stream-view-change';
// The 🧠 modal's two buttons: `data-stream-view` is "on" or "off".
export const STREAM_VIEW_BUTTON_SELECTOR = '.ctx-stream-view-btn[data-stream-view]';

/** Only an explicit on is on: a missing or damaged value reads off. */
export function parseStreamViewSetting(stored) {
  const value = String(stored ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function serializeStreamViewSetting(on) {
  return on ? '1' : '0';
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function isStreamViewEnabled(store = storage()) {
  try {
    return parseStreamViewSetting(store?.getItem(STREAM_VIEW_STORAGE_KEY));
  } catch {
    return false;
  }
}

/** The Settings checkbox and the 🧠 buttons, wherever they are rendered. */
export function syncStreamViewToggle(doc = globalThis.document, store = storage()) {
  const on = isStreamViewEnabled(store);
  const checkbox = doc?.getElementById?.(STREAM_VIEW_TOGGLE_ID);
  if (checkbox) checkbox.checked = on;
  const buttons = doc?.querySelectorAll?.(STREAM_VIEW_BUTTON_SELECTOR) || [];
  for (const btn of buttons) {
    const active = (btn.dataset?.streamView === 'on') === on;
    btn.classList?.toggle('is-active', active);
    btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
  }
}

export function updateStreamViewSetting(on, { doc = globalThis.document, store = storage(), target = globalThis.window } = {}) {
  const value = !!on;
  const before = isStreamViewEnabled(store);
  try { store?.setItem(STREAM_VIEW_STORAGE_KEY, serializeStreamViewSetting(value)); } catch {}
  syncStreamViewToggle(doc, store);
  if (before === isStreamViewEnabled(store)) return;
  try {
    target?.dispatchEvent?.(new CustomEvent(STREAM_VIEW_CHANGE_EVENT, { detail: { on: value } }));
  } catch {}
}
