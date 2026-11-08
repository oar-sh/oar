// What an OpenAI image request costs: the price of the usage OpenAI reported,
// and an estimate before (or instead of) one, for the daily cap
// (shared/openai-image-spend.mjs) and the reply line.
//
// - A model is looked up by its bare lower-case id, then with a dated
//   snapshot suffix (-YYYY-MM-DD) stripped. There is no family fallback.
// - A model the table lacks gets the stand-in: never a missing cost (a cost
//   the cap cannot add up is no cost to it), always `costUnknown: true`.
// - `auto` quality is the model's dearest quality. `auto` size (and a size
//   that cannot be read) counts as 1536x1024: OpenAI says what `auto` costs
//   depends on the image it makes, and the landscape size is the one the
//   relay's composer offers first.
// - Partial images are added to estimates only (100 image output tokens
//   each); a reported usage is priced as it is.
//
// SDK-free and side-effect free.

import { OPENAI_IMAGE_COST_SOURCES } from './openai-image-spend.mjs';

// The per-image cost of a size OpenAI chooses (`auto`), or of a size the
// estimate cannot read.
export const OPENAI_IMAGE_AUTO_SIZE = '1536x1024';
// "each partial image will incur an additional 100 image output tokens"
// (developers.openai.com/api/docs/guides/image-generation, "Partial images
// cost", l.3673; read 2026-11-08).
export const OPENAI_IMAGE_PARTIAL_OUTPUT_TOKENS = 100;
// The input an estimate allows for, besides the images: the prompt as text
// tokens, and each input image (edits) as image input tokens. Assumptions,
// not published figures: OpenAI gives no input token counts for these
// models; the guide says only that gpt-image-2 reads input images at high
// fidelity, so edits "can use more input tokens" (l.3764-3765, 3788).
export const OPENAI_IMAGE_ESTIMATE_PROMPT_TOKENS = 500;
export const OPENAI_IMAGE_ESTIMATE_INPUT_IMAGE_TOKENS = 4000;

const PER_MILLION = 1_000_000;

// ---------------------------------------------------------------------------
// TABLE. Each entry names its source and the day it was read. Rates are USD
// per 1M tokens: text input, image input, image output. Standard rates only:
// cached input rates apply to the Responses API's image tool alone, "not ...
// direct Images API requests, including /v1/images/edits" (guide l.3644), and
// cached counts are not in `usage` (l.3646).
//
// `outputTokens`: the guide's token calculator for the 2.x models, computed
// for any size: base = per quality; d = base / (long edge / short edge),
// rounded half to even; tokens = ceil(base * d * (2e6 + w * h) / 4e6); for
// 2.6 that times a per-quality factor, rounded. The calculator "Excludes text
// and image input tokens and streaming partial images." Source:
// https://developers.openai.com/_astro/GptImageTokenCalculator.react.eSCKNoob.js
// (read 2026-11-08); its gpt-image-2 figures match the guide's published
// per-image table (l.3840-3854).
//
// `perImageUsd`: the published per-image prices of the older models, for
// their three sizes (guide "Earlier GPT Image models", l.3858-3921, and the
// model pages; read 2026-11-08).
//
// dall-e-3 and dall-e-2 have no entry: OpenAI lists no price for them (both
// were shut down 2026-05-12, developers.openai.com/api/docs/deprecations);
// they get the stand-in.
// ---------------------------------------------------------------------------

const GPT_IMAGE_2X_BASE = Object.freeze({ low: 16, medium: 24, high: 48, xhigh: 64, max: 96 });

