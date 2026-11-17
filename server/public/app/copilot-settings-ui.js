// Settings → Providers → Copilot: the "Enable GitHub Copilot" switch above
// the CLI row (markup in index.html), and the client's copy of the switch
// for the views that ask whether Copilot is on (the composer, the CLI row's
// note), handed to provider readiness with every answer (null: no answer).
//
// GET /api/settings/copilot answers `{ engine, engines, enabled, cliFound }`;
// an answer without `enabled` (an older relay) means on. The toggle binds
// itself here, so nothing on window is needed.

import { showTransientRelayNotice } from './store.js';
import { loadCopilotSettings, updateCopilotSettings } from './api-client.js';
import { updateProviderReadinessInputs } from './provider-readiness.mjs';

let copilotSettingsState = { enabled: true, cliFound: false, loaded: false };
let copilotSettingsUpdateInFlight = false;
let copilotSettingsLoadFailed = false;
const listeners = new Set();

export function getCopilotSettings() {
  return copilotSettingsState;
}

/** Whether Copilot is switched on; on until the relay has said otherwise. */
export function isCopilotEnabled() {
  return copilotSettingsState.enabled !== false;
}

export function subscribeCopilotSettings(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The line under the switch. */
export function copilotSettingsStatusText(state = {}, { loadFailed = false } = {}) {
  if (loadFailed) return 'Unable to load Copilot settings.';
  if (state.enabled === false) {
    return 'Copilot is off: its models are not in New Chat, and Copilot chats take no messages until it is switched on again.';
  }
  // Whether the CLI is installed is the CLI row's to say (cli-install-ui.js),
  // not this line's.
  return 'Copilot is on: its models are in New Chat. It runs on the GitHub Copilot CLI and its login on the relay host.';
}

function renderCopilotSettingsSection() {
  const toggle = document.getElementById('copilot-enabled-toggle');
  const status = document.getElementById('copilot-settings-status');
  if (toggle) {
    if (toggle.dataset.bound !== '1') {
      toggle.dataset.bound = '1';
      toggle.addEventListener('change', () => { void toggleCopilotProvider(toggle.checked); });
    }
    toggle.checked = isCopilotEnabled();
    toggle.disabled = copilotSettingsUpdateInFlight;
  }
  if (status) {
    status.textContent = copilotSettingsStatusText(copilotSettingsState, { loadFailed: copilotSettingsLoadFailed });
    status.dataset.state = copilotSettingsLoadFailed ? 'error' : (isCopilotEnabled() ? 'active' : 'unconfigured');
  }
}

/** Takes a settings payload (GET, the POST answer, copilot_settings_updated). */
export function applyCopilotSettingsState(payload = {}) {
  const settings = payload && typeof payload === 'object' ? payload : {};
  copilotSettingsLoadFailed = false;
  copilotSettingsState = {
    enabled: settings.enabled !== false,
    cliFound: settings.cliFound === true,
    loaded: true,
  };
  renderCopilotSettingsSection();
  updateProviderReadinessInputs({ copilot: copilotSettingsState });
  for (const listener of Array.from(listeners)) {
    try { listener(copilotSettingsState); } catch {}
  }
  return copilotSettingsState;
}

export async function refreshCopilotSettingsState() {
  const settings = await loadCopilotSettings().catch(() => null);
  if (!settings) {
    copilotSettingsLoadFailed = true;
    renderCopilotSettingsSection();
    updateProviderReadinessInputs({ copilot: null });
    return null;
  }
  return applyCopilotSettingsState(settings);
}

export async function toggleCopilotProvider(enabled) {
  if (copilotSettingsUpdateInFlight) return;
  copilotSettingsUpdateInFlight = true;
  renderCopilotSettingsSection();
  try {
    const result = await updateCopilotSettings({ enabled: enabled === true });
    if (!result) throw new Error('Failed to update the Copilot provider.');
    copilotSettingsUpdateInFlight = false;
    applyCopilotSettingsState(result);
    const label = result.enabled === false ? 'GitHub Copilot switched off' : 'GitHub Copilot switched on';
    showTransientRelayNotice(`${label}.${result.warning ? ` ${result.warning}` : ''}`, result.warning ? 8000 : 4500);
  } catch (error) {
    copilotSettingsUpdateInFlight = false;
    renderCopilotSettingsSection();
    alert(error?.message || 'Failed to update the Copilot provider.');
  } finally {
    copilotSettingsUpdateInFlight = false;
    renderCopilotSettingsSection();
  }
}
