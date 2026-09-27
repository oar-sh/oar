// Settings → Relays: this relay's identity for its peers (name, public
// address, the inbound switch), the list of paired remote relays, and the form
// that adds one (docs/plans/2026-09-27-remote-relays.md §8, decisions 3, 4, 12,
// 15 and 23). Rows are dynamic, so their listeners are attached during render
// (the Features tab does the same); the static controls use inline handlers
// that bootstrap.js exposes on window.

import { BASE, showTransientRelayNotice } from './store.js';
import {
  addRemoteRelay,
  checkRemoteRelay,
  loadRemoteRelaySettings,
  removeRemoteRelay,
  updateRemoteRelay,
  updateRemoteRelaySettings,
} from './api-client.js';
import {
  getRemoteRelaysSnapshot,
  refreshRemoteRelays,
  remoteRelayStatus,
  removeRemoteRelayFromSnapshot,
  subscribeRemoteRelays,
  upsertRemoteRelay,
} from './remote-relays-store.mjs';
import { REMOTE_RELAY_PERMISSIONS, normalizeRemoteRelayPermission } from './remote-relay-shared.mjs';

export const REMOTE_RELAY_PERMISSION_LABELS = Object.freeze({
  read: 'Read only',
  prompt: 'Read and prompt',
  full: 'Full',
});

const STATUS_LABELS = Object.freeze({
  online: 'Online',
  offline: 'Offline',
  unauthorized: 'Token not accepted',
  error: 'Error',
  unknown: 'Not checked yet',
});

// Fired by pwa-install.js when the relay name (the PWA app name) changes.
export const RELAY_NAME_CHANGED_EVENT = 'oar:relay-name-changed';

let relaySettings = { publicUrl: '', inboundEnabled: true, loaded: false };
let publicUrlSaveInFlight = false;
// What the user entered while it is being saved, or after the relay refused
// it: shown instead of the stored value so a refused address can be fixed.
let publicUrlPending = null;
let inboundSaveInFlight = false;
let addInFlight = false;
let listLoadFailed = false;
// Per-row action in flight ('check' | 'remove' | 'permission'), kept across
// re-renders a socket update can trigger in the middle of one.
const rowBusy = new Map();
let listRenderDeferred = false;
let listFocusBound = false;

