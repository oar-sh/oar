// "Messages kept per conversation for switching back" (Settings › General):
// how many loaded messages the page keeps of a conversation it leaves, so a
// switch back shows the same rows. A setting of this browser, kept in
// localStorage like the scroll-on-send one. The slider runs from 100 to 1,000
// by 100 and has one more step at the far end, no limit. The document and
// the storage are passed in by the tests.

export const WINDOW_RETENTION_STORAGE_KEY = 'copilot_conversation_window_retention';
export const WINDOW_RETENTION_SLIDER_ID = 'conversation-window-retention-slider';
export const WINDOW_RETENTION_VALUE_ID = 'conversation-window-retention-value';
export const WINDOW_RETENTION_DEFAULT = 200;
export const WINDOW_RETENTION_MIN = 100;
export const WINDOW_RETENTION_MAX = 1000;
export const WINDOW_RETENTION_STEP = 100;
/** The slider's last step: no limit. */
export const WINDOW_RETENTION_UNLIMITED_POSITION = WINDOW_RETENTION_MAX + WINDOW_RETENTION_STEP;
const UNLIMITED_TOKEN = 'none';

function clampToStep(value) {
  const stepped = Math.round(value / WINDOW_RETENTION_STEP) * WINDOW_RETENTION_STEP;
  return Math.min(WINDOW_RETENTION_MAX, Math.max(WINDOW_RETENTION_MIN, stepped));
}

/** The cap a stored value stands for: a count, or Infinity for no limit. */
export function parseWindowRetention(stored) {
  const text = String(stored ?? '').trim().toLowerCase();
  if (!text) return WINDOW_RETENTION_DEFAULT;
  if (text === UNLIMITED_TOKEN) return Infinity;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return WINDOW_RETENTION_DEFAULT;
  return clampToStep(value);
}

export function serializeWindowRetention(cap) {
  return Number.isFinite(Number(cap)) ? String(clampToStep(Number(cap))) : UNLIMITED_TOKEN;
}

/** The cap at a slider position; the far end is no limit. */
export function windowRetentionFromSlider(position) {
  const value = Number(position);
  if (!Number.isFinite(value)) return WINDOW_RETENTION_DEFAULT;
  if (value >= WINDOW_RETENTION_UNLIMITED_POSITION) return Infinity;
  return clampToStep(value);
}

export function sliderPositionForWindowRetention(cap) {
  return Number.isFinite(Number(cap)) ? clampToStep(Number(cap)) : WINDOW_RETENTION_UNLIMITED_POSITION;
}

export function formatWindowRetention(cap) {
  if (!Number.isFinite(Number(cap))) return 'No limit';
  return `${clampToStep(Number(cap)).toLocaleString('en-US')} messages`;
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function readWindowRetention(store = storage()) {
  try {
    return parseWindowRetention(store?.getItem(WINDOW_RETENTION_STORAGE_KEY));
  } catch {
    return WINDOW_RETENTION_DEFAULT;
  }
}

function showValue(doc, cap) {
  const text = formatWindowRetention(cap);
  const label = doc?.getElementById?.(WINDOW_RETENTION_VALUE_ID);
  if (label) label.textContent = text;
  doc?.getElementById?.(WINDOW_RETENTION_SLIDER_ID)?.setAttribute?.('aria-valuetext', text);
}

export function syncWindowRetentionSlider(doc = globalThis.document, store = storage()) {
  const cap = readWindowRetention(store);
  const slider = doc?.getElementById?.(WINDOW_RETENTION_SLIDER_ID);
  if (slider) slider.value = String(sliderPositionForWindowRetention(cap));
  showValue(doc, cap);
}

/** While the thumb moves: the label follows, nothing is saved. */
export function previewWindowRetention(position, { doc = globalThis.document } = {}) {
  showValue(doc, windowRetentionFromSlider(position));
}

/**
 * Saves the slider's value and hands the new cap to `onChange` (the kept
 * conversations are cut down to it). Returns the cap.
 */
export function updateWindowRetention(position, { doc = globalThis.document, store = storage(), onChange = null } = {}) {
  const cap = windowRetentionFromSlider(position);
  try { store?.setItem(WINDOW_RETENTION_STORAGE_KEY, serializeWindowRetention(cap)); } catch {}
  syncWindowRetentionSlider(doc, store);
  if (typeof onChange === 'function') onChange(cap);
  return cap;
}
