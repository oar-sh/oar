// "Expand thoughts while an agent works" (Settings › General, and its mirror
// in the 🧠 modal). A setting of this browser, kept in localStorage like the
// scroll-on-send one. On unless switched off: it decides whether a thought
// starts open in the live turn, in a live sub-agent bubble and in the
// sub-agent viewer. A fold the reader opened or closed by hand wins over it.
// A finished message's 💭 fold stays closed either way. The document, the
// storage and the event target are passed in by the tests.

export const THOUGHTS_EXPANDED_STORAGE_KEY = 'copilot_thoughts_expanded';
export const THOUGHTS_EXPANDED_TOGGLE_ID = 'thoughts-expanded-toggle';
export const THOUGHTS_EXPANDED_CHANGE_EVENT = 'oar:thoughts-expanded-change';
// The 🧠 modal's two buttons: `data-thoughts-expanded` is "on" or "off".
export const THOUGHTS_EXPANDED_BUTTON_SELECTOR = '.ctx-thoughts-btn[data-thoughts-expanded]';

/** Anything but an explicit off is on: a missing or damaged value included. */
export function parseThoughtsExpandedSetting(stored) {
  const value = String(stored ?? '').trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false';
}

export function serializeThoughtsExpandedSetting(expanded) {
  return expanded ? '1' : '0';
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function isThoughtsExpanded(store = storage()) {
  try {
    return parseThoughtsExpandedSetting(store?.getItem(THOUGHTS_EXPANDED_STORAGE_KEY));
  } catch {
    return true;
  }
}

/** The Settings checkbox and the 🧠 buttons, wherever they are rendered. */
export function syncThoughtsExpandedToggle(doc = globalThis.document, store = storage()) {
  const expanded = isThoughtsExpanded(store);
  const checkbox = doc?.getElementById?.(THOUGHTS_EXPANDED_TOGGLE_ID);
  if (checkbox) checkbox.checked = expanded;
  const buttons = doc?.querySelectorAll?.(THOUGHTS_EXPANDED_BUTTON_SELECTOR) || [];
  for (const btn of buttons) {
    const active = (btn.dataset?.thoughtsExpanded === 'on') === expanded;
    btn.classList?.toggle('is-active', active);
    btn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
  }
}

export function updateThoughtsExpandedSetting(expanded, { doc = globalThis.document, store = storage(), target = globalThis.window } = {}) {
  const value = !!expanded;
  try { store?.setItem(THOUGHTS_EXPANDED_STORAGE_KEY, serializeThoughtsExpandedSetting(value)); } catch {}
  syncThoughtsExpandedToggle(doc, store);
  try {
    target?.dispatchEvent?.(new CustomEvent(THOUGHTS_EXPANDED_CHANGE_EVENT, { detail: { expanded: value } }));
  } catch {}
}

/**
 * Whether a thought fold shows open. `choice` is what the reader did by hand
 * ('open' | 'folded'), and it wins; everything else, a thought still
 * streaming included, follows the setting (`expanded`).
 */
export function thoughtFoldOpen({ choice = null, expanded = true } = {}) {
  if (choice === 'open') return true;
  if (choice === 'folded') return false;
  return !!expanded;
}

export const MAX_THOUGHT_FOLD_CHOICES = 500;

/** Record a hand fold; the oldest choice goes once the map is full. */
export function rememberThoughtFoldChoice(choices, key, open, max = MAX_THOUGHT_FOLD_CHOICES) {
  if (!choices || key === undefined || key === null || key === '') return;
  choices.delete(key);
  while (choices.size >= max) choices.delete(choices.keys().next().value);
  choices.set(key, open ? 'open' : 'folded');
}
