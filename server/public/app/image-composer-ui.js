// The composer's image controls for an OpenAI image model: the Size select
// (the context-tier select, which bootstrap.js hands over for image models)
// with "Custom…" and its W×H input, and the Count, Format and Background
// selects. Values come from openai-image-composer.mjs (the browser's copy of
// the shared validator); the send reads them through
// readImageComposerSendInput.
//
// Size, Count, Format and Background are kept per conversation on this
// device (localStorage); Quality stays the effort select, stored with the
// conversation's preferences as before.
//
// The Preset select above them lists the relay's image presets (built-in
// and own, openai-image-cost-ui.js): a pick fills the selects so the values
// show, and the send names the preset (image.preset) next to the fields,
// which win over it. "Save as preset…" keeps what the selects show under a
// name.

import { currentConvId } from './store.js';
import { scheduleComposerSettingsSync } from './composer-settings-ui.js';
import { saveOpenAIImagePreset } from './api-client.js';
import {
  applyOpenAIImagePresets,
  currentOpenAIImagePresets,
  loadOpenAIImagePresetList,
  onOpenAIImagePresetsChange,
} from './openai-image-cost-ui.js';
import {
  IMAGE_COMPOSER_STORAGE_KEY,
  IMAGE_SIZE_CUSTOM_VALUE,
  buildImageSendOptions,
  checkCustomImageSize,
  clampImageComposerValues,
  imageComposerChoices,
  parseImageComposerStore,
  updateImageComposerStore,
} from './openai-image-composer.mjs';
import {
  buildImagePresetToSave,
  describeImagePreset,
  findImagePreset,
  imagePresetComposerValues,
  isImagePresetExistsRefusal,
} from './openai-image-spend.mjs';

const SIZE_SELECT_ID = 'context-tier-select';
const CUSTOM_ROW_ID = 'image-size-custom-row';
const CUSTOM_INPUT_ID = 'image-size-custom-input';
const CUSTOM_ERROR_ID = 'image-size-custom-error';
const OPTIONS_ROW_ID = 'image-options-row';
const COUNT_SELECT_ID = 'image-count-select';
const FORMAT_SELECT_ID = 'image-format-select';
const BACKGROUND_SELECT_ID = 'image-background-select';
const PRESET_FIELD_ID = 'image-preset-field';
const PRESET_SELECT_ID = 'image-preset-select';
const PRESET_SAVE_ID = 'image-preset-save-btn';
const PRESET_NOTE_ID = 'image-preset-note';

const FORMAT_LABELS = Object.freeze({ png: 'PNG', webp: 'WebP', jpeg: 'JPEG' });
const BACKGROUND_LABELS = Object.freeze({ auto: 'Auto', transparent: 'Transparent', opaque: 'Opaque' });

// The image model and conversation the controls were last built for.
let activeModel = '';
let activeConversationId = '';
let bound = false;

function el(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStore() {
  return parseImageComposerStore(storage()?.getItem(IMAGE_COMPOSER_STORAGE_KEY) || '');
}

/** The stored Size, Count, Format and Background of a conversation (this device). */
export function storedImageComposerValues(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return {};
  const entry = readStore()[id];
  return entry && typeof entry === 'object' ? entry : {};
}

/** Keeps `values` (any of size, count, output_format, background) for a conversation. */
export function rememberImageComposerValues(conversationId, values = {}) {
  const id = String(conversationId || '').trim();
  const store = storage();
  if (!id || !store) return;
  try {
    store.setItem(IMAGE_COMPOSER_STORAGE_KEY, JSON.stringify(updateImageComposerStore(readStore(), id, values)));
  } catch {}
}

function fillSelect(select, entries, value) {
  if (!select) return;
  const signature = JSON.stringify(entries);
  if (select.dataset.imageOptions !== signature) {
    select.replaceChildren(...entries.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (entry.custom) option.dataset.customSize = '1';
      return option;
    }));
    select.dataset.imageOptions = signature;
  }
  if (Array.from(select.options).some((option) => option.value === value)) select.value = value;
  else if (select.options.length) select.value = select.options[0].value;
}

