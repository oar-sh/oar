// The composer's image options (Size with Custom…, Quality, Count, Format,
// Background) and the live placeholder of a running image turn: the pure
// part, no DOM.
//
// The first block mirrors shared/openai-image-options.mjs and the event names
// of shared/openai-image-previews.mjs, which the browser cannot import (only
// server/public is served). openai-image-composer.test.mjs asserts the two
// stay identical.

// ---- Mirror of shared/openai-image-options.mjs --------------------------

export const OPENAI_IMAGE_PER_TURN_MAX = 4;

export const OPENAI_IMAGE_LIMITS = Object.freeze({
  countMax: OPENAI_IMAGE_PER_TURN_MAX,
  inputImagesMax: OPENAI_IMAGE_PER_TURN_MAX,
  inputImageBytesMax: 20 * 1024 * 1024,
  sizeStep: 16,
  edgeMax: 3840,
  pixelsMax: 3840 * 2160,
  aspectMax: 3,
  pixelsMin: 655_360,
});

export const OPENAI_IMAGE_OPTION_KEYS = Object.freeze(['size', 'quality', 'count', 'output_format', 'background']);
export const OPENAI_IMAGE_OUTPUT_FORMATS = Object.freeze(['png', 'webp', 'jpeg']);
export const OPENAI_IMAGE_BACKGROUNDS = Object.freeze(['auto', 'transparent', 'opaque']);

export const OPENAI_IMAGE_FAMILIES = Object.freeze({
  'gpt-image': Object.freeze({
    sizes: null,
    qualities: Object.freeze(['auto', 'low', 'medium', 'high']),
    countMax: OPENAI_IMAGE_LIMITS.countMax,
    formats: true,
  }),
  'dall-e-3': Object.freeze({
    sizes: Object.freeze(['1024x1024', '1792x1024', '1024x1792']),
    qualities: Object.freeze(['auto', 'standard', 'hd']),
    countMax: 1,
    formats: false,
  }),
  'dall-e-2': Object.freeze({
    sizes: Object.freeze(['256x256', '512x512', '1024x1024']),
    qualities: Object.freeze(['auto', 'standard']),
    countMax: OPENAI_IMAGE_LIMITS.countMax,
    formats: false,
  }),
});

export const OPENAI_IMAGE_EXTENDED_QUALITIES = Object.freeze(['xhigh', 'max']);
const EXTENDED_QUALITY_MODEL = /^gpt-image-2\.[56](?:-|$)/;
const PIXEL_FLOOR_MODEL = /^gpt-image-2(?:$|[.-])/;

const ALL_QUALITIES = Object.freeze([
  ...new Set([...Object.values(OPENAI_IMAGE_FAMILIES).flatMap((family) => family.qualities), ...OPENAI_IMAGE_EXTENDED_QUALITIES]),
]);

function bareModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/^openai\//, '');
}

export function openAIImageModelQualities(model = '') {
  const family = openAIImageModelFamily(model);
  if (!family) return [...ALL_QUALITIES];
  const base = OPENAI_IMAGE_FAMILIES[family].qualities;
  return family === 'gpt-image' && EXTENDED_QUALITY_MODEL.test(bareModelId(model)) ? [...base, ...OPENAI_IMAGE_EXTENDED_QUALITIES] : [...base];
}

export function openAIImageModelHasPixelFloor(model = '') {
  return PIXEL_FLOOR_MODEL.test(bareModelId(model));
}

export function openAIImageModelFamily(model = '') {
  const id = bareModelId(model);
  if (id.startsWith('gpt-image-')) return 'gpt-image';
  if (id.startsWith('dall-e-3')) return 'dall-e-3';
  if (id.startsWith('dall-e-')) return 'dall-e-2';
  return null;
}