function el(id) {
  return document.getElementById(id);
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** "just now", "5 min ago", "3 h ago", "2 d ago"; "never" without a time. */
export function formatRelativeTime(value, now = Date.now()) {
  if (!value) return 'never';
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.endsWith('.localhost');
}

/**
 * How this relay looks from the browser — origin plus the relay's base path —
 * or '' when the page was opened on loopback (another relay could not use a
 * localhost address; the user has to enter the public one).
 */
export function browserSelfUrl(location = window.location, basePath = BASE) {
  const origin = String(location?.origin || '').trim();
  if (!/^https?:\/\//i.test(origin)) return '';
  if (isLoopbackHost(location?.hostname)) return '';
  return `${origin}${String(basePath || '').replace(/\/+$/, '')}`;
}

/**
 * Maps the add call's answer onto the form's status line.
 * `state` is the line's data-state: added | paired | pair-failed | needs-token
 * | self | error. `added` says the relay is now in the list; `showToken` that
 * the token field has to come up.
 */
export function describeAddRemoteRelayResult(result, { pairBack = true, usedToken = false } = {}) {
  if (!result) {
    return { state: 'error', text: 'This relay is not reachable right now. Try again in a moment.', added: false, showToken: false };
  }
  if (result.needsToken) {
    return {
      state: 'needs-token',
      text: usedToken
        ? 'The other relay did not accept that token either. Check it and press Add again.'
        : 'The other relay did not accept this relay\'s token. Paste the other relay\'s token and press Add again.',
      added: false,
      showToken: true,
    };
  }
  if (result.ok) {
    const name = String(result.relay?.name || '').trim() || 'the relay';
    const warning = String(result.warning || '').trim();
    const suffix = warning ? ` ${warning}` : '';
    const verb = result.updated === true ? 'Updated' : 'Added';
    if (result.pairedBack === true) {
      return { state: 'paired', text: `${verb} ${name}. It added this relay too.${suffix}`, added: true, showToken: false };
    }
    if (pairBack) {
      const reason = String(result.pairBackError || '').trim() || 'the other relay did not confirm';
      return {
        state: 'pair-failed',
        text: `${verb} ${name}, but adding this relay there failed: ${reason}${suffix}`,
        added: true,
        showToken: false,
      };
    }
    return { state: 'added', text: `${verb} ${name}.${suffix}`, added: true, showToken: false };
  }
  if (String(result.code || '').toUpperCase() === 'SELF') {
    return { state: 'self', text: 'That address is this relay. Paste the address of another relay.', added: false, showToken: false };
  }
  return {
    state: 'error',
    text: String(result.error || '').trim() || 'Could not add the relay.',
    added: false,
    showToken: false,
  };
}

// ─── This relay ──────────────────────────────────────────────────────────────

function applyRelaySettingsPayload(payload) {
  if (!payload || typeof payload !== 'object') return relaySettings;
  relaySettings = {
    publicUrl: typeof payload.publicUrl === 'string' ? payload.publicUrl : (relaySettings.publicUrl || ''),
    inboundEnabled: typeof payload.inboundEnabled === 'boolean' ? payload.inboundEnabled : relaySettings.inboundEnabled,
    loaded: true,
  };
  return relaySettings;
}

function setStatusLine(id, state, text) {
  const line = el(id);
  if (!line) return;
  line.textContent = text || '';
  line.hidden = !text;
  if (state) line.dataset.state = state;
  else delete line.dataset.state;
}

function renderSelfSection() {
  const snapshot = getRemoteRelaysSnapshot();
  const nameEl = el('remote-relays-self-name');
  if (nameEl) {
    const name = String(snapshot?.self?.name || '').trim();
    nameEl.textContent = name || '—';
  }
  const input = el('remote-relays-public-url-input');
  if (input) {
    input.placeholder = browserSelfUrl() || 'https://…';
    // Never clobber what the user is typing.
    if (document.activeElement !== input) input.value = publicUrlPending ?? (relaySettings.publicUrl || '');
    input.disabled = publicUrlSaveInFlight;
  }
  const toggle = el('remote-relays-inbound-toggle');
  if (toggle) {
    toggle.checked = relaySettings.inboundEnabled !== false;
    toggle.disabled = inboundSaveInFlight || !relaySettings.loaded;
  }
}

export async function saveRemoteRelayPublicUrl(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (publicUrlSaveInFlight) return;
  if (relaySettings.loaded && publicUrlPending === null && value === (relaySettings.publicUrl || '')) return;
  publicUrlSaveInFlight = true;
  publicUrlPending = value;
  setStatusLine('remote-relays-self-status', 'saved', 'Saving…');
  renderSelfSection();
  let result = null;
  try {
    result = await updateRemoteRelaySettings({ publicUrl: value });
  } finally {
    publicUrlSaveInFlight = false;
  }
  if (result?.ok) {
    publicUrlPending = null;
    applyRelaySettingsPayload({ publicUrl: value, ...result });
    setStatusLine(
      'remote-relays-self-status',
      'active',
      relaySettings.publicUrl ? `Other relays reach this one at ${relaySettings.publicUrl}.` : 'Public address cleared.',
    );
  } else {
    // The typed value stays (publicUrlPending) so it can be fixed.
    setStatusLine('remote-relays-self-status', 'error', result?.error || 'Failed to save the public address.');
  }
  renderSelfSection();
}

export async function toggleRemoteRelayInbound(checked) {
  if (inboundSaveInFlight) return;
  const enabled = checked === true;
  inboundSaveInFlight = true;
  renderSelfSection();
  let result = null;
  try {
    result = await updateRemoteRelaySettings({ inboundEnabled: enabled });
  } finally {
    inboundSaveInFlight = false;
  }
  if (result?.ok) {
    applyRelaySettingsPayload({ inboundEnabled: enabled, ...result });
    showTransientRelayNotice(relaySettings.inboundEnabled
      ? 'Agents on other relays may send prompts here again.'
      : 'Prompts from other relays\' agents are refused now.');
  } else {
    alert(result?.error || 'Failed to update the setting.');
  }
  renderSelfSection();
}

// ─── Remote relay list ───────────────────────────────────────────────────────

function statusTooltip(relay, status) {
  if (status === 'online') return STATUS_LABELS.online;
  const error = String(relay?.lastError || '').trim();
  return error || STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

function relayDetailText(relay) {
  const parts = [];
  const host = String(relay?.host || '').trim();
  if (host) parts.push(host);
  const version = String(relay?.version || '').trim();
  if (version) parts.push(`OAR ${version}`);
  parts.push(relay?.lastSeenAt ? `seen ${formatRelativeTime(relay.lastSeenAt)}` : 'not reached yet');
  return parts.join(' · ');
}

function safeRelayUrl(relay) {
  const url = String(relay?.url || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function buildRelayRow(relay) {
  const status = remoteRelayStatus(relay);
  const busy = rowBusy.get(relay.id) || '';
  const name = String(relay.name || relay.host || relay.id);

  const row = document.createElement('div');
  row.className = 'preview-row remote-relay-row';
  row.dataset.relayId = relay.id;
  row.dataset.status = status;

  const dot = document.createElement('span');
  dot.className = 'remote-relay-dot';
  dot.dataset.status = status;
  dot.title = statusTooltip(relay, status);
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', STATUS_LABELS[status] || STATUS_LABELS.unknown);
  row.appendChild(dot);

  const main = document.createElement('span');
  main.className = 'preview-main';
  row.appendChild(main);

  // textContent throughout: names, hosts and errors come from other relays.
  const label = document.createElement('span');
  label.className = 'preview-label remote-relay-name';
  label.textContent = name;
  if (relay.addedBy === 'pairing') {
    const tag = document.createElement('span');
    tag.className = 'remote-relay-tag';
    tag.textContent = 'Paired automatically';
    tag.title = 'That relay added this one and asked to be added back.';
    label.appendChild(document.createTextNode(' '));
    label.appendChild(tag);
  }
  main.appendChild(label);

  const detail = document.createElement('span');
  detail.className = 'preview-detail remote-relay-detail';
  detail.textContent = relayDetailText(relay);
  main.appendChild(detail);

  const lastError = String(relay.lastError || '').trim();
  if (status !== 'online' && status !== 'unknown' && lastError) {
    const error = document.createElement('span');
    error.className = 'preview-detail remote-relay-error';
    error.textContent = lastError;
    main.appendChild(error);
  }

  const httpWarning = String(relay.httpWarning || '').trim();
  if (httpWarning) {
    const warning = document.createElement('span');
    warning.className = 'preview-warning remote-relay-http-warning';
    warning.textContent = `⚠ ${httpWarning}`;
    main.appendChild(warning);
  }

  const side = document.createElement('span');
  side.className = 'preview-side';
  row.appendChild(side);

  const permissionLabel = document.createElement('label');
  permissionLabel.className = 'remote-relay-permission';
  permissionLabel.appendChild(document.createTextNode('Agents may '));
  const select = document.createElement('select');
  select.className = 'remote-relay-permission-select';
  select.setAttribute('aria-label', `What agents may do on ${name}`);
  for (const permission of REMOTE_RELAY_PERMISSIONS) {
    const option = document.createElement('option');
    option.value = permission;
    option.textContent = REMOTE_RELAY_PERMISSION_LABELS[permission] || permission;
    select.appendChild(option);
  }
  select.value = normalizeRemoteRelayPermission(relay.permission);
  select.disabled = !!busy;
  select.addEventListener('change', () => {
    void changeRemoteRelayPermission(relay, select.value, select);
  });
  permissionLabel.appendChild(select);
  side.appendChild(permissionLabel);

  const actions = document.createElement('span');
  actions.className = 'preview-actions';
  side.appendChild(actions);

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'preview-copy remote-relay-check';
  check.textContent = busy === 'check' ? 'Checking…' : 'Check';
  check.disabled = !!busy;
  check.addEventListener('click', () => {
    void checkRemoteRelayRow(relay);
  });
  actions.appendChild(check);

  const url = safeRelayUrl(relay);
  if (url) {
    const open = document.createElement('a');
    open.className = 'preview-open remote-relay-open';
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';
    open.title = `Open ${name} in a new tab`;
    actions.appendChild(open);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'preview-close remote-relay-remove';
  remove.textContent = busy === 'remove' ? 'Removing…' : 'Remove';
  remove.disabled = !!busy;
  remove.addEventListener('click', () => {
    void removeRemoteRelayRow(relay);
  });
  actions.appendChild(remove);

  return row;
}

function bindListFocusTracking(list) {
  if (listFocusBound) return;
  listFocusBound = true;
  // A re-render while a permission dropdown is open would close it under the
  // user's finger; hold the render until focus leaves the select.
  list.addEventListener('focusout', () => {
    if (!listRenderDeferred) return;
    setTimeout(() => renderRelayList(), 0);
  });
}

function renderRelayList() {
  const list = el('remote-relays-list');
  if (!list) return;
  bindListFocusTracking(list);
  const active = document.activeElement;
  if (active && active.tagName === 'SELECT' && list.contains(active)) {
    listRenderDeferred = true;
    return;
  }
  listRenderDeferred = false;
  const snapshot = getRemoteRelaysSnapshot();
  const relays = snapshot?.relays || [];
  list.textContent = '';
  for (const relay of relays) list.appendChild(buildRelayRow(relay));
  const empty = el('remote-relays-empty');
  if (empty) {
    empty.hidden = relays.length > 0;
    empty.textContent = snapshot
      ? 'No remote relays yet. Add one below.'
      : (listLoadFailed ? 'Could not load the remote relays.' : 'Loading remote relays…');
  }
}

export function renderRemoteRelaysSection() {
  renderSelfSection();
  renderRelayList();
}

async function changeRemoteRelayPermission(relay, value, select) {
  const previous = normalizeRemoteRelayPermission(relay.permission);
  const next = normalizeRemoteRelayPermission(value);
  if (next === previous || rowBusy.has(relay.id)) return;
  rowBusy.set(relay.id, 'permission');
  if (select) select.disabled = true;
  let result = null;
  try {
    result = await updateRemoteRelay(relay.id, { permission: next });
  } finally {
    rowBusy.delete(relay.id);
  }
  if (select) select.disabled = false;
  if (result?.ok) {
    const updated = result.relay && typeof result.relay === 'object' ? result.relay : { ...relay, permission: next };
    // Blur first so the deferred-render guard does not hold the new state back.
    select?.blur?.();
    upsertRemoteRelay(updated);
    showTransientRelayNotice(`Agents may now use "${REMOTE_RELAY_PERMISSION_LABELS[next]}" on ${relay.name || relay.host}.`);
  } else {
    if (select) select.value = previous;
    alert(result?.error || 'Failed to change what agents may do there.');
  }
  renderRelayList();
}

async function checkRemoteRelayRow(relay) {
  if (rowBusy.has(relay.id)) return;
  rowBusy.set(relay.id, 'check');
  renderRelayList();
  let result = null;
  try {
    result = await checkRemoteRelay(relay.id);
  } finally {
    rowBusy.delete(relay.id);
  }
  if (result?.relay && typeof result.relay === 'object') {
    upsertRemoteRelay(result.relay);
  } else if (!result?.ok) {
    alert(result?.error || 'The check could not run.');
  }
  renderRelayList();
}

async function removeRemoteRelayRow(relay) {
  if (rowBusy.has(relay.id)) return;
  const name = relay.name || relay.host || 'this relay';
  const confirmed = confirm(
    `Remove ${name}? Agents here can no longer work on it. ${name} keeps its own entry for this relay; remove it there too to unpair both ways.`,
  );
  if (!confirmed) return;
  rowBusy.set(relay.id, 'remove');
  renderRelayList();
  let result = null;
  try {
    result = await removeRemoteRelay(relay.id);
  } finally {
    rowBusy.delete(relay.id);
  }
  if (result?.ok) {
    removeRemoteRelayFromSnapshot(relay.id);
    showTransientRelayNotice(`Removed ${name}.`);
  } else {
    alert(result?.error || 'Failed to remove the relay.');
  }
  renderRelayList();
}

// ─── Add form ────────────────────────────────────────────────────────────────

function setTokenFieldVisible(visible) {
  const row = el('remote-relays-add-token-row');
  if (row) row.hidden = !visible;
  const link = el('remote-relays-use-token-btn');
  if (link) link.hidden = !!visible;
  const input = el('remote-relays-add-token-input');
  if (!visible && input) input.value = '';
}

function setAddControlsDisabled(disabled) {
  for (const id of [
    'remote-relays-add-url-input',
    'remote-relays-add-token-input',
    'remote-relays-pair-back-toggle',
    'remote-relays-add-btn',
    'remote-relays-use-token-btn',
  ]) {
    const control = el(id);
    if (control) control.disabled = disabled;
  }
}

/** "Use a different token": brings the token field up without a failed add first. */
export function showRemoteRelayTokenField() {
  setTokenFieldVisible(true);
  el('remote-relays-add-token-input')?.focus?.();
}

export async function addRemoteRelayFromForm() {
  if (addInFlight) return null;
  const urlInput = el('remote-relays-add-url-input');
  const tokenInput = el('remote-relays-add-token-input');
  const pairBackToggle = el('remote-relays-pair-back-toggle');
  const url = String(urlInput?.value || '').trim();
  if (!url) {
    setStatusLine('remote-relays-add-status', 'error', 'Paste the other relay\'s web address first.');
    urlInput?.focus?.();
    return null;
  }
  const tokenVisible = el('remote-relays-add-token-row')?.hidden === false;
  const token = tokenVisible ? String(tokenInput?.value || '').trim() : '';
  const pairBack = pairBackToggle ? pairBackToggle.checked !== false : true;

  addInFlight = true;
  setAddControlsDisabled(true);
  setStatusLine('remote-relays-add-status', 'working', 'Adding…');
  let result = null;
  try {
    result = await addRemoteRelay({ url, token, pairBack, selfUrl: browserSelfUrl() });
  } finally {
    addInFlight = false;
    setAddControlsDisabled(false);
    // The token is sent once and never kept in the page.
    if (tokenInput) tokenInput.value = '';
  }

  const outcome = describeAddRemoteRelayResult(result, { pairBack, usedToken: !!token });
  setStatusLine('remote-relays-add-status', outcome.state, outcome.text);
  if (outcome.showToken) {
    setTokenFieldVisible(true);
    tokenInput?.focus?.();
  }
  if (outcome.added) {
    if (urlInput) urlInput.value = '';
    setTokenFieldVisible(false);
    if (result?.relay && typeof result.relay === 'object' && getRemoteRelaysSnapshot()) upsertRemoteRelay(result.relay);
    void refreshRemoteRelays();
  }
  return outcome;
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

/** Called when the settings modal opens (and by the tab deep link). */
export async function refreshRemoteRelaysSection() {
  // Reopening the modal shows what the relay has, not an old refused entry.
  if (!publicUrlSaveInFlight) publicUrlPending = null;
  setStatusLine('remote-relays-self-status', '', '');
  renderRemoteRelaysSection();
  const [snapshot, settings] = await Promise.all([
    refreshRemoteRelays(),
    loadRemoteRelaySettings(),
  ]);
  listLoadFailed = !snapshot;
  if (settings) applyRelaySettingsPayload(settings);
  setStatusLine(
    'remote-relays-status',
    snapshot ? '' : 'error',
    snapshot ? '' : 'Could not load the remote relays from this relay.',
  );
  renderRemoteRelaysSection();
  return snapshot;
}

/** Test hook. */
export function resetRemoteRelaysSettingsForTests() {
  relaySettings = { publicUrl: '', inboundEnabled: true, loaded: false };
  publicUrlSaveInFlight = false;
  publicUrlPending = null;
  inboundSaveInFlight = false;
  addInFlight = false;
  listLoadFailed = false;
  listRenderDeferred = false;
  rowBusy.clear();
}

// The relay's own settings ride along in the list payload's `self` (GET and
// remote_relays_updated alike), so a change made on another device shows here
// too — except while this page is saving the same field.
function applySelfSettingsFromSnapshot(snapshot) {
  const self = snapshot?.self;
  if (!self || typeof self !== 'object') return;
  const next = {};
  if (typeof self.publicUrl === 'string' && !publicUrlSaveInFlight) next.publicUrl = self.publicUrl;
  if (typeof self.inboundEnabled === 'boolean' && !inboundSaveInFlight) next.inboundEnabled = self.inboundEnabled;
  if (Object.keys(next).length) applyRelaySettingsPayload(next);
}

// Live: a remote_relays_updated event (or any other store change) repaints.
subscribeRemoteRelays((snapshot) => {
  applySelfSettingsFromSnapshot(snapshot);
  renderRemoteRelaysSection();
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(RELAY_NAME_CHANGED_EVENT, () => {
    void refreshRemoteRelays();
  });
}