function sizeEntries(choices, customSize) {
  const entries = choices.sizes.map((size) => ({ value: size, label: size }));
  if (!choices.customSize) return entries;
  if (customSize && !choices.sizes.includes(customSize)) entries.push({ value: customSize, label: customSize, custom: true });
  entries.push({ value: IMAGE_SIZE_CUSTOM_VALUE, label: 'Custom…' });
  return entries;
}

function defaultSize(choices) {
  if (choices.sizes.includes('auto')) return 'auto';
  if (choices.sizes.includes('1024x1024')) return '1024x1024';
  return choices.sizes[0] || '';
}

function showCustomRow(show) {
  const row = el(CUSTOM_ROW_ID);
  if (row && row.hidden === show) row.hidden = !show;
  if (!show) setCustomError('');
}

function setCustomError(text) {
  const error = el(CUSTOM_ERROR_ID);
  const input = el(CUSTOM_INPUT_ID);
  const message = String(text || '');
  if (error) {
    if (error.textContent !== message) error.textContent = message;
    error.hidden = !message;
  }
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function selectedSizeIsCustom(select) {
  const option = select?.options?.[select.selectedIndex];
  return !!option && (option.value === IMAGE_SIZE_CUSTOM_VALUE || option.dataset.customSize === '1');
}

function syncBackgroundForFormat() {
  const format = el(FORMAT_SELECT_ID);
  const background = el(BACKGROUND_SELECT_ID);
  if (!format || !background) return;
  const jpeg = format.value === 'jpeg';
  const transparent = Array.from(background.options).find((option) => option.value === 'transparent');
  if (transparent) {
    transparent.disabled = jpeg;
    transparent.title = jpeg ? 'Transparent needs PNG or WebP' : '';
  }
  if (jpeg && background.value === 'transparent') background.value = 'auto';
}

function setPresetNote(text, state = '') {
  const note = el(PRESET_NOTE_ID);
  if (!note) return;
  const message = String(text || '');
  note.textContent = message;
  note.hidden = !message;
  if (state) note.dataset.state = state;
  else delete note.dataset.state;
}

function presetOption(value, label, title = '') {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  if (title) option.title = title;
  return option;
}

/** The Preset select: None, the built-ins, the own presets; `selected` by name. */
function fillPresetSelect(selected) {
  const select = el(PRESET_SELECT_ID);
  if (!select) return;
  const list = currentOpenAIImagePresets();
  const signature = JSON.stringify(list.map((preset) => [preset.name, preset.builtIn, describeImagePreset(preset)]));
  if (select.dataset.presets !== signature) {
    const groups = [['Built-in', list.filter((preset) => preset.builtIn)], ['Own', list.filter((preset) => !preset.builtIn)]]
      .filter(([, entries]) => entries.length)
      .map(([label, entries]) => {
        const group = document.createElement('optgroup');
        group.label = label;
        group.append(...entries.map((preset) => presetOption(preset.name, preset.name, describeImagePreset(preset))));
        return group;
      });
    select.replaceChildren(presetOption('', 'None'), ...groups);
    select.dataset.presets = signature;
  }
  select.value = findImagePreset(list, selected)?.name || '';
}

/**
 * Builds the image controls for `modelId` (an image model) from the
 * conversation's stored values, else what the selects show now, else the
 * family's defaults. The Size select gets "Custom…" for gpt-image models.
 */
export function syncImageComposerControls(modelId, conversationId = currentConvId) {
  const choices = imageComposerChoices(modelId);
  if (!choices) {
    hideImageComposerControls();
    return;
  }
  bindImageComposerControls();
  const convId = String(conversationId || '').trim();
  // A rebuild for the conversation and model on screen (a poll, a catalog
  // refresh) keeps what the selects show, a Custom… being typed included;
  // another conversation or model starts from its stored values, else the
  // defaults (never the previous chat's choice).
  const sameContext = activeModel === String(modelId || '') && activeConversationId === convId;
  activeModel = String(modelId || '');
  activeConversationId = convId;
  const stored = clampImageComposerValues(storedImageComposerValues(convId), modelId);
  const pick = (storedValue, currentValue, fallback) => (
    sameContext ? (currentValue || storedValue || fallback) : (storedValue || fallback)
  );
  const sizeSelect = el(SIZE_SELECT_ID);
  const countSelect = el(COUNT_SELECT_ID);
  const formatSelect = el(FORMAT_SELECT_ID);
  const backgroundSelect = el(BACKGROUND_SELECT_ID);

  if (sizeSelect) {
    const current = String(sizeSelect.value || '').trim().toLowerCase();
    // Custom… with nothing valid typed yet only stays for the same chat.
    const currentValid = current === IMAGE_SIZE_CUSTOM_VALUE
      ? choices.customSize && sameContext
      : !!current && !checkCustomImageSize(current, modelId).error;
    const currentSize = choices.sizes.includes(current) || (choices.customSize && currentValid) ? current : '';
    const size = pick(stored.size, currentSize, defaultSize(choices));
    const customSize = size !== IMAGE_SIZE_CUSTOM_VALUE && !choices.sizes.includes(size) ? size : '';
    fillSelect(sizeSelect, sizeEntries(choices, customSize), size);
    sizeSelect.title = 'Image size';
    showCustomRow(selectedSizeIsCustom(sizeSelect));
    const input = el(CUSTOM_INPUT_ID);
    if (input && customSize && document.activeElement !== input) input.value = customSize;
    else if (input && !sameContext && !customSize) input.value = '';
  }

  const countEntries = Array.from({ length: choices.countMax }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));
  fillSelect(countSelect, countEntries, String(pick(stored.count, countSelect?.value, 1)));
  const countField = countSelect?.closest('.composer-settings-field');
  if (countField) countField.hidden = !choices.showCount;

  if (choices.formats) {
    fillSelect(formatSelect, choices.formats.map((value) => ({ value, label: FORMAT_LABELS[value] || value })), pick(stored.output_format, formatSelect?.value, 'png'));
    fillSelect(backgroundSelect, choices.backgrounds.map((value) => ({ value, label: BACKGROUND_LABELS[value] || value })), pick(stored.background, backgroundSelect?.value, 'auto'));
    syncBackgroundForFormat();
  }
  for (const select of [formatSelect, backgroundSelect]) {
    const field = select?.closest('.composer-settings-field');
    if (field) field.hidden = !choices.formats;
  }
  const row = el(OPTIONS_ROW_ID);
  if (row) row.hidden = !choices.showCount && !choices.formats;

  const presetField = el(PRESET_FIELD_ID);
  if (presetField) presetField.hidden = false;
  const storedPreset = String(storedImageComposerValues(convId).preset || '');
  const currentPreset = String(el(PRESET_SELECT_ID)?.value || '');
  fillPresetSelect(sameContext ? (currentPreset || storedPreset) : storedPreset);
  if (!sameContext) setPresetNote('');
  void loadOpenAIImagePresetList();
}

