// "Tool lines shown while an agent works" (Settings › Appearance): how many
// of its newest tool lines each agent of a running turn keeps in the live
// bubble, the main agent and every sub-agent apart.
// A setting of this browser, kept in localStorage like the scroll-on-send
// one. The slider runs from 10 to 500 by 10 and has one more step at the far
// end, no limit (stored as '0'). The document and the storage are passed in
// by the tests.

import { IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD, LIVE_ACTIVITY_CAP } from './activity-replay-state.mjs';

export const LIVE_ACTIVITY_CAP_STORAGE_KEY = 'copilot_live_activity_cap';
export const LIVE_ACTIVITY_CAP_SLIDER_ID = 'live-activity-cap-slider';
export const LIVE_ACTIVITY_CAP_VALUE_ID = 'live-activity-cap-value';
// One source with the relay's default and its most per thread.
export const LIVE_ACTIVITY_CAP_DEFAULT = LIVE_ACTIVITY_CAP;
export const LIVE_ACTIVITY_CAP_MIN = 10;
export const LIVE_ACTIVITY_CAP_MAX = IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD;
export const LIVE_ACTIVITY_CAP_STEP = 10;
/** The slider's last step: no limit. */
export const LIVE_ACTIVITY_CAP_UNLIMITED_POSITION = LIVE_ACTIVITY_CAP_MAX + LIVE_ACTIVITY_CAP_STEP;
/** The cap that keeps every line. */
export const LIVE_ACTIVITY_CAP_UNLIMITED = 0;

function clampToStep(value) {
  const stepped = Math.round(value / LIVE_ACTIVITY_CAP_STEP) * LIVE_ACTIVITY_CAP_STEP;
  return Math.min(LIVE_ACTIVITY_CAP_MAX, Math.max(LIVE_ACTIVITY_CAP_MIN, stepped));
}

/** The cap a stored value stands for: a count, or 0 for no limit. */
export function parseLiveActivityCap(stored) {
  const text = String(stored ?? '').trim();
  if (!text) return LIVE_ACTIVITY_CAP_DEFAULT;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return LIVE_ACTIVITY_CAP_DEFAULT;
  if (value === 0) return LIVE_ACTIVITY_CAP_UNLIMITED;
  return clampToStep(value);
}

export function serializeLiveActivityCap(cap) {
  const value = Number(cap);
  if (!Number.isFinite(value) || value <= 0) return '0';
  return String(clampToStep(value));
}

/** The cap at a slider position; the far end is no limit. */
export function liveActivityCapFromSlider(position) {
  const value = Number(position);
  if (!Number.isFinite(value)) return LIVE_ACTIVITY_CAP_DEFAULT;
  if (value >= LIVE_ACTIVITY_CAP_UNLIMITED_POSITION) return LIVE_ACTIVITY_CAP_UNLIMITED;
  return clampToStep(value);
}

export function sliderPositionForLiveActivityCap(cap) {
  const value = Number(cap);
  return Number.isFinite(value) && value > 0 ? clampToStep(value) : LIVE_ACTIVITY_CAP_UNLIMITED_POSITION;
}

export function formatLiveActivityCap(cap) {
  const value = Number(cap);
  if (!Number.isFinite(value) || value <= 0) return 'No limit';
  return `${clampToStep(value)} lines`;
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** The cap in force: a count per agent, or 0 for no limit. */
export function liveActivityCap(store = storage()) {
  try {
    return parseLiveActivityCap(store?.getItem(LIVE_ACTIVITY_CAP_STORAGE_KEY));
  } catch {
    return LIVE_ACTIVITY_CAP_DEFAULT;
  }
}

function showValue(doc, cap) {
  const text = formatLiveActivityCap(cap);
  const label = doc?.getElementById?.(LIVE_ACTIVITY_CAP_VALUE_ID);
  if (label) label.textContent = text;
  doc?.getElementById?.(LIVE_ACTIVITY_CAP_SLIDER_ID)?.setAttribute?.('aria-valuetext', text);
}

export function syncLiveActivityCapSlider(doc = globalThis.document, store = storage()) {
  const cap = liveActivityCap(store);
  const slider = doc?.getElementById?.(LIVE_ACTIVITY_CAP_SLIDER_ID);
  if (slider) slider.value = String(sliderPositionForLiveActivityCap(cap));
  showValue(doc, cap);
}

/** While the thumb moves: the label follows, nothing is saved. */
export function previewLiveActivityCap(position, { doc = globalThis.document } = {}) {
  showValue(doc, liveActivityCapFromSlider(position));
}

/** Saves the slider's value; returns the cap. */
export function updateLiveActivityCap(position, { doc = globalThis.document, store = storage(), onChange = null } = {}) {
  const cap = liveActivityCapFromSlider(position);
  try { store?.setItem(LIVE_ACTIVITY_CAP_STORAGE_KEY, serializeLiveActivityCap(cap)); } catch {}
  syncLiveActivityCapSlider(doc, store);
  if (typeof onChange === 'function') onChange(cap);
  return cap;
}