function invalid(error) {
  return { ok: false, error };
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function parseOpenAIImageSize(value) {
  const match = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i.exec(String(value ?? ''));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function checkOpenAIImageSize(value, family = null, { model = '' } = {}) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'auto') return { size: 'auto' };
  const parsed = parseOpenAIImageSize(text);
  if (!parsed) return { error: 'size must be "auto" or WIDTHxHEIGHT in pixels, e.g. 1536x1024' };
  const size = `${parsed.width}x${parsed.height}`;
  const fixed = family ? OPENAI_IMAGE_FAMILIES[family]?.sizes : null;
  if (fixed) {
    return fixed.includes(size) ? { size } : { error: `size must be one of: ${fixed.join(', ')} for ${family}` };
  }
  if (!family && Object.values(OPENAI_IMAGE_FAMILIES).some((entry) => entry.sizes?.includes(size))) return { size };
  const { sizeStep, edgeMax, pixelsMax, aspectMax } = OPENAI_IMAGE_LIMITS;
  const { width, height } = parsed;
  if (width % sizeStep || height % sizeStep) return { error: `size ${size}: both edges must be multiples of ${sizeStep}` };
  if (Math.max(width, height) > edgeMax) return { error: `size ${size}: the longer edge may be at most ${edgeMax}` };
  if (width * height > pixelsMax) return { error: `size ${size}: at most ${pixelsMax} pixels (3840x2160)` };
  if (model && openAIImageModelHasPixelFloor(model) && width * height < OPENAI_IMAGE_LIMITS.pixelsMin) {
    return { error: `size ${size}: ${bareModelId(model)} takes ${OPENAI_IMAGE_LIMITS.pixelsMin} to ${pixelsMax} pixels, this is ${width * height}` };
  }
  if (Math.max(width, height) > aspectMax * Math.min(width, height)) {
    return { error: `size ${size}: the aspect ratio must lie between 1:${aspectMax} and ${aspectMax}:1` };
  }
  return { size };
}

export function validateOpenAIImageOptions(input, { model = '', field = 'image' } = {}) {
  if (input === undefined || input === null) return { ok: true, values: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return invalid(`${field} must be an object with any of: ${OPENAI_IMAGE_OPTION_KEYS.join(', ')}`);
  }
  const unknown = Object.keys(input).filter((key) => !OPENAI_IMAGE_OPTION_KEYS.includes(key) && !isEmpty(input[key]));
  if (unknown.length) {
    return invalid(`${field} does not take: ${unknown.slice(0, 10).join(', ')}. It takes: ${OPENAI_IMAGE_OPTION_KEYS.join(', ')}`);
  }
  const family = model ? openAIImageModelFamily(model) : null;
  if (model && !family) return invalid(`${field} options go with an OpenAI image model (gpt-image-*, dall-e-*), not ${String(model).slice(0, 80)}`);
  const rules = family ? OPENAI_IMAGE_FAMILIES[family] : null;
  const values = {};

  if (!isEmpty(input.size)) {
    const checked = checkOpenAIImageSize(input.size, family, { model });
    if (checked.error) return invalid(`${field}.${checked.error}`);
    values.size = checked.size;
  }
  if (!isEmpty(input.quality)) {
    const quality = String(input.quality).trim().toLowerCase();
    const allowed = openAIImageModelQualities(model);
    if (!allowed.includes(quality)) {
      const extendedNote = family === 'gpt-image' && OPENAI_IMAGE_EXTENDED_QUALITIES.includes(quality)
        ? ` (${OPENAI_IMAGE_EXTENDED_QUALITIES.join(' and ')}: the gpt-image 2.5 and 2.6 models only)`
        : '';
      return invalid(`${field}.quality must be one of: ${allowed.join(', ')}${model ? ` for ${bareModelId(model)}` : ''}${extendedNote}`);
    }
    values.quality = quality;
  }
  if (!isEmpty(input.count)) {
    const count = Number(input.count);
    const max = rules ? rules.countMax : OPENAI_IMAGE_LIMITS.countMax;
    if (typeof input.count === 'boolean' || !Number.isInteger(count) || count < 1 || count > max) {
      return invalid(`${field}.count must be a whole number from 1 to ${max}${family ? ` for ${family}` : ''}`);
    }
    values.count = count;
  }
  for (const [key, allowed] of [['output_format', OPENAI_IMAGE_OUTPUT_FORMATS], ['background', OPENAI_IMAGE_BACKGROUNDS]]) {
    if (isEmpty(input[key])) continue;
    const value = String(input[key]).trim().toLowerCase();
    if (rules && !rules.formats) return invalid(`${field}.${key} goes with gpt-image models only, not ${family}`);
    if (!allowed.includes(value)) return invalid(`${field}.${key} must be one of: ${allowed.join(', ')}`);
    values[key] = value;
  }
  if (values.background === 'transparent' && values.output_format === 'jpeg') {
    return invalid(`${field}.background "transparent" needs output_format png or webp`);
  }
  return { ok: true, values };
}

// ---- Mirror of shared/openai-image-previews.mjs (event names) ------------

export const OPENAI_IMAGE_STARTED_EVENT = 'image_started';
export const OPENAI_IMAGE_PREVIEW_EVENT = 'image_preview';
export const OPENAI_IMAGE_PREVIEW_RESET_EVENT = 'image_preview_reset';
export const OPENAI_IMAGE_PREVIEW_RESET_REASONS = Object.freeze(['retry', 'done', 'failed']);

