import {
  defaultSessionWorkspaceRootPath,
  defaultSessionWorkspaceRootWarning,
  serverPlatform,
  showTransientRelayNotice,
} from './store.js';
import {
  loadClaudeSettings,
  loadCursorSettings,
  loadCursorAllowanceSettings,
  updateCursorAllowanceSettings,
  loadOpenAISettings,
  updateClaudeSettings,
  updateCursorSettings,
  updateDefaultSessionWorkspaceRoot,
  updateOpenAISettings,
  loadWindowsAutostartSetting,
  updateWindowsAutostartSetting,
  loadTurnCeilingSetting,
  updateTurnCeilingSetting as requestTurnCeilingSetting,
} from './api-client.js';
import { syncFontScaleSelect } from './font-scaling.js';
import { syncPwaAppNameInput } from './pwa-install.js';
import { normalizeKnownCwdPath } from './cwd-picker.js';
import { refreshPushSettingsSection } from './push-settings.js';

const THEME_STORAGE_KEY = 'copilot_theme';
const SHOW_SUSPEND_HOST_STORAGE_KEY = 'copilot_show_suspend_host';

let defaultSessionWorkspaceRootUpdateInFlight = false;
let openAISettingsUpdateInFlight = false;
let openAISettingsState = {
  configured: false,
  enabled: false,
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
};
let openAISettingsInputsDirty = false;

function ensureOpenAISettingsInputTracking() {
  for (const id of ['openai-api-key-input', 'openai-model-input', 'openai-base-url-input']) {
    const input = document.getElementById(id);
    if (!input || input.dataset.openaiDirtyTracking === '1') continue;
    input.dataset.openaiDirtyTracking = '1';
    input.addEventListener('input', () => {
      openAISettingsInputsDirty = true;
    });
  }
}
let windowsAutostartUpdateInFlight = false;
let windowsAutostartEnabled = false;

// Mirrors shared/turn-ceiling.mjs, which the browser cannot import — only
// server/public is served. The authoritative bounds come from the API response;
// these are just the pre-response defaults.
let turnCeilingMinutes = 60;
let turnCeilingUpdateInFlight = false;

function formatTurnCeilingLabel(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value === 0) return 'No limit';
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function syncTurnCeilingSlider() {
  const slider = document.getElementById('turn-ceiling-slider');
  const label = document.getElementById('turn-ceiling-value');
  if (slider instanceof HTMLInputElement) {
    slider.value = String(turnCeilingMinutes);
    slider.disabled = turnCeilingUpdateInFlight;
  }
  if (label) label.textContent = formatTurnCeilingLabel(turnCeilingMinutes);
}

/** Live label feedback while dragging; nothing is persisted until change fires. */
export function previewTurnCeilingSetting(value) {
  const label = document.getElementById('turn-ceiling-value');
  if (label) label.textContent = formatTurnCeilingLabel(value);
}

export async function refreshTurnCeilingSetting() {
  syncTurnCeilingSlider();
  try {
    const result = await loadTurnCeilingSetting();
    if (!result || !Number.isFinite(Number(result.ceilingMinutes))) return;
    turnCeilingMinutes = Number(result.ceilingMinutes);
    const slider = document.getElementById('turn-ceiling-slider');
    if (slider instanceof HTMLInputElement) {
      if (Number.isFinite(Number(result.minMinutes))) slider.min = String(result.minMinutes);
      if (Number.isFinite(Number(result.maxMinutes))) slider.max = String(result.maxMinutes);
      if (Number.isFinite(Number(result.stepMinutes))) slider.step = String(result.stepMinutes);
    }
  } catch {
    // Leave the slider at its last known value; the setting is not critical.
  } finally {
    syncTurnCeilingSlider();
  }
}

export async function updateTurnCeilingSetting(value) {
  if (turnCeilingUpdateInFlight) {
    syncTurnCeilingSlider();
    return;
  }
  const requested = Math.max(0, Math.round(Number(value) || 0));
  turnCeilingUpdateInFlight = true;
  syncTurnCeilingSlider();
  try {
    const result = await requestTurnCeilingSetting(requested);
    turnCeilingMinutes = Number.isFinite(Number(result?.ceilingMinutes))
      ? Number(result.ceilingMinutes)
      : requested;
    showTransientRelayNotice(
      turnCeilingMinutes === 0
        ? 'Turns will run without a time limit.'
        : `Max turn duration set to ${formatTurnCeilingLabel(turnCeilingMinutes)}.`,
    );
  } catch (error) {
    alert(error?.message || 'Failed to update the max turn duration.');
  } finally {
    turnCeilingUpdateInFlight = false;
    syncTurnCeilingSlider();
  }
}

function readLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function closeChatActionsMenu() {
  const menu = document.getElementById('chat-actions-menu');
  const trigger = document.getElementById('chat-actions-menu-btn');
  const backdrop = document.getElementById('chat-actions-menu-backdrop');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (backdrop && !window.__chatActionsMenuShieldTimer) backdrop.classList.remove('visible');
}

export function syncDefaultSessionWorkspaceRootInput() {
  const input = document.getElementById('default-session-workspace-root-input');
  if (!input) return;
  input.value = normalizeKnownCwdPath(defaultSessionWorkspaceRootPath || '');
  if (defaultSessionWorkspaceRootWarning) {
    input.title = defaultSessionWorkspaceRootWarning;
  } else {
    input.removeAttribute('title');
  }
}

function setOpenAISettingsControlsDisabled(disabled) {
  for (const id of [
    'openai-api-key-input',
    'openai-model-input',
    'openai-base-url-input',
    'openai-enabled-toggle',
    'openai-save-btn',
    'openai-remove-btn',
  ]) {
    const element = document.getElementById(id);
    if (element) element.disabled = disabled;
  }
}

export function applyOpenAISettingsState(settings = {}, { resetInputs = false } = {}) {
  ensureOpenAISettingsInputTracking();
  openAISettingsState = {
    configured: settings?.configured === true,
    enabled: settings?.configured === true && settings?.enabled === true,
    model: String(settings?.model || openAISettingsState.model || 'gpt-4o').trim() || 'gpt-4o',
    baseUrl: String(settings?.baseUrl || openAISettingsState.baseUrl || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
  };
  const keyInput = document.getElementById('openai-api-key-input');
  const modelInput = document.getElementById('openai-model-input');
  const baseUrlInput = document.getElementById('openai-base-url-input');
  const toggle = document.getElementById('openai-enabled-toggle');
  const removeButton = document.getElementById('openai-remove-btn');
  const status = document.getElementById('openai-settings-status');
  if (keyInput && (!openAISettingsInputsDirty || resetInputs)) {
    keyInput.value = '';
    keyInput.placeholder = openAISettingsState.configured ? 'Saved API key (enter to replace)' : 'sk-...';
  }
  if (modelInput && (!openAISettingsInputsDirty || resetInputs)) modelInput.value = openAISettingsState.model;
  if (baseUrlInput && (!openAISettingsInputsDirty || resetInputs)) {
    baseUrlInput.value = openAISettingsState.baseUrl === 'https://api.openai.com/v1' ? '' : openAISettingsState.baseUrl;
    baseUrlInput.placeholder = 'https://api.openai.com/v1';
  }
  if (resetInputs) openAISettingsInputsDirty = false;
  if (toggle) {
    toggle.checked = openAISettingsState.enabled;
    toggle.disabled = openAISettingsUpdateInFlight || !openAISettingsState.configured;
  }
  if (removeButton) {
    removeButton.disabled = openAISettingsUpdateInFlight || !openAISettingsState.configured;
  }
  if (status) {
    status.textContent = openAISettingsState.enabled
      ? `OpenAI API is enabled. Select OpenAI in New Chat to use model ${openAISettingsState.model}.`
      : (openAISettingsState.configured
          ? 'API key saved but currently disabled. Enable it to allow OpenAI selection in New Chat.'
          : 'Not configured. New conversations use GitHub Copilot.');
    status.dataset.state = openAISettingsState.enabled
      ? 'active'
      : (openAISettingsState.configured ? 'saved' : 'unconfigured');
  }
  window.syncAutoModelAvailability?.();
  return openAISettingsState;
}

export async function refreshOpenAISettingsState() {
  const settings = await loadOpenAISettings();
  if (!settings) return null;
  return applyOpenAISettingsState(settings);
}

let claudeSettingsUpdateInFlight = false;
let claudeSettingsState = {
  configured: false,
  enabled: false,
  model: 'claude-sonnet-5',
  models: [],
};
let claudeSettingsInputsDirty = false;

function ensureClaudeSettingsInputTracking() {
  const input = document.getElementById('claude-model-input');
  if (!input || input.dataset.claudeDirtyTracking === '1') return;
  input.dataset.claudeDirtyTracking = '1';
  input.addEventListener('input', () => {
    claudeSettingsInputsDirty = true;
  });
}

function setClaudeSettingsControlsDisabled(disabled) {
  for (const id of ['claude-model-input', 'claude-enabled-toggle', 'claude-save-btn']) {
    const element = document.getElementById(id);
    if (element) element.disabled = disabled;
  }
}

export function applyClaudeSettingsState(settings = {}, { resetInputs = false } = {}) {
  ensureClaudeSettingsInputTracking();
  claudeSettingsState = {
    configured: settings?.enabled === true,
    enabled: settings?.enabled === true,
    model: String(settings?.model || claudeSettingsState.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5',
    models: Array.isArray(settings?.models) ? settings.models : claudeSettingsState.models,
  };
  const modelInput = document.getElementById('claude-model-input');
  const toggle = document.getElementById('claude-enabled-toggle');
  const status = document.getElementById('claude-settings-status');
  if (modelInput && (!claudeSettingsInputsDirty || resetInputs)) modelInput.value = claudeSettingsState.model;
  if (resetInputs) claudeSettingsInputsDirty = false;
  if (toggle) {
    toggle.checked = claudeSettingsState.enabled;
    toggle.disabled = claudeSettingsUpdateInFlight;
  }
  if (status) {
    status.textContent = claudeSettingsState.enabled
      ? `Claude is enabled. Select Claude in New Chat to use model ${claudeSettingsState.model}. Uses the host machine's logged-in Claude credentials.`
      : 'Not enabled. Enable to allow Claude selection in New Chat (requires a logged-in Claude Code CLI on the relay host).';
    status.dataset.state = claudeSettingsState.enabled ? 'active' : 'unconfigured';
  }
  window.syncAutoModelAvailability?.();
  return claudeSettingsState;
}

export async function refreshClaudeSettingsState() {
  const settings = await loadClaudeSettings();
  if (!settings) return null;
  return applyClaudeSettingsState(settings);
}

async function syncClaudeSettingsInputs() {
  const status = document.getElementById('claude-settings-status');
  if (!status) return;
  const settings = await refreshClaudeSettingsState();
  if (!settings) {
    status.textContent = 'Unable to load Claude settings.';
    status.dataset.state = 'error';
  }
}

export async function saveClaudeSettings() {
  if (claudeSettingsUpdateInFlight) return;
  const modelInput = document.getElementById('claude-model-input');
  const model = String(modelInput?.value || '').trim() || 'claude-sonnet-5';
  claudeSettingsUpdateInFlight = true;
  setClaudeSettingsControlsDisabled(true);
  try {
    const result = await updateClaudeSettings({ model });
    if (!result) throw new Error('Failed to save Claude settings.');
    applyClaudeSettingsState(result, { resetInputs: true });
    showTransientRelayNotice(
      result.warning
        ? `Claude settings saved. ${result.warning}`
        : `Claude settings saved for ${result.model}.`,
      result.warning ? 8000 : 4000,
    );
  } catch (error) {
    alert(error?.message || 'Failed to save Claude settings.');
  } finally {
    claudeSettingsUpdateInFlight = false;
    setClaudeSettingsControlsDisabled(false);
    applyClaudeSettingsState(claudeSettingsState);
  }
}

export async function toggleClaudeProvider(enabled) {
  if (claudeSettingsUpdateInFlight) return;
  claudeSettingsUpdateInFlight = true;
  setClaudeSettingsControlsDisabled(true);
  try {
    const result = await updateClaudeSettings({ enabled: enabled === true });
    if (!result) throw new Error('Failed to update the Claude provider.');
    applyClaudeSettingsState(result);
    const providerLabel = result.enabled ? 'Claude provider enabled' : 'Claude provider disabled';
    showTransientRelayNotice(
      `${providerLabel}.${result.warning ? ` ${result.warning}` : ''}`,
      result.warning ? 8000 : 4500,
    );
  } catch (error) {
    applyClaudeSettingsState(claudeSettingsState);
    alert(error?.message || 'Failed to update the Claude provider.');
  } finally {
    claudeSettingsUpdateInFlight = false;
    setClaudeSettingsControlsDisabled(false);
    applyClaudeSettingsState(claudeSettingsState);
  }
}

let cursorSettingsUpdateInFlight = false;
let cursorSettingsState = {
  configured: false,
  enabled: false,
  model: 'composer-2.5',
};
let cursorSettingsInputsDirty = false;

function ensureCursorSettingsInputTracking() {
  for (const id of ['cursor-api-key-input', 'cursor-model-input']) {
    const input = document.getElementById(id);
    if (!input || input.dataset.cursorDirtyTracking === '1') continue;
    input.dataset.cursorDirtyTracking = '1';
    input.addEventListener('input', () => {
      cursorSettingsInputsDirty = true;
    });
  }
}

function setCursorSettingsControlsDisabled(disabled) {
  for (const id of [
    'cursor-api-key-input',
    'cursor-model-input',
    'cursor-enabled-toggle',
    'cursor-save-btn',
    'cursor-remove-btn',
  ]) {
    const element = document.getElementById(id);
    if (element) element.disabled = disabled;
  }
}

export function applyCursorSettingsState(settings = {}, { resetInputs = false } = {}) {
  ensureCursorSettingsInputTracking();
  cursorSettingsState = {
    configured: settings?.configured === true,
    enabled: settings?.configured === true && settings?.enabled === true,
    model: String(settings?.model || cursorSettingsState.model || 'composer-2.5').trim() || 'composer-2.5',
  };
  const keyInput = document.getElementById('cursor-api-key-input');
  const modelInput = document.getElementById('cursor-model-input');
  const toggle = document.getElementById('cursor-enabled-toggle');
  const removeButton = document.getElementById('cursor-remove-btn');
  const status = document.getElementById('cursor-settings-status');
  if (keyInput && (!cursorSettingsInputsDirty || resetInputs)) {
    keyInput.value = '';
    keyInput.placeholder = cursorSettingsState.configured ? 'Saved API key (enter to replace)' : 'Cursor API key…';
  }
  if (modelInput && (!cursorSettingsInputsDirty || resetInputs)) modelInput.value = cursorSettingsState.model;
  if (resetInputs) cursorSettingsInputsDirty = false;
  if (toggle) {
    toggle.checked = cursorSettingsState.enabled;
    toggle.disabled = cursorSettingsUpdateInFlight || !cursorSettingsState.configured;
  }
  if (removeButton) {
    removeButton.disabled = cursorSettingsUpdateInFlight || !cursorSettingsState.configured;
  }
  if (status) {
    status.textContent = cursorSettingsState.enabled
      ? 'Cursor is enabled. Select Cursor in New Chat to use it.'
      : (cursorSettingsState.configured
          ? 'API key saved but currently disabled. Enable it to allow Cursor selection in New Chat.'
          : 'Not configured. New conversations use GitHub Copilot.');
    status.dataset.state = cursorSettingsState.enabled
      ? 'active'
      : (cursorSettingsState.configured ? 'saved' : 'unconfigured');
  }
  window.syncAutoModelAvailability?.();
  return cursorSettingsState;
}

export async function refreshCursorSettingsState() {
  const settings = await loadCursorSettings();
  if (!settings) return null;
  return applyCursorSettingsState(settings);
}

// ── Cursor manual plan allowances ──
// Cursor's SDK reports spend but not the included-pool balance, so these
// user-entered numbers are what the plan-usage card measures spend against.
let cursorAllowanceUpdateInFlight = false;

function setCursorAllowanceControlsDisabled(disabled) {
  for (const id of [
    'cursor-allowance-cursor-models-input',
    'cursor-allowance-other-models-input',
    'cursor-allowance-reset-day-input',
    'cursor-allowance-save-btn',
    'cursor-allowance-reset-btn',
  ]) {
    const element = document.getElementById(id);
    if (element) element.disabled = disabled;
  }
}

export function applyCursorAllowanceState(settings = {}) {
  const cursorModels = document.getElementById('cursor-allowance-cursor-models-input');
  const otherModels = document.getElementById('cursor-allowance-other-models-input');
  const resetDay = document.getElementById('cursor-allowance-reset-day-input');
  const status = document.getElementById('cursor-allowance-status');
  if (cursorModels) {
    cursorModels.value = settings?.cursorModelsUsd === null || settings?.cursorModelsUsd === undefined
      ? ''
      : String(settings.cursorModelsUsd);
  }
  if (otherModels) {
    otherModels.value = settings?.otherModelsUsd === null || settings?.otherModelsUsd === undefined
      ? ''
      : String(settings.otherModelsUsd);
  }
  if (resetDay) resetDay.value = String(settings?.resetDay ?? 1);
  if (status) {
    const configured = settings?.cursorModelsUsd != null || settings?.otherModelsUsd != null;
    status.textContent = configured
      ? `Tracking spend against your allowances; resets on day ${settings?.resetDay ?? 1} of each month.`
      : 'No allowance set — the usage card shows Cursor spend without a remaining balance.';
    status.dataset.state = configured ? 'active' : 'unconfigured';
  }
  setCursorAllowanceControlsDisabled(cursorAllowanceUpdateInFlight);
  return settings;
}

export async function refreshCursorAllowanceState() {
  try {
    const settings = await loadCursorAllowanceSettings();
    if (!settings) return null;
    return applyCursorAllowanceState(settings);
  } catch {
    const status = document.getElementById('cursor-allowance-status');
    if (status) {
      status.textContent = 'Unable to load Cursor allowances.';
      status.dataset.state = 'error';
    }
    return null;
  }
}

/**
 * Read one allowance field.
 *
 * A `type="number"` input reports an empty `value` for text the browser could
 * not parse, so `validity.badInput` is the only way to tell a deliberately
 * cleared field from "12,50" typed in a comma-decimal locale. Without that
 * check the second case silently posts `null` and wipes the allowance.
 *
 * @returns {number|null|undefined} the amount, null to clear, undefined when
 *   the control is absent (leave the stored value alone)
 * @throws {Error} when the field holds something that is not a valid amount
 */
function readAllowanceInput(id, label) {
  const input = document.getElementById(id);
  if (!input) return undefined;
  if (input.validity?.badInput) throw new Error(`${label} must be a number, for example 20 or 20.00.`);
  const raw = String(input.value ?? '').trim();
  // An emptied field clears the allowance rather than leaving the old value.
  if (raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be zero or a positive amount.`);
  return parsed;
}

function readResetDayInput() {
  const input = document.getElementById('cursor-allowance-reset-day-input');
  if (!input) return undefined;
  if (input.validity?.badInput) throw new Error('Billing reset day must be a whole number between 1 and 31.');
  const raw = String(input.value ?? '').trim();
  if (raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 31) {
    throw new Error('Billing reset day must be between 1 and 31.');
  }
  return Math.round(parsed);
}

export async function saveCursorAllowanceSettings({ resetAccounting = false } = {}) {
  if (cursorAllowanceUpdateInFlight) return;
  let payload;
  try {
    const resetDay = readResetDayInput();
    payload = {
      cursorModelsUsd: readAllowanceInput('cursor-allowance-cursor-models-input', 'Cursor Models allowance'),
      otherModelsUsd: readAllowanceInput('cursor-allowance-other-models-input', 'Other Models allowance'),
      ...(resetDay === undefined ? {} : { resetDay }),
      ...(resetAccounting ? { resetAccounting: true } : {}),
    };
  } catch (error) {
    alert(error?.message || 'Please check the Cursor allowance values.');
    return;
  }
  cursorAllowanceUpdateInFlight = true;
  setCursorAllowanceControlsDisabled(true);
  try {
    const result = await updateCursorAllowanceSettings(payload);
    cursorAllowanceUpdateInFlight = false;
    applyCursorAllowanceState(result);
    showTransientRelayNotice(resetAccounting
      ? 'Cursor allowances saved and tracked spend reset.'
      : 'Cursor allowances saved.');
  } catch (error) {
    cursorAllowanceUpdateInFlight = false;
    setCursorAllowanceControlsDisabled(false);
    alert(error?.message || 'Failed to update Cursor allowances.');
  }
}

export async function resetCursorAllowanceAccounting() {
  if (!confirm('Reset the tracked Cursor spend for the current billing cycle?')) return;
  await saveCursorAllowanceSettings({ resetAccounting: true });
}

async function syncCursorSettingsInputs() {
  const keyInput = document.getElementById('cursor-api-key-input');
  const modelInput = document.getElementById('cursor-model-input');
  const status = document.getElementById('cursor-settings-status');
  if (!keyInput || !modelInput || !status) return;
  const settings = await refreshCursorSettingsState();
  if (!settings) {
    status.textContent = 'Unable to load Cursor settings.';
    status.dataset.state = 'error';
    return;
  }
}

export async function saveCursorSettings() {
  if (cursorSettingsUpdateInFlight) return;
  const keyInput = document.getElementById('cursor-api-key-input');
  const modelInput = document.getElementById('cursor-model-input');
  const apiKey = String(keyInput?.value || '').trim();
  const model = String(modelInput?.value || '').trim() || 'composer-2.5';
  if (!apiKey && !cursorSettingsState.configured) {
    alert('Enter a Cursor API key.');
    return;
  }
  cursorSettingsUpdateInFlight = true;
  setCursorSettingsControlsDisabled(true);
  try {
    const result = await updateCursorSettings({
      apiKey,
      model,
      enabled: cursorSettingsState.configured ? cursorSettingsState.enabled : true,
    });
    if (!result) throw new Error('Failed to save Cursor settings.');
    applyCursorSettingsState(result, { resetInputs: true });
    showTransientRelayNotice(
      result.warning
        ? `Cursor settings saved. ${result.warning}`
        : `Cursor settings saved for ${result.model}.`,
      result.warning ? 8000 : 4000,
    );
  } catch (error) {
    alert(error?.message || 'Failed to save Cursor settings.');
  } finally {
    cursorSettingsUpdateInFlight = false;
    setCursorSettingsControlsDisabled(false);
    applyCursorSettingsState(cursorSettingsState);
  }
}

export async function toggleCursorProvider(enabled) {
  if (cursorSettingsUpdateInFlight) return;
  if (enabled && !cursorSettingsState.configured) {
    applyCursorSettingsState(cursorSettingsState);
    alert('Save a Cursor API key before enabling Cursor.');
    return;
  }
  cursorSettingsUpdateInFlight = true;
  setCursorSettingsControlsDisabled(true);
  try {
    const result = await updateCursorSettings({
      model: cursorSettingsState.model,
      enabled: enabled === true,
    });
    if (!result) throw new Error('Failed to update the Cursor provider.');
    applyCursorSettingsState(result);
    const providerLabel = result.enabled ? 'Cursor API key enabled' : 'Cursor API key disabled';
    showTransientRelayNotice(
      `${providerLabel}.${result.warning ? ` ${result.warning}` : ''}`,
      result.warning ? 8000 : 4500,
    );
  } catch (error) {
    applyCursorSettingsState(cursorSettingsState);
    alert(error?.message || 'Failed to update the Cursor provider.');
  } finally {
    cursorSettingsUpdateInFlight = false;
    setCursorSettingsControlsDisabled(false);
    applyCursorSettingsState(cursorSettingsState);
  }
}

export async function removeCursorSettings() {
  if (cursorSettingsUpdateInFlight) return;
  if (!cursorSettingsState.configured) return;
  if (!confirm('Remove the saved Cursor API key?')) return;
  const modelInput = document.getElementById('cursor-model-input');
  const model = String(modelInput?.value || '').trim() || 'composer-2.5';
  cursorSettingsUpdateInFlight = true;
  setCursorSettingsControlsDisabled(true);
  try {
    const result = await updateCursorSettings({ model, remove: true });
    if (!result) throw new Error('Failed to remove Cursor settings.');
    applyCursorSettingsState(result, { resetInputs: true });
    showTransientRelayNotice('Cursor API key removed. New conversations use GitHub Copilot.');
  } catch (error) {
    // A 409 'cursor-key-removal-blocked' rejection carries the active
    // conversation counts inside the server's error message.
    alert(error?.message || 'Failed to remove Cursor settings.');
  } finally {
    cursorSettingsUpdateInFlight = false;
    setCursorSettingsControlsDisabled(false);
    applyCursorSettingsState(cursorSettingsState);
  }
}

async function syncOpenAISettingsInputs() {
  const keyInput = document.getElementById('openai-api-key-input');
  const modelInput = document.getElementById('openai-model-input');
  const status = document.getElementById('openai-settings-status');
  if (!keyInput || !modelInput || !status) return;
  const settings = await refreshOpenAISettingsState();
  if (!settings) {
    status.textContent = 'Unable to load OpenAI settings.';
    status.dataset.state = 'error';
    return;
  }
}

export async function saveOpenAISettings() {
  if (openAISettingsUpdateInFlight) return;
  const keyInput = document.getElementById('openai-api-key-input');
  const modelInput = document.getElementById('openai-model-input');
  const baseUrlInput = document.getElementById('openai-base-url-input');
  const apiKey = String(keyInput?.value || '').trim();
  const model = String(modelInput?.value || '').trim() || 'gpt-4o';
  const baseUrl = String(baseUrlInput?.value || '').trim() || 'https://api.openai.com/v1';
  if (!apiKey && !openAISettingsState.configured) {
    alert('Enter an OpenAI API key.');
    return;
  }
  openAISettingsUpdateInFlight = true;
  setOpenAISettingsControlsDisabled(true);
  try {
    const result = await updateOpenAISettings({
      apiKey,
      model,
      baseUrl,
      enabled: openAISettingsState.configured ? openAISettingsState.enabled : true,
    });
    if (!result) throw new Error('Failed to save OpenAI settings.');
    applyOpenAISettingsState(result, { resetInputs: true });
    showTransientRelayNotice(
      result.warning
        ? `OpenAI settings saved. ${result.warning}`
        : `OpenAI settings saved for ${result.model}.`,
      result.warning ? 8000 : 4000,
    );
  } catch (error) {
    alert(error?.message || 'Failed to save OpenAI settings.');
  } finally {
    openAISettingsUpdateInFlight = false;
    setOpenAISettingsControlsDisabled(false);
    applyOpenAISettingsState(openAISettingsState);
  }
}

export async function toggleOpenAIProvider(enabled) {
  if (openAISettingsUpdateInFlight) return;
  if (enabled && !openAISettingsState.configured) {
    applyOpenAISettingsState(openAISettingsState);
    alert('Save an OpenAI API key before enabling OpenAI.');
    return;
  }
  openAISettingsUpdateInFlight = true;
  setOpenAISettingsControlsDisabled(true);
  try {
    const result = await updateOpenAISettings({
      model: openAISettingsState.model,
      baseUrl: openAISettingsState.baseUrl,
      enabled: enabled === true,
    });
    if (!result) throw new Error('Failed to update OpenAI provider.');
    applyOpenAISettingsState(result);
    const providerLabel = result.enabled ? 'OpenAI API key enabled' : 'OpenAI API key disabled';
    showTransientRelayNotice(
      `${providerLabel}.${result.warning ? ` ${result.warning}` : ''}`,
      result.warning ? 8000 : 4500,
    );
  } catch (error) {
    applyOpenAISettingsState(openAISettingsState);
    alert(error?.message || 'Failed to update OpenAI provider.');
  } finally {
    openAISettingsUpdateInFlight = false;
    setOpenAISettingsControlsDisabled(false);
    applyOpenAISettingsState(openAISettingsState);
  }
}

export async function removeOpenAISettings() {
  if (openAISettingsUpdateInFlight) return;
  if (!openAISettingsState.configured) return;
  if (!confirm('Remove the saved OpenAI API key?')) return;
  const modelInput = document.getElementById('openai-model-input');
  const model = String(modelInput?.value || '').trim() || 'gpt-4o';
  openAISettingsUpdateInFlight = true;
  setOpenAISettingsControlsDisabled(true);
  try {
    const result = await updateOpenAISettings({ model, remove: true });
    if (!result) throw new Error('Failed to remove OpenAI settings.');
    applyOpenAISettingsState(result, { resetInputs: true });
    showTransientRelayNotice('OpenAI API key removed. New conversations use GitHub Copilot.');
  } catch (error) {
    alert(error?.message || 'Failed to remove OpenAI settings.');
  } finally {
    openAISettingsUpdateInFlight = false;
    setOpenAISettingsControlsDisabled(false);
    applyOpenAISettingsState(openAISettingsState);
  }
}

function syncWindowsAutostartSetting() {
  const container = document.getElementById('windows-autostart-setting');
  const checkbox = document.getElementById('windows-autostart-toggle');
  const supported = serverPlatform === 'win32';
  if (container) container.hidden = !supported;
  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = windowsAutostartEnabled;
    checkbox.disabled = !supported || windowsAutostartUpdateInFlight;
  }
}

export async function refreshWindowsAutostartSetting() {
  syncWindowsAutostartSetting();
  if (serverPlatform !== 'win32' || windowsAutostartUpdateInFlight) return;
  windowsAutostartUpdateInFlight = true;
  syncWindowsAutostartSetting();
  try {
    const result = await loadWindowsAutostartSetting();
    if (!result?.supported) {
      alert('Failed to read the Windows autostart setting.');
      return;
    }
    windowsAutostartEnabled = !!result.enabled;
  } catch (error) {
    alert(error?.message || 'Failed to read the Windows autostart setting.');
  } finally {
    windowsAutostartUpdateInFlight = false;
    syncWindowsAutostartSetting();
  }
}

export async function updateWindowsAutostartSettingFromToggle(enabled) {
  if (serverPlatform !== 'win32' || windowsAutostartUpdateInFlight) {
    syncWindowsAutostartSetting();
    return;
  }
  windowsAutostartUpdateInFlight = true;
  syncWindowsAutostartSetting();
  try {
    const result = await updateWindowsAutostartSetting(!!enabled);
    if (!result?.supported) {
      alert('Failed to update the Windows autostart setting.');
      return;
    }
    windowsAutostartEnabled = !!result.enabled;
    showTransientRelayNotice(
      windowsAutostartEnabled
        ? 'Windows autostart enabled.'
        : 'Windows autostart disabled.',
    );
  } catch (error) {
    alert(error?.message || 'Failed to update the Windows autostart setting.');
  } finally {
    windowsAutostartUpdateInFlight = false;
    syncWindowsAutostartSetting();
  }
}

function readShowSuspendHostSetting() {
  const stored = String(readLocalStorage(SHOW_SUSPEND_HOST_STORAGE_KEY) || '').trim().toLowerCase();
  if (!stored) return true;
  return stored !== '0' && stored !== 'false';
}

function setShowSuspendHostSetting(show, { persist = true } = {}) {
  const next = !!show;
  if (persist) writeLocalStorage(SHOW_SUSPEND_HOST_STORAGE_KEY, next ? '1' : '0');
  return next;
}

export function isSuspendHostActionVisible() {
  return readShowSuspendHostSetting();
}

export function syncSuspendHostVisibility() {
  const show = isSuspendHostActionVisible();
  const menuBtn = document.getElementById('chat-menu-suspend-host');
  const checkbox = document.getElementById('show-suspend-host-toggle');
  if (menuBtn) {
    menuBtn.hidden = !show;
    menuBtn.disabled = !show;
    menuBtn.tabIndex = show ? 0 : -1;
    menuBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
  }
  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = show;
  }
}

export function initTheme() {
  const saved = readLocalStorage(THEME_STORAGE_KEY);
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function updateTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    writeLocalStorage(THEME_STORAGE_KEY, 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
    writeLocalStorage(THEME_STORAGE_KEY, 'dark');
  }
}

export function updateShowSuspendHostSetting(next) {
  setShowSuspendHostSetting(next, { persist: true });
  syncSuspendHostVisibility();
}

export async function updateDefaultSessionWorkspaceRootSetting(rawValue) {
  if (defaultSessionWorkspaceRootUpdateInFlight) {
    syncDefaultSessionWorkspaceRootInput();
    return;
  }
  const normalizedPath = normalizeKnownCwdPath(rawValue);
  defaultSessionWorkspaceRootUpdateInFlight = true;
  try {
    const result = await updateDefaultSessionWorkspaceRoot(normalizedPath, {
      clear: !normalizedPath,
    });
    if (!result) {
      alert('Failed to update the default CWD for new sessions.');
      syncDefaultSessionWorkspaceRootInput();
      return;
    }
    syncDefaultSessionWorkspaceRootInput();
    if (result.defaultSessionWorkspaceRootWarning) {
      showTransientRelayNotice(String(result.defaultSessionWorkspaceRootWarning), 7000);
    }
    if (normalizedPath) {
      const savedPath = String(result.defaultSessionWorkspaceRootPath || normalizedPath).trim();
      showTransientRelayNotice(`Default CWD for new sessions saved as ${savedPath}.`);
    } else {
      showTransientRelayNotice('Default CWD reset. New sessions will use relay workspace root.');
    }
  } catch (error) {
    alert(error?.message || 'Failed to update the default CWD for new sessions.');
    syncDefaultSessionWorkspaceRootInput();
  } finally {
    defaultSessionWorkspaceRootUpdateInFlight = false;
  }
}

export function openSettingsModal() {
  closeChatActionsMenu();
  const modal = document.getElementById('settings-modal');
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.value = readLocalStorage(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  }
  syncSuspendHostVisibility();
  syncFontScaleSelect();
  syncPwaAppNameInput();
  syncDefaultSessionWorkspaceRootInput();
  openAISettingsInputsDirty = false;
  ensureOpenAISettingsInputTracking();
  void syncOpenAISettingsInputs();
  claudeSettingsInputsDirty = false;
  ensureClaudeSettingsInputTracking();
  void syncClaudeSettingsInputs();
  cursorSettingsInputsDirty = false;
  ensureCursorSettingsInputTracking();
  void syncCursorSettingsInputs();
  void refreshCursorAllowanceState();
  syncWindowsAutostartSetting();
  void refreshWindowsAutostartSetting();
  syncTurnCeilingSlider();
  void refreshTurnCeilingSetting();
  void refreshPushSettingsSection();
  modal?.classList.add('visible');
  modal?.setAttribute('aria-hidden', 'false');
}

export function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
}
