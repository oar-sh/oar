// What OpenAI image turns cost, the daily cap and the image presets, as the
// web client shows them: the pure part, no DOM.
//
// The first two blocks mirror shared/openai-image-spend.mjs and
// shared/openai-image-presets.mjs, which the browser cannot import (only
// server/public is served). openai-image-spend.test.mjs asserts they stay
// identical.
//
// Money is always "USD 1.23": a `$` pair renders as maths in this client.

import { escapeHtml } from './context-usage-view.mjs';
import {
  OPENAI_IMAGE_OPTION_KEYS,
  imageComposerChoices,
  validateOpenAIImageOptions,
} from './openai-image-composer.mjs';

// ---- Mirror of shared/openai-image-spend.mjs ------------------------------

export const OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD = 5;
export const OPENAI_IMAGE_CAP_WARN_RATIO = 0.8;
export const OPENAI_IMAGE_DAILY_CAP_REACHED_CODE = 'OPENAI_IMAGE_DAILY_CAP_REACHED';
export const OPENAI_IMAGE_USAGE_PATH = '/api/image-usage';
export const OPENAI_IMAGE_USAGE_EVENT = 'image_usage_updated';
export const OPENAI_IMAGE_SETTINGS_FIELDS = Object.freeze({
  dailyCapUsd: 'imageDailyCapUsd',
  allowToday: 'allowImagesToday',
});
export const OPENAI_IMAGE_PRESETS_PATH = '/api/openai-image-presets';

// The relay's socket event with `{ presets }` after every preset change
// (sessions-routes.mjs), and the top of the cap POST /api/settings/openai
// takes.
export const OPENAI_IMAGE_PRESETS_EVENT = 'openai_image_presets_updated';
export const OPENAI_IMAGE_DAILY_CAP_MAX_USD = 10_000;

export function formatOpenAIImageUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'USD ?';
  return `USD ${number > 0 && number < 0.01 ? number.toFixed(3) : number.toFixed(2)}`;
}

// ---- Mirror of shared/openai-image-presets.mjs (names, built-ins) ---------

export const OPENAI_IMAGE_PRESET_LIMITS = Object.freeze({
  ownMax: 30,
  nameChars: 40,
  storedBytesMax: 8 * 1024,
});

export const OPENAI_IMAGE_PRESET_REFUSED_CODE = 'OPENAI_IMAGE_PRESET_REFUSED';

export const OPENAI_IMAGE_BUILTIN_PRESETS = Object.freeze([
  Object.freeze({ name: 'Draft square', size: '1024x1024', quality: 'low' }),
  Object.freeze({ name: 'Photo landscape', size: '1536x1024', quality: 'medium' }),
  Object.freeze({ name: 'Portrait', size: '1024x1536', quality: 'medium' }),
  Object.freeze({ name: 'Wallpaper 4K', size: '3840x2160', quality: 'high' }),
  Object.freeze({ name: 'Sticker', size: '1024x1024', quality: 'medium', output_format: 'png', background: 'transparent' }),
]);

const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/u;

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

export function openAIImagePresetKey(value) {
  const cleaned = cleanOpenAIImagePresetName(value);
  return cleaned.error ? '' : cleaned.name.toLowerCase();
}

// ---- The spend state ------------------------------------------------------

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** "5.00": an amount without its unit, for "USD 1.20 of 5.00". */
function bareAmount(value) {
  return formatOpenAIImageUsd(value).replace(/^USD /, '');
}

/**
 * The spend state of GET OPENAI_IMAGE_USAGE_PATH or the socket event, with
 * numbers that are numbers; null for anything that is not one.
 */