// ---- Composer choices ---------------------------------------------------

// The Size select's "Custom…" entry: chosen, it opens the W×H input. Never
// sent: a send while it is selected (no valid size typed) is refused.
export const IMAGE_SIZE_CUSTOM_VALUE = '__custom__';

// The presets the Size select lists for gpt-image models; dall-e models list
// their family's fixed sizes.
export const GPT_IMAGE_SIZE_PRESETS = Object.freeze(['auto', '1024x1024', '1536x1024', '1024x1536']);

/**
 * What the composer offers for `model`: null for a model that makes no
 * images. `sizes` are the select's fixed entries, `customSize` whether it
 * gets "Custom…", `countMax` the Count select's top (hidden at 1),
 * `formats`/`backgrounds` the Format and Background lists (null: hidden).
 */
export function imageComposerChoices(model = '') {
  const family = openAIImageModelFamily(model);
  if (!family) return null;
  const rules = OPENAI_IMAGE_FAMILIES[family];
  return {
    family,
    sizes: rules.sizes ? [...rules.sizes] : [...GPT_IMAGE_SIZE_PRESETS],
    customSize: !rules.sizes,
    qualities: openAIImageModelQualities(model),
    countMax: rules.countMax,
    showCount: rules.countMax > 1,
    formats: rules.formats ? [...OPENAI_IMAGE_OUTPUT_FORMATS] : null,
    backgrounds: rules.formats ? [...OPENAI_IMAGE_BACKGROUNDS] : null,
  };
}

/** The catalog's efforts for an image model, kept to what its family takes (all of them when none matches). */
export function imageQualityOptions(model = '', catalogEfforts = []) {
  const family = openAIImageModelFamily(model);
  const list = Array.isArray(catalogEfforts) ? catalogEfforts : [];
  if (!family) return list;
  const allowed = openAIImageModelQualities(model);
  const kept = list.filter((effort) => allowed.includes(String(effort || '').trim().toLowerCase()));
  if (!kept.length) return list;
  // The catalog lists a gpt-image model's efforts up to high; xhigh and max
  // come from the model's own rules (the 2.5 and 2.6 models).
  const extra = allowed.filter((quality) => OPENAI_IMAGE_EXTENDED_QUALITIES.includes(quality) && !kept.includes(quality));
  return [...kept, ...extra];
}

/**
 * The reasoningEffort a send names for an image model's Quality: xhigh and
 * max are no effort the catalog lists (the relay would refuse them as one),
 * so the send names high there and `image.quality` carries the real value.
 */
export function imageEffortForSend(model = '', quality = '') {
  const text = String(quality || '').trim().toLowerCase();
  return openAIImageModelFamily(model) === 'gpt-image' && OPENAI_IMAGE_EXTENDED_QUALITIES.includes(text) ? 'high' : text;
}

/**
 * The W×H typed into the custom-size input, checked for the model's family:
 * `{ size }` (normalised "WxH") or `{ error }` to show under the input.
 */
export function checkCustomImageSize(text, model = '') {
  const family = openAIImageModelFamily(model);
  if (!family) return { error: 'Custom sizes go with an image model' };
  if (OPENAI_IMAGE_FAMILIES[family].sizes) return { error: `${family} takes its listed sizes only` };
  const raw = String(text ?? '').trim();
  if (!raw) return { error: 'Enter WIDTHxHEIGHT, e.g. 2048x1152' };
  if (raw.toLowerCase() === 'auto') return { error: 'Pick "auto" from the list; enter WIDTHxHEIGHT here' };
  const checked = checkOpenAIImageSize(raw, family, { model });
  if (checked.error) return { error: checked.error.replace(/^size /, 'Size ') };
  return { size: checked.size };
}

/** Whether `size` is one of the select's fixed entries for `model`. */
export function isListedImageSize(size, model = '') {
  const choices = imageComposerChoices(model);
  return !!choices && choices.sizes.includes(String(size || '').trim().toLowerCase());
}

/**
 * The composer's stored values for one conversation, kept to what `model`
 * takes: a size its family refuses, a count above its top, a format on dall-e
 * are dropped (the select's default shows then).
 */
