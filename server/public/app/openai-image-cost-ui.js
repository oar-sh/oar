// What OpenAI image turns cost, on screen: the relay's spend state (GET
// OPENAI_IMAGE_USAGE_PATH, then live through OPENAI_IMAGE_USAGE_EVENT), the
// banner of an image chat, the chat menu's cost line, the image cap section
// of Settings → Providers → OpenAI, and the image presets the composer and
// that section share. The wording is openai-image-spend.mjs's.

import {
  deleteOpenAIImagePreset,
  loadOpenAIImagePresets,
  loadOpenAIImageUsage,
  updateOpenAIImageSpendSettings,
} from './api-client.js';
import {
  describeImagePreset,
  imageCapInputText,
  imageChatCostText,
  imageSpendBanner,
  imageSpendOverrideButtons,
  imageSpendSettingsLine,
  normalizeImagePresets,
  normalizeImageSpendState,
  parseImageCapInput,
  formatOpenAIImageUsd,
} from './openai-image-spend.mjs';

let spendState = null;
let spendLoadedAt = 0;
let spendRefresh = null;
const spendListeners = new Set();
// Whether the chat on screen is an image chat (the banner shows only there).
let bannerImageChat = false;

let presets = normalizeImagePresets(null);
let presetsLoaded = false;
let presetsRefresh = null;
const presetListeners = new Set();

let capInputDirty = false;
let spendSettingsInFlight = false;
// The cap and today's override as the last OpenAI settings answer named
// them: the buttons follow them until a spend state is known.
let settingsSpend = null;

const SPEND_STALE_MS = 60_000;