export function normalizeImageSpendState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cap = raw.capUsd === null || raw.capUsd === undefined ? null : Number(raw.capUsd);
  const capUsd = Number.isFinite(cap) && cap > 0 ? cap : null;
  const spentUsd = Math.max(0, finite(raw.spentUsd));
  const reservedUsd = Math.max(0, finite(raw.reservedUsd));
  const ratio = raw.ratio === null || raw.ratio === undefined
    ? (capUsd ? (spentUsd + reservedUsd) / capUsd : null)
    : finite(raw.ratio, null);
  const state = {
    day: String(raw.day || ''),
    capUsd,
    spentUsd,
    reservedUsd,
    estimatedUsd: Math.max(0, finite(raw.estimatedUsd)),
    unknownPriceUsd: Math.max(0, finite(raw.unknownPriceUsd)),
    monthUsd: Math.max(0, finite(raw.monthUsd)),
    ratio: capUsd ? ratio : null,
    warning: capUsd ? raw.warning === true : false,
    reached: capUsd ? raw.reached === true : false,
    allowedToday: raw.allowedToday === true,
    allowedAt: raw.allowedAt ? String(raw.allowedAt) : null,
  };
  const conversation = raw.conversation;
  if (conversation && typeof conversation === 'object' && !Array.isArray(conversation)) {
    state.conversation = {
      costUsd: Math.max(0, finite(conversation.costUsd)),
      estimatedUsd: Math.max(0, finite(conversation.estimatedUsd)),
      images: Math.max(0, Math.floor(finite(conversation.images))),
      tries: Math.max(0, Math.floor(finite(conversation.tries))),
    };
  }
  return state;
}

/** Today's spend the cap counts: booked plus in flight. */
export function imageSpendTodayUsd(state) {
  return finite(state?.spentUsd) + finite(state?.reservedUsd);
}

/** "USD 1.20 of 5.00", or "USD 1.20 (no cap)". */
function todayAgainstCap(state) {
  const today = formatOpenAIImageUsd(imageSpendTodayUsd(state));
  return state?.capUsd ? `${today} of ${bareAmount(state.capUsd)}` : `${today} (no cap)`;
}

/** The time of an ISO stamp in the reader's clock ("14:05"), or ''. */
function clockOf(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Settings → Providers → OpenAI's spend line:
 * "Today USD 1.20 of 5.00 · this month USD 7.80", with what is in flight and
 * the day's override when there are any.
 */
export function imageSpendSettingsLine(state) {
  if (!state) return '';
  const parts = [`Today ${todayAgainstCap(state)}`];
  if (state.reservedUsd > 0) parts.push(`${formatOpenAIImageUsd(state.reservedUsd)} of it in flight`);
  parts.push(`this month ${formatOpenAIImageUsd(state.monthUsd)}`);
  if (state.capUsd && state.allowedToday) {
    const at = clockOf(state.allowedAt);
    parts.push(at ? `allowed past the cap today (since ${at})` : 'allowed past the cap today');
  } else if (state.reached) {
    parts.push('cap reached');
  }
  return parts.join(' · ');
}

/**
 * The image chat's banner: `{ kind: 'reached' | 'warning', text }`, or null
 * when the spend is below the warning mark (or there is no cap).
 */
export function imageSpendBanner(state) {
  if (!state || !state.capUsd) return null;
  if (state.reached && !state.allowedToday) {
    return {
      kind: 'reached',
      text: 'Daily image cap reached: image turns are refused until tomorrow (relay time) or until you allow more today in Settings → Providers → OpenAI',
    };
  }
  if (state.warning || state.reached) {
    const allowed = state.allowedToday && state.reached ? ' (allowed past the cap today)' : '';
    return { kind: 'warning', text: `Today's OpenAI image spend: ${todayAgainstCap(state)}${allowed}` };
  }
  return null;
}

/** The chat menu's line: "OpenAI images: USD 0.42 in this chat (3 images)". */
export function imageChatCostText(conversation) {
  if (!conversation) return '';
  const images = Math.max(0, Math.floor(finite(conversation.images)));
  const parts = [images === 1 ? '1 image' : `${images} images`];
  if (finite(conversation.estimatedUsd) > 0) parts.push(`${formatOpenAIImageUsd(conversation.estimatedUsd)} of it estimated`);
  return `OpenAI images: ${formatOpenAIImageUsd(conversation.costUsd)} in this chat (${parts.join(', ')})`;
}

/**
 * The Allow / Stop allowing buttons of the settings section: `{ allow:
 * { shown, label }, stop: { shown } }`. Nothing without a cap; while allowed
 * only Stop allowing.
 */
export function imageSpendOverrideButtons(state) {
  const none = { allow: { shown: false, label: '' }, stop: { shown: false } };
  if (!state || !state.capUsd) return none;
  if (state.allowedToday) return { allow: { shown: false, label: '' }, stop: { shown: true } };
  return {
    allow: { shown: true, label: state.reached ? 'Allow for today' : 'Allow past the cap for today' },
    stop: { shown: false },
  };
}

// ---- The cap field ---------------------------------------------------------

/**
 * The cap as the field shows it, from GET /api/settings/openai's
 * imageDailyCapUsd: the default (5) when the relay names none, "0" for no
 * cap, else the amount ("12.5").
 */
export function imageCapInputText(capUsd) {
  if (capUsd === undefined) return String(OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD);
  if (capUsd === null) return '0';
  const value = Number(capUsd);
  if (!Number.isFinite(value) || value < 0) return String(OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD);
  return String(value);
}

/**
 * The cap field's text as the relay takes it: `{ ok: true, capUsd }` (0: no
 * cap) or `{ ok: false, error }`. The relay checks it again.
 */
export function parseImageCapInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, error: 'Enter the daily image cap in US dollars, or 0 for no cap.' };
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value) || Number(value) > OPENAI_IMAGE_DAILY_CAP_MAX_USD) {
    return { ok: false, error: `The daily image cap is an amount of US dollars up to ${OPENAI_IMAGE_DAILY_CAP_MAX_USD} (at most two decimals), or 0 for no cap.` };
  }
  return { ok: true, capUsd: Number(value) };
}