export function clampImageComposerValues(values = {}, model = '') {
  const choices = imageComposerChoices(model);
  if (!choices || !values || typeof values !== 'object') return {};
  const out = {};
  const size = String(values.size || '').trim().toLowerCase();
  if (size) {
    const checked = checkOpenAIImageSize(size, choices.family);
    if (!checked.error) out.size = checked.size;
  }
  const count = Number(values.count);
  if (Number.isInteger(count) && count >= 1 && count <= choices.countMax) out.count = count;
  if (choices.formats) {
    const format = String(values.output_format || '').trim().toLowerCase();
    if (choices.formats.includes(format)) out.output_format = format;
    const background = String(values.background || '').trim().toLowerCase();
    if (choices.backgrounds.includes(background)) out.background = background;
  }
  return out;
}

/**
 * The `image` field of POST /api/message for the composer's values, checked
 * with validateOpenAIImageOptions for `model`, and the `contextTier` that goes
 * with it (the size, for relays that read it there), and the preset's name
 * as `image.preset` when one is picked. `{ ok:true, image,
 * contextTier }` or `{ ok:false, error, field }` (field: 'size' | 'image').
 * A quality the family does not take (a catalog value) is left to the
 * effort field; Count, Format and Background only for families that take them.
 * `customText` is what the custom size field holds while the select says
 * Custom… (no valid size in it yet): its own reason is the refusal.
 */
export function buildImageSendOptions({
  model = '',
  size = '',
  customText = '',
  quality = '',
  count = 1,
  outputFormat = '',
  background = '',
  preset = '',
} = {}) {
  const choices = imageComposerChoices(model);
  if (!choices) return { ok: false, field: 'image', error: 'Image options go with an image model' };
  let sizeText = String(size || '').trim().toLowerCase();
  if (!sizeText || sizeText === IMAGE_SIZE_CUSTOM_VALUE) {
    const typed = String(customText || '').trim();
    if (!typed) return { ok: false, field: 'size', error: 'Enter a custom image size (WIDTHxHEIGHT) or pick one from the list' };
    const checked = checkCustomImageSize(typed, model);
    if (checked.error) return { ok: false, field: 'size', error: checked.error };
    sizeText = checked.size;
  }
  const input = { size: sizeText };
  const qualityText = String(quality || '').trim().toLowerCase();
  if (qualityText && choices.qualities.includes(qualityText)) input.quality = qualityText;
  const countValue = Number(count);
  input.count = Number.isInteger(countValue) && countValue >= 1 ? countValue : 1;
  if (choices.formats) {
    const format = String(outputFormat || '').trim().toLowerCase();
    if (format) input.output_format = format;
    const bg = String(background || '').trim().toLowerCase();
    if (bg) input.background = bg;
  }
  const checked = validateOpenAIImageOptions(input, { model });
  if (!checked.ok) {
    return { ok: false, field: /^image\.size/.test(checked.error) ? 'size' : 'image', error: checked.error };
  }
  // The preset picked goes along by name; the fields above win over it.
  const presetName = String(preset || '').trim().replace(/\s+/g, ' ');
  const image = presetName ? { ...checked.values, preset: presetName } : checked.values;
  return { ok: true, image, contextTier: checked.values.size };
}

// ---- Per-conversation storage (this device) ------------------------------

export const IMAGE_COMPOSER_STORAGE_KEY = 'oar_image_composer_options_v1';
export const IMAGE_COMPOSER_STORE_MAX = 200;

