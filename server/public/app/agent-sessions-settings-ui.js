// Settings → Relays → Agent sessions: the switch that lets agents start and use
// sessions on this relay through the remote_relay tool, and the slider for the
// longest wait of one tool call. The decisions live in
// agent-sessions-settings.mjs; this file only moves them into the markup in
// index.html. The static controls use inline handlers that bootstrap.js
// exposes on window.
//
// The section ships hidden. It shows once the relay answered with settings and
// stays hidden on a relay that does not know the route (404).

import { loadAgentSessionsSettings, updateAgentSessionsSettings } from './api-client.js';
import {
  agentSessionsSavedText,
  agentSessionsViewModel,
  clampWaitSeconds,
  classifyAgentSessionsLoad,
  formatWaitMinutesLabel,
  normalizeAgentSessionsSettings,
} from './agent-sessions-settings.mjs';

// null until the first successful read: "never answered" is not "off".
let settingsState = null;
let unsupported = false;
let loadFailed = false;
let saveInFlight = false;
// What is being saved, drawn over the stored state until the relay answers so
// the switch and the thumb stay where the user put them.
let pendingChange = null;
// A value from elsewhere arrived while the slider had focus; drawn on blur.
let sliderRenderDeferred = false;
let sliderBlurBound = false;

function el(id) {
  return document.getElementById(id);
}

export function getAgentSessionsSettings() {
  return settingsState;
}

function setStatusLine(state, text) {
  const line = el('agent-sessions-status');
  if (!line) return;
  line.textContent = text || '';
  line.hidden = !text;
  if (state) line.dataset.state = state;
  else delete line.dataset.state;
}

function setSliderLabel(text) {
  const label = el('agent-sessions-max-wait-value');
  if (label) label.textContent = text;
  // The value is in seconds; a screen reader hears the minutes.
  el('agent-sessions-max-wait-slider')?.setAttribute('aria-valuetext', text);
}

function bindSliderBlur(slider) {
  if (sliderBlurBound) return;
  sliderBlurBound = true;
  slider.addEventListener('blur', () => {
    if (sliderRenderDeferred) renderAgentSessionsSection({ forceSlider: true });
  });
}

/**
 * Idempotent. A value that came from elsewhere (socket, refresh) never moves
 * the thumb under the user's finger: it waits until focus leaves the slider.
 * `forceSlider` is for this page's own saves.
 */
export function renderAgentSessionsSection({ forceSlider = false } = {}) {
  const section = el('agent-sessions-section');
  if (!section) return;
  const view = agentSessionsViewModel({
    settings: settingsState && pendingChange ? { ...settingsState, ...pendingChange } : settingsState,
    unsupported,
    loadFailed,
    saving: saveInFlight,
  });
  section.hidden = view.hidden;

  const toggle = el('agent-sessions-enabled-toggle');
  if (toggle) {
    toggle.checked = view.toggle.checked;
    toggle.disabled = view.toggle.disabled;
  }

  const slider = el('agent-sessions-max-wait-slider');
  if (slider) {
    bindSliderBlur(slider);
    slider.disabled = view.slider.disabled;
    const held = !forceSlider && !view.slider.disabled && document.activeElement === slider;
    sliderRenderDeferred = held;
    if (!held) {
      // Range first: a value outside the old range would be clamped by the input.
      slider.min = String(view.slider.min);
      slider.max = String(view.slider.max);
      slider.step = String(view.slider.step);
      slider.value = String(view.slider.value);
      setSliderLabel(view.slider.label);
    }
  }

  const cap = el('agent-sessions-cap');
  if (cap) {
    cap.textContent = view.capText;
    cap.hidden = !view.capText;
  }
}

// Single entry point for every payload (GET, POST answer, socket event).
export function applyAgentSessionsSettingsState(payload, { forceSlider = false } = {}) {
  if (!payload || typeof payload !== 'object') return settingsState;
  settingsState = normalizeAgentSessionsSettings(payload, settingsState);
  unsupported = false;
  loadFailed = false;
  renderAgentSessionsSection({ forceSlider });
  return settingsState;
}

/** Called when the settings modal opens, and for a socket event without a body. */
export async function refreshAgentSessionsSection() {
  if (!saveInFlight) setStatusLine('', '');
  renderAgentSessionsSection();
  const result = await loadAgentSessionsSettings();
  const outcome = classifyAgentSessionsLoad(result);
  if (outcome === 'loaded') return applyAgentSessionsSettingsState(result);
  if (outcome === 'unsupported') {
    unsupported = true;
    settingsState = null;
  } else if (!settingsState) {
    // Keep what an earlier read said: one failed refresh is not "gone".
    loadFailed = true;
    setStatusLine('error', 'Could not load the agent session settings from this relay.');
  }
  renderAgentSessionsSection();
  return settingsState;
}

async function saveAgentSessionsChange(change, patch, failureText) {
  saveInFlight = true;
  pendingChange = patch;
  setStatusLine('saved', 'Saving…');
  renderAgentSessionsSection({ forceSlider: true });
  let result = null;
  try {
    result = await updateAgentSessionsSettings(patch);
  } finally {
    saveInFlight = false;
    pendingChange = null;
  }
  if (result?.ok) {
    // The relay's answer is the truth (it may have clamped the wait).
    applyAgentSessionsSettingsState({ ...patch, ...result }, { forceSlider: true });
    setStatusLine('active', agentSessionsSavedText(change, settingsState));
  } else {
    // Back to what the relay has; the line says why.
    setStatusLine('error', result?.error || failureText);
    renderAgentSessionsSection({ forceSlider: true });
  }
}

export async function toggleAgentSessions(checked) {
  if (saveInFlight || !settingsState) {
    renderAgentSessionsSection();
    return;
  }
  await saveAgentSessionsChange('enabled', { enabled: checked === true }, 'Failed to update the setting.');
}

/** Live label feedback while dragging; nothing is saved until change fires. */
export function previewAgentSessionsMaxWait(value) {
  const seconds = clampWaitSeconds(value, settingsState?.limits, settingsState?.maxWaitSeconds);
  setSliderLabel(formatWaitMinutesLabel(seconds));
}

export async function saveAgentSessionsMaxWait(value) {
  if (saveInFlight || !settingsState) {
    renderAgentSessionsSection({ forceSlider: true });
    return;
  }
  const seconds = clampWaitSeconds(value, settingsState.limits, settingsState.maxWaitSeconds);
  if (seconds === settingsState.maxWaitSeconds) {
    renderAgentSessionsSection({ forceSlider: true });
    return;
  }
  await saveAgentSessionsChange('maxWaitSeconds', { maxWaitSeconds: seconds }, 'Failed to save the longest wait.');
}

/** Test hook. */
export function resetAgentSessionsSettingsForTests() {
  settingsState = null;
  unsupported = false;
  loadFailed = false;
  saveInFlight = false;
  pendingChange = null;
  sliderRenderDeferred = false;
}