// ---- Presets ---------------------------------------------------------------

/** The option values a preset holds, in OPENAI_IMAGE_OPTION_KEYS order. */
export function imagePresetValues(preset) {
  const values = {};
  for (const key of OPENAI_IMAGE_OPTION_KEYS) {
    const value = preset?.[key];
    if (value !== undefined && value !== null && value !== '') values[key] = value;
  }
  return values;
}

const FORMAT_LABELS = Object.freeze({ png: 'PNG', webp: 'WebP', jpeg: 'JPEG' });

/** "1536x1024 · medium · 2 images · PNG · transparent background". */
export function describeImagePreset(preset) {
  const values = imagePresetValues(preset);
  const parts = [];
  if (values.size) parts.push(values.size === 'auto' ? 'auto size' : String(values.size));
  if (values.quality) parts.push(values.quality === 'auto' ? 'auto quality' : String(values.quality));
  const count = Number(values.count);
  if (Number.isInteger(count) && count >= 1) parts.push(count === 1 ? '1 image' : `${count} images`);
  if (values.output_format) parts.push(FORMAT_LABELS[values.output_format] || String(values.output_format));
  if (values.background) parts.push(`${values.background} background`);
  return parts.join(' · ');
}

/**
 * The presets list of GET/PUT/DELETE OPENAI_IMAGE_PRESETS_PATH, kept to
 * entries with a clean name, built-ins first; the client's built-ins when
 * the answer has none (an older relay, a failed read).
 */
export function normalizeImagePresets(answer) {
  const list = Array.isArray(answer?.presets) ? answer.presets : null;
  if (!list) return OPENAI_IMAGE_BUILTIN_PRESETS.map((preset) => ({ ...preset, builtIn: true }));
  const seen = new Set();
  const presets = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const cleaned = cleanOpenAIImagePresetName(entry.name);
    if (cleaned.error) continue;
    const key = cleaned.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ name: cleaned.name, ...imagePresetValues(entry), builtIn: entry.builtIn === true });
  }
  return [...presets.filter((preset) => preset.builtIn), ...presets.filter((preset) => !preset.builtIn)];
}

