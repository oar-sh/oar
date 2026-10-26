// Settings → Providers → Claude API: Claude chats on an API key from the
// Claude Console. The key (written, never read back: the tab only says that
// one is saved), the switch, the default model and the monthly spend cap.
// The relay asks Anthropic for the key's models when a key is saved, when the
// provider is switched on again, and on Refresh models. Commit attribution,
// the background command limit, the effort levels and the compaction window
// are the Claude tab's: a link there says so.

import { loadClaudeApiSettings, refreshModelVariantCatalog, updateClaudeApiSettings } from './api-client.js';
import { selectSettingsTab } from './settings-tabs.js';
import { showTransientRelayNotice } from './store.js';

export const CLAUDE_API_BILLING_URL = 'https://platform.claude.com/settings/billing';
export const CLAUDE_API_LIMITS_URL = 'https://platform.claude.com/settings/limits';
export const CLAUDE_API_KEYS_URL = 'https://platform.claude.com/settings/keys';

let updateInFlight = false;
let inputsDirty = false;
// The default model was picked by hand since the tab was filled. Only such a
// pick, from the key's own list, is saved as the default: a save that sends
// whatever the select shows would pin a model the key may not have (before
// discovery the select shows the Claude tab's list).
let modelChosen = false;
let state = {
  configured: false,
  enabled: false,
  model: '',
  availableModels: [],
  discovered: false,
  monthlyCapUsd: null,
  discoveryError: null,
};
const listeners = new Set();

const CONTROL_IDS = [
  'claude-api-key-input',
  'claude-api-model-select',
  'claude-api-monthly-cap-input',
  'claude-api-enabled-toggle',
  'claude-api-save-btn',
  'claude-api-remove-btn',
  'claude-api-refresh-btn',
];

function element(id) {
  return document.getElementById(id);
}

function ensureInputTracking() {
  for (const id of ['claude-api-key-input', 'claude-api-model-select', 'claude-api-monthly-cap-input']) {
    const input = element(id);
    if (!input || input.dataset.claudeApiDirtyTracking === '1') continue;
    input.dataset.claudeApiDirtyTracking = '1';
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
      inputsDirty = true;
      if (id === 'claude-api-monthly-cap-input') showCapError('');
      if (id === 'claude-api-model-select') modelChosen = true;
    });
  }
}

function setControlsDisabled(disabled) {
  for (const id of CONTROL_IDS) {
    const control = element(id);
    if (control) control.disabled = disabled;
  }
}

function fillModelSelect(select) {
  const models = Array.from(new Set([state.model, ...state.availableModels].filter(Boolean)));
  select.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }
  select.value = state.model;
}

/** The cap as the field shows it: "25", "12.5", or '' for none. */
export function claudeApiCapInputText(capUsd) {
  const value = Number(capUsd);
  return Number.isFinite(value) && value > 0 ? String(value) : '';
}

/**
 * The cap field's text as the relay takes it: `{ ok: true, capUsd }` (null:
 * no cap), else `{ ok: false, error }`. The relay checks it again.
 */
export function parseClaudeApiCapInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: true, capUsd: null };
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) || !(Number(value) > 0)) {
    return { ok: false, error: 'The monthly cap must be an amount of US dollars above 0 with at most two decimals, or empty for no cap.' };
  }
  return { ok: true, capUsd: Number(value) };
}