/** A model that makes no images: the image controls go. */
export function hideImageComposerControls() {
  activeModel = '';
  activeConversationId = '';
  const row = el(OPTIONS_ROW_ID);
  if (row) row.hidden = true;
  const presetField = el(PRESET_FIELD_ID);
  if (presetField) presetField.hidden = true;
  setPresetNote('');
  showCustomRow(false);
  const sizeSelect = el(SIZE_SELECT_ID);
  if (sizeSelect) delete sizeSelect.dataset.imageOptions;
}

/**
 * What the send needs from the controls: `{ size, customText, quality,
 * count, outputFormat, background, preset }` (strings; size '__custom__'
 * while no valid custom size is typed, `customText` then the typed text;
 * preset '' for none). Hidden selects count as not given.
 */
export function readImageComposerSendInput() {
  // Hidden for this model: the field or the whole row (the panel itself is
  // closed most of the time and does not count).
  const visible = (select) => !!select
    && !select.closest('.composer-settings-field')?.hidden
    && !el(OPTIONS_ROW_ID)?.hidden;
  const count = el(COUNT_SELECT_ID);
  const format = el(FORMAT_SELECT_ID);
  const background = el(BACKGROUND_SELECT_ID);
  const presetField = el(PRESET_FIELD_ID);
  const size = String(el(SIZE_SELECT_ID)?.value || '').trim().toLowerCase();
  return {
    size,
    // While the select says Custom…, what is typed: its own reason refuses it.
    customText: size === IMAGE_SIZE_CUSTOM_VALUE ? String(el(CUSTOM_INPUT_ID)?.value || '') : '',
    quality: String(el('reasoning-effort-select')?.value || '').trim().toLowerCase(),
    count: visible(count) ? Number(count.value) || 1 : 1,
    outputFormat: visible(format) ? String(format.value || '') : '',
    background: visible(background) ? String(background.value || '') : '',
    preset: presetField && !presetField.hidden ? String(el(PRESET_SELECT_ID)?.value || '') : '',
  };
}