// Rates: developers.openai.com/api/docs/pricing (#image-generation) and the
// model pages, read 2026-11-08. Output tokens: the calculator (above).
const GPT_IMAGE_2_6 = Object.freeze({
  rates: Object.freeze({ textInput: 5, imageInput: 8, imageOutput: 30 }),
  outputTokens: Object.freeze({
    base: GPT_IMAGE_2X_BASE,
    factor: Object.freeze({ low: 4.2, medium: 3.3, high: 1, xhigh: 1, max: 1 }),
  }),
  qualities: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

// Rates: the pricing page and the guide (l.3638: "Both GPT Image 2.5 models
// use the same token rates"), read 2026-11-08. Output tokens: the calculator.
const GPT_IMAGE_2_5 = Object.freeze({
  rates: Object.freeze({ textInput: 5, imageInput: 8, imageOutput: 30 }),
  outputTokens: Object.freeze({ base: GPT_IMAGE_2X_BASE }),
  qualities: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

const OPENAI_IMAGE_PRICE_TABLE = Object.freeze({
  'gpt-image-2.6-sunburst': GPT_IMAGE_2_6,
  'gpt-image-2.6-flare': GPT_IMAGE_2_6,
  'gpt-image-2.5-sunburst': GPT_IMAGE_2_5,
  'gpt-image-2.5-flare': GPT_IMAGE_2_5,
  // Rates: the pricing page and the model page, read 2026-11-08. Output
  // tokens: the calculator (= the guide's table, l.3840-3854).
  'gpt-image-2': Object.freeze({
    rates: Object.freeze({ textInput: 5, imageInput: 8, imageOutput: 30 }),
    outputTokens: Object.freeze({ base: Object.freeze({ low: 16, medium: 48, high: 96 }) }),
    qualities: Object.freeze(['low', 'medium', 'high']),
  }),
  // Rates: the pricing page and the model page (deprecated, off
  // 2026-12-01), read 2026-11-08. Per image: guide l.3858-3921.
  'gpt-image-1.5': Object.freeze({
    rates: Object.freeze({ textInput: 5, imageInput: 8, imageOutput: 32 }),
    perImageUsd: Object.freeze({
      low: Object.freeze({ '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 }),
      medium: Object.freeze({ '1024x1024': 0.034, '1024x1536': 0.05, '1536x1024': 0.05 }),
      high: Object.freeze({ '1024x1024': 0.133, '1024x1536': 0.2, '1536x1024': 0.2 }),
    }),
    qualities: Object.freeze(['low', 'medium', 'high']),
  }),
  // Rates: the pricing page and the model page (deprecated, off
  // 2026-12-01), read 2026-11-08. Per image: guide l.3858-3921.
  'gpt-image-1-mini': Object.freeze({
    rates: Object.freeze({ textInput: 2, imageInput: 2.5, imageOutput: 8 }),
    perImageUsd: Object.freeze({
      low: Object.freeze({ '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 }),
      medium: Object.freeze({ '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 }),
      high: Object.freeze({ '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 }),
    }),
    qualities: Object.freeze(['low', 'medium', 'high']),
  }),
  // Rates: the model page (shut down 2026-10-23), read 2026-11-08. Per
  // image: guide l.3858-3921.
  'gpt-image-1': Object.freeze({
    rates: Object.freeze({ textInput: 5, imageInput: 10, imageOutput: 40 }),
    perImageUsd: Object.freeze({
      low: Object.freeze({ '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 }),
      medium: Object.freeze({ '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 }),
      high: Object.freeze({ '1024x1024': 0.167, '1024x1536': 0.25, '1536x1024': 0.25 }),
    }),
    qualities: Object.freeze(['low', 'medium', 'high']),
  }),
});
// END OF TABLE
// ---------------------------------------------------------------------------

// The per-image stand-in for a model the table lacks: the dearest of every
// model the table prices, at the quality and size asked for (a model's
// dearest quality where it lacks the one asked for), so an unknown model is
// never estimated below a known one.
const STAND_IN_PER_IMAGE_MODELS = Object.freeze(Object.keys(OPENAI_IMAGE_PRICE_TABLE));

// The token rates of the stand-in: the dearest rate of each kind the table
// has, so a usage of an unknown model is never priced low.
const STAND_IN_RATES = Object.freeze(Object.fromEntries(
  ['textInput', 'imageInput', 'imageOutput'].map((key) => [
    key,
    Math.max(...Object.values(OPENAI_IMAGE_PRICE_TABLE).map((entry) => entry.rates[key])),
  ]),
));

/** The models the table prices, for tests and the settings view. */
export const OPENAI_IMAGE_PRICED_MODELS = Object.freeze(Object.keys(OPENAI_IMAGE_PRICE_TABLE));

/** The id an image turn books under: bare (no `openai/`), lower-case. */
export function openAIImageBookingModel(model) {
  return String(model || '').trim().toLowerCase().replace(/^openai\//, '');
}

/** The table entry of a model: its exact id, else the id without a dated snapshot suffix; or null. */
export function findOpenAIImagePriceEntry(model) {
  const id = openAIImageBookingModel(model);
  if (!id) return null;
  if (Object.hasOwn(OPENAI_IMAGE_PRICE_TABLE, id)) return OPENAI_IMAGE_PRICE_TABLE[id];
  const bare = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return bare !== id && Object.hasOwn(OPENAI_IMAGE_PRICE_TABLE, bare) ? OPENAI_IMAGE_PRICE_TABLE[bare] : null;
}

function roundUsd(value) {
  return Math.round(value * 1e9) / 1e9;
}

function sizeOf(size) {
  const match = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i.exec(String(size ?? ''));
  const text = match ? `${Number(match[1])}x${Number(match[2])}` : OPENAI_IMAGE_AUTO_SIZE;
  const [width, height] = text.split('x').map(Number);
  return width > 0 && height > 0 ? { width, height, text } : { width: 1536, height: 1024, text: OPENAI_IMAGE_AUTO_SIZE };
}

// The quality an entry is priced at: the one asked for when it has it, else
// (`auto`, empty, or one it does not know) its dearest.
function qualityFor(entry, quality) {
  const wanted = String(quality || '').trim().toLowerCase();
  return entry.qualities.includes(wanted) ? wanted : entry.qualities[entry.qualities.length - 1];
}

function roundHalfEven(value) {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
}

/** Image output tokens of one image by the guide calculator's formula. */
export function openAIImageOutputTokens({ model, size, quality }) {
  const entry = findOpenAIImagePriceEntry(model);
  if (!entry?.outputTokens) return null;
  const { width, height } = sizeOf(size);
  const priced = qualityFor(entry, quality);
  const base = entry.outputTokens.base[priced];
  const d = roundHalfEven(base / (Math.max(width, height) / Math.min(width, height)));
  const tokens = Math.ceil((base * d * (2e6 + width * height)) / 4e6);
  const factor = entry.outputTokens.factor?.[priced];
  return factor ? Math.round(tokens * factor) : tokens;
}

// One image's price for a table entry: its output tokens at the output
// rate, or the published price of the listed size the image is closest to
// in shape, scaled by area.
function entryPerImageUsd(entry, model, size, quality) {
  if (entry.outputTokens) {
    return (openAIImageOutputTokens({ model, size, quality }) * entry.rates.imageOutput) / PER_MILLION;
  }
  const prices = entry.perImageUsd[qualityFor(entry, quality)];
  const { width, height, text } = sizeOf(size);
  if (Object.hasOwn(prices, text)) return prices[text];
  const listed = width > height * 1.25 ? '1536x1024' : (height > width * 1.25 ? '1024x1536' : '1024x1024');
  const [listedWidth, listedHeight] = listed.split('x').map(Number);
  return prices[listed] * ((width * height) / (listedWidth * listedHeight));
}

function standInPerImageUsd(size, quality) {
  return Math.max(...STAND_IN_PER_IMAGE_MODELS.map((id) => (
    entryPerImageUsd(OPENAI_IMAGE_PRICE_TABLE[id], id, size, quality)
  )));
}

function rateOf(entry, key) {
  return (entry ? entry.rates : STAND_IN_RATES)[key];
}

function countOf(value) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function tokensOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * One image's estimated price, times `count`: what the images of a request
 * cost at least, without input or partials. `{ costUsd, costUnknown }`;
 * `costUnknown` for the stand-in.
 */
export function openAIImageCostFloor({ model, size, quality, count = 1 } = {}) {
  const entry = findOpenAIImagePriceEntry(model);
  const perImage = entry ? entryPerImageUsd(entry, model, size, quality) : standInPerImageUsd(size, quality);
  return { costUsd: roundUsd(perImage * countOf(count)), costUnknown: !entry };
}

/**
 * What a request may cost before OpenAI has said: the floor, plus the
 * partial images received (100 image output tokens each), plus an allowance
 * for the prompt and each input image. `{ costUsd, costUnknown }`, never a
 * missing cost.
 */
export function estimateOpenAIImageCost({ model, size, quality, count = 1, partials = 0, inputImages = 0 } = {}) {
  const entry = findOpenAIImagePriceEntry(model);
  const floor = openAIImageCostFloor({ model, size, quality, count });
  const partialUsd = (tokensOf(partials) * OPENAI_IMAGE_PARTIAL_OUTPUT_TOKENS * rateOf(entry, 'imageOutput')) / PER_MILLION;
  const inputUsd = (OPENAI_IMAGE_ESTIMATE_PROMPT_TOKENS * rateOf(entry, 'textInput')
    + tokensOf(inputImages) * OPENAI_IMAGE_ESTIMATE_INPUT_IMAGE_TOKENS * rateOf(entry, 'imageInput')) / PER_MILLION;
  return { costUsd: roundUsd(floor.costUsd + partialUsd + inputUsd), costUnknown: floor.costUnknown };
}

/**
 * The price of a usage OpenAI reported (`input_tokens`, `output_tokens`,
 * `input_tokens_details: { text_tokens, image_tokens }`):
 * `{ costUsd, costUnknown, source, inputTokens, outputTokens }`, `source`
 * being the cost_source to book. Input without the text/image split is
 * priced at the image input rate (the dearer). A model the table lacks is
 * priced at the dearest rates the table has, `costUnknown`. Null when the
 * usage holds no token count.
 */
export function priceOpenAIImageUsage({ model, usage } = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const hasInput = Number.isFinite(Number(usage.input_tokens)) && usage.input_tokens !== null;
  const hasOutput = Number.isFinite(Number(usage.output_tokens)) && usage.output_tokens !== null;
  if (!hasInput && !hasOutput) return null;
  const entry = findOpenAIImagePriceEntry(model);
  const input = tokensOf(usage.input_tokens);
  const output = tokensOf(usage.output_tokens);
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object' ? usage.input_tokens_details : null;
  const textTokens = details ? Math.min(input, tokensOf(details.text_tokens)) : 0;
  const imageTokens = input - textTokens;
  const costUsd = (textTokens * rateOf(entry, 'textInput')
    + imageTokens * rateOf(entry, 'imageInput')
    + output * rateOf(entry, 'imageOutput')) / PER_MILLION;
  return {
    costUsd: roundUsd(costUsd),
    costUnknown: !entry,
    source: entry ? OPENAI_IMAGE_COST_SOURCES.table : OPENAI_IMAGE_COST_SOURCES.estimate,
    inputTokens: hasInput ? input : null,
    outputTokens: hasOutput ? output : null,
  };
}
