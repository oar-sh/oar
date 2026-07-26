import {
  defaultSessionWorkspaceRootPath,
  defaultSessionWorkspaceRootWarning,
  serverPlatform,
  showTransientRelayNotice,
} from './store.js';
import {
  loadOpenAISettings,
  updateDefaultSessionWorkspaceRoot,
  updateOpenAISettings,
  loadWindowsAutostartSetting,
  updateWindowsAutostartSetting,
} from './api-client.js';
import { syncFontScaleSelect } from './font-scaling.js';
import { syncPwaAppNameInput } from './pwa-install.js';
import { normalizeKnownCwdPath } from './cwd-picker.js';

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
  const header = document.getElementById('provider-status-pill');
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
  if (header) {
    header.textContent = 'GitHub Copilot';
    header.dataset.provider = 'github';
    header.title = openAISettingsState.enabled
      ? `GitHub Copilot is active by default; OpenAI is enabled for optional new-chat selection (${openAISettingsState.model})`
      : (openAISettingsState.configured
          ? 'GitHub Copilot is active; OpenAI API key is saved but currently disabled'
          : 'GitHub Copilot is active');
  }
  window.syncAutoModelAvailability?.();
  return openAISettingsState;
}

export async function refreshOpenAISettingsState() {
  const settings = await loadOpenAISettings();
  if (!settings) return null;
  return applyOpenAISettingsState(settings);
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
  syncWindowsAutostartSetting();
  void refreshWindowsAutostartSetting();
  modal?.classList.add('visible');
  modal?.setAttribute('aria-hidden', 'false');
}

export function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
}
