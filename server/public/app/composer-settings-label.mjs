// The composer's settings label ("🔒 Opus 5.5 · high · Auto · 1M") and
// its billing pill. Pure and DOM-free: composer-settings-ui.js reads the
// selects' shown option texts and hands them in.

export const COMPOSER_LABEL_SEPARATOR = ' · ';
export const COMPOSER_LOCK_GLYPH = '🔒';

// The effort select's placeholder when a model has no effort choice.
const UNAVAILABLE_EFFORT = 'unavailable';

// Values of the context-window select that are its default: the model's base
// window, or "auto" when the select is the image-size picker.
const DEFAULT_TIER_VALUES = new Set(['', 'default', 'auto']);

// Mode names the label shortens; the panel's select keeps the full name.
const SHORT_MODE_NAMES = new Map([['autopilot', 'Auto']]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The label's parts, in order: model, effort, mode, context window.
 * Each is `{ field, text }`; `field` names the panel field a tap on it opens
 * ('model' | 'effort' | 'mode' | 'tier'). The model part carries `locked`.
 *
 * - `cloud`: a cloud chat has no mode, effort or context window.
 * - an effort with no value or "Unavailable" is left out.
 * - the context window shows only when it is not the default.
 * - a hidden field (`hidden.mode` etc.) is left out.
 */
export function composerSettingsLabelParts({
  model = '',
  locked = false,
  effort = '',
  effortValue = undefined,
  mode = '',
  tier = '',
  tierValue = '',
  cloud = false,
  hidden = {},
} = {}) {
  const parts = [];
  const modelText = clean(model);
  if (modelText && !hidden.model) {
    parts.push({ field: 'model', text: modelText, locked: locked === true });
  }
  if (!cloud && !hidden.effort) {
    const effortText = clean(effort);
    const effortEmpty = effortValue !== undefined && clean(effortValue) === '';
    if (effortText && !effortEmpty && effortText.toLowerCase() !== UNAVAILABLE_EFFORT) {
      parts.push({ field: 'effort', text: effortText });
    }
  }
  if (!cloud && !hidden.mode) {
    const modeText = clean(mode);
    if (modeText) parts.push({ field: 'mode', text: SHORT_MODE_NAMES.get(modeText.toLowerCase()) || modeText });
  }
  if (!cloud && !hidden.tier) {
    const tierText = clean(tier);
    const value = clean(tierValue).toLowerCase();
    if (tierText && !DEFAULT_TIER_VALUES.has(value)) parts.push({ field: 'tier', text: tierText });
  }
  return parts;
}

/** A part as it reads in the label: the model gets the lock in front. */
export function composerSettingsPartText(part) {
  if (!part) return '';
  return part.field === 'model' && part.locked ? `${COMPOSER_LOCK_GLYPH} ${part.text}` : part.text;
}

/** The whole label as one string, e.g. "🔒 Opus 5.5 · high · Autopilot · 1M". */
export function composerSettingsLabelText(input = {}) {
  const parts = Array.isArray(input) ? input : composerSettingsLabelParts(input);
  return parts.map(composerSettingsPartText).filter(Boolean).join(COMPOSER_LABEL_SEPARATOR);
}

/**
 * The billing pill beside the label, from the billing toggle's state:
 * `{ visible, billing, text }`. Hidden when the toggle is hidden or says
 * no billing.
 */
export function composerBillingPill({ toggleVisible = false, billing = '' } = {}) {
  const value = clean(billing).toLowerCase();
  if (!toggleVisible || (value !== 'claude' && value !== 'claude-api')) {
    return { visible: false, billing: '', text: '' };
  }
  return { visible: true, billing: value, text: value === 'claude-api' ? 'API key' : 'Subscription' };
}
