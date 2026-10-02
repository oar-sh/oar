// Settings → Providers → Claude Cloud, and the client's copy of that tab's
// settings (the New Chat modal and the composer read their model list from it).
//
// One payload shape everywhere: GET and POST /api/settings/claude-cloud and the
// `claude_cloud_settings_updated` socket event all carry
// { enabled, defaultModel, environmentId, environments, environmentsError,
//   account, token, models }, so every source goes through
// applyClaudeCloudSettingsState and rendering is idempotent.
//
// The tab is always there so the provider can be switched on from it. A relay
// that does not know the routes yet answers nothing: the tab then says so in
// plain muted text and the controls stay off — not an error, just an older relay.
//
// Secret hygiene: the payload never carries the login token, only where it was
// read from and when it expires.

import { showTransientRelayNotice } from './store.js';
import { loadClaudeCloudSettings, updateClaudeCloudSettings } from './api-client.js';
import { selectSettingsTab } from './settings-tabs.js';
import { humanizeModelLabel } from './model-selector-options.mjs';
import { claudeCloudDefaultModel, claudeCloudModelIds } from './claude-cloud-ui.mjs';

// null until the first successful read: "never answered" is not "disabled".
let settingsState = null;
let settingsLoadFailed = false;
let updateInFlight = false;
let inputsDirty = false;
// A refused save or toggle, shown in the status line until the next state.
let localError = '';
const listeners = new Set();

export function getClaudeCloudSettings() {
  return settingsState;
}

export function isClaudeCloudEnabled() {
  return settingsState?.enabled === true;
}

/** Called after every state change; returns an unsubscribe function. */
export function subscribeClaudeCloudSettings(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener(settingsState);
    } catch (error) {
      console.error('[claude-cloud] settings listener failed', error);
    }
  }
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeSettingsPayload(payload = {}, previous = null) {
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  const keep = (key, fallback) => (previous && Object.prototype.hasOwnProperty.call(previous, key)
    ? previous[key]
    : fallback);
  return {
    enabled: has('enabled') ? payload.enabled === true : keep('enabled', false),
    defaultModel: has('defaultModel') ? oneLine(payload.defaultModel) : keep('defaultModel', ''),
    environmentId: has('environmentId') ? oneLine(payload.environmentId) : keep('environmentId', ''),
    environments: has('environments')
      ? (Array.isArray(payload.environments) ? payload.environments : null)
      : keep('environments', null),
    environmentsError: has('environmentsError') ? oneLine(payload.environmentsError) : keep('environmentsError', ''),
    account: has('account')
      ? (payload.account && typeof payload.account === 'object' ? payload.account : null)
      : keep('account', null),
    token: has('token')
      ? (payload.token && typeof payload.token === 'object' ? payload.token : null)
      : keep('token', null),
    models: has('models')
      ? (Array.isArray(payload.models) ? payload.models.map((model) => oneLine(model)).filter(Boolean) : [])
      : keep('models', []),
  };
}

