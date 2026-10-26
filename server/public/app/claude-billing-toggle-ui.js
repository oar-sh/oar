// The composer's billing toggle (claude-billing-toggle.mjs) on the page: a
// row above the composer, under the lock note, in Claude SDK chats. A press
// moves the open chat between the subscription and the saved API key through
// the relay's billing route; the relay's answer and its `conversation_billing`
// events (usage-limit-ui.js keeps them per chat) redraw it.

import { switchConversationBilling } from './api-client.js';
import { claudeApiSettingsState, onClaudeApiSettingsChange } from './claude-api-settings-ui.js';
import {
  CLAUDE_BILLING_CACHE_WARNING,
  claudeBillingSwitchedText,
  claudeBillingToggleModel,
} from './claude-billing-toggle.mjs';
import { conversations, currentConvId, showTransientRelayNotice } from './store.js';
import { conversationBillingState, onConversationBillingChange, setConversationBilling } from './usage-limit-ui.js';

const ROW_ID = 'claude-billing-toggle';

// The relay's refusals of a switch that say the target is closed for now: the
// toggle closes that side with the relay's reason until the next billing event.
const CLOSING_REFUSALS = new Set([
  'CLAUDE_API_CAP_REACHED',
  'CLAUDE_API_NOT_CONFIGURED',
  'CLAUDE_BILLING_MODEL_UNAVAILABLE',
  'CLAUDE_BILLING_HISTORY',
]);

let deps = {};
// The chats this page has a switch on its way for; one per chat.
const inFlightConversationIds = new Set();
// Chat → what the relay said it may switch to before this page closed the
// side a refusal named: given back when the Claude API tab changes.
const switchableBeforeRefusal = new Map();
// The Claude API tab's state as last seen, so that only a change reopens.
let claudeApiSettingsKey = '';

function settingsKey(settings) {
  return JSON.stringify([
    settings?.configured === true,
    settings?.enabled === true,
    String(settings?.model || ''),
    Array.isArray(settings?.availableModels) ? settings.availableModels : [],
    settings?.monthlyCapUsd ?? null,
  ]);
}
// The chat this page just moved to the key: the toggle says what the first
// turn there costs until another chat is opened.
let warnCacheConversationId = '';
let renderedConversationId = '';

function conversationProvider(conversationId) {
  const conversation = conversations[conversationId] || null;
  return String(conversation?.runtimeProviderType || conversation?.runtime_provider_type || '').trim().toLowerCase();
}

// A switch changes the chat's provider: the composer's model list, the lock
// note and the list pill follow it.
function followBilling(conversationId, billing) {
  const provider = String(billing?.provider || '').trim().toLowerCase();
  if (provider !== 'claude' && provider !== 'claude-api') return;
  const conversation = conversations[conversationId];
  if (!conversation || conversationProvider(conversationId) === provider) return;
  conversations[conversationId] = { ...conversation, runtimeProviderType: provider };
  if (provider !== 'claude-api' && warnCacheConversationId === conversationId) warnCacheConversationId = '';
  try { deps.onConversationProviderChanged?.(conversationId, provider); } catch {}
}

function optionButton(option, conversationId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'claude-billing-option';
  button.dataset.billing = option.value;
  button.textContent = option.label;
  button.setAttribute('aria-pressed', option.pressed ? 'true' : 'false');
  // Not `disabled`: a press on an unavailable side says why (a phone has no
  // tooltip to read).
  if (!option.pressed && !option.available) button.setAttribute('aria-disabled', 'true');
  const title = option.reason || (!option.pressed && option.value === 'claude-api' ? CLAUDE_BILLING_CACHE_WARNING : '');
  if (title) button.title = title;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (option.pressed) return;
    if (!option.available) {
      showTransientRelayNotice(option.reason, 7000);
      return;
    }
    void switchClaudeBilling(conversationId, option.value);
  });
  return button;
}

