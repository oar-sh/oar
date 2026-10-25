// Settings → Providers → DeepSeek: the key (written, never read back), the
// switch, the default model, the commit attribution, the monthly budget for
// the usage card with its currency, the starting balance its balance bar
// measures from and, under Advanced, the base URL. The
// relay discovers the models when a key is saved. Below them, the import of
// DeepSeek's usage export (two CSV files) for the usage card.

import { importDeepSeekUsageExport as postDeepSeekUsageExport, loadDeepSeekSettings, updateDeepSeekSettings } from './api-client.js';
import { showTransientRelayNotice } from './store.js';

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

let updateInFlight = false;
let inputsDirty = false;
// The starting balance field was typed in since the tab was filled.
let startingBalanceEdited = false;
let state = {
  configured: false,
  enabled: false,
  model: DEFAULT_MODEL,
  availableModels: [DEFAULT_MODEL, 'deepseek-v4-pro'],
  baseUrl: DEFAULT_BASE_URL,
  attribution: 'oar',
  monthlyBudget: null,
  // 'USD' or 'CNY'; null for a budget saved before the currency was stored
  // (the card reads it in the balance's currency), or no budget.
  monthlyBudgetCurrency: null,
  startingBalance: null,
  // What the relay says of the starting balance (for example that a later
  // top-up has replaced it), or null.
  startingBalanceNote: null,
};

const BUDGET_CURRENCIES = ['USD', 'CNY'];

const CONTROL_IDS = [
  'deepseek-api-key-input',
  'deepseek-model-select',
  'deepseek-attribution-select',
  'deepseek-monthly-budget-input',
  'deepseek-monthly-budget-currency-select',
  'deepseek-starting-balance-input',
  'deepseek-base-url-input',
  'deepseek-enabled-toggle',
  'deepseek-save-btn',
  'deepseek-remove-btn',
];

function element(id) {
  return document.getElementById(id);
}

function ensureInputTracking() {
  for (const id of ['deepseek-api-key-input', 'deepseek-model-select', 'deepseek-attribution-select', 'deepseek-monthly-budget-input', 'deepseek-monthly-budget-currency-select', 'deepseek-starting-balance-input', 'deepseek-base-url-input']) {
    const input = element(id);
    if (!input || input.dataset.deepseekDirtyTracking === '1') continue;
    input.dataset.deepseekDirtyTracking = '1';
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
      inputsDirty = true;
      if (id === 'deepseek-starting-balance-input') startingBalanceEdited = true;
    });
  }
}

function setControlsDisabled(disabled) {
  for (const id of CONTROL_IDS) {
    const control = element(id);
    if (control) control.disabled = disabled;
  }
}

function fillModelSelect(select) {
  const models = Array.from(new Set([state.model, ...state.availableModels].filter(Boolean)));
  select.innerHTML = '';
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }
  select.value = state.model;
}

