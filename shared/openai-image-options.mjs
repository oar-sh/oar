// The options of an OpenAI image turn (gpt-image-*, dall-e-*): size, quality,
// count, output format and background, checked in one place for the
// relay_tool contract, the relay's routes and the composer.
//
// SDK-free and side-effect free: imported by the server, the session workers
// and the browser.

// The models a new image session gets when the caller names none, in this
// order, the first the relay's OpenAI list has; else the first gpt-image id
// listed. A newer model the list offers (2.6 and up) is never picked by
// itself: a session gets one only when it is named.
export const OPENAI_IMAGE_DEFAULT_MODELS = Object.freeze([
  'gpt-image-2.5-flare',
  'gpt-image-2.5-flare-2026-09-08',
  'gpt-image-2',
]);
export const OPENAI_IMAGE_DEFAULT_MODEL = OPENAI_IMAGE_DEFAULT_MODELS[0];
// An image session asked for without a model on a relay whose OpenAI list
// has no gpt-image model at all.
export const OPENAI_IMAGE_NO_MODEL_CODE = 'OPENAI_IMAGE_NO_MODEL';

// Images one turn may produce (count) and attach (images): one number for both.
export const OPENAI_IMAGE_PER_TURN_MAX = 4;

// POST /api/message refuses an image path, a file that is no image, a model
// that makes no images or an option that model does not take with this code
// (400); nothing is queued then.
export const IMAGE_INPUT_REFUSED_CODE = 'IMAGE_INPUT_REFUSED';

export const OPENAI_IMAGE_LIMITS = Object.freeze({
  countMax: OPENAI_IMAGE_PER_TURN_MAX,
  inputImagesMax: OPENAI_IMAGE_PER_TURN_MAX,
  // One attached image, read from disk on the target relay.
  inputImageBytesMax: 20 * 1024 * 1024,
  // gpt-image sizes: both edges a multiple of sizeStep, the longer at most
  // edgeMax, the area at most pixelsMax (3840x2160), the long edge at most
  // aspectMax times the short one.
  sizeStep: 16,
  edgeMax: 3840,
  pixelsMax: 3840 * 2160,
  aspectMax: 3,
  // The fewest pixels gpt-image-2 and the 2.5 models take ("The total pixel
  // count must be between 655,360 and 8,294,400", OpenAI's image-generation
  // guide, "Size and quality options" and the gpt-image-2 settings, read
  // 2026-11-08). It goes by family: gpt-image-2 and every later 2.x model
  // (2.6 included); earlier models keep their sizes.
  pixelsMin: 655_360,
});

export const OPENAI_IMAGE_OPTION_KEYS = Object.freeze(['size', 'quality', 'count', 'output_format', 'background']);