/** The preset of that name (any case, any spacing), or null. */
export function findImagePreset(presets, name) {
  const key = openAIImagePresetKey(String(name ?? ''));
  if (!key || !Array.isArray(presets)) return null;
  return presets.find((preset) => String(preset?.name || '').toLowerCase() === key) || null;
}

/**
 * What picking `preset` sets in the composer for `model`: `{ values, skipped }`.
 * `values` holds what the model's selects take (quality only when
 * `qualities` lists it: the Quality select's options); `skipped` names the
 * preset's fields the model does not take ("size 1536x1024"), which keep
 * what the composer shows.
 */
export function imagePresetComposerValues(preset, model = '', { qualities = null, currentFormat = '' } = {}) {
  const choices = imageComposerChoices(model);
  const values = {};
  const skipped = [];
  if (!choices) return { values, skipped };
  for (const [key, value] of Object.entries(imagePresetValues(preset))) {
    const checked = validateOpenAIImageOptions({ [key]: value }, { model });
    const clean = checked.ok ? checked.values[key] : undefined;
    const offered = key !== 'quality' || !Array.isArray(qualities) || qualities.includes(clean);
    if (clean === undefined || !offered) {
      skipped.push(`${key === 'output_format' ? 'format' : key} ${value}`);
      continue;
    }
    values[key] = clean;
  }
  // A transparent background needs PNG or WebP: with JPEG on screen and no
  // format in the preset, PNG goes with it.
  if (values.background === 'transparent' && !values.output_format && String(currentFormat || '').toLowerCase() === 'jpeg') {
    values.output_format = 'png';
  }
  return { values, skipped };
}

/** A save refused because an own preset has that name (the relay's words). */
export function isImagePresetExistsRefusal(error) {
  return /\bexists\b/i.test(String(error?.message ?? error ?? ''));
}

/**
 * The preset a save would write from the composer's checked `image` (the
 * send's values) under `name`: `{ ok: true, preset }` or `{ ok: false,
 * error }` for a name the relay would refuse (a built-in's included).
 */
export function buildImagePresetToSave(name, image = {}) {
  const cleaned = cleanOpenAIImagePresetName(String(name ?? ''));
  if (cleaned.error) return { ok: false, error: `${cleaned.error[0].toUpperCase()}${cleaned.error.slice(1)}.` };
  const key = cleaned.name.toLowerCase();
  if (OPENAI_IMAGE_BUILTIN_PRESETS.some((preset) => preset.name.toLowerCase() === key)) {
    return { ok: false, error: `"${cleaned.name}" is a built-in preset; pick another name.` };
  }
  const values = imagePresetValues(image);
  if (!Object.keys(values).length) return { ok: false, error: 'Nothing to save: pick a size or a quality first.' };
  return { ok: true, preset: { name: cleaned.name, ...values } };
}

// ---- The Check Usage card ---------------------------------------------------
//
// The relay's "OpenAI images" card of GET /api/usage (provider 'openai')
// carries the spend state as `imageSpend`: plan-usage-view.mjs draws its
// meter, figures and badges from it with these, so a live state (the socket
// event) redraws the whole card.

function usageColor(ratio) {
  if (ratio === null) return '#6e7681';
  if (ratio >= 1) return '#f85149';
  if (ratio >= OPENAI_IMAGE_CAP_WARN_RATIO) return '#e3b341';
  if (ratio >= 0.5) return '#d29922';
  return '#3fb950';
}