function el(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function notify(listeners, value) {
  for (const listener of listeners) {
    try { listener(value); } catch {}
  }
}

// ---- The spend state -------------------------------------------------------

export function currentOpenAIImageSpendState() {
  return spendState;
}

/** Called with the state after every change (the Check Usage modal listens). */
export function onOpenAIImageSpendChange(listener) {
  if (typeof listener !== 'function') return () => {};
  spendListeners.add(listener);
  return () => spendListeners.delete(listener);
}

/** A state from the relay (the GET, the socket event): kept and shown. */
export function applyOpenAIImageSpendState(raw) {
  const state = normalizeImageSpendState(raw);
  if (!state) return spendState;
  // The day's state; a chat's cost belongs to the request that asked for it.
  delete state.conversation;
  spendState = state;
  spendLoadedAt = Date.now();
  renderSpendBanner();
  renderSpendSettings();
  notify(spendListeners, spendState);
  return spendState;
}

/** Reads the state again (serialised); the state, or null when the relay has none. */
export async function refreshOpenAIImageSpendState() {
  if (spendRefresh) return spendRefresh;
  spendRefresh = (async () => {
    const answer = await loadOpenAIImageUsage();
    return answer ? applyOpenAIImageSpendState(answer) : null;
  })();
  try {
    return await spendRefresh;
  } finally {
    spendRefresh = null;
  }
}

function refreshSpendIfStale() {
  if (!spendState || Date.now() - spendLoadedAt > SPEND_STALE_MS) void refreshOpenAIImageSpendState();
}

// ---- The banner of an image chat ---------------------------------------------

function renderSpendBanner() {
  const banner = el('openai-image-spend-banner');
  if (!banner) return;
  const content = bannerImageChat ? imageSpendBanner(spendState) : null;
  if (!content) {
    banner.hidden = true;
    banner.textContent = '';
    delete banner.dataset.kind;
    return;
  }
  banner.textContent = content.text;
  banner.dataset.kind = content.kind;
  banner.title = content.text;
  banner.hidden = false;
}

/** The chat on screen (or the composer's model) is an image chat, or not. */
export function syncOpenAIImageSpendBanner({ imageChat = false } = {}) {
  bannerImageChat = imageChat === true;
  if (bannerImageChat) refreshSpendIfStale();
  renderSpendBanner();
}

// ---- The chat menu's cost line ---------------------------------------------

let chatCostRequest = 0;

/**
 * Fills the chat menu's "OpenAI images: USD … in this chat" line for an
 * image chat (asked from the relay each time the menu opens); hidden for
 * any other chat.
 */
export async function syncChatMenuImageCost({ conversationId = '', imageChat = false } = {}) {
  const row = el('chat-menu-image-cost');
  const value = el('chat-menu-image-cost-value');
  if (!row || !value) return;
  const id = String(conversationId || '').trim();
  const request = ++chatCostRequest;
  if (!imageChat || !id) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  value.textContent = 'OpenAI images: …';
  const answer = await loadOpenAIImageUsage({ conversationId: id });
  if (request !== chatCostRequest) return;
  const state = normalizeImageSpendState(answer);
  if (!state) {
    value.textContent = 'OpenAI images: cost not available';
    return;
  }
  value.textContent = state.conversation
    ? imageChatCostText(state.conversation)
    : 'OpenAI images: cost not available';
  applyOpenAIImageSpendState(answer);
}

// ---- Settings → Providers → OpenAI: the cap ----------------------------------

function showSpendError(text) {
  const error = el('openai-image-spend-error');
  const input = el('openai-image-cap-input');
  const message = String(text || '');
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  if (input) {
    if (message && input.dataset.invalid === '1') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function setSpendControlsDisabled(disabled) {
  for (const id of ['openai-image-cap-input', 'openai-image-cap-save-btn', 'openai-image-allow-today-btn', 'openai-image-stop-allowing-btn']) {
    const control = el(id);
    if (control) control.disabled = disabled;
  }
}

function renderSpendSettings() {
  const line = el('openai-image-spend-line');
  if (line) {
    line.textContent = spendState ? imageSpendSettingsLine(spendState) : 'Today\'s image spend is not known yet.';
    line.dataset.state = spendState?.reached && !spendState?.allowedToday ? 'error' : (spendState?.warning ? 'warning' : 'saved');
  }
  const buttons = imageSpendOverrideButtons(spendState || settingsSpend);
  const allow = el('openai-image-allow-today-btn');
  if (allow) {
    allow.hidden = !buttons.allow.shown;
    if (buttons.allow.label) allow.textContent = buttons.allow.label;
  }
  const stop = el('openai-image-stop-allowing-btn');
  if (stop) stop.hidden = !buttons.stop.shown;
}

/**
 * The cap field from an OpenAI settings answer (GET, POST or the socket
 * event): only an answer that names the cap changes it, and never while the
 * field is being edited.
 */
export function applyOpenAIImageSpendSettings(settings = {}, { force = false } = {}) {
  const named = settings && Object.prototype.hasOwnProperty.call(settings, 'imageDailyCapUsd');
  if (named) {
    settingsSpend = normalizeImageSpendState({
      capUsd: settings.imageDailyCapUsd,
      allowedToday: settings.imagesAllowedToday === true,
      allowedAt: settings.imagesAllowedAt || null,
    });
    if (!spendState) renderSpendSettings();
  }
  const input = el('openai-image-cap-input');
  if (!input) return;
  bindSpendSettings();
  if ((!named && !force) || (capInputDirty && !force)) return;
  input.value = imageCapInputText(named ? settings.imageDailyCapUsd : undefined);
  input.dataset.invalid = '';
  capInputDirty = false;
  showSpendError('');
}

/** Called when the Settings modal opens. */
export async function syncOpenAIImageSpendSettings() {
  capInputDirty = false;
  bindSpendSettings();
  showSpendError('');
  renderSpendSettings();
  renderSettingsPresets();
  await Promise.all([refreshOpenAIImageSpendState(), loadOpenAIImagePresetList({ force: true })]);
}

async function runSpendUpdate(patch, successText) {
  if (spendSettingsInFlight) return;
  spendSettingsInFlight = true;
  setSpendControlsDisabled(true);
  showSpendError('');
  try {
    const result = await updateOpenAIImageSpendSettings(patch);
    if (result) applyOpenAIImageSpendSettings(result);
    // The relay sends the new state to every owner page; this one reads it too.
    await refreshOpenAIImageSpendState();
    const status = el('openai-image-spend-status');
    if (status) status.textContent = successText;
  } catch (error) {
    // A paired relay's request (403) and a refused amount say why.
    showSpendError(error?.message || 'Could not update the image cap.');
  } finally {
    spendSettingsInFlight = false;
    setSpendControlsDisabled(false);
  }
}

export async function saveOpenAIImageCap() {
  const input = el('openai-image-cap-input');
  // A number field reads '' for text it cannot parse.
  const parsed = input?.validity?.badInput ? parseImageCapInput('not a number') : parseImageCapInput(input?.value);
  if (!parsed.ok) {
    if (input) input.dataset.invalid = '1';
    showSpendError(parsed.error);
    input?.focus?.();
    return;
  }
  if (input) input.dataset.invalid = '';
  await runSpendUpdate(
    { imageDailyCapUsd: parsed.capUsd },
    parsed.capUsd > 0 ? `Daily image cap saved: ${formatOpenAIImageUsd(parsed.capUsd)}.` : 'Daily image cap off: image turns are not stopped by spend.',
  );
  capInputDirty = false;
}

export async function setOpenAIImagesAllowedToday(allowed) {
  await runSpendUpdate(
    { allowImagesToday: allowed === true },
    allowed === true ? 'Image turns are allowed past the cap until the end of the relay\'s day.' : 'Image turns stop at the cap again.',
  );
}

/** The cap refusal's button: the cap field, ready to raise. */
export function focusOpenAIImageCapInput() {
  const input = el('openai-image-cap-input');
  if (!input) return;
  input.scrollIntoView?.({ block: 'center' });
  input.focus?.();
}

function bindSpendSettings() {
  const input = el('openai-image-cap-input');
  if (!input || input.dataset.imageSpendBound === '1') return;
  input.dataset.imageSpendBound = '1';
  input.addEventListener('input', () => {
    capInputDirty = true;
    input.dataset.invalid = '';
    showSpendError('');
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveOpenAIImageCap();
    }
  });
  el('openai-image-cap-save-btn')?.addEventListener('click', () => { void saveOpenAIImageCap(); });
  el('openai-image-allow-today-btn')?.addEventListener('click', () => { void setOpenAIImagesAllowedToday(true); });
  el('openai-image-stop-allowing-btn')?.addEventListener('click', () => { void setOpenAIImagesAllowedToday(false); });
  el('openai-image-presets-list')?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-image-preset-delete]');
    if (button) void removeOwnImagePreset(button.dataset.imagePresetDelete);
  });
}

