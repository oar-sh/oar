// New Chat's provider list (journal-view.js): the providers that are on, in a
// fixed order, and the one preselected. No DOM.
//
// Copilot is listed like the others, by its switch (GET /api/settings/copilot
// `enabled`; a payload without it, or none at all, reads as on). Nothing is
// forced first: the preselection is the provider this browser last started a
// chat on, while it is on, else the first listed. That is a choice shown in
// the picker, not a default the relay applies.

export const NEW_CHAT_PROVIDER_STORAGE_KEY = 'oar_new_chat_provider';

/**
 * @param {object} settings the payloads New Chat loads, keyed as in provider
 *   readiness: copilot, openai, claude, claudeApi, claudeCloud, cursor, grok, deepseek
 * @returns {{ value: string, label: string }[]}
 */
export function newChatProviderOptions(settings = {}) {
  const on = (key) => settings?.[key]?.enabled === true;
  const options = [];
  if (settings?.copilot?.enabled !== false) options.push({ value: 'github', label: 'Copilot' });
  if (on('openai')) {
    options.push({ value: 'openai', label: 'OpenAI (BYOK)' });
    options.push({ value: 'openai-image', label: 'OpenAI Image (BYOK)' });
  }
  if (on('claude')) options.push({ value: 'claude', label: 'Claude SDK' });
  if (on('claudeApi')) options.push({ value: 'claude-api', label: 'Claude API' });
  if (on('claudeCloud')) options.push({ value: 'claude-cloud', label: 'Claude Cloud' });
  if (on('cursor')) options.push({ value: 'cursor', label: 'Cursor SDK' });
  if (on('grok')) options.push({ value: 'grok', label: 'Grok' });
  if (on('deepseek')) options.push({ value: 'deepseek', label: 'DeepSeek' });
  return options;
}

/** The provider to preselect: the last used while it is listed, else the first; '' with none. */
export function preselectedNewChatProvider(options = [], lastUsed = '') {
  const last = String(lastUsed || '').trim();
  if (last && options.some((option) => option.value === last)) return last;
  return options[0]?.value || '';
}

export function readLastNewChatProvider(storage = globalThis.localStorage) {
  try {
    return String(storage?.getItem?.(NEW_CHAT_PROVIDER_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

/** Kept once a chat was really started on it. */
export function rememberNewChatProvider(provider, storage = globalThis.localStorage) {
  const value = String(provider || '').trim();
  if (!value) return;
  try { storage?.setItem?.(NEW_CHAT_PROVIDER_STORAGE_KEY, value); } catch {}
}