/** The figures of the card: `[{ id, label, value, hint? }]`. */
export function imageUsageCardFacts(state) {
  if (!state) return [];
  const facts = [
    { id: 'openai-images-month', label: 'This month', value: formatOpenAIImageUsd(state.monthUsd) },
    { id: 'openai-images-cap', label: 'Daily cap', value: state.capUsd ? formatOpenAIImageUsd(state.capUsd) : 'No cap' },
  ];
  if (state.reservedUsd > 0) {
    facts.push({ id: 'openai-images-reserved', label: 'In progress', value: formatOpenAIImageUsd(state.reservedUsd), hint: 'tries running now, counted toward the cap' });
  }
  if (state.estimatedUsd > 0) {
    facts.push({ id: 'openai-images-estimated', label: 'Estimated', value: formatOpenAIImageUsd(state.estimatedUsd), hint: 'part of today: tries that may have been billed without a usage report' });
  }
  if (state.unknownPriceUsd > 0) {
    facts.push({ id: 'openai-images-unknown-price', label: 'Unknown price', value: formatOpenAIImageUsd(state.unknownPriceUsd), hint: 'part of today: a model the price table lacks, booked at a stand-in price' });
  }
  if (state.capUsd) {
    const at = clockOf(state.allowedAt);
    facts.push({
      id: 'openai-images-override',
      label: 'Past the cap today',
      value: state.allowedToday ? (at ? `Allowed since ${at}` : 'Allowed') : 'Not allowed',
    });
  }
  return facts;
}

/** The card's badges: the cap reached, or allowed past it today. */
export function imageUsageBadgesHtml(state) {
  if (!state?.capUsd) return '';
  if (state.allowedToday) return '<span class="plan-usage-badge" data-testid="openai-image-usage-allowed">Allowed today</span>';
  if (state.reached) return '<span class="plan-usage-badge plan-usage-badge-status" data-testid="openai-image-usage-reached">Cap reached</span>';
  return '';
}

/**
 * The card's message, from the state: the cap reached (and whether today
 * is allowed), the warning share, or no cap.
 */
export function imageUsageCardMessage(state) {
  if (!state) return '';
  if (!state.capUsd) return 'No daily cap is set for OpenAI images on this relay.';
  if (state.reached && state.allowedToday) return 'Today\'s image spend has reached the daily cap; image turns run anyway, allowed for today in Settings → Providers → OpenAI.';
  const banner = imageSpendBanner(state);
  return banner ? `${banner.text}.` : '';
}

/**
 * Today against the cap: the bar with the 80 % mark, "USD 1.20 of 5.00 ·
 * resets at midnight (relay time)"; without a cap the amount alone.
 */
export function renderImageUsageMeterHtml(state) {
  if (!state) return '';
  const today = imageSpendTodayUsd(state);
  const ratio = state.capUsd ? today / state.capUsd : null;
  const percentLabel = ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
  const width = ratio === null ? 0 : Math.max(0, Math.min(100, ratio * 100));
  const markLeft = Math.round(OPENAI_IMAGE_CAP_WARN_RATIO * 100);
  const meta = state.capUsd
    ? `${formatOpenAIImageUsd(today)} of ${bareAmount(state.capUsd)} · resets at midnight (relay time)`
    : `${formatOpenAIImageUsd(today)} today · no cap`;
  const flags = state.estimatedUsd > 0 ? '<span class="plan-usage-flag">estimated</span>' : '';
  const bar = state.capUsd
    ? `<div class="plan-usage-bar plan-usage-bar-marked" role="img" aria-label="${escapeHtml(`Today: ${percentLabel} of the daily cap`)}">
        <span class="plan-usage-bar-fill" style="width:${width.toFixed(1)}%;background:${usageColor(ratio)}"></span>
        <span class="plan-usage-bar-mark" style="left:${markLeft}%" title="${markLeft}%: the warning mark" aria-hidden="true"></span>
      </div>`
    : '';
  return `
    <div class="plan-usage-meter plan-usage-meter-primary" data-meter-id="openai-images-daily-cap" data-testid="openai-image-usage-meter">
      <div class="plan-usage-meter-head">
        <span class="plan-usage-meter-label">Today${flags}</span>
        <span class="plan-usage-meter-pct">${escapeHtml(percentLabel)}</span>
      </div>
      ${bar}
      <div class="plan-usage-meter-meta" data-testid="openai-image-usage-today">${escapeHtml(meta)}</div>
    </div>
  `;
}