// ---- Presets ---------------------------------------------------------------

export function currentOpenAIImagePresets() {
  return presets;
}

/** Called with the list after every change (the composer's select listens). */
export function onOpenAIImagePresetsChange(listener) {
  if (typeof listener !== 'function') return () => {};
  presetListeners.add(listener);
  return () => presetListeners.delete(listener);
}

/** A presets answer of the relay (GET, PUT, DELETE): kept and shown. */
export function applyOpenAIImagePresets(answer) {
  if (!Array.isArray(answer?.presets)) return presets;
  presets = normalizeImagePresets(answer);
  presetsLoaded = true;
  renderSettingsPresets();
  notify(presetListeners, presets);
  return presets;
}

/** Reads the list once (or again with `force`); the built-ins stand in until then. */
export async function loadOpenAIImagePresetList({ force = false } = {}) {
  if (presetsLoaded && !force) return presets;
  if (presetsRefresh) return presetsRefresh;
  presetsRefresh = (async () => {
    const answer = await loadOpenAIImagePresets();
    return answer ? applyOpenAIImagePresets(answer) : presets;
  })();
  try {
    return await presetsRefresh;
  } finally {
    presetsRefresh = null;
  }
}

function renderSettingsPresets() {
  const list = el('openai-image-presets-list');
  if (!list) return;
  list.replaceChildren(...presets.map((preset) => {
    const item = document.createElement('li');
    item.className = 'openai-image-preset-row';
    item.dataset.testid = 'openai-image-preset-row';
    item.dataset.presetName = preset.name;
    const text = document.createElement('span');
    text.className = 'openai-image-preset-text';
    const name = document.createElement('strong');
    name.textContent = preset.name;
    const details = document.createElement('span');
    details.className = 'openai-image-preset-details';
    details.textContent = describeImagePreset(preset);
    text.append(name, details);
    item.append(text);
    if (preset.builtIn) {
      const tag = document.createElement('span');
      tag.className = 'openai-image-preset-tag';
      tag.textContent = 'built-in';
      item.append(tag);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'summary-btn';
      button.textContent = 'Delete';
      button.dataset.imagePresetDelete = preset.name;
      button.dataset.testid = 'openai-image-preset-delete';
      button.setAttribute('aria-label', `Delete the preset ${preset.name}`);
      item.append(button);
    }
    return item;
  }));
  const own = presets.filter((preset) => !preset.builtIn).length;
  const note = el('openai-image-presets-note');
  if (note) {
    note.textContent = own
      ? `${own} own preset${own === 1 ? '' : 's'}. Save more from an image chat's ⚙ settings (Save as preset…).`
      : 'No own presets yet: save one from an image chat\'s ⚙ settings (Save as preset…).';
  }
}

async function removeOwnImagePreset(name) {
  const preset = presets.find((entry) => entry.name === name && !entry.builtIn);
  if (!preset) return;
  if (!confirm(`Delete the image preset "${preset.name}"?`)) return;
  const error = el('openai-image-presets-error');
  if (error) {
    error.textContent = '';
    error.hidden = true;
  }
  try {
    const answer = await deleteOpenAIImagePreset(preset.name);
    if (answer) applyOpenAIImagePresets(answer);
  } catch (failure) {
    if (error) {
      error.textContent = failure?.message || 'Could not delete the preset.';
      error.hidden = false;
    }
  }
}

export function __resetOpenAIImageCostUiForTests() {
  spendState = null;
  spendLoadedAt = 0;
  spendRefresh = null;
  spendListeners.clear();
  bannerImageChat = false;
  presets = normalizeImagePresets(null);
  presetsLoaded = false;
  presetsRefresh = null;
  presetListeners.clear();
  capInputDirty = false;
  spendSettingsInFlight = false;
  settingsSpend = null;
}