function subscriptionLabel(value) {
  const text = oneLine(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** "dev@example.com · Example Org · Max": the account cloud chats are billed to. */
export function claudeCloudAccountLineText(account) {
  if (!account) return 'Claude account status unavailable.';
  if (account.loggedIn !== true) return 'Not signed in to Claude on the relay host.';
  const parts = [oneLine(account.email), oneLine(account.orgName), subscriptionLabel(account.subscriptionType)]
    .filter((part, index, all) => part && all.indexOf(part) === index);
  return parts.length ? `Billed to ${parts.join(' · ')}` : 'Signed in to Claude.';
}

export function claudeCloudAccountLineState(account) {
  if (!account) return 'pending';
  return account.loggedIn === true ? 'active' : 'unconfigured';
}

function defaultFormatTime(date) {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Where the relay reads the login from and how long it lasts. An expired file
 * token is not a logged-out verdict: the Claude CLI rewrites the file whenever
 * it refreshes, and the relay re-reads it on the next cloud call.
 */
export function claudeCloudTokenLineText(token, { now = Date.now(), formatTime = defaultFormatTime } = {}) {
  const source = oneLine(token?.source).toLowerCase();
  if (!token || token.hasToken !== true || source === 'none') {
    return 'No Claude login found on the relay host. Sign in on the Claude tab first.';
  }
  if (source === 'env') return 'Login: CLAUDE_CODE_OAUTH_TOKEN from the relay environment.';
  const expiresAtMs = token.expiresAt ? Date.parse(token.expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) return 'Login: read from the Claude CLI on the relay host.';
  if (expiresAtMs <= Number(now)) {
    return 'Login: read from the Claude CLI on the relay host. It has expired; the relay picks up the new one as soon as the CLI refreshes it.';
  }
  return `Login: read from the Claude CLI on the relay host, valid until ${formatTime(new Date(expiresAtMs))}.`;
}

export function claudeCloudTokenLineState(token, { now = Date.now() } = {}) {
  if (!token || token.hasToken !== true || oneLine(token.source).toLowerCase() === 'none') return 'error';
  const expiresAtMs = token.expiresAt ? Date.parse(token.expiresAt) : NaN;
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Number(now) ? 'pending' : 'active';
}

/**
 * The environment select's options: what the account lists, plus the stored id
 * when the list does not carry it (the list call failed, or the environment
 * was removed) so saving something else never silently drops it.
 */
export function claudeCloudEnvironmentOptions(settings) {
  const options = [];
  const seen = new Set();
  for (const environment of Array.isArray(settings?.environments) ? settings.environments : []) {
    const id = oneLine(environment?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = oneLine(environment?.name);
    options.push({ value: id, label: name ? `${name} (${id})` : id });
  }
  const stored = oneLine(settings?.environmentId);
  if (stored && !seen.has(stored)) options.push({ value: stored, label: `${stored} (saved)` });
  return options;
}

/**
 * Why the environment select has nothing (or not everything) to offer. The
 * relay asks Anthropic for the list only while the provider is on and a login
 * exists, so "not listed" and "the account has none" are different answers.
 */
export function claudeCloudEnvironmentNoteText(settings) {
  const error = oneLine(settings?.environmentsError);
  if (error) return `Could not list the cloud environments: ${error}`;
  if (claudeCloudEnvironmentOptions(settings).length) return '';
  if (Array.isArray(settings?.environments)) {
    return 'No cloud environment found. Open claude.ai/code once with this account to create the default one.';
  }
  if (settings?.token && settings.token.hasToken !== true) {
    return 'The environments are listed once the relay host is signed in to Claude.';
  }
  return settings?.enabled
    ? 'The cloud environments have not been listed yet.'
    : 'The environments of the account are listed once Claude Cloud is enabled.';
}

export function claudeCloudModelOptions(settings) {
  return claudeCloudModelIds(settings).map((value) => ({ value, label: humanizeModelLabel(value) || value }));
}

export function claudeCloudStatusLine(settings, { loadFailed = false, error = '' } = {}) {
  if (error) return { text: error, state: 'error' };
  if (!settings) {
    return loadFailed
      ? { text: 'Claude Cloud is not available on this relay.', state: 'unconfigured' }
      : { text: 'Loading Claude Cloud settings…', state: 'pending' };
  }
  if (settings.enabled) {
    const model = oneLine(settings.defaultModel);
    return {
      text: `Claude Cloud is enabled. Select Claude Cloud in New Chat${model ? ` to start with ${humanizeModelLabel(model) || model}` : ''}.`,
      state: 'active',
    };
  }
  return {
    text: 'Not enabled. Enable to offer Claude Cloud in New Chat (needs a Claude login on the relay host).',
    state: 'unconfigured',
  };
}

function fillSelect(select, options, selectedValue, emptyLabel) {
  if (!select) return;
  // The user's unsaved pick survives a re-render (a socket update, a refresh).
  const wanted = inputsDirty ? String(select.value || '') : String(selectedValue || '');
  select.innerHTML = '';
  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.appendChild(option);
    select.value = '';
    return;
  }
  for (const entry of options) {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    select.appendChild(option);
  }
  const values = options.map((entry) => entry.value);
  select.value = values.includes(wanted)
    ? wanted
    : (values.includes(String(selectedValue || '')) ? String(selectedValue) : values[0]);
}

function ensureInputTracking() {
  for (const id of ['claude-cloud-environment-select', 'claude-cloud-model-select']) {
    const select = document.getElementById(id);
    if (!select || select.dataset.claudeCloudDirtyTracking === '1') continue;
    select.dataset.claudeCloudDirtyTracking = '1';
    select.addEventListener('change', () => {
      inputsDirty = true;
    });
  }
}

export function renderClaudeCloudSettingsSection() {
  const panel = document.getElementById('settings-provider-panel-claude-cloud');
  if (!panel) return;
  ensureInputTracking();
  const settings = settingsState;
  const available = !!settings;
  const environmentOptions = claudeCloudEnvironmentOptions(settings);
  const modelOptions = claudeCloudModelOptions(settings);

  const toggle = document.getElementById('claude-cloud-enabled-toggle');
  if (toggle) {
    toggle.checked = settings?.enabled === true;
    toggle.disabled = !available || updateInFlight;
  }

  const account = document.getElementById('claude-cloud-account');
  if (account) {
    account.textContent = available ? claudeCloudAccountLineText(settings.account) : '';
    account.dataset.state = available ? claudeCloudAccountLineState(settings.account) : 'pending';
  }
  const accountRow = document.getElementById('claude-cloud-account-row');
  if (accountRow) accountRow.hidden = !available;

  const token = document.getElementById('claude-cloud-token');
  if (token) {
    token.hidden = !available;
    token.textContent = available ? claudeCloudTokenLineText(settings.token) : '';
    token.dataset.state = available ? claudeCloudTokenLineState(settings.token) : 'pending';
  }

  const environmentSelect = document.getElementById('claude-cloud-environment-select');
  fillSelect(
    environmentSelect,
    environmentOptions,
    settings?.environmentId,
    Array.isArray(settings?.environments) ? 'No environment found' : 'Not listed yet',
  );
  if (environmentSelect) environmentSelect.disabled = !available || updateInFlight || !environmentOptions.length;

  const environmentNote = document.getElementById('claude-cloud-environment-note');
  if (environmentNote) {
    const noteText = available ? claudeCloudEnvironmentNoteText(settings) : '';
    environmentNote.textContent = noteText;
    environmentNote.hidden = !noteText;
  }

  const modelSelect = document.getElementById('claude-cloud-model-select');
  fillSelect(modelSelect, modelOptions, claudeCloudDefaultModel(settings), 'No model available');
  if (modelSelect) modelSelect.disabled = !available || updateInFlight || !modelOptions.length;

  const saveButton = document.getElementById('claude-cloud-save-btn');
  if (saveButton) saveButton.disabled = !available || updateInFlight;

  const status = document.getElementById('claude-cloud-settings-status');
  if (status) {
    const line = claudeCloudStatusLine(settings, { loadFailed: settingsLoadFailed, error: localError });
    status.textContent = line.text;
    status.dataset.state = line.state;
  }
}

// Single entry point for every payload (GET, POST response, socket event).
export function applyClaudeCloudSettingsState(payload, { resetInputs = false } = {}) {
  if (!payload || typeof payload !== 'object') return settingsState;
  settingsState = normalizeSettingsPayload(payload, settingsState);
  settingsLoadFailed = false;
  localError = '';
  if (resetInputs) inputsDirty = false;
  renderClaudeCloudSettingsSection();
  notifyListeners();
  return settingsState;
}

export async function refreshClaudeCloudSettingsState() {
  const payload = await loadClaudeCloudSettings();
  if (!payload) {
    // Keep what an earlier read said: one failed refresh is not "gone".
    settingsLoadFailed = !settingsState;
    renderClaudeCloudSettingsSection();
    return settingsState;
  }
  return applyClaudeCloudSettingsState(payload);
}

// Opening the modal starts from what is saved, as the other provider tabs do.
export function openClaudeCloudSettingsSection() {
  inputsDirty = false;
  localError = '';
  renderClaudeCloudSettingsSection();
  return refreshClaudeCloudSettingsState();
}

async function submitClaudeCloudSettings(change, { successNotice, failureText, resetInputs = false }) {
  if (updateInFlight || !settingsState) return;
  updateInFlight = true;
  localError = '';
  renderClaudeCloudSettingsSection();
  try {
    const result = await updateClaudeCloudSettings(change);
    if (!result) throw new Error(failureText);
    updateInFlight = false;
    applyClaudeCloudSettingsState(result, { resetInputs });
    showTransientRelayNotice(successNotice(settingsState));
  } catch (error) {
    // Inline rather than an alert: "sign in first" is an instruction to act on
    // in the tab next door, and it should still be there after switching back.
    localError = String(error?.message || failureText);
  } finally {
    updateInFlight = false;
    renderClaudeCloudSettingsSection();
  }
}

export async function toggleClaudeCloudProvider(enabled) {
  await submitClaudeCloudSettings(
    { enabled: enabled === true },
    {
      successNotice: (state) => (state?.enabled ? 'Claude Cloud enabled.' : 'Claude Cloud disabled.'),
      failureText: 'Failed to update Claude Cloud.',
    },
  );
}

export async function saveClaudeCloudSettings() {
  const defaultModel = String(document.getElementById('claude-cloud-model-select')?.value || '').trim();
  const environmentId = String(document.getElementById('claude-cloud-environment-select')?.value || '').trim();
  await submitClaudeCloudSettings(
    { defaultModel: defaultModel || undefined, environmentId: environmentId || undefined },
    {
      successNotice: () => 'Claude Cloud settings saved.',
      failureText: 'Failed to save Claude Cloud settings.',
      resetInputs: true,
    },
  );
}

// The login itself lives on the Claude tab (Relogin / Logout): one account,
// one place to change it.
export function openClaudeCloudLoginTab() {
  selectSettingsTab('providers', 'claude');
}
