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
  confirmRemoteRelayIdentity,
  loadRemoteRelaySettings,
  removeRemoteRelay,
  renewRemoteRelayKey,
  repairRemoteRelay,
  revokeRemoteRelayKey,
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
import { currentPwaAppName, isPwaAppNameSaveInFlight, syncPwaAppNameInput } from './pwa-install.js';
import { SETTINGS_TAB_SHOWN_EVENT } from './settings-tabs.js';
import { relayPageUrl, relaySettingsUrl, sameHostOtherPort } from './remote-relay-links.mjs';

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
// Per-row action in flight ('check' | 'remove' | 'permission' | 'repair' |
// 'renew'), kept across re-renders a socket update can trigger in the middle
// of one.
const rowBusy = new Map();
// The last Re-pair outcome per row: `{ state, text }`.
const rowNotes = new Map();
let listRenderDeferred = false;
let listFocusBound = false;
// The relay's name as the last snapshot had it: a change made elsewhere is
// read into the Relay name field.
let lastSelfName = null;

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
      const keyed = result.keys?.ours?.ok === true && result.keys?.theirs?.ok === true;
      const keys = keyed ? ' Both relays sign in to each other with keys of their own.' : '';
      return { state: 'paired', text: `${verb} ${name}. It added this relay too.${keys}${suffix}`, added: true, showToken: false };
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
    // One way on purpose: that relay gave this one an inbound-only key and
    // this relay kept nothing else.
    if (result.oneWay === 'inbound-only') {
      return {
        state: 'added',
        text: `${verb} ${name} one way. ${name} gave this relay a key of its own and lists it as inbound only: this relay's prompts arrive there verified, ${name} never calls this relay, and its token was not kept. To make the pairing two-way, add it again with "Also add this relay there".${suffix}`,
        added: true,
        showToken: false,
      };
    }
    // One way with a relay older than 0.9.27: no key, so the token stays.
    if (result.oneWay === 'older') {
      return {
        state: 'added',
        text: `${verb} ${name} one way. It runs an OAR older than 0.9.27, which gives no keys: this relay keeps ${name}'s token (which opens everything there) and its prompts arrive there as claimed. Update ${name} to 0.9.27 or later, then add it again.${suffix}`,
        added: true,
        showToken: false,
      };
    }
    if (result.keys?.theirs?.unlisted === true) {
      return {
        state: 'added',
        text: `${verb} ${name} one way. Its OAR gives no inbound-only keys (older than 0.9.27) and it does not list this relay, so neither relay gets a key: this relay keeps ${name}'s token (which opens everything there), its prompts arrive there as claimed, and ${name}'s Inbox, asks and session watches are not available here. Re-pair on its row (or Add again with "Also add this relay there") switches both to keys.${suffix}`,
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

/**
 * The peer-key line of a relay's row (origin binding): `{ state, label,
 * text }`. `state` is keyed | legacy | older | held | relink | revoked |
 * waiting.
 * - keyed: it signs in here with its own key; its prompts are verified;
 * - legacy: it still calls here with this relay's token, and its prompts
 *   arrive as claimed (unverified) until it has a key: Re-pair;
 * - older: it runs an OAR from before keys (protocol 1 or 0): claimed, and
 *   Re-pair asks for its pairing link until it is updated;
 * - held: another identity answers at its address: confirm first;
 * - one-way: this relay added it one way. Normally it gave this relay an
 *   inbound-only key: calls go on that key and arrive there verified, and
 *   only an add from its link with "Also add this relay there" makes it two
 *   way (Re-pair opens that). On an OAR older than 0.9.27 it lists no entry
 *   for this one and gives no key: calls go on its token and arrive there as
 *   claimed; Re-pair adds this relay there and brings keys. Not a fault;
 * - relink: it refuses this relay for want of a key it takes (its key was
 *   revoked there, it no longer lists this relay, or it wants a key this
 *   relay does not hold): re-add it from its link;
 * - revoked: its key was revoked here; Renew issues a new one;
 * - waiting: a key is on its way (one health check, about a minute).
 */
export function describeRelayPeerKey(relay, now = Date.now()) {
  const name = String(relay?.name || relay?.host || 'that relay');
  const key = relay?.peerKey && typeof relay.peerKey === 'object' ? relay.peerKey : null;
  const status = String(key?.status || (Number(relay?.protocol) >= 2 ? 'waiting' : 'older'));
  const theirs = key?.theirKey ? 'this relay holds its key' : 'this relay holds no key from it yet';
  if (status === 'held') {
    return { state: 'held', label: 'Identity changed', text: `Another relay identity answers at the address of ${name}. Its keys were revoked; confirm it is the relay you meant, then Re-pair.` };
  }
  if (key?.listedInboundOnly && key?.theirKey) {
    return {
      state: 'one-way',
      label: 'One way',
      text: `${name} lists this relay as inbound only. This relay signs in there with a key ${name} gave it, so its prompts arrive there verified, and it holds no token of ${name}'s; ${name} never calls this relay. To make the pairing two-way, add ${name} again from its pairing link with "Also add this relay there" on (Re-pair opens that).`,
    };
  }
  if (key?.theirKeyState === 'unlisted') {
    return {
      state: 'one-way',
      label: 'One way',
      text: `Added one way to an OAR older than 0.9.27: ${name} does not list this relay, so it gives it no key. This relay calls it with its token (which opens everything there), and ${name} takes this relay's prompts as claimed; its Inbox, asks and session watches need a key. Re-pair adds this relay there and switches both to keys.`,
    };
  }
  // Refused there for want of a key it takes: this relay can fix that only
  // by adding it again from its link.
  const why = {
    revoked: `${name} refuses the key it gave this relay (revoked there, or it no longer lists this relay)`,
    gone: `${name} no longer lists this relay, so it refuses this relay's key`,
    required: `${name} takes calls from this relay only with the key it gave it, and this relay holds none it takes`,
  }[key?.theirKeyState];
  if (why) {
    return { state: 'relink', label: 'Re-add from link', text: `${why}. Re-add this relay from its link: Add a relay, paste ${name}'s pairing link (the entry is updated in place).` };
  }
  if (status === 'revoked') {
    return { state: 'revoked', label: 'Key revoked', text: `You revoked ${name}'s key. Its prompts arrive as claimed until you Renew the key or Re-pair.` };
  }
  if (status === 'older') {
    return { state: 'older', label: 'Old version', text: `${name} runs an OAR from before keys: its prompts arrive as claimed (unverified) and open nothing here. Update it to 0.9.27 or later, then Re-pair.` };
  }
  if (status === 'active') {
    const used = key?.lastUsedAt ? `, last used ${formatRelativeTime(key.lastUsedAt, now)}` : '';
    return { state: 'keyed', label: 'Keyed', text: `${name} signs in here with its own key${used}; ${theirs}.` };
  }
  if (relay?.tokenMode === 'custom' || key?.unconfirmed) {
    return { state: 'legacy', label: 'Legacy token', text: `${name} has no confirmed key here yet: its prompts arrive as claimed (unverified). Re-pair to switch to keys.` };
  }
  return { state: 'waiting', label: 'Waiting for key', text: `A key for ${name} is on its way (within about a minute). Until then its prompts arrive as claimed; ${theirs}.` };
}

/**
 * The line of an inbound-only entry (a relay that added this one one way and
 * holds a key this relay gave it): `{ state: 'inbound-only', label, text }`.
 */
export function describeInboundOnlyRelay(relay, now = Date.now()) {
  const name = String(relay?.name || relay?.relayId || 'That relay');
  const key = relay?.peerKey && typeof relay.peerKey === 'object' ? relay.peerKey : null;
  let used;
  if (key?.status === 'revoked') used = 'its key is revoked';
  else if (key?.status === 'active') used = key.lastUsedAt ? `its key was last used ${formatRelativeTime(key.lastUsedAt, now)}` : 'its key works';
  else used = 'its key was not used yet';
  return {
    state: 'inbound-only',
    label: 'Inbound only',
    text: `${name} added this relay one way and signs in here with a key this relay gave it (${used}); its prompts arrive verified. This relay never calls it: it has no address here. Remove revokes its key at once.`,
  };
}

/** "N refused claims since start", or '' for none. */
export function refusedClaimsText(relay) {
  const count = Number(relay?.refusedClaims) || 0;
  if (count <= 0) return '';
  return `${count} refused claim${count === 1 ? '' : 's'} since start`;
}

/**
 * What the Re-pair answer means for the row: `{ state, text, openLink }`.
 * `openLink`: bring up the paste-the-pairing-link field (an older relay, or a
 * credential the other relay no longer takes).
 */
export function describeRepairResult(result, relay) {
  const name = String(relay?.name || relay?.host || 'the relay');
  if (!result) return { state: 'error', text: 'This relay is not reachable right now. Try again in a moment.', openLink: false };
  if (result.ok) {
    const ours = result.keys?.ours?.ok === true;
    const theirs = result.keys?.theirs?.ok === true;
    if (ours && theirs) return { state: 'paired', text: `Re-paired with ${name}: keys both ways.`, openLink: false };
    if (ours || theirs) return { state: 'pair-failed', text: `Re-paired with ${name} one way; the other key follows within about a minute.`, openLink: false };
    // A one-way pairing whose pair-back failed (no public address here, say):
    // nothing is retried until that is fixed, so say why.
    if (result.pairedBack === false && String(result.pairBackError || '').trim()) {
      return { state: 'pair-failed', text: `Could not add this relay to ${name}: ${String(result.pairBackError).trim()}. It stays one way until then.`, openLink: false };
    }
    return { state: 'pair-failed', text: `${name} answered, but no key went through yet. It is retried within about a minute.`, openLink: false };
  }
  if (result.needsLink) {
    return { state: 'needs-token', text: String(result.error || `Paste ${name}'s pairing link to re-pair.`), openLink: true };
  }
  return { state: 'error', text: String(result.error || 'Re-pair failed.'), openLink: false };
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
  // Empty, the field shows the name the relay goes by then (its host name).
  const nameInput = el('pwa-app-name-input');
  const defaultName = String(getRemoteRelaysSnapshot()?.self?.defaultName || '').trim();
  if (nameInput && defaultName) nameInput.placeholder = defaultName;
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

  // Peer key (origin binding): keyed, legacy token or old version, and the
  // refused claims since this relay started.
  const peer = describeRelayPeerKey(relay);
  const keyLine = document.createElement('span');
  keyLine.className = 'preview-detail remote-relay-peer-key';
  keyLine.dataset.state = peer.state;
  const keyTag = document.createElement('span');
  keyTag.className = 'remote-relay-key-tag';
  keyTag.dataset.state = peer.state;
  keyTag.textContent = peer.label;
  keyLine.appendChild(keyTag);
  keyLine.appendChild(document.createTextNode(` ${peer.text}`));
  main.appendChild(keyLine);
  const refused = refusedClaimsText(relay);
  if (refused) {
    const refusedLine = document.createElement('span');
    refusedLine.className = 'preview-warning remote-relay-refused';
    refusedLine.textContent = `⚠ ${refused}`;
    refusedLine.title = 'Requests that claimed to be another relay, or claimed to be this one without its key. They were refused and logged.';
    main.appendChild(refusedLine);
  }
  const repairNote = rowNotes.get(relay.id);
  if (repairNote) {
    const note = document.createElement('span');
    note.className = 'preview-detail remote-relay-repair-status';
    note.dataset.state = repairNote.state;
    note.setAttribute('role', 'status');
    note.textContent = repairNote.text;
    main.appendChild(note);
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

  const repair = document.createElement('button');
  repair.type = 'button';
  repair.className = 'preview-copy remote-relay-repair';
  repair.textContent = busy === 'repair' ? 'Re-pairing…' : 'Re-pair';
  repair.title = `Keys both ways with ${name}; for an older relay, paste its pairing link`;
  repair.disabled = !!busy;
  repair.addEventListener('click', () => {
    void repairRemoteRelayRow(relay);
  });
  actions.appendChild(repair);

  if (peer.state === 'held') {
    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'preview-copy remote-relay-confirm-identity';
    confirmButton.textContent = 'Confirm';
    confirmButton.disabled = !!busy;
    confirmButton.addEventListener('click', () => {
      void confirmRemoteRelayIdentityRow(relay);
    });
    actions.appendChild(confirmButton);
  }
  if (peer.state === 'keyed' || peer.state === 'revoked') {
    const renew = document.createElement('button');
    renew.type = 'button';
    renew.className = 'preview-copy remote-relay-renew';
    renew.textContent = busy === 'renew' ? 'Renewing…' : 'Renew key';
    renew.disabled = !!busy;
    renew.addEventListener('click', () => {
      void renewRemoteRelayKeyRow(relay);
    });
    actions.appendChild(renew);
  }
  if (peer.state === 'keyed') {
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'preview-copy remote-relay-revoke';
    revoke.textContent = 'Revoke key';
    revoke.disabled = !!busy;
    revoke.addEventListener('click', () => {
      void revokeRemoteRelayKeyRow(relay);
    });
    actions.appendChild(revoke);
  }

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

/** An inbound-only entry's row: name, what it is, and Remove. */
function buildInboundOnlyRow(relay) {
  const busy = rowBusy.get(relay.id) || '';
  const name = String(relay.name || relay.relayId || relay.id);
  const row = document.createElement('div');
  row.className = 'preview-row remote-relay-row remote-relay-inbound-row';
  row.dataset.relayId = relay.id;
  row.dataset.inboundOnly = 'true';

  const main = document.createElement('span');
  main.className = 'preview-main';
  row.appendChild(main);

  // textContent throughout: the name and version come from that relay.
  const label = document.createElement('span');
  label.className = 'preview-label remote-relay-name';
  label.textContent = name;
  main.appendChild(label);

  const detail = document.createElement('span');
  detail.className = 'preview-detail remote-relay-detail';
  const version = String(relay.version || '').trim();
  detail.textContent = [version ? `OAR ${version}` : '', relay.addedAt ? `added ${formatRelativeTime(relay.addedAt)}` : ''].filter(Boolean).join(' · ') || 'inbound only';
  main.appendChild(detail);

  const line = describeInboundOnlyRelay(relay);
  const keyLine = document.createElement('span');
  keyLine.className = 'preview-detail remote-relay-peer-key';
  keyLine.dataset.state = line.state;
  const keyTag = document.createElement('span');
  keyTag.className = 'remote-relay-key-tag';
  keyTag.dataset.state = line.state;
  keyTag.textContent = line.label;
  keyLine.appendChild(keyTag);
  keyLine.appendChild(document.createTextNode(` ${line.text}`));
  main.appendChild(keyLine);
  const refused = refusedClaimsText(relay);
  if (refused) {
    const refusedLine = document.createElement('span');
    refusedLine.className = 'preview-warning remote-relay-refused';
    refusedLine.textContent = `⚠ ${refused}`;
    main.appendChild(refusedLine);
  }

  const side = document.createElement('span');
  side.className = 'preview-side';
  row.appendChild(side);
  const actions = document.createElement('span');
  actions.className = 'preview-actions';
  side.appendChild(actions);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'preview-close remote-relay-remove';
  remove.textContent = busy === 'remove' ? 'Removing…' : 'Remove';
  remove.title = `Revoke ${name}'s key: it can no longer call this relay`;
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
  const inbound = snapshot?.inbound || [];
  list.textContent = '';
  for (const relay of relays) list.appendChild(buildRelayRow(relay));
  for (const relay of inbound) list.appendChild(buildInboundOnlyRow(relay));
  const empty = el('remote-relays-empty');
  if (empty) {
    empty.hidden = relays.length + inbound.length > 0;
    empty.textContent = snapshot
      ? 'No remote relays yet. Add one below.'
      : (listLoadFailed ? 'Could not load the remote relays.' : 'Loading remote relays…');
  }
}

// ─── This browser on the paired relays (agent auth §13.2, 1b/1c) ─────────────

export const BROWSER_CHECKLIST_NOTE = 'Each relay keeps its own sign-in; this page cannot see it.';
export const SAME_HOST_WARNING = 'Same host as this page, another port: browsers keep one sign-in per host, so the two relays sign each other out here. Open one of them under another address (its tunnel, or 127.0.0.1 for the other on localhost).';

/**
 * One row per paired relay with a usable address: its name, "Sign in there"
 * (its start page) and "Turn on push there" (its Notifications tab), and
 * whether it shares this page's host on another port. No probe of the other
 * relay: a cross-site read would carry none of its cookies.
 */
export function browserChecklistRows(relays, pageUrl = (typeof window !== 'undefined' ? window.location?.href : '')) {
  return (Array.isArray(relays) ? relays : []).map((relay) => {
    // An inbound-only relay has no address here: nothing to open.
    if (relay?.inboundOnly === true) return null;
    const signIn = relayPageUrl(relay?.url);
    if (!signIn) return null;
    return {
      id: String(relay.id || ''),
      name: String(relay.name || relay.host || relay.id || ''),
      signIn,
      push: relaySettingsUrl(relay.url, 'notifications'),
      sameHost: sameHostOtherPort(relay.url, pageUrl),
    };
  }).filter(Boolean);
}

function checklistLink(className, label, href, title) {
  const link = document.createElement('a');
  link.className = className;
  link.textContent = label;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = title;
  return link;
}

function renderBrowserChecklist() {
  const section = el('remote-relays-browser-section');
  const list = el('remote-relays-browser-list');
  if (!section || !list) return;
  const rows = browserChecklistRows(getRemoteRelaysSnapshot()?.relays || []);
  list.textContent = '';
  for (const entry of rows) {
    const row = document.createElement('div');
    row.className = 'remote-relays-browser-row';
    row.dataset.relayId = entry.id;
    const name = document.createElement('span');
    name.className = 'remote-relays-browser-name';
    name.textContent = entry.name;
    row.append(
      name,
      checklistLink('remote-relays-browser-signin', 'Sign in there', entry.signIn, `Open ${entry.name} to sign this browser in there`),
      checklistLink('remote-relays-browser-push', 'Turn on push there', entry.push, `Open ${entry.name}'s Notifications settings`),
    );
    if (entry.sameHost) {
      const warning = document.createElement('div');
      warning.className = 'remote-relays-browser-warning';
      warning.setAttribute('role', 'note');
      warning.textContent = SAME_HOST_WARNING;
      row.append(warning);
    }
    list.append(row);
  }
  section.hidden = rows.length === 0;
}

export function renderRemoteRelaysSection() {
  renderSelfSection();
  renderRelayList();
  renderBrowserChecklist();
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

async function repairRemoteRelayRow(relay, { confirmIdentity = false } = {}) {
  if (rowBusy.has(relay.id)) return;
  rowBusy.set(relay.id, 'repair');
  rowNotes.delete(relay.id);
  renderRelayList();
  let result = null;
  try {
    result = await repairRemoteRelay(relay.id, { confirmIdentity });
  } finally {
    rowBusy.delete(relay.id);
  }
  if (result && result.needsConfirm && !confirmIdentity) {
    const found = result.identity || {};
    const what = [found.name, found.version ? `OAR ${found.version}` : ''].filter(Boolean).join(', ');
    if (confirm(`Another relay identity answers at the address of ${relay.name || relay.host}${what ? ` (${what})` : ''}. Is it the relay you meant? Its keys are issued again.`)) {
      return repairRemoteRelayRow(relay, { confirmIdentity: true });
    }
    rowNotes.set(relay.id, { state: 'error', text: 'Not re-paired: the identity change was not confirmed.' });
    renderRelayList();
    return;
  }
  const outcome = describeRepairResult(result, relay);
  rowNotes.set(relay.id, { state: outcome.state, text: outcome.text });
  if (result?.relay && typeof result.relay === 'object') upsertRemoteRelay(result.relay);
  if (outcome.openLink) openPairingLinkField(relay, outcome.text);
  renderRelayList();
}

/** Re-pair of an older relay: the add form, its address filled in, the token field up. */
function openPairingLinkField(relay, text) {
  const urlInput = el('remote-relays-add-url-input');
  if (urlInput) urlInput.value = String(relay?.url || '');
  setTokenFieldVisible(true);
  setStatusLine('remote-relays-add-status', 'needs-token', `${text} Paste its pairing link (or its token below) and press Add: the entry is updated in place.`);
  urlInput?.scrollIntoView?.({ block: 'center' });
  urlInput?.focus?.();
}

async function confirmRemoteRelayIdentityRow(relay) {
  if (rowBusy.has(relay.id)) return;
  if (!confirm(`Confirm that the relay now at the address of ${relay.name || relay.host} is the one you meant? Keys are issued again after Re-pair.`)) return;
  const result = await confirmRemoteRelayIdentity(relay.id);
  if (result?.relay) upsertRemoteRelay(result.relay);
  else if (!result?.ok) alert(result?.error || 'Could not confirm.');
  renderRelayList();
}

async function renewRemoteRelayKeyRow(relay) {
  if (rowBusy.has(relay.id)) return;
  rowBusy.set(relay.id, 'renew');
  renderRelayList();
  let result = null;
  try {
    result = await renewRemoteRelayKey(relay.id);
  } finally {
    rowBusy.delete(relay.id);
  }
  if (result?.relay) upsertRemoteRelay(result.relay);
  rowNotes.set(relay.id, result?.ok
    ? { state: 'paired', text: `A new key went to ${relay.name || relay.host}.` }
    : { state: 'error', text: result?.error || 'The new key could not be delivered.' });
  renderRelayList();
}

async function revokeRemoteRelayKeyRow(relay) {
  if (rowBusy.has(relay.id)) return;
  const name = relay.name || relay.host || 'this relay';
  if (!confirm(`Revoke ${name}'s key? Its requests are refused until you Renew the key or Re-pair, and its earlier prompts no longer open anything here.`)) return;
  const result = await revokeRemoteRelayKey(relay.id);
  if (result?.relay) upsertRemoteRelay(result.relay);
  else if (!result?.ok) alert(result?.error || 'Could not revoke the key.');
  renderRelayList();
}

async function removeRemoteRelayRow(relay) {
  if (rowBusy.has(relay.id)) return;
  const name = relay.name || relay.host || 'this relay';
  const confirmed = confirm(relay.inboundOnly === true
    ? `Remove ${name}? Its key is revoked at once: ${name} can no longer call this relay. ${name} keeps its own entry for this relay; remove it there too.`
    : `Remove ${name}? Agents here can no longer work on it. ${name} keeps its own entry for this relay; remove it there too to unpair both ways.`);
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

/**
 * `?settings=relays&add-relay=1` (a paired relay's rotation dialog, "Open
 * there"): the "Add a relay" form in view with its address field focused.
 * Nothing is filled in: the pairing link is pasted by hand.
 */
export function revealAddRemoteRelayForm() {
  const section = el('remote-relays-add-section');
  try { section?.scrollIntoView?.({ block: 'center' }); } catch {}
  el('remote-relays-add-url-input')?.focus?.({ preventScroll: true });
  return !!section;
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
  lastSelfName = null;
  rowBusy.clear();
}

// A rename on another device (the relay announces it with the list) or the
// Relays tab coming into view reads the name again; the field keeps what is
// being typed in it (pwa-install.js).
function refreshRelayNameOnChange(snapshot) {
  const name = typeof snapshot?.self?.name === 'string' ? snapshot.self.name : null;
  if (name === null) return;
  const changed = lastSelfName !== null && name !== lastSelfName;
  lastSelfName = name;
  if (!changed) return;
  // This page's own rename: its answer paints the field.
  if (isPwaAppNameSaveInFlight()) return;
  // A name this page already has (an empty one goes by the default).
  const known = currentPwaAppName() || String(snapshot.self.defaultName || '');
  if (name === known) return;
  syncPwaAppNameInput();
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
  refreshRelayNameOnChange(snapshot);
  renderRemoteRelaysSection();
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(RELAY_NAME_CHANGED_EVENT, () => {
    void refreshRemoteRelays();
  });
  window.addEventListener(SETTINGS_TAB_SHOWN_EVENT, (event) => {
    if (event?.detail?.tab !== 'relays') return;
    syncPwaAppNameInput();
    void refreshRemoteRelays();
  });
}