export function renderClaudeBillingToggle() {
  if (typeof document === 'undefined') return;
  const row = document.getElementById(ROW_ID);
  if (!row) return;
  const conversationId = String(currentConvId || '').trim();
  if (conversationId !== renderedConversationId) {
    renderedConversationId = conversationId;
    if (warnCacheConversationId && warnCacheConversationId !== conversationId) warnCacheConversationId = '';
  }
  const shared = (() => {
    try { return deps.isSharedReaderMode?.() === true; } catch { return false; }
  })();
  const model = conversationId && !shared
    ? claudeBillingToggleModel({
      providerType: conversationProvider(conversationId),
      billing: conversationBillingState(conversationId),
      claudeApi: claudeApiSettingsState(),
      inFlight: inFlightConversationIds.has(conversationId),
      warnCache: warnCacheConversationId === conversationId,
    })
    : { visible: false };
  if (!model.visible) {
    row.hidden = true;
    row.replaceChildren();
    delete row.dataset.billing;
    return;
  }
  const label = document.createElement('span');
  label.className = 'claude-billing-label';
  label.id = 'claude-billing-toggle-label';
  label.textContent = 'Billing';
  const group = document.createElement('div');
  group.className = 'claude-billing-options';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', 'claude-billing-toggle-label');
  group.append(...model.options.map((option) => optionButton(option, conversationId)));
  const status = document.createElement('span');
  status.className = 'claude-billing-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = model.status;
  if (model.statusKind) status.dataset.kind = model.statusKind;
  row.replaceChildren(label, group, status);
  row.dataset.billing = model.current;
  row.hidden = false;
}

// A 409 carries no billing: the side it refused is closed here with the
// relay's reason, so a second press does not ask again. The next
// conversation_billing for the chat (a switch, or the cap flipping) replaces
// it; a change on the Claude API tab (a key, the switch, the models, the cap)
// opens it again, since the relay sends no billing event for those.
function closeRefusedSide(conversationId, to, result) {
  const code = String(result?.code || '').trim().toUpperCase();
  if (!CLOSING_REFUSALS.has(code)) return;
  const known = conversationBillingState(conversationId);
  if (!known || String(known.switchable?.to || '') !== to) return;
  if (known.switchable?.refused !== true) switchableBeforeRefusal.set(conversationId, known.switchable);
  setConversationBilling(conversationId, {
    ...known,
    switchable: {
      to,
      allowed: false,
      code,
      reason: String(result?.error || '').trim() || null,
      refused: true,
    },
  });
}

function reopenRefusedSides() {
  for (const [conversationId, before] of Array.from(switchableBeforeRefusal.entries())) {
    switchableBeforeRefusal.delete(conversationId);
    const known = conversationBillingState(conversationId);
    if (known?.switchable?.refused !== true) continue;
    setConversationBilling(conversationId, { ...known, switchable: before });
  }
}

/** Moves a chat to `to` ('claude' | 'claude-api'); answers the relay's result. */
export async function switchClaudeBilling(conversationId, to) {
  const id = String(conversationId || '').trim();
  if (!id || inFlightConversationIds.has(id)) return null;
  inFlightConversationIds.add(id);
  renderClaudeBillingToggle();
  let result = null;
  try {
    result = await switchConversationBilling(id, { to, by: 'user' });
  } finally {
    inFlightConversationIds.delete(id);
  }
  if (!result?.ok) {
    showTransientRelayNotice(`Not switched: ${result?.error || 'the relay refused it.'}`, 7000);
    closeRefusedSide(id, to, result);
    renderClaudeBillingToggle();
    return result;
  }
  if (result.changed && result.provider === 'claude-api') warnCacheConversationId = id;
  if (result.billing) setConversationBilling(id, result.billing);
  else followBilling(id, { provider: result.provider });
  if (result.changed) showTransientRelayNotice(claudeBillingSwitchedText(result.provider), 6000);
  renderClaudeBillingToggle();
  return result;
}

export function initClaudeBillingToggle(options = {}) {
  deps = options && typeof options === 'object' ? options : {};
  onConversationBillingChange((conversationId, billing) => {
    // The relay's own word replaces this page's patch.
    if (billing?.switchable?.refused !== true) switchableBeforeRefusal.delete(conversationId);
    if (billing) followBilling(conversationId, billing);
    if (conversationId === String(currentConvId || '').trim()) renderClaudeBillingToggle();
  });
  claudeApiSettingsKey = settingsKey(claudeApiSettingsState());
  onClaudeApiSettingsChange((settings) => {
    const key = settingsKey(settings);
    if (key !== claudeApiSettingsKey) {
      claudeApiSettingsKey = key;
      reopenRefusedSides();
    }
    renderClaudeBillingToggle();
  });
  renderClaudeBillingToggle();
}

export function __resetClaudeBillingToggleForTests() {
  deps = {};
  inFlightConversationIds.clear();
  switchableBeforeRefusal.clear();
  claudeApiSettingsKey = '';
  warnCacheConversationId = '';
  renderedConversationId = '';
}
