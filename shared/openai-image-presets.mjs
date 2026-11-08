// Image presets: named bundles of image options (size, quality, count,
// output format, background). A built-in set, and the owner's own, stored
// relay-wide in app_settings. A turn's options are layered: the session's
// defaults, then a preset, then the turn's own fields; the merged result is
// what the validator checks (validateOpenAIImageOptions with the model).
//
// SDK-free and side-effect free: imported by the server and the session
// workers (the browser keeps a tested copy, as for the options).

import { OPENAI_IMAGE_OPTION_KEYS, validateOpenAIImageOptions } from './openai-image-options.mjs';

export const OPENAI_IMAGE_PRESETS_SETTING_KEY = 'openai_image_presets';

export const OPENAI_IMAGE_PRESET_LIMITS = Object.freeze({
  // Own presets one relay keeps, a name's characters, and the stored JSON.
  ownMax: 30,
  nameChars: 40,
  storedBytesMax: 8 * 1024,
});

// The relay refuses a preset name it does not know, or an own preset that
// breaks the rules (a built-in's name, too many, too long), with this code.
export const OPENAI_IMAGE_PRESET_REFUSED_CODE = 'OPENAI_IMAGE_PRESET_REFUSED';

export const OPENAI_IMAGE_BUILTIN_PRESETS = Object.freeze([
  Object.freeze({ name: 'Draft square', size: '1024x1024', quality: 'low' }),
  Object.freeze({ name: 'Photo landscape', size: '1536x1024', quality: 'medium' }),
  Object.freeze({ name: 'Portrait', size: '1024x1536', quality: 'medium' }),
  Object.freeze({ name: 'Wallpaper 4K', size: '3840x2160', quality: 'high' }),
  Object.freeze({ name: 'Sticker', size: '1024x1024', quality: 'medium', output_format: 'png', background: 'transparent' }),
]);

// Control characters, and the invisible ones that make two names look alike.
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/u;

/**
 * A preset name as shown: NFC, trimmed, runs of white space as one space;
 * or `{ error }` for an empty, too long or hidden-character name.
 */
export function cleanOpenAIImagePresetName(value) {
  if (typeof value !== 'string') return { error: 'a preset name must be text' };
  const normalized = value.normalize('NFC');
  if (HIDDEN_CHARACTERS.test(normalized)) return { error: 'a preset name may not hold control or invisible characters' };
  const name = normalized.trim().replace(/\s+/gu, ' ');
  if (!name) return { error: 'a preset name may not be empty' };
  // "." and ".." would be path steps in the preset's URL (DELETE …/:name).
  if (/^\.+$/.test(name)) return { error: 'a preset name may not be dots alone' };
  if ([...name].length > OPENAI_IMAGE_PRESET_LIMITS.nameChars) {
    return { error: `a preset name has at most ${OPENAI_IMAGE_PRESET_LIMITS.nameChars} characters` };
  }
  return { name };
}

/** The one key a name is saved and looked up by: the clean name, lower-cased. */
export function openAIImagePresetKey(value) {
  const cleaned = cleanOpenAIImagePresetName(value);
  return cleaned.error ? '' : cleaned.name.toLowerCase();
}

function presetValues(preset) {
  const values = {};
  for (const key of OPENAI_IMAGE_OPTION_KEYS) {
    if (preset?.[key] !== undefined && preset?.[key] !== null && preset?.[key] !== '') values[key] = preset[key];
  }
  return values;
}

/**
 * An own preset as the owner saves it, checked without a model (a preset
 * serves any image session; its use is checked against the session's
 * model): `{ ok:true, preset:{ name, ...values } }` or `{ ok:false, error }`.
 */
export function validateOwnOpenAIImagePreset(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'a preset is an object with a name and image options' };
  const cleaned = cleanOpenAIImagePresetName(input.name);
  if (cleaned.error) return { ok: false, error: cleaned.error };
  const key = cleaned.name.toLowerCase();
  if (OPENAI_IMAGE_BUILTIN_PRESETS.some((preset) => preset.name.toLowerCase() === key)) {
    return { ok: false, error: `"${cleaned.name}" is a built-in preset; pick another name` };
  }
  const { name: _name, ...rest } = input;
  const checked = validateOpenAIImageOptions(rest, { field: 'preset' });
  if (!checked.ok) return { ok: false, error: checked.error };
  if (!Object.keys(checked.values).length) return { ok: false, error: `a preset needs at least one of: ${OPENAI_IMAGE_OPTION_KEYS.join(', ')}` };
  return { ok: true, preset: { name: cleaned.name, ...checked.values } };
}