/**
 * A preset picked: the selects show its values (what the model takes; the
 * note names what it does not), and the conversation keeps the pick.
 */
export function applyImagePresetPick(name) {
  if (!activeModel) return;
  const choices = imageComposerChoices(activeModel);
  const preset = findImagePreset(currentOpenAIImagePresets(), name);
  if (!choices || !preset) {
    rememberImageComposerValues(currentConvId, { preset: '' });
    setPresetNote('');
    notifyLabel();
    return;
  }
  const effort = el('reasoning-effort-select');
  const format = el(FORMAT_SELECT_ID);
  const { values, skipped } = imagePresetComposerValues(preset, activeModel, {
    qualities: effort ? Array.from(effort.options).map((option) => option.value) : null,
    currentFormat: format?.value || '',
  });
  const remembered = { preset: preset.name };
  const sizeSelect = el(SIZE_SELECT_ID);
  if (values.size && sizeSelect) {
    const customSize = choices.sizes.includes(values.size) ? '' : values.size;
    fillSelect(sizeSelect, sizeEntries(choices, customSize), values.size);
    showCustomRow(selectedSizeIsCustom(sizeSelect));
    const input = el(CUSTOM_INPUT_ID);
    if (input && customSize) input.value = customSize;
    setCustomError('');
    remembered.size = values.size;
  }
  const count = el(COUNT_SELECT_ID);
  if (values.count && count) {
    count.value = String(values.count);
    remembered.count = values.count;
  }
  if (values.output_format && format) {
    format.value = values.output_format;
    remembered.output_format = values.output_format;
  }
  const background = el(BACKGROUND_SELECT_ID);
  if (values.background && background) {
    background.value = values.background;
    remembered.background = values.background;
  }
  syncBackgroundForFormat();
  rememberImageComposerValues(currentConvId, remembered);
  // Quality is the effort select: its own change handler keeps it with the
  // conversation's preferences.
  if (values.quality && effort && effort.value !== values.quality) {
    effort.value = values.quality;
    effort.dispatchEvent(new Event('change', { bubbles: true }));
  }
  setPresetNote(skipped.length
    ? `Not for ${activeModel}: ${skipped.join(', ')}. Those fields keep what they show.`
    : `${preset.name}: ${describeImagePreset(preset)}`);
  notifyLabel();
}

function askToReplacePreset(name) {
  return confirm(`A preset "${name}" exists. Replace it with the options shown now?`);
}

/**
 * "Save as preset…": what the selects show (checked for the model), under a
 * name asked for; an own preset of that name is replaced only when the user
 * says so. Refusals show under the Preset select.
 */
