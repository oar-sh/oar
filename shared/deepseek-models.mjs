// What OAR knows about DeepSeek without asking it: the provider id, the
// default endpoint, the models to offer when discovery has not run or failed,
// and the effort levels DeepSeek's thinking mode takes.
//
// Source: api-docs.deepseek.com (pricing, list-models and thinking-mode pages,
// built 2026-10-19). `deepseek-chat` and `deepseek-reasoner` were retired on
// 2026-07-24; thinking is a request parameter now, not a model of its own.

export const DEEPSEEK_PROVIDER_TYPE = 'deepseek';
export const DEEPSEEK_PROVIDER_LABEL = 'DeepSeek';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';

// Context window and output ceiling are the same for both today (1M / 384K).
export const DEEPSEEK_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;
// When a DeepSeek session compacts unless the conversation pins a window: far
// below the 1M window, so a turn after the cache has expired does not re-send
// most of a million tokens at the cache-miss price.
export const DEEPSEEK_DEFAULT_AUTO_COMPACT_WINDOW = 400_000;

export const DEFAULT_DEEPSEEK_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro']);

const KNOWN_MODELS = Object.freeze({
  'deepseek-flash': Object.freeze({ label: 'DeepSeek Flash', imageInput: true }),
  'deepseek-v4-pro': Object.freeze({ label: 'DeepSeek V4 Pro', imageInput: false }),
  // Aliases DeepSeek still accepts; both are served by the Flash model.
  'deepseek-v4-flash': Object.freeze({ label: 'DeepSeek V4 Flash', imageInput: true }),
  'deepseek-v4-flash-vision-exp': Object.freeze({ label: 'DeepSeek V4 Flash Vision', imageInput: true }),
});

// The levels a DeepSeek chat offers. DeepSeek folds medium and xhigh into
// high, so they are not offered. Its `none` (thinking off) is not offered
// either: Claude Code, which runs DeepSeek turns, never sends
// `thinking: {type: disabled}` for a DeepSeek model (requests captured
// 2026-10-24), and DeepSeek thinks unless told not to.
export const DEEPSEEK_REASONING_EFFORTS = Object.freeze(['low', 'high', 'max']);
export const DEFAULT_DEEPSEEK_REASONING_EFFORT = 'high';

// The levels DeepSeek itself maps other names to (thinking-mode guide), so an
// agent asking for "medium" gets what DeepSeek would run, not thinking off.
const DEEPSEEK_EFFORT_ALIASES = Object.freeze({
  none: 'low',
  minimal: 'low',
  medium: 'high',
  xhigh: 'high',
  ultra: 'max',
  ultracode: 'max',
});

/** A requested effort in DeepSeek's terms: one of DEEPSEEK_REASONING_EFFORTS, or '' for unknown. */
export function deepseekReasoningEffortFor(value) {
  const effort = String(value ?? '').trim().toLowerCase();
  if (!effort) return '';
  if (DEEPSEEK_REASONING_EFFORTS.includes(effort)) return effort;
  return DEEPSEEK_EFFORT_ALIASES[effort] || '';
}

// Commit attribution in DeepSeek chats: OAR's trailer or none. Claude Code's
// own ("vanilla") lines would credit Claude for DeepSeek's work.
export const DEEPSEEK_ATTRIBUTION_MODES = Object.freeze(['oar', 'off']);
export const DEFAULT_DEEPSEEK_ATTRIBUTION = 'oar';

function modelKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Whether a model id is one of DeepSeek's (its ids all carry the prefix). */
export function isDeepSeekModelId(value) {
  return modelKey(value).startsWith('deepseek-');
}

// What DeepSeek's Anthropic-compatible endpoint serves a Claude model id
// with (api-docs.deepseek.com, guides/anthropic_api): the Opus ids run on V4
// Pro, the Sonnet and Haiku ids on Flash. Claude Code sends such an id when
// an alias ("opus") has no ANTHROPIC_DEFAULT_*_MODEL pin, so a report or a
// badge may name a Claude model DeepSeek never ran.
const CLAUDE_FAMILIES_SERVED_AS = Object.freeze([
  ['claude-opus', 'deepseek-v4-pro'],
  ['claude-sonnet', 'deepseek-flash'],
  ['claude-haiku', 'deepseek-flash'],
]);

/**
 * The DeepSeek model a model name stands for, without Claude Code's `[1m]`
 * suffix: a DeepSeek id as given, a Claude id by the model DeepSeek serves it
 * with, '' for a name DeepSeek is not known to serve (an alias, another
 * vendor's id).
 */
export function deepseekServedModel(value) {
  const id = String(value ?? '').trim().replace(/\[1m\]$/i, '');
  const key = id.toLowerCase();
  if (key.startsWith('deepseek-')) return id;
  for (const [family, model] of CLAUDE_FAMILIES_SERVED_AS) {
    if (key.startsWith(family)) return model;
  }
  return '';
}

/** The display name of a DeepSeek model id: "DeepSeek Flash", or the id itself. */
export function deepseekModelLabel(value) {
  const id = String(value ?? '').trim();
  return KNOWN_MODELS[modelKey(id)]?.label || id;
}

/**
 * Whether the model takes image input. A model this module does not know is
 * treated as text-only: sending images to one that refuses them fails the
 * whole request, while passing an image as a file path still works.
 */
export function deepseekModelAcceptsImages(value) {
  return KNOWN_MODELS[modelKey(value)]?.imageInput === true;
}