/**
 * The owner's presets as stored (the app_settings JSON), the ones that still
 * pass the rules, in their order; anything else is dropped.
 */
export function parseOwnOpenAIImagePresets(stored) {
  let list = stored;
  if (typeof stored === 'string') {
    try { list = JSON.parse(stored); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const presets = [];
  for (const entry of list) {
    const checked = validateOwnOpenAIImagePreset(entry);
    if (!checked.ok) continue;
    const key = checked.preset.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push(checked.preset);
    if (presets.length >= OPENAI_IMAGE_PRESET_LIMITS.ownMax) break;
  }
  return presets;
}

/** Built-ins first (`builtIn: true`), then the owner's. */
export function listOpenAIImagePresets(ownPresets = []) {
  return [
    ...OPENAI_IMAGE_BUILTIN_PRESETS.map((preset) => ({ ...preset, builtIn: true })),
    ...(Array.isArray(ownPresets) ? ownPresets : []).map((preset) => ({ ...preset, builtIn: false })),
  ];
}

/**
 * The preset a turn names, by its key: `{ ok:true, values }` (the options
 * alone), `{ ok:true, values:{} }` for no name, or `{ ok:false, error }` for
 * a name the relay does not know, with the names it has.
 */
export function findOpenAIImagePreset(name, ownPresets = []) {
  if (name === undefined || name === null || (typeof name === 'string' && !name.trim())) return { ok: true, values: {} };
  const key = openAIImagePresetKey(name);
  const all = listOpenAIImagePresets(ownPresets);
  const found = key ? all.find((preset) => preset.name.toLowerCase() === key) : null;
  if (!found) {
    return { ok: false, error: `no image preset "${String(name).slice(0, 60)}" here; presets: ${all.map((preset) => preset.name).join(', ')}` };
  }
  return { ok: true, values: presetValues(found), name: found.name };
}

/**
 * Splits a turn's `image` into the preset it names and its own fields (the
 * validator takes no `preset` key): `{ preset, own }`.
 */
export function splitOpenAIImagePreset(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return { preset: null, own: image };
  const { preset = null, ...own } = image;
  return { preset, own };
}

/**
 * The stored list after one change, for the server to write in the same
 * transaction it read in: `{ ok:true, presets }` or `{ ok:false, error }`.
 * `op` is 'put' (add, or replace one of that name only with `replace`) or
 * 'delete'.
 */
export function applyOwnOpenAIImagePresetChange(ownPresets, { op, preset = null, name = '', replace = false } = {}) {
  const list = Array.isArray(ownPresets) ? [...ownPresets] : [];
  if (op === 'delete') {
    const key = openAIImagePresetKey(name);
    if (OPENAI_IMAGE_BUILTIN_PRESETS.some((entry) => entry.name.toLowerCase() === key)) return { ok: false, error: 'a built-in preset cannot be deleted' };
    const index = list.findIndex((entry) => entry.name.toLowerCase() === key);
    if (index < 0) return { ok: false, error: `no own preset "${String(name).slice(0, 60)}"` };
    list.splice(index, 1);
    return { ok: true, presets: list };
  }
  if (op !== 'put') return { ok: false, error: 'op must be put or delete' };
  const checked = validateOwnOpenAIImagePreset(preset);
  if (!checked.ok) return checked;
  const key = checked.preset.name.toLowerCase();
  const index = list.findIndex((entry) => entry.name.toLowerCase() === key);
  if (index >= 0 && !replace) return { ok: false, error: `a preset "${list[index].name}" exists; save with replace to change it` };
  if (index >= 0) list[index] = checked.preset;
  else if (list.length >= OPENAI_IMAGE_PRESET_LIMITS.ownMax) return { ok: false, error: `at most ${OPENAI_IMAGE_PRESET_LIMITS.ownMax} own presets` };
  else list.push(checked.preset);
  if (new TextEncoder().encode(JSON.stringify(list)).length > OPENAI_IMAGE_PRESET_LIMITS.storedBytesMax) {
    return { ok: false, error: `the presets would take more than ${OPENAI_IMAGE_PRESET_LIMITS.storedBytesMax} bytes` };
  }
  return { ok: true, presets: list };
}