export async function saveImageComposerPreset() {
  if (!activeModel) return;
  const built = buildImageSendOptions({ model: activeModel, ...readImageComposerSendInput(), preset: '' });
  if (!built.ok) {
    if (built.field === 'size') flagImageComposerSizeError(built.error);
    setPresetNote(built.error, 'error');
    return;
  }
  const picked = findImagePreset(currentOpenAIImagePresets(), el(PRESET_SELECT_ID)?.value || '');
  const name = prompt('Name of the image preset', picked && !picked.builtIn ? picked.name : '');
  if (name === null) return;
  const checked = buildImagePresetToSave(name, built.image);
  if (!checked.ok) {
    setPresetNote(checked.error, 'error');
    return;
  }
  const own = currentOpenAIImagePresets().filter((preset) => !preset.builtIn);
  const existing = findImagePreset(own, checked.preset.name);
  if (existing && !askToReplacePreset(existing.name)) return;
  const button = el(PRESET_SAVE_ID);
  if (button) button.disabled = true;
  setPresetNote('');
  try {
    let answer;
    try {
      answer = await saveOpenAIImagePreset(checked.preset, { replace: !!existing });
    } catch (error) {
      // Saved from another page in the meantime: asked once more.
      if (existing || !isImagePresetExistsRefusal(error)) throw error;
      if (!askToReplacePreset(checked.preset.name)) return;
      answer = await saveOpenAIImagePreset(checked.preset, { replace: true });
    }
    if (!answer) throw new Error('Could not save the preset: the relay is not reachable.');
    applyOpenAIImagePresets(answer);
    fillPresetSelect(checked.preset.name);
    rememberImageComposerValues(currentConvId, { preset: checked.preset.name });
    setPresetNote(`Saved as preset "${checked.preset.name}".`);
    notifyLabel();
  } catch (error) {
    setPresetNote(error?.message || 'Could not save the preset.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/** A send refused for its size: the custom input opens with the reason under it. */
export function flagImageComposerSizeError(text) {
  const select = el(SIZE_SELECT_ID);
  if (select && select.value !== IMAGE_SIZE_CUSTOM_VALUE && !selectedSizeIsCustom(select)) return;
  showCustomRow(true);
  setCustomError(text);
}

function applyCustomInput({ persist = true } = {}) {
  const select = el(SIZE_SELECT_ID);
  const input = el(CUSTOM_INPUT_ID);
  if (!select || !input || !activeModel) return;
  const checked = checkCustomImageSize(input.value, activeModel);
  const choices = imageComposerChoices(activeModel);
  if (!choices) return;
  if (checked.error) {
    // Nothing valid to send: the select says Custom… until the input is.
    select.value = IMAGE_SIZE_CUSTOM_VALUE;
    setCustomError(checked.error);
  } else {
    const customSize = choices.sizes.includes(checked.size) ? '' : checked.size;
    fillSelect(select, sizeEntries(choices, customSize), checked.size);
    setCustomError('');
    if (persist) rememberImageComposerValues(currentConvId, { size: checked.size });
  }
  notifyLabel();
}

// The composer label reads the selects; a value set from the input fires no
// change event, so it is told here.
function notifyLabel() {
  scheduleComposerSettingsSync();
}

function bindImageComposerControls() {
  if (bound || typeof document === 'undefined') return;
  const sizeSelect = el(SIZE_SELECT_ID);
  const input = el(CUSTOM_INPUT_ID);
  if (!sizeSelect || !input) return;
  bound = true;
  sizeSelect.addEventListener('change', () => {
    if (!activeModel) return;
    if (sizeSelect.value === IMAGE_SIZE_CUSTOM_VALUE) {
      showCustomRow(true);
      const previous = Array.from(sizeSelect.options).find((option) => option.dataset.customSize === '1')?.value || '';
      if (!input.value && previous) input.value = previous;
      if (input.value) applyCustomInput();
      else setCustomError('Enter WIDTHxHEIGHT, e.g. 2048x1152');
      try { input.focus({ preventScroll: true }); } catch {}
      return;
    }
    showCustomRow(selectedSizeIsCustom(sizeSelect));
    rememberImageComposerValues(currentConvId, { size: sizeSelect.value });
  });
  input.addEventListener('input', () => applyCustomInput());
  input.addEventListener('keydown', (event) => {
    // Enter in the size field must not send the message.
    if (event.key === 'Enter') event.preventDefault();
  });
  el(COUNT_SELECT_ID)?.addEventListener('change', (event) => {
    rememberImageComposerValues(currentConvId, { count: Number(event.target.value) || 1 });
    notifyLabel();
  });
  el(FORMAT_SELECT_ID)?.addEventListener('change', (event) => {
    syncBackgroundForFormat();
    rememberImageComposerValues(currentConvId, {
      output_format: event.target.value,
      background: el(BACKGROUND_SELECT_ID)?.value || '',
    });
    notifyLabel();
  });
  el(BACKGROUND_SELECT_ID)?.addEventListener('change', (event) => {
    rememberImageComposerValues(currentConvId, { background: event.target.value });
    notifyLabel();
  });
  el(PRESET_SELECT_ID)?.addEventListener('change', (event) => applyImagePresetPick(event.target.value));
  el(PRESET_SAVE_ID)?.addEventListener('click', () => { void saveImageComposerPreset(); });
  // A list read or changed (here, in Settings, on another page's save):
  // the select follows, keeping its pick.
  onOpenAIImagePresetsChange(() => {
    if (activeModel) fillPresetSelect(el(PRESET_SELECT_ID)?.value || storedImageComposerValues(activeConversationId).preset || '');
  });
}