export const OPENAI_IMAGE_OUTPUT_FORMATS = Object.freeze(['png', 'webp', 'jpeg']);
export const OPENAI_IMAGE_BACKGROUNDS = Object.freeze(['auto', 'transparent', 'opaque']);
export const OPENAI_IMAGE_MIME_BY_FORMAT = Object.freeze({ png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg' });

// What each model family takes. dall-e keep their fixed size lists; `auto`
// size or quality on a dall-e model means "not sent" (the API's own default).
export const OPENAI_IMAGE_FAMILIES = Object.freeze({
  'gpt-image': Object.freeze({
    sizes: null,
    // Every gpt-image model takes these; the 2.5 and 2.6 models take
    // OPENAI_IMAGE_EXTENDED_QUALITIES too (openAIImageModelQualities).
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

// "gpt-image-2.5-sunburst and gpt-image-2.5-flare add xhigh and max quality
// settings … Earlier GPT Image models support quality settings up to high",
// and the calculator's note: "For GPT Image 2.6 and 2.5 Sunburst and Flare,
// the quality options are low, medium, high, xhigh, and max. For
// gpt-image-2, the options are low, medium, and high." (OpenAI's
// image-generation guide, "Size and quality options" and "Calculating
// costs", read 2026-11-08). A gpt-image id the relay does not know gets the
// narrower set.
export const OPENAI_IMAGE_EXTENDED_QUALITIES = Object.freeze(['xhigh', 'max']);
const EXTENDED_QUALITY_MODEL = /^gpt-image-2\.[56](?:-|$)/;
// gpt-image-2 and later 2.x ids: the pixel floor applies (pixelsMin).
const PIXEL_FLOOR_MODEL = /^gpt-image-2(?:$|[.-])/;

const ALL_QUALITIES = Object.freeze([
  ...new Set([...Object.values(OPENAI_IMAGE_FAMILIES).flatMap((family) => family.qualities), ...OPENAI_IMAGE_EXTENDED_QUALITIES]),
]);

function bareModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/^openai\//, '');
}

export function isOpenAIImageModelId(model = '') {
  const id = bareModelId(model);
  return id.startsWith('gpt-image-') || id.startsWith('dall-e-');
}

// Copilot lists image ids its runtime cannot serve: a Copilot chat on one is
// refused with this code (creation, model switch, send), pointing to an
// OpenAI Image chat.
export const OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE = 'IMAGE_MODEL_NEEDS_OPENAI';

export function openAIImageModelNeedsOpenAIText(model = '') {
  return `"${String(model || '').trim().slice(0, 120)}" makes images: start an OpenAI Image chat (provider openai) for it.`;
}

/**
 * The model a new image session gets when the caller names none, from the
 * ids the relay's OpenAI provider lists: the first of
 * OPENAI_IMAGE_DEFAULT_MODELS listed, else the first gpt-image id in the
 * list's order, else '' (the caller refuses with OPENAI_IMAGE_NO_MODEL_CODE).
 * Returned in the list's own casing.
 */
export function pickOpenAIImageDefaultModel(models = []) {
  const ids = (Array.isArray(models) ? models : []).map((value) => String(value || '').trim()).filter(Boolean);
  for (const wanted of OPENAI_IMAGE_DEFAULT_MODELS) {
    const listed = ids.find((id) => bareModelId(id) === wanted);
    if (listed) return listed;
  }
  return ids.find((id) => bareModelId(id).startsWith('gpt-image-')) || '';
}

export function openAIImageNoModelText(where = 'this relay') {
  return `The OpenAI model list on ${where} has no gpt-image model, so an image session has none to start on: `
    + 'name a model the list has, or turn a gpt-image model on in Settings → Providers → OpenAI.';
}

/**
 * The qualities `model` takes: its family's, and xhigh and max for the
 * gpt-image 2.5 and 2.6 models. Without a model, every value any model takes.
 */
export function openAIImageModelQualities(model = '') {
  const family = openAIImageModelFamily(model);
  if (!family) return [...ALL_QUALITIES];
  const base = OPENAI_IMAGE_FAMILIES[family].qualities;
  return family === 'gpt-image' && EXTENDED_QUALITY_MODEL.test(bareModelId(model)) ? [...base, ...OPENAI_IMAGE_EXTENDED_QUALITIES] : [...base];
}

/** Whether `model`'s sizes have the pixel floor (gpt-image-2 and later 2.x). */
export function openAIImageModelHasPixelFloor(model = '') {
  return PIXEL_FLOOR_MODEL.test(bareModelId(model));
}

/** 'gpt-image', 'dall-e-3', 'dall-e-2', or null for a model that makes no images. */
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

/** `{ width, height }` of a "WxH" text (also "W×H", "W X H"), or null. */
export function parseOpenAIImageSize(value) {
  const match = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i.exec(String(value ?? ''));
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * A size as the API takes it ("auto" or "WxH"), or `{ error }`. Without a
 * family the gpt-image rules apply, or a dall-e list entry passes as well
 * (the contract does not know the model; the relay checks again with it).
 * `model` adds the pixel floor of gpt-image-2 and later.
 */
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

/**
 * Checks the image options of one call or one session's defaults. `input` is
 * an object with any of OPENAI_IMAGE_OPTION_KEYS; empty values (null, '')
 * are left out. `model` names the image model when it is known (the relay);
 * without it every family's values pass that one of them takes. Returns
 * `{ ok:true, values }` (only the keys named, normalised) or `{ ok:false, error }`.
 * `field` prefixes the messages (the contract's "image").
 */
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

/**
 * The options of one turn: the session's defaults with the turn's own values
 * over them, and count 1 when neither names one.
 */
export function mergeOpenAIImageOptions(defaults, override) {
  const merged = {};
  for (const source of [defaults, override]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of OPENAI_IMAGE_OPTION_KEYS) {
      if (!isEmpty(source[key])) merged[key] = source[key];
    }
  }
  if (!merged.count) merged.count = 1;
  return merged;
}

/**
 * The reply line of an image turn, for agents and the transcript alike when
 * the model wrote no text: "2 images · 1536x1024 · gpt-image-2 · ~USD 0.08".
 * `images` are `{ width, height }` entries; the cost part only when known.
 */
export function formatOpenAIImageSummary({ images = [], model = '', costUsd = null } = {}) {
  const list = Array.isArray(images) ? images : [];
  const parts = [`${list.length} image${list.length === 1 ? '' : 's'}`];
  const sizes = [...new Set(list.filter((image) => image?.width > 0 && image?.height > 0).map((image) => `${image.width}x${image.height}`))];
  if (sizes.length) parts.push(sizes.join(', '));
  const id = String(model || '').trim();
  if (id) parts.push(id);
  if (Number.isFinite(costUsd) && costUsd >= 0) parts.push(`~USD ${costUsd < 0.01 && costUsd > 0 ? costUsd.toFixed(3) : costUsd.toFixed(2)}`);
  return parts.join(' · ');
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}