// Why the cap field's text is refused, under the field; '' clears it.
function showCapError(text) {
  const message = element('claude-api-monthly-cap-error');
  const input = element('claude-api-monthly-cap-input');
  if (message) {
    message.textContent = text;
    message.hidden = !text;
  }
  if (input) {
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

/** The tab's status line: `{ text, state }`. */
export function claudeApiSettingsStatus(settings = {}) {
  // Anthropic refused the key when it was saved or its models refreshed: the
  // key stays saved, and the tab says why it does not work yet.
  if (settings.configured === true && settings.discoveryError?.error) {
    const changed = settings.discoveryError.defaultModelChanged;
    const note = changed?.from && changed?.to
      ? ` Until it lists this key's models, the default model is ${changed.to} (was ${changed.from}).`
      : '';
    return { text: `API key saved, but Anthropic refused it: ${settings.discoveryError.error}${note}`, state: 'error' };
  }
  if (settings.configured === true && settings.enabled === true) {
    return {
      text: 'API key saved. Claude API is on: pick it in New Chat, or switch a Claude chat to the API key.',
      state: 'active',
    };
  }
  if (settings.configured === true) {
    return { text: 'API key saved, Claude API is off. Switch it on to offer it in New Chat.', state: 'saved' };
  }
  return { text: 'No API key saved. Claude chats run on the relay host\'s Claude login.', state: 'unconfigured' };
}

export function claudeApiSettingsState() {
  return state;
}

/** Called with the tab's state whenever it changes (the composer's toggle listens). */
export function onClaudeApiSettingsChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyClaudeApiSettingsState(settings = {}, { resetInputs = false } = {}) {
  if (typeof document !== 'undefined') ensureInputTracking();
  const available = Array.isArray(settings?.availableModels)
    ? settings.availableModels.map((value) => String(value || '').trim()).filter(Boolean)
    : state.availableModels;
  const cap = Number(settings?.monthlyCapUsd);
  state = {
    configured: settings?.configured === true,
    enabled: settings?.configured === true && settings?.enabled === true,
    model: String(settings?.model || state.model || '').trim(),
    availableModels: available.length ? available : state.availableModels,
    discovered: settings?.discovered === true,
    monthlyCapUsd: Number.isFinite(cap) && cap > 0 ? cap : null,
    // From a save's or a refresh's answer; a plain read keeps the last one.
    discoveryError: settings?.configured !== true
      ? null
      : (Object.prototype.hasOwnProperty.call(settings || {}, 'discoveryError') ? (settings.discoveryError || null) : (state.discoveryError || null)),
  };
  for (const listener of listeners) {
    try { listener(state); } catch {}
  }
  if (typeof document === 'undefined') return state;
  const keepInputs = inputsDirty && !resetInputs;
  const keyInput = element('claude-api-key-input');
  if (keyInput && !keepInputs) {
    // Never filled from the relay: it has no key to give back.
    keyInput.value = '';
    keyInput.placeholder = state.configured ? 'Saved API key (enter to replace)' : 'Claude Console API key…';
  }
  const modelSelect = element('claude-api-model-select');
  if (modelSelect && !keepInputs) fillModelSelect(modelSelect);
  const capInput = element('claude-api-monthly-cap-input');
  if (capInput && !keepInputs) {
    capInput.value = claudeApiCapInputText(state.monthlyCapUsd);
    showCapError('');
  }
  if (resetInputs) {
    inputsDirty = false;
    modelChosen = false;
  }
  const toggle = element('claude-api-enabled-toggle');
  if (toggle) {
    toggle.checked = state.enabled;
    toggle.disabled = updateInFlight || !state.configured;
  }
  const removeButton = element('claude-api-remove-btn');
  if (removeButton) removeButton.disabled = updateInFlight || !state.configured;
  const refreshButton = element('claude-api-refresh-btn');
  if (refreshButton) refreshButton.disabled = updateInFlight || !state.enabled;
  const modelsNote = element('claude-api-models-status');
  if (modelsNote) {
    modelsNote.textContent = state.configured && !state.discovered
      ? 'Not listed by Anthropic yet: these are the Claude tab\'s models until the key\'s list is read.'
      : '';
    modelsNote.hidden = !modelsNote.textContent;
  }
  const status = element('claude-api-settings-status');
  if (status) {
    const { text, state: statusState } = claudeApiSettingsStatus(state);
    status.textContent = text;
    status.dataset.state = statusState;
  }
  window.syncAutoModelAvailability?.();
  return state;
}

export async function refreshClaudeApiSettingsState() {
  const settings = await loadClaudeApiSettings();
  if (!settings) return null;
  return applyClaudeApiSettingsState(settings);
}

/** Called when the Settings modal opens. */
export async function syncClaudeApiSettingsInputs() {
  inputsDirty = false;
  modelChosen = false;
  ensureInputTracking();
  const status = element('claude-api-settings-status');
  const settings = await refreshClaudeApiSettingsState();
  if (!settings && status) {
    status.textContent = 'Unable to load Claude API settings.';
    status.dataset.state = 'error';
  }
}

async function runUpdate(payload, { successText, failureText, resetInputs = false }) {
  if (updateInFlight) return null;
  updateInFlight = true;
  setControlsDisabled(true);
  try {
    const result = await updateClaudeApiSettings(payload);
    if (!result) throw new Error(failureText);
    applyClaudeApiSettingsState(result, { resetInputs });
    const text = typeof successText === 'function' ? successText(result) : successText;
    showTransientRelayNotice(result.warning ? `${text} ${result.warning}` : text, result.warning ? 8000 : 4000);
    return result;
  } catch (error) {
    // A refused key (a login token, an Admin key) or a refused removal (409)
    // says why; the relay never quotes the key back.
    alert(error?.message || failureText);
    return null;
  } finally {
    updateInFlight = false;
    setControlsDisabled(false);
    applyClaudeApiSettingsState(state);
  }
}

export async function saveClaudeApiSettings() {
  const apiKey = String(element('claude-api-key-input')?.value || '').trim();
  if (!apiKey && !state.configured) {
    alert('Enter an API key from the Claude Console.');
    return;
  }
  const capInput = element('claude-api-monthly-cap-input');
  // A number field reads '' for text it cannot parse: that is not "no cap".
  const cap = capInput?.validity?.badInput
    ? parseClaudeApiCapInput('not a number')
    : parseClaudeApiCapInput(capInput?.value);
  showCapError(cap.ok ? '' : cap.error);
  if (!cap.ok) {
    capInput?.focus?.();
    return;
  }
  // A pick from the key's discovered list; otherwise the relay keeps the
  // default it has, or derives one from the key's models.
  const model = modelChosen && state.discovered
    ? String(element('claude-api-model-select')?.value || '').trim()
    : '';
  await runUpdate({
    apiKey,
    ...(model ? { model } : {}),
    monthlyCapUsd: cap.capUsd,
    enabled: state.configured ? state.enabled : true,
  }, {
    successText: (result) => (result.model ? `Claude API settings saved for ${result.model}.` : 'Claude API settings saved.'),
    failureText: 'Failed to save Claude API settings.',
    resetInputs: true,
  });
}

export async function toggleClaudeApiProvider(enabled) {
  if (enabled && !state.configured) {
    applyClaudeApiSettingsState(state);
    alert('Save an API key from the Claude Console before switching Claude API on.');
    return;
  }
  await runUpdate({ enabled: enabled === true }, {
    successText: (result) => (result.enabled ? 'Claude API switched on.' : 'Claude API switched off.'),
    failureText: 'Failed to update the Claude API provider.',
  });
}

export async function removeClaudeApiSettings() {
  if (!state.configured) return;
  if (!confirm('Remove the saved Claude API key?')) return;
  await runUpdate({ remove: true }, {
    successText: 'Claude API key removed.',
    failureText: 'Failed to remove the Claude API key.',
    resetInputs: true,
  });
}

/** Asks Anthropic for the key's models again (the relay's model refresh). */
export async function refreshClaudeApiModels() {
  if (updateInFlight || !state.enabled) return;
  updateInFlight = true;
  setControlsDisabled(true);
  try {
    const refreshed = await refreshModelVariantCatalog();
    const discovery = refreshed?.claudeApiModelDiscovery || null;
    await refreshClaudeApiSettingsState();
    if (discovery && !discovery.skipped) {
      state = {
        ...state,
        discoveryError: discovery.ok === false && discovery.stale !== true
          ? { error: discovery.error || 'Claude API model discovery failed', code: discovery.code || null }
          : (discovery.ok === true ? null : state.discoveryError),
      };
    }
    if (!refreshed) {
      showTransientRelayNotice('Could not refresh the models.', 6000);
    } else if (discovery && discovery.ok === false && !discovery.skipped) {
      showTransientRelayNotice(`Claude API model discovery failed. The stored models were kept: ${discovery.error || 'unknown error'}`, 8000);
    } else {
      showTransientRelayNotice('Claude API models refreshed.', 4000);
    }
  } finally {
    updateInFlight = false;
    setControlsDisabled(false);
    applyClaudeApiSettingsState(state);
  }
}

/** The cap refusal's button: the cap field, ready to raise or empty. */
export function focusClaudeApiCapInput() {
  const input = element('claude-api-monthly-cap-input');
  if (!input) return;
  input.scrollIntoView?.({ block: 'center' });
  input.focus?.();
}

// The settings Claude API chats share with Claude chats live on the Claude
// tab: one place to change them.
export function openClaudeTabFromClaudeApi() {
  selectSettingsTab('providers', 'claude');
}

export function __resetClaudeApiSettingsUiForTests() {
  updateInFlight = false;
  inputsDirty = false;
  modelChosen = false;
  state = { configured: false, enabled: false, model: '', availableModels: [], discovered: false, monthlyCapUsd: null, discoveryError: null };
  listeners.clear();
}