/** The stored map `{ [conversationId]: { size, count, output_format, background, preset, at } }` of a JSON text. */
export function parseImageComposerStore(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The store with `values` merged into `conversationId`'s entry; the oldest
 * entries go past IMAGE_COMPOSER_STORE_MAX. Keys outside size, count,
 * output_format, background and preset (a preset's name) are not kept.
 */
export function updateImageComposerStore(store, conversationId, values = {}, now = Date.now()) {
  const id = String(conversationId || '').trim();
  const next = { ...(store && typeof store === 'object' ? store : {}) };
  if (!id) return next;
  const entry = { ...(next[id] && typeof next[id] === 'object' ? next[id] : {}) };
  for (const key of ['size', 'count', 'output_format', 'background', 'preset']) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    if (isEmpty(values[key])) delete entry[key];
    else entry[key] = values[key];
  }
  entry.at = now;
  next[id] = entry;
  const ids = Object.keys(next);
  if (ids.length > IMAGE_COMPOSER_STORE_MAX) {
    ids.sort((a, b) => Number(next[a]?.at || 0) - Number(next[b]?.at || 0));
    for (const old of ids.slice(0, ids.length - IMAGE_COMPOSER_STORE_MAX)) delete next[old];
  }
  return next;
}

// ---- The placeholder of a running image turn -----------------------------

/** "m:ss" of an elapsed time in milliseconds (negative counts as 0). */
export function formatImageElapsed(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The CSS aspect-ratio of a size ("1536 / 1024"); square for auto or an unreadable one. */
export function imageAspectRatio(size) {
  const parsed = parseOpenAIImageSize(size);
  return parsed ? `${parsed.width} / ${parsed.height}` : '1 / 1';
}

/** The placeholder's details line: "1536x1024 · high · 2 images · gpt-image-2". */
export function imagePlaceholderDetails({ size = '', quality = '', count = 1, model = '' } = {}) {
  const parts = [];
  const sizeText = String(size || '').trim();
  if (sizeText) parts.push(sizeText === 'auto' ? 'auto size' : sizeText);
  const qualityText = String(quality || '').trim();
  if (qualityText) parts.push(qualityText === 'auto' ? 'auto quality' : qualityText);
  const n = Number(count);
  if (Number.isInteger(n) && n > 1) parts.push(`${n} images`);
  const modelText = String(model || '').trim();
  if (modelText) parts.push(modelText);
  return parts.join(' · ');
}

/**
 * The address a preview's `contentUrl` is loaded from: a relay path gets the
 * app's base; http(s) addresses pass; anything else is refused ('').
 */
export function resolveImagePreviewUrl(contentUrl, base = '') {
  const value = String(contentUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith('/') || value.startsWith('//')) return '';
  const normalizedBase = String(base || '').trim().replace(/\/+$/, '');
  if (normalizedBase && value.startsWith(`${normalizedBase}/`)) return value;
  return `${normalizedBase}${value}`;
}

function startedAtMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The placeholder state of one turn after a socket event, or null when the
 * placeholder goes. `state` is the turn's current state (null for none):
 *   { conversationId, messageId, attempt, size, quality, count, model,
 *     startedAtMs, retrying, partials: { [imageIndex]: { partialIndex, url } } }
 * `type` is 'started' | 'preview' | 'reset'. An event of an older attempt
 * than the state's is ignored (the state is returned as it is); a preview
 * older than the one shown for its image too.
 */
export function reduceImageTurnState(state, type, payload = {}, { base = '', now = Date.now() } = {}) {
  const messageId = String(payload?.messageId || '').trim();
  const conversationId = String(payload?.conversationId || '').trim();
  if (!messageId || !conversationId) return state || null;
  const current = state && state.messageId === messageId && state.conversationId === conversationId ? state : null;
  const attempt = Number.isInteger(Number(payload.attempt)) && Number(payload.attempt) > 0 ? Number(payload.attempt) : 1;
  if (current && attempt < current.attempt) return current;
  if (type === 'reset') {
    const reason = String(payload.reason || '').trim();
    if (reason === 'retry') {
      if (!current) return null;
      // `attempt` names the try whose previews went: a late partial of it
      // stays away.
      return { ...current, attempt: Math.max(current.attempt, attempt + 1), retrying: true, partials: {} };
    }
    return null;
  }
  const base0 = current || {
    conversationId,
    messageId,
    attempt,
    size: '',
    quality: '',
    count: 1,
    model: '',
    startedAtMs: null,
    retrying: false,
    partials: {},
  };
  const next = { ...base0, partials: { ...base0.partials } };
  if (attempt > next.attempt) {
    next.attempt = attempt;
    next.partials = {};
  }
  for (const key of ['size', 'quality', 'model']) {
    const value = String(payload[key] || '').trim();
    if (value) next[key] = value;
  }
  const count = Number(payload.count);
  if (Number.isInteger(count) && count >= 1) next.count = Math.min(count, OPENAI_IMAGE_PER_TURN_MAX);
  const started = startedAtMs(payload.startedAt);
  if (started !== null && (next.startedAtMs === null || type === 'started' || started < next.startedAtMs)) {
    next.startedAtMs = started;
  }
  if (next.startedAtMs === null) next.startedAtMs = now;
  // A new try that went out keeps the "trying again" hint until a partial shows.
  if (type === 'started') return next;
  if (type === 'preview') {
    const url = resolveImagePreviewUrl(payload.contentUrl, base);
    const imageIndex = Number(payload.imageIndex);
    if (!url || !Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= OPENAI_IMAGE_PER_TURN_MAX) return next;
    const partialIndex = Number.isFinite(Number(payload.partialIndex)) ? Number(payload.partialIndex) : 0;
    const shown = next.partials[imageIndex];
    if (shown && shown.partialIndex > partialIndex) return next;
    next.partials[imageIndex] = { partialIndex, url };
    next.retrying = false;
    if (imageIndex + 1 > next.count) next.count = imageIndex + 1;
    return next;
  }
  return next;
}