export function applyDeepSeekSettingsState(settings = {}, { resetInputs = false } = {}) {
  ensureInputTracking();
  const available = Array.isArray(settings?.availableModels)
    ? settings.availableModels.map((value) => String(value || '').trim()).filter(Boolean)
    : state.availableModels;
  state = {
    configured: settings?.configured === true,
    enabled: settings?.configured === true && settings?.enabled === true,
    model: String(settings?.model || state.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    availableModels: available.length ? available : state.availableModels,
    baseUrl: String(settings?.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    attribution: settings?.attribution === 'off' ? 'off' : 'oar',
    monthlyBudget: Number.isFinite(Number(settings?.monthlyBudget)) && Number(settings.monthlyBudget) > 0 ? Number(settings.monthlyBudget) : null,
    monthlyBudgetCurrency: BUDGET_CURRENCIES.includes(String(settings?.monthlyBudgetCurrency || '').toUpperCase())
      ? String(settings.monthlyBudgetCurrency).toUpperCase()
      : null,
    startingBalance: Number.isFinite(Number(settings?.startingBalance)) && Number(settings.startingBalance) > 0 ? Number(settings.startingBalance) : null,
    startingBalanceNote: String(settings?.startingBalanceNote || '').trim() || null,
  };
  const keepInputs = inputsDirty && !resetInputs;
  const keyInput = element('deepseek-api-key-input');
  if (keyInput && !keepInputs) {
    keyInput.value = '';
    keyInput.placeholder = state.configured ? 'Saved API key (enter to replace)' : 'DeepSeek API key…';
  }
  const modelSelect = element('deepseek-model-select');
  if (modelSelect && !keepInputs) fillModelSelect(modelSelect);
  const attributionSelect = element('deepseek-attribution-select');
  if (attributionSelect && !keepInputs) attributionSelect.value = state.attribution;
  const budgetInput = element('deepseek-monthly-budget-input');
  if (budgetInput && !keepInputs) budgetInput.value = state.monthlyBudget === null ? '' : String(state.monthlyBudget);
  const budgetCurrencySelect = element('deepseek-monthly-budget-currency-select');
  // A new budget is in dollars unless chosen otherwise; a budget saved
  // without a currency stays in the balance's until one is chosen.
  if (budgetCurrencySelect && !keepInputs) budgetCurrencySelect.value = state.monthlyBudgetCurrency || (state.monthlyBudget === null ? 'USD' : '');
  const startingInput = element('deepseek-starting-balance-input');
  if (startingInput && !keepInputs) startingInput.value = state.startingBalance === null ? '' : String(state.startingBalance);
  const startingStatus = element('deepseek-starting-balance-status');
  if (startingStatus) {
    startingStatus.textContent = state.startingBalanceNote || '';
    startingStatus.hidden = !state.startingBalanceNote;
  }
  const baseUrlInput = element('deepseek-base-url-input');
  if (baseUrlInput && !keepInputs) baseUrlInput.value = state.baseUrl === DEFAULT_BASE_URL ? '' : state.baseUrl;
  if (resetInputs) {
    inputsDirty = false;
    startingBalanceEdited = false;
  }
  const toggle = element('deepseek-enabled-toggle');
  if (toggle) {
    toggle.checked = state.enabled;
    toggle.disabled = updateInFlight || !state.configured;
  }
  const removeButton = element('deepseek-remove-btn');
  if (removeButton) removeButton.disabled = updateInFlight || !state.configured;
  const status = element('deepseek-settings-status');
  if (status) {
    status.textContent = state.enabled
      ? 'DeepSeek is enabled. Select DeepSeek in New Chat to use it.'
      : (state.configured
          ? 'API key saved but currently disabled. Enable it to allow DeepSeek selection in New Chat.'
          : 'Not configured. New conversations use GitHub Copilot.');
    status.dataset.state = state.enabled ? 'active' : (state.configured ? 'saved' : 'unconfigured');
  }
  window.syncAutoModelAvailability?.();
  return state;
}

export async function refreshDeepSeekSettingsState() {
  const settings = await loadDeepSeekSettings();
  if (!settings) return null;
  return applyDeepSeekSettingsState(settings);
}

/** Called when the Settings modal opens. */
export async function syncDeepSeekSettingsInputs() {
  inputsDirty = false;
  startingBalanceEdited = false;
  ensureInputTracking();
  const status = element('deepseek-settings-status');
  const settings = await refreshDeepSeekSettingsState();
  if (!settings && status) {
    status.textContent = 'Unable to load DeepSeek settings.';
    status.dataset.state = 'error';
  }
}

async function runUpdate(payload, { successText, failureText, resetInputs = false }) {
  if (updateInFlight) return null;
  updateInFlight = true;
  setControlsDisabled(true);
  try {
    const result = await updateDeepSeekSettings(payload);
    if (!result) throw new Error(failureText);
    applyDeepSeekSettingsState(result, { resetInputs });
    const text = typeof successText === 'function' ? successText(result) : successText;
    showTransientRelayNotice(result.warning ? `${text} ${result.warning}` : text, result.warning ? 8000 : 4000);
    return result;
  } catch (error) {
    // A refused key removal (409) names the conversations in its message.
    alert(error?.message || failureText);
    return null;
  } finally {
    updateInFlight = false;
    setControlsDisabled(false);
    applyDeepSeekSettingsState(state);
  }
}

export async function saveDeepSeekSettings() {
  const apiKey = String(element('deepseek-api-key-input')?.value || '').trim();
  if (!apiKey && !state.configured) {
    alert('Enter a DeepSeek API key.');
    return;
  }
  const baseUrlText = String(element('deepseek-base-url-input')?.value || '').trim();
  const budgetText = String(element('deepseek-monthly-budget-input')?.value || '').trim();
  const monthlyBudget = budgetText ? Number(budgetText) : null;
  if (budgetText && !(Number.isFinite(monthlyBudget) && monthlyBudget >= 0)) {
    alert('The monthly budget must be an amount of zero or more, or empty for no budget bar.');
    return;
  }
  const startingText = String(element('deepseek-starting-balance-input')?.value || '').trim();
  const startingBalance = startingText ? Number(startingText) : null;
  if (startingText && !(Number.isFinite(startingBalance) && startingBalance >= 0)) {
    alert('The starting balance must be an amount of zero or more, or empty to measure from the balance after the last top-up.');
    return;
  }
  await runUpdate({
    apiKey,
    model: String(element('deepseek-model-select')?.value || state.model || DEFAULT_MODEL),
    attribution: String(element('deepseek-attribution-select')?.value || state.attribution),
    // Empty is DeepSeek's own endpoint.
    baseUrl: baseUrlText || null,
    // Empty (or zero) is no budget bar on the usage card. The currency goes
    // with the amount; empty is the balance's currency.
    monthlyBudget,
    monthlyBudgetCurrency: String(element('deepseek-monthly-budget-currency-select')?.value || '').trim() || null,
    // Empty (or zero): the balance bar measures from the balance after the
    // last top-up the relay has seen (before one, the highest balance read).
    startingBalance,
    // Typed in since the tab was filled: only then does the relay set a
    // starting balance a top-up has replaced anew (the same amount too). The
    // relay decides "replaced" itself, so a tab opened before a top-up was
    // seen does not bring the old amount back when another field is saved.
    startingBalanceEdited,
    enabled: state.configured ? state.enabled : true,
  }, {
    successText: (result) => `DeepSeek settings saved for ${result.model}.`,
    failureText: 'Failed to save DeepSeek settings.',
    resetInputs: true,
  });
}

export async function toggleDeepSeekProvider(enabled) {
  if (enabled && !state.configured) {
    applyDeepSeekSettingsState(state);
    alert('Save a DeepSeek API key before enabling DeepSeek.');
    return;
  }
  await runUpdate({ enabled: enabled === true }, {
    successText: (result) => (result.enabled ? 'DeepSeek enabled.' : 'DeepSeek disabled.'),
    failureText: 'Failed to update the DeepSeek provider.',
  });
}

export async function removeDeepSeekSettings() {
  if (!state.configured) return;
  if (!confirm('Remove the saved DeepSeek API key?')) return;
  await runUpdate({ remove: true }, {
    successText: 'DeepSeek API key removed. New conversations use GitHub Copilot.',
    failureText: 'Failed to remove DeepSeek settings.',
    resetInputs: true,
  });
}

// The export's times keep its offset: "2026-10-26T00:00:00+01:00" reads
// "2026-10-26 00:00 (UTC+01:00)".
function exportTimeLabel(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(value || ''));
  if (!match) return String(value || '');
  const zone = !match[3] || match[3] === 'Z' ? 'UTC' : `UTC${match[3]}`;
  return `${match[1]} ${match[2]} (${zone})`;
}

function listText(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The import's answer, in the panel. */
export function deepseekUsageImportSummaryText(summary = {}) {
  const days = Array.isArray(summary.days) ? summary.days : [];
  const models = Array.isArray(summary.models) ? summary.models : [];
  const keys = Array.isArray(summary.keys) ? summary.keys : [];
  const rows = Number(summary.rows) || 0;
  const parts = [];
  if (!rows) {
    parts.push('Nothing to import: the export has no period that has ended.');
  } else {
    const span = days.length > 1 ? `${days[0]} to ${days.at(-1)}` : (days[0] || '');
    parts.push(`Imported ${rows} row${rows === 1 ? '' : 's'}${span ? ` for ${span}` : ''}${models.length ? `: ${listText(models)}` : ''}.`);
  }
  const skipped = Array.isArray(summary.skippedPeriods) ? summary.skippedPeriods.length : 0;
  if (skipped) parts.push(`${skipped} period${skipped === 1 ? '' : 's'} not ended yet left out.`);
  const currencies = Array.isArray(summary.currencies) ? summary.currencies : [];
  const cardCurrency = summary.cardCurrency || '';
  const exportCurrency = currencies.length ? listText(currencies) : '';
  if (rows && summary.savedKeyMatched && summary.currencyMatched === false) {
    parts.push(`The export is in ${exportCurrency || 'another currency'}, the usage card in ${cardCurrency} (the balance's): the card does not use these figures and stays estimated.`);
  } else if (rows && summary.savedKeyMatched) {
    const inCurrency = exportCurrency ? ` (${exportCurrency})` : '';
    const cardNote = !cardCurrency && exportCurrency ? ` It uses them while the balance is in ${exportCurrency}.` : '';
    parts.push(`The usage card shows the saved key's figures${inCurrency} on the export's days through ${exportTimeLabel(summary.through)}, estimated on the others.${cardNote}`);
  } else if (rows && summary.savedKeyFp) {
    parts.push(`The saved key (${summary.savedKeyFp}) is not in this export${keys.length ? `, only ${listText(keys.map((key) => key.keyFp))}` : ''}; the usage card stays estimated.`);
  } else if (rows) {
    parts.push('No DeepSeek key is saved: save the key this export belongs to and the usage card shows its figures.');
  }
  return parts.join(' ');
}

let importInFlight = false;

function setImportStatus(text, stateName) {
  const status = element('deepseek-usage-import-status');
  if (!status) return;
  status.textContent = text;
  status.dataset.state = stateName;
}

export async function importDeepSeekUsageExport() {
  if (importInFlight) return null;
  const amountFile = element('deepseek-usage-amount-input')?.files?.[0] || null;
  const costFile = element('deepseek-usage-cost-input')?.files?.[0] || null;
  if (!amountFile || !costFile) {
    setImportStatus('Choose both files of the export: the amount file and the cost file.', 'error');
    return null;
  }
  const button = element('deepseek-usage-import-btn');
  importInFlight = true;
  if (button) button.disabled = true;
  setImportStatus('Importing…', 'saved');
  try {
    const [amount, cost] = await Promise.all([amountFile.text(), costFile.text()]);
    const result = await postDeepSeekUsageExport({ amount, cost });
    if (!result?.ok) throw new Error('The relay could not be reached.');
    const used = result.summary?.savedKeyMatched && result.summary?.currencyMatched !== false;
    setImportStatus(deepseekUsageImportSummaryText(result.summary), used ? 'active' : 'saved');
    return result;
  } catch (error) {
    setImportStatus(String(error?.message || 'The import failed.'), 'error');
    return null;
  } finally {
    importInFlight = false;
    if (button) button.disabled = false;
  }
}
