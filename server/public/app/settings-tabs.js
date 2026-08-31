const SETTINGS_TAB_STORAGE_KEY = 'copilot_settings_tab';
const SETTINGS_PROVIDER_TAB_STORAGE_KEY = 'copilot_settings_provider_tab';

const SETTINGS_TABS = ['general', 'providers', 'previews', 'notifications'];
// Copilot leads: it is the default provider, and `SETTINGS_PROVIDER_TABS[0]`
// is also the sub-tab a first-time visitor lands on.
const SETTINGS_PROVIDER_TABS = ['copilot', 'openai', 'claude', 'grok', 'cursor'];

let settingsTabsBound = false;

function readLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function normalizeTab(raw, allowed) {
  const value = String(raw || '').trim().toLowerCase();
  return allowed.includes(value) ? value : '';
}

function storedSettingsTab() {
  return normalizeTab(readLocalStorage(SETTINGS_TAB_STORAGE_KEY), SETTINGS_TABS) || SETTINGS_TABS[0];
}

function storedProviderTab() {
  return normalizeTab(readLocalStorage(SETTINGS_PROVIDER_TAB_STORAGE_KEY), SETTINGS_PROVIDER_TABS)
    || SETTINGS_PROVIDER_TABS[0];
}

function settingsElements(attribute) {
  return Array.from(document.querySelectorAll(`#settings-modal [${attribute}]`));
}

// One strip + its panels: mark the selected button/panel and hide the rest.
function applyTabState(buttonAttribute, panelAttribute, active) {
  const buttons = settingsElements(buttonAttribute);
  if (!buttons.length) return false;
  for (const button of buttons) {
    const selected = button.getAttribute(buttonAttribute) === active;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of settingsElements(panelAttribute)) {
    const selected = panel.getAttribute(panelAttribute) === active;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  }
  return true;
}

function focusTabByOffset(strip, current, offset) {
  const buttons = Array.from(strip.querySelectorAll('[data-settings-tab], [data-settings-provider-tab]'))
    .filter((button) => !button.disabled);
  if (!buttons.length) return;
  const index = buttons.indexOf(current);
  const next = offset === 'home'
    ? buttons[0]
    : offset === 'end'
      ? buttons[buttons.length - 1]
      : buttons[(index + offset + buttons.length) % buttons.length];
  if (!next) return;
  next.focus();
  next.click();
}

function handleTabKeydown(event) {
  const button = event.target?.closest?.('[data-settings-tab], [data-settings-provider-tab]');
  if (!button) return;
  const strip = button.closest('.settings-tab-strip');
  if (!strip) return;
  const offset = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
    Home: 'home',
    End: 'end',
  }[event.key];
  if (offset === undefined) return;
  event.preventDefault();
  focusTabByOffset(strip, button, offset);
}

function handleTabClick(event) {
  const topTab = event.target?.closest?.('[data-settings-tab]');
  if (topTab) {
    selectSettingsTab(topTab.dataset.settingsTab);
    return;
  }
  const providerTab = event.target?.closest?.('[data-settings-provider-tab]');
  if (providerTab) selectSettingsTab(null, providerTab.dataset.settingsProviderTab);
}

export function ensureSettingsTabsBound() {
  if (settingsTabsBound) return;
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  settingsTabsBound = true;
  modal.addEventListener('click', handleTabClick);
  modal.addEventListener('keydown', handleTabKeydown);
}

// `tab` / `providerTab` are optional: anything omitted (or unknown) falls back
// to the last selection persisted in localStorage.
export function selectSettingsTab(tab, providerTab) {
  ensureSettingsTabsBound();
  const nextTab = normalizeTab(tab, SETTINGS_TABS) || storedSettingsTab();
  const nextProviderTab = normalizeTab(providerTab, SETTINGS_PROVIDER_TABS) || storedProviderTab();
  if (applyTabState('data-settings-tab', 'data-settings-panel', nextTab)) {
    writeLocalStorage(SETTINGS_TAB_STORAGE_KEY, nextTab);
  }
  if (applyTabState('data-settings-provider-tab', 'data-settings-provider-panel', nextProviderTab)) {
    writeLocalStorage(SETTINGS_PROVIDER_TAB_STORAGE_KEY, nextProviderTab);
  }
  return { tab: nextTab, providerTab: nextProviderTab };
}
