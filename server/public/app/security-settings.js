// Settings → Security (agent auth §4.6, §5): the browsers signed in to this
// relay (rename, sign out one, all others, or this one), a single-use link
// that signs one more device in, and the relay token (its state, and a new
// one shown once). Also the security notices banner under the header: a new
// relay token recommended after the upgrade, and a token changed outside OAR.
//
// Every route here is the person's (a browser session or the owner token);
// agents and paired relays are refused by the relay. Labels, user agents and
// addresses go into the page as text only.
//
// The new relay token is kept nowhere in this module: it goes from the
// rotation's answer into the fields of its dialog (a form a password manager
// can save from, agent auth §13.2, 2a), the Copy buttons read those fields,
// and closing the dialog (whichever way) clears them and drops the dialog's
// DOM. The sign-in link and its QR code are kept until the link expires or is
// used; the QR code shows only after a tap, and hides again (§13.2, 2b).
//
// New sign-ins (§13.2, 2d) are one row of the notices banner, however many:
// the newest (who, from where, how) or "N new browsers signed in", a list
// with "Sign it out" per browser, and one "Got it"; they arrive live
// (socket `auth_new_signin`). While a new relay token is recommended (3b) the
// Security tab carries a quiet dot.

import {
  IS_SHARED_VIEW,
  closeSummaryModal,
  escHtml,
  openSummaryModal,
  setSummaryModalLeaveHandler,
  showTransientRelayNotice,
} from './store.js';
import { apiFetch, apiFetchOrThrow, reportSignedOut } from './api-client.js';
import { clearOutbox } from './sync-outbox.mjs';
import { SETTINGS_TAB_SHOWN_EVENT, setSettingsTabDot } from './settings-tabs.js';
import { formatRelativeTime } from './remote-relays-settings.js';
import { clearQrCode, drawQrCode } from './qr-canvas.mjs';
import { relaySettingsUrl } from './remote-relay-links.mjs';

// How a browser signed in, after "Signed in <time>".
export const AUTH_METHOD_LABELS = Object.freeze({
  token: 'with the relay token',
  code: 'with a sign-in link',
  upgrade: 'before browser sessions (carried over)',
  terminal: 'from the terminal (oar url --sign-in)',
});

// "via …" in a new sign-in's notice (the relay sends its own label too).
export const SIGNIN_VIA_LABELS = Object.freeze({
  token: 'the relay token',
  code: 'a sign-in link',
  terminal: 'the terminal',
});
export const SIGNIN_NOTICE_SOCKET_EVENT = 'auth_new_signin';
export const ROTATE_RECOMMENDATION_ID = 'rotate-owner-token';
export const CLIPBOARD_HINT_TEXT = 'Copy puts the token on the clipboard, where clipboard history and clipboard managers keep it: clear it once you have pasted it.';
// How long the QR code of a sign-in link stays up after the tap.
export const SIGNIN_QR_SHOW_MS = 60_000;

export const ROTATE_CONFIRM_TEXT = 'The current token stops working at once. Signed-in browsers stay signed in; agents keep working.';
export const TOKEN_SHOWN_ONCE_TEXT = 'Shown once. Keep it in your password manager.';
export const SELF_SIGNED_OUT_MESSAGE = 'You signed this browser out';

export const SECURITY_NOTICE_IDS = Object.freeze({
  rotateAfterUpgrade: 'rotate-after-upgrade',
  changedOutside: 'changed-outside',
});

const TOKEN_DIALOG_KIND = 'security-token';
const COPY_RESET_MS = 2000;
const SIGNIN_TICK_MS = 1000;

let sessions = [];
let sessionsLoaded = false;
let sessionsError = '';
let ownerToken = null;
let pairedRelays = 0;
let tokenError = '';
// The sign-in link on show: { link, expiresAt }, until it expires or is used.
let signin = null;
let signinTimer = null;
// The QR code of the link: shown after a tap, hidden after SIGNIN_QR_SHOW_MS.
let qrShown = false;
let qrTimer = null;
const busy = new Set();
let controlsBound = false;
let notices = [];
// New sign-ins this browser is shown (GET /api/auth/notices `signins`), newest first.
let signins = [];
// The new sign-ins the socket brought, in order (id → { seq, notice }): an
// answer to a request sent before one arrived does not hold it, and must not
// take it off the banner ("Got it" on the sign-ins before, while a new
// browser signs in). Each arrival counts up `signinArrivalSeq`.
let signinArrivalSeq = 0;
const signinArrivals = new Map();
const SIGNIN_ARRIVALS_MAX = 50;
// The sign-ins dismissed in this page, oldest first: an answer made before
// the relay had them dismissed (a notices call on its way at "Got it", or
// the first of two overlapping dismissals answering last) still lists them,
// and must not bring them back. One whose dismissal fails leaves the set.
const dismissedSignins = new Set();
const DISMISSED_SIGNINS_MAX = 50;
// Whether the banner's list of several new sign-ins is open.
let signinsExpanded = false;
// `recommendations`: [{ id: 'rotate-owner-token', tab: 'security' }] or [].
let recommendations = [];
// "Sign it out" of a notice in flight, and what came of it: id → 'busy' | 'done' | 'gone'.
const signinOutcomes = new Map();
// When the owner token's record of non-browser uses began (GET owner-token).
let ownerTokenUseSince = null;

function el(id) {
  return document.getElementById(id);
}

function toText(value) {
  return String(value ?? '').trim();
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** A time as the push devices' list shows it, or "unknown". */
export function formatSecurityTimestamp(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString();
}

/** One signed-in browser's row: its name, whether it is this one, and the line below. */
export function describeBrowserSession(session, now = Date.now()) {
  const method = AUTH_METHOD_LABELS[toText(session?.authMethod)] || '';
  const parts = [
    `Signed in ${formatSecurityTimestamp(session?.createdAt)}${method ? ` ${method}` : ''}`,
    `last seen ${formatRelativeTime(session?.lastSeenAt, now)}`,
  ];
  const ip = toText(session?.lastIp);
  if (ip) parts.push(`from ${ip}`);
  return {
    name: toText(session?.label) || 'Browser',
    current: session?.current === true,
    meta: parts.join(' · '),
  };
}

/** The relay token's status line and its data-state. */
export function describeOwnerToken(status, { pairedRelays: paired = 0, now = Date.now() } = {}) {
  if (!status || typeof status !== 'object') return { state: '', text: '' };
  if (status.set !== true) return { state: 'error', text: 'No relay token is set.' };
  const parts = [status.hashed === false ? 'Set.' : 'Set, stored as a hash.'];
  if (status.rotatedAt) parts.push(`Last replaced ${formatRelativeTime(status.rotatedAt, now)}.`);
  else if (status.createdAt) parts.push(`Made ${formatRelativeTime(status.createdAt, now)}, never replaced.`);
  if (status.persisted === false) parts.push('Not saved on disk (see the relay log).');
  const count = Number(paired) || 0;
  if (count > 0) parts.push(`${count} paired relay${count === 1 ? '' : 's'} use${count === 1 ? 's' : ''} it.`);
  if (status.legacyPlaintext === true) {
    parts.push('Agents could read it until this version: generate a new one.');
    return { state: 'error', text: parts.join(' ') };
  }
  return { state: 'active', text: parts.join(' ') };
}

/** "Works once, until 14:32 (9 min left).", or '' once it has expired. */
export function describeSigninExpiry(expiresAt, now = Date.now()) {
  const at = Date.parse(toText(expiresAt));
  if (!Number.isFinite(at) || at <= now) return '';
  const seconds = Math.ceil((at - now) / 1000);
  const until = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const left = seconds >= 60 ? `${Math.ceil(seconds / 60)} min left` : `${seconds} s left`;
  return `Works once, until ${until} (${left}).`;
}

// "Chrome on Android, 192.168.1.20, via a sign-in link".
function signinWhoVia(notice) {
  const via = SIGNIN_VIA_LABELS[toText(notice?.via)] || toText(notice?.viaLabel) || SIGNIN_VIA_LABELS.token;
  const who = [toText(notice?.label) || 'Browser', toText(notice?.address)].filter(Boolean).join(', ');
  return `${who}, via ${via}`;
}

/** "New browser signed in: Chrome on Android, 192.168.1.20, via a sign-in link". */
export function describeSigninNotice(notice) {
  return `New browser signed in: ${signinWhoVia(notice)}`;
}

/**
 * One entry of the list of several: who, from where, how and when, so two
 * that read alike ("Chrome on Android, 127.0.0.1") can be told apart:
 * "Chrome on Android, 192.168.1.20, via a sign-in link · 5 min ago".
 */
export function describeSigninEntry(notice, now = Date.now()) {
  const when = notice?.at ? formatRelativeTime(notice.at, now) : '';
  return `${signinWhoVia(notice)}${when ? ` · ${when}` : ''}`;
}

/**
 * The banner's one sign-in row, newest first: a single notice as above;
 * several as "3 new browsers signed in (latest: Chrome on Android, …, via …)".
 */
export function describeSigninSummary(list) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (items.length === 0) return '';
  if (items.length === 1) return describeSigninNotice(items[0]);
  return `${items.length} new browsers signed in (latest: ${signinWhoVia(items[0])})`;
}

/**
 * The rotation dialog's line on the old token (§13.2, 3a): when something
 * other than a browser page last used it, and from where.
 */
export function describeLastNonBrowserUse(use, since = null, now = Date.now()) {
  const prefix = 'Owner token last used by a non-browser client:';
  const at = toText(use?.at);
  if (at && Number.isFinite(Date.parse(at))) {
    const address = toText(use?.address);
    return `${prefix} ${formatRelativeTime(at, now)}${address ? `, from ${address}` : ''}.`;
  }
  const start = toText(since);
  if (start && Number.isFinite(Date.parse(start))) return `${prefix} not since ${formatSecurityTimestamp(start)}.`;
  return `${prefix} not that this relay knows of.`;
}

/** The re-pair hint for one paired relay a new token leaves on the old one. */
export function rePairHint(name) {
  const label = toText(name) || 'that relay';
  return `On ${label}: Settings → Relays → Add a relay, paste the pairing link; it updates the existing entry.`;
}

const CHANGED_OUTSIDE_REASONS = Object.freeze({
  config: 'config.json held a new token',
  file: 'the relay\'s secrets file holds another token',
});

/** A notice's banner text. */
export function securityNoticeText(notice, now = Date.now()) {
  const id = toText(notice?.id);
  if (id === SECURITY_NOTICE_IDS.rotateAfterUpgrade) {
    return 'Your relay token was readable by agents until this version. Generate a new one.';
  }
  if (id === SECURITY_NOTICE_IDS.changedOutside) {
    const reason = CHANGED_OUTSIDE_REASONS[toText(notice?.reason)] || '';
    const when = notice?.at ? formatRelativeTime(notice.at, now) : '';
    const detail = [reason, when].filter(Boolean).join(', ');
    return `The relay token was changed outside OAR${detail ? ` (${detail})` : ''}. If that was not you, generate a new one.`;
  }
  return toText(notice?.message);
}

// ─── Copying ─────────────────────────────────────────────────────────────────

async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}
  return false;
}

/** Copies `input`'s value; without a clipboard the field is selected to copy by hand. */
async function copyField(input, button, label) {
  if (!input) return;
  const copied = await copyText(input.value);
  if (!copied) {
    try { input.focus(); input.select(); } catch {}
  }
  if (button) {
    button.textContent = copied ? '✓ Copied' : 'Select and copy';
    clearTimeout(button.__securityCopyTimer);
    button.__securityCopyTimer = setTimeout(() => { button.textContent = label; }, COPY_RESET_MS);
  }
}

// ─── Browsers signed in ──────────────────────────────────────────────────────

function setStatus(id, state, text) {
  const line = el(id);
  if (!line) return;
  line.textContent = text || '';
  line.hidden = !text;
  if (state) line.dataset.state = state;
  else delete line.dataset.state;
}

function rowButton(label, onClick, { disabled = false, className = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `summary-btn${className ? ` ${className}` : ''}`;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    void onClick();
  });
  return button;
}

function buildSessionRow(session, now) {
  const { name, current, meta } = describeBrowserSession(session, now);
  const row = document.createElement('div');
  row.className = 'push-device-row settings-row security-session-row';
  row.dataset.sessionId = toText(session.id);
  // How it signed in ("via …" is the line's method label).
  if (toText(session.authMethod)) row.dataset.via = toText(session.authMethod);
  if (current) row.dataset.current = 'true';

  const info = document.createElement('div');
  info.className = 'security-session-info';
  const title = document.createElement('div');
  title.className = 'security-session-name';
  title.textContent = name;
  if (current) {
    const tag = document.createElement('span');
    tag.className = 'remote-relay-tag security-current-tag';
    tag.textContent = 'this browser';
    title.append(' ', tag);
  }
  const line = document.createElement('div');
  line.className = 'settings-help security-session-meta';
  line.textContent = meta;
  if (toText(session.userAgent)) line.title = toText(session.userAgent);
  info.append(title, line);

  const rowBusy = busy.has(`session:${session.id}`);
  row.append(
    info,
    rowButton('Rename', () => openRenameDialog(session), { disabled: rowBusy, className: 'security-rename-btn' }),
    rowButton(rowBusy ? 'Signing out…' : 'Sign out', () => (current ? confirmSignOutThisBrowser() : confirmSignOutSession(session)), {
      disabled: rowBusy,
      className: 'security-signout-btn',
    }),
  );
  return row;
}

export function renderBrowserSessions(now = Date.now()) {
  const list = el('security-session-list');
  if (!list) return;
  list.textContent = '';
  for (const session of sessions) list.appendChild(buildSessionRow(session, now));
  if (sessionsError) setStatus('security-sessions-status', 'error', sessionsError);
  else if (!sessionsLoaded) setStatus('security-sessions-status', '', 'Loading the signed-in browsers…');
  else if (!sessions.length) setStatus('security-sessions-status', '', 'No browser is signed in with a session.');
  else setStatus('security-sessions-status', '', '');
  const others = sessions.filter((session) => session.current !== true).length;
  const othersButton = el('security-signout-others-btn');
  if (othersButton) othersButton.disabled = busy.has('others') || (sessionsLoaded && others === 0);
  const selfButton = el('security-signout-self-btn');
  if (selfButton) selfButton.disabled = busy.has('self');
}

async function loadBrowserSessions() {
  try {
    const payload = await apiFetchOrThrow('/api/auth/sessions');
    if (!payload) return;
    sessions = Array.isArray(payload.sessions) ? payload.sessions.filter((row) => row && toText(row.id)) : [];
    // This browser first, then the most recently seen.
    sessions.sort((a, b) => (b.current === true) - (a.current === true)
      || toText(b.lastSeenAt).localeCompare(toText(a.lastSeenAt)));
    sessionsLoaded = true;
    sessionsError = '';
  } catch (error) {
    sessionsError = `Could not load the signed-in browsers: ${error?.message || 'unknown error'}`;
  }
}

/** A dialog in the shared summary modal, with a confirm button that runs `run`. */
function openConfirmDialog({ title, kind, bodyHtml, confirmLabel, danger = false, run }) {
  openSummaryModal({
    title,
    kind,
    bodyHtml: `
      ${bodyHtml}
      <div class="summary-modal-actions">
        <button id="security-confirm-btn" class="chat-title-action-btn${danger ? ' danger-btn' : ''}" type="button">${escHtml(confirmLabel)}</button>
        <button id="security-cancel-btn" class="chat-title-action-btn" type="button">Cancel</button>
      </div>
    `,
  });
  el('security-cancel-btn')?.addEventListener('click', () => closeSummaryModal());
  const confirm = el('security-confirm-btn');
  confirm?.addEventListener('click', async () => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    try {
      await run();
    } finally {
      if (confirm.isConnected) confirm.disabled = false;
    }
  });
  confirm?.focus?.();
}

function openRenameDialog(session) {
  const current = toText(session?.label);
  openSummaryModal({
    title: 'Rename browser',
    kind: 'security-rename',
    bodyHtml: `
      <p><label for="security-rename-input">Name for this signed-in browser</label></p>
      <p><input id="security-rename-input" class="security-rename-field" type="text" maxlength="80" autocomplete="off" spellcheck="false" value="${escHtml(current)}"></p>
      <div class="summary-modal-actions">
        <button id="security-rename-save" class="chat-title-action-btn" type="button">Save</button>
        <button id="security-cancel-btn" class="chat-title-action-btn" type="button">Cancel</button>
      </div>
    `,
  });
  const input = el('security-rename-input');
  const save = el('security-rename-save');
  el('security-cancel-btn')?.addEventListener('click', () => closeSummaryModal());
  const submit = async () => {
    if (!save || save.disabled) return;
    save.disabled = true;
    try {
      await renameBrowserSession(session.id, input?.value ?? '');
      closeSummaryModal();
    } catch (error) {
      showTransientRelayNotice(error?.message || 'The browser could not be renamed.');
      save.disabled = false;
    }
  };
  save?.addEventListener('click', () => { void submit(); });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
  try { input?.focus(); input?.select(); } catch {}
}

export async function renameBrowserSession(id, label) {
  const payload = await apiFetchOrThrow(`/api/auth/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label: String(label ?? '').trim() }),
  });
  const updated = payload?.session;
  if (updated?.id) sessions = sessions.map((row) => (row.id === updated.id ? { ...row, ...updated } : row));
  renderBrowserSessions();
  return updated || null;
}

function signedOutNotice(label, effects) {
  const pushes = Number(effects?.pushDevices) || 0;
  return `Signed out ${label}.${pushes ? ' Its push notifications stopped.' : ''}`;
}

function confirmSignOutSession(session) {
  const { name } = describeBrowserSession(session);
  openConfirmDialog({
    title: 'Sign out browser',
    kind: 'security-signout',
    bodyHtml: `<p>Sign out <strong>${escHtml(name)}</strong>?</p>
      <p>Its connection ends at once and its push notifications stop. To come back it signs in again with the relay token or a sign-in link.</p>`,
    confirmLabel: 'Sign out',
    danger: true,
    run: async () => {
      await signOutBrowserSession(session.id, name);
      closeSummaryModal();
    },
  });
}

export async function signOutBrowserSession(id, name = 'the browser') {
  const key = `session:${id}`;
  if (busy.has(key)) return null;
  busy.add(key);
  renderBrowserSessions();
  try {
    const payload = await apiFetchOrThrow(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (payload?.current === true) {
      void clearOutbox().catch(() => {});
      reportSignedOut(SELF_SIGNED_OUT_MESSAGE);
      return payload;
    }
    sessions = sessions.filter((row) => row.id !== id);
    showTransientRelayNotice(signedOutNotice(name, payload?.effects));
    return payload;
  } catch (error) {
    showTransientRelayNotice(error?.message || 'The browser could not be signed out.');
    return null;
  } finally {
    busy.delete(key);
    renderBrowserSessions();
  }
}

function confirmSignOutOthers() {
  const others = sessions.filter((session) => session.current !== true).length;
  openConfirmDialog({
    title: 'Sign out all other browsers',
    kind: 'security-signout-others',
    bodyHtml: `<p>Sign out ${others === 1 ? 'the other browser' : `all ${others || 'other'} other browsers`}? This one stays signed in.</p>
      <p>Their connections end at once and their push notifications stop.</p>`,
    confirmLabel: 'Sign out all others',
    danger: true,
    run: async () => {
      await signOutOtherBrowsers();
      closeSummaryModal();
    },
  });
}

export async function signOutOtherBrowsers() {
  if (busy.has('others')) return null;
  busy.add('others');
  renderBrowserSessions();
  try {
    const payload = await apiFetchOrThrow('/api/auth/sessions', { method: 'DELETE' });
    const count = Number(payload?.revoked) || 0;
    sessions = sessions.filter((row) => row.current === true);
    showTransientRelayNotice(count ? `Signed out ${count} other browser${count === 1 ? '' : 's'}.` : 'No other browser was signed in.');
    return payload;
  } catch (error) {
    showTransientRelayNotice(error?.message || 'The other browsers could not be signed out.');
    return null;
  } finally {
    busy.delete('others');
    renderBrowserSessions();
  }
}

function confirmSignOutThisBrowser() {
  openConfirmDialog({
    title: 'Sign out this browser',
    kind: 'security-signout-self',
    bodyHtml: `<p>Sign out this browser?</p>
      <p>The sign-in box comes up; to come back, sign in with the relay token or a sign-in link.</p>`,
    confirmLabel: 'Sign out this browser',
    danger: true,
    run: async () => { await signOutThisBrowser(); },
  });
}

export async function signOutThisBrowser() {
  if (busy.has('self')) return null;
  busy.add('self');
  renderBrowserSessions();
  try {
    const payload = await apiFetchOrThrow('/api/auth/session', { method: 'DELETE' });
    closeSummaryModal();
    // Signed out on purpose: nothing it queued goes out after the next sign-in.
    void clearOutbox().catch(() => {});
    reportSignedOut(SELF_SIGNED_OUT_MESSAGE);
    return payload;
  } catch (error) {
    showTransientRelayNotice(error?.message || 'This browser could not be signed out.');
    return null;
  } finally {
    busy.delete('self');
    renderBrowserSessions();
  }
}

// ─── Sign in another device ──────────────────────────────────────────────────

function stopSigninTimer() {
  if (signinTimer) clearInterval(signinTimer);
  signinTimer = null;
}

/** Hides the QR code and draws over it: after a minute, on a tab switch, on Hide, when the link goes. */
export function hideSigninQr() {
  qrShown = false;
  if (qrTimer) clearTimeout(qrTimer);
  qrTimer = null;
  clearQrCode(el('security-signin-qr-canvas'));
  const box = el('security-signin-qr');
  if (box) box.hidden = true;
  const button = el('security-signin-qr-btn');
  if (button) {
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'Show QR code';
  }
}

/** "Show QR code": draws the link's code, for a minute at most. */
export function showSigninQr() {
  if (!signin?.qr) return false;
  const canvas = el('security-signin-qr-canvas');
  if (!drawQrCode(canvas, signin.qr)) {
    hideSigninQr();
    showTransientRelayNotice('The QR code could not be drawn. Copy the link instead.');
    return false;
  }
  qrShown = true;
  const box = el('security-signin-qr');
  if (box) box.hidden = false;
  const button = el('security-signin-qr-btn');
  if (button) {
    button.setAttribute('aria-expanded', 'true');
    button.textContent = 'Hide QR code';
  }
  if (qrTimer) clearTimeout(qrTimer);
  qrTimer = setTimeout(() => hideSigninQr(), SIGNIN_QR_SHOW_MS);
  qrTimer?.unref?.();
  return true;
}

function toggleSigninQr() {
  if (qrShown) hideSigninQr();
  else showSigninQr();
}

/** Drops the sign-in link (and its QR code) from the module and the page. */
export function clearSigninLink() {
  signin = null;
  stopSigninTimer();
  hideSigninQr();
  const input = el('security-signin-link');
  if (input) input.value = '';
  const box = el('security-signin-code');
  if (box) box.hidden = true;
}

export function renderSigninLink(now = Date.now()) {
  const box = el('security-signin-code');
  const input = el('security-signin-link');
  const expiry = el('security-signin-expiry');
  const button = el('security-signin-code-btn');
  if (button) {
    button.disabled = busy.has('signin');
    button.textContent = busy.has('signin') ? 'Making a link…' : (signin ? 'Make a new sign-in link' : 'Make a sign-in link');
  }
  if (!signin) {
    if (box) box.hidden = true;
    return;
  }
  const text = describeSigninExpiry(signin.expiresAt, now);
  if (!text) {
    clearSigninLink();
    if (expiry) expiry.textContent = '';
    showTransientRelayNotice('The sign-in link expired. Make a new one when you need it.');
    if (button) button.textContent = 'Make a sign-in link';
    return;
  }
  if (box) box.hidden = false;
  if (input && input.value !== signin.link) input.value = signin.link;
  if (expiry) expiry.textContent = text;
  // A relay that sent no matrix: the link only.
  const qrButton = el('security-signin-qr-btn');
  if (qrButton) qrButton.hidden = !signin.qr;
}

export async function makeSigninLink() {
  if (busy.has('signin')) return null;
  busy.add('signin');
  renderSigninLink();
  try {
    const payload = await apiFetchOrThrow('/api/auth/signin-codes', { method: 'POST', body: '{}' });
    const link = toText(payload?.link);
    if (!link) throw new Error('The relay sent no link.');
    // The relay revoked this browser's previous code: its QR code goes too.
    hideSigninQr();
    const qr = payload?.qr && typeof payload.qr === 'object' ? { size: payload.qr.size, bits: String(payload.qr.bits || '') } : null;
    signin = { link, expiresAt: payload.expiresAt, qr, madeAt: Date.now() };
    stopSigninTimer();
    signinTimer = setInterval(() => renderSigninLink(), SIGNIN_TICK_MS);
    signinTimer?.unref?.();
    return signin;
  } catch (error) {
    showTransientRelayNotice(error?.message || 'The sign-in link could not be made.');
    return null;
  } finally {
    busy.delete('signin');
    renderSigninLink();
  }
}

/**
 * A new sign-in with a sign-in link while this page shows one: the link is
 * used up (or another one was, and this one is better made anew), so the
 * link and its QR code leave the page.
 */
function noteSigninLinkUsed(notice) {
  if (!signin || toText(notice?.via) !== 'code') return;
  const at = Date.parse(toText(notice?.at));
  if (Number.isFinite(at) && at < signin.madeAt - 5_000) return;
  clearSigninLink();
  renderSigninLink();
  showTransientRelayNotice('A browser signed in with a sign-in link. Make a new link if you need another.');
}

// ─── Relay token ─────────────────────────────────────────────────────────────

export function renderOwnerToken(now = Date.now()) {
  if (tokenError) setStatus('security-token-status', 'error', tokenError);
  else if (!ownerToken) setStatus('security-token-status', '', 'Loading…');
  else {
    const { state, text } = describeOwnerToken(ownerToken, { pairedRelays, now });
    setStatus('security-token-status', state, text);
  }
  const button = el('security-rotate-btn');
  if (button) {
    button.disabled = busy.has('rotate');
    button.textContent = busy.has('rotate') ? 'Generating…' : 'Generate new relay token';
  }
  renderRecommendation();
}

function rotationRecommended() {
  return recommendations.some((entry) => toText(entry?.id) === ROTATE_RECOMMENDATION_ID);
}

/** 3b: the Security tab's dot and the token row's tag, while a new token is recommended. */
export function renderRecommendation() {
  const on = rotationRecommended();
  setSettingsTabDot('security', on, 'Recommended');
  const tag = el('security-token-recommended');
  if (tag) tag.hidden = !on;
}

async function loadOwnerToken() {
  try {
    const payload = await apiFetchOrThrow('/api/auth/owner-token');
    if (!payload) return;
    ownerToken = payload.ownerToken && typeof payload.ownerToken === 'object' ? payload.ownerToken : null;
    pairedRelays = Number(payload.pairedRelays) || 0;
    ownerTokenUseSince = toText(payload.lastNonBrowserUseSince) || null;
    tokenError = '';
  } catch (error) {
    tokenError = `Could not read the relay token's state: ${error?.message || 'unknown error'}`;
  }
}

/** "Generate new relay token": the confirmation first. */
export function openRotateConfirm() {
  const paired = pairedRelays > 0
    ? `<p>${pairedRelays === 1 ? 'The paired relay needs' : `The ${pairedRelays} paired relays need`} the new token; the next dialog says how.</p>`
    : '';
  openConfirmDialog({
    title: 'Generate new relay token',
    kind: 'security-rotate',
    bodyHtml: `<p>${escHtml(ROTATE_CONFIRM_TEXT)}</p>${paired}`,
    confirmLabel: 'Generate new relay token',
    danger: true,
    run: () => rotateOwnerToken(),
  });
}

function affectedRelaysHtml(relays) {
  if (!relays.length) return '<p class="security-affected-none">No paired relay uses this relay\'s token.</p>';
  const items = relays.map((relay) => {
    // Settings → Relays there, its "Add a relay" form open; the token is
    // pasted by hand (Copy), never carried in the address.
    const href = relaySettingsUrl(relay.url, 'relays', { addRelay: true });
    const name = toText(relay.name) || toText(relay.id);
    const open = href
      ? ` <a class="security-affected-open" href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">Open there</a>`
      : '';
    return `<li data-relay-id="${escHtml(toText(relay.id))}"><span class="security-affected-name">${escHtml(name)}</span>${open}<div class="security-affected-hint">${escHtml(rePairHint(name))}</div></li>`;
  }).join('');
  return `<p>These paired relays keep the old token until you give them the new one:</p>
    <ul class="security-affected-relays">${items}</ul>`;
}

/** Empties the token dialog's fields: on every way out of it. */
function wipeTokenFields() {
  for (const id of ['security-new-token', 'security-pairing-link']) {
    const input = el(id);
    if (input) input.value = '';
  }
}

/**
 * The one-time dialog, a form a password manager saves from (§13.2, 2a):
 * the relay's name as the username (in the layout, never seen), the token in
 * a password field with no `name` (a native submit would carry nothing), and
 * "Save in password manager" as the submit button. The submit is always
 * stopped and closes the dialog: the form leaving the page after a submit is
 * what makes Chrome and Firefox offer to save. The token and the pairing
 * link live in the fields only; the Copy buttons read them there.
 */
function openTokenDialog({ token, pairingLink, affectedRelays, lastNonBrowserUse = null }, { since = null } = {}) {
  const relays = Array.isArray(affectedRelays) ? affectedRelays.filter((relay) => relay && (relay.name || relay.id)) : [];
  openSummaryModal({
    title: 'New relay token',
    kind: TOKEN_DIALOG_KIND,
    bodyHtml: `
      <form id="security-token-form" class="security-token-dialog" method="post" action="#" autocomplete="on">
        <input id="security-token-user" class="credential-username" type="text" autocomplete="username" tabindex="-1" aria-hidden="true">
        <p><label for="security-new-token">Relay token</label></p>
        <div class="security-copy-row">
          <input id="security-new-token" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" aria-label="New relay token">
          <button id="security-show-token-btn" class="summary-btn" type="button" aria-pressed="false" aria-controls="security-new-token">Show</button>
          <button id="security-copy-token-btn" class="summary-btn" type="button">Copy</button>
        </div>
        <input id="security-pairing-link" type="text" readonly hidden tabindex="-1" aria-hidden="true">
        <p class="security-actions">
          <button id="security-save-token-btn" class="summary-btn" type="submit">Save in password manager</button>
          <button id="security-copy-pairing-btn" class="summary-btn" type="button">Copy pairing link</button>
        </p>
        <p class="security-token-once">${escHtml(TOKEN_SHOWN_ONCE_TEXT)}</p>
        <p class="security-token-last-use">${escHtml(describeLastNonBrowserUse(lastNonBrowserUse, since))}</p>
        ${affectedRelaysHtml(relays)}
        <p class="settings-help security-clipboard-hint">${escHtml(CLIPBOARD_HINT_TEXT)}</p>
        <div class="summary-modal-actions">
          <button id="security-token-done-btn" class="chat-title-action-btn" type="button">Done</button>
        </div>
      </form>
    `,
  });
  const form = el('security-token-form');
  // Bound before any value is set: the form never submits itself.
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    closeSummaryModal();
  });
  const tokenInput = el('security-new-token');
  const linkInput = el('security-pairing-link');
  const userInput = el('security-token-user');
  if (userInput) userInput.value = relayAccountName();
  // Kept only while the dialog is open: an edit of the field is put back
  // (not read-only: some password managers skip read-only fields).
  let shown = String(token || '');
  if (tokenInput) tokenInput.value = shown;
  if (linkInput) linkInput.value = String(pairingLink || '');
  tokenInput?.addEventListener('input', () => {
    if (shown && tokenInput.value !== shown) tokenInput.value = shown;
  });
  // Whichever way it closes (Done, Save, ×, the backdrop, Escape, Back,
  // another dialog): the fields are emptied before the modal drops its DOM.
  setSummaryModalLeaveHandler(TOKEN_DIALOG_KIND, () => {
    shown = '';
    wipeTokenFields();
  });
  const show = el('security-show-token-btn');
  show?.addEventListener('click', () => {
    const visible = tokenInput?.type === 'text';
    if (tokenInput) tokenInput.type = visible ? 'password' : 'text';
    show.textContent = visible ? 'Show' : 'Hide';
    show.setAttribute('aria-pressed', visible ? 'false' : 'true');
  });
  const copyToken = el('security-copy-token-btn');
  copyToken?.addEventListener('click', () => { void copyField(el('security-new-token'), copyToken, 'Copy'); });
  const copyLink = el('security-copy-pairing-btn');
  copyLink?.addEventListener('click', () => { void copyField(el('security-pairing-link'), copyLink, 'Copy pairing link'); });
  el('security-token-done-btn')?.addEventListener('click', () => closeSummaryModal());
  try { tokenInput?.focus(); tokenInput?.select(); } catch {}
}

/** The password manager's username for this relay's token: its name, else its address. */
export function relayAccountName(config = (typeof window !== 'undefined' ? window.__COPILOT_APP_CONFIG : null), host = (typeof window !== 'undefined' ? window.location?.host : '')) {
  const name = toText(config?.relayName);
  return name || `OAR (${toText(host) || 'relay'})`;
}

export async function rotateOwnerToken() {
  if (busy.has('rotate')) return false;
  busy.add('rotate');
  renderOwnerToken();
  let opened = false;
  try {
    const payload = await apiFetchOrThrow('/api/auth/owner-token/rotate', { method: 'POST', body: '{}' });
    if (!toText(payload?.token)) throw new Error('The relay sent no token.');
    openTokenDialog(payload, { since: ownerTokenUseSince });
    opened = true;
    if (ownerToken) ownerToken = { ...ownerToken, set: true, rotatedAt: payload.rotatedAt || new Date().toISOString(), legacyPlaintext: false };
  } catch (error) {
    closeSummaryModal();
    showTransientRelayNotice(error?.message || 'The new relay token could not be made; the current one still works.');
  } finally {
    busy.delete('rotate');
    renderOwnerToken();
  }
  if (opened) {
    void loadOwnerToken().then(() => renderOwnerToken());
    void refreshSecurityNotices();
  }
  return opened;
}

// ─── The section ─────────────────────────────────────────────────────────────

function bindControls() {
  if (controlsBound) return;
  const others = el('security-signout-others-btn');
  if (!others) return;
  controlsBound = true;
  others.addEventListener('click', () => confirmSignOutOthers());
  el('security-signout-self-btn')?.addEventListener('click', () => confirmSignOutThisBrowser());
  el('security-signin-code-btn')?.addEventListener('click', () => { void makeSigninLink(); });
  const copy = el('security-signin-copy-btn');
  copy?.addEventListener('click', () => { void copyField(el('security-signin-link'), copy, 'Copy'); });
  el('security-signin-qr-btn')?.addEventListener('click', () => toggleSigninQr());
  el('security-rotate-btn')?.addEventListener('click', () => openRotateConfirm());
}

export function renderSecuritySection() {
  bindControls();
  renderBrowserSessions();
  renderSigninLink();
  renderOwnerToken();
}

/** Called when Settings opens and when the Security tab comes into view. */
export async function refreshSecuritySection() {
  if (IS_SHARED_VIEW) return;
  renderSecuritySection();
  await Promise.all([loadBrowserSessions(), loadOwnerToken()]);
  renderSecuritySection();
}

// ─── Notices banner ──────────────────────────────────────────────────────────

function noticeButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `relay-toast-action ${className}`;
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    void onClick();
  });
  return button;
}

/** Opens Settings → Security and its "Generate new relay token" confirmation. */
export async function openRotateFromNotice() {
  if (typeof window !== 'undefined' && typeof window.openSettingsModal === 'function') window.openSettingsModal('security');
  openRotateConfirm();
}

function signinOutcomeSuffix(notice) {
  const outcome = signinOutcomes.get(notice.id) || (notice.signedOut === true ? 'gone' : '');
  return { outcome, suffix: outcome === 'done' ? ' (signed out)' : (outcome === 'gone' ? ' (already signed out)' : '') };
}

// "Sign it out" for one new sign-in while it is signed in (or on its way out).
function signinSignOutButton(notice, outcome) {
  if (outcome && outcome !== 'busy') return null;
  const out = noticeButton(outcome === 'busy' ? 'Signing out…' : 'Sign it out', 'security-signin-signout', () => signOutFromNotice(notice));
  out.disabled = outcome === 'busy';
  return out;
}

// The new sign-ins are ONE row of the banner, whatever their number, so the
// banner never grows with them: the newest (or "N new browsers signed in
// (latest: …)"), "Show all" for the list, and one "Got it" that dismisses
// all of them for this browser. A single one has its "Sign it out" on the
// row; several have theirs in the list, which lies over the transcript in a
// bounded box (CSS) instead of pushing it down.
function buildSigninSummary(list) {
  const row = document.createElement('div');
  row.className = 'security-notice-row security-signin-notice';
  row.dataset.count = String(list.length);
  row.dataset.via = toText(list[0].via);
  if (list.length === 1) row.dataset.noticeId = toText(list[0].id);
  const text = document.createElement('span');
  text.className = 'security-notice-text';
  const single = list.length === 1 ? signinOutcomeSuffix(list[0]) : null;
  text.textContent = `${describeSigninSummary(list)}${single ? single.suffix : ''}`;
  text.title = list.length === 1 && toText(list[0].userAgent) ? toText(list[0].userAgent) : text.textContent;
  row.append(text);
  if (single) {
    const out = signinSignOutButton(list[0], single.outcome);
    if (out) row.append(out);
  } else {
    const toggle = noticeButton(signinsExpanded ? 'Hide' : 'Show all', 'security-signin-toggle', () => {
      signinsExpanded = !signinsExpanded;
      renderSecurityNotices();
      if (typeof document !== 'undefined') document.querySelector('#security-notice-banner .security-signin-toggle')?.focus?.();
    });
    toggle.setAttribute('aria-expanded', signinsExpanded ? 'true' : 'false');
    toggle.setAttribute('aria-controls', 'security-signin-list');
    row.append(toggle);
  }
  const dismissible = list.filter((notice) => notice.dismissible !== false);
  if (dismissible.length > 0) {
    const gotIt = noticeButton('Got it', 'security-notice-dismiss', () => dismissSignins(dismissible.map((notice) => notice.id)));
    gotIt.setAttribute('aria-label', list.length === 1 ? 'Dismiss this notice' : `Dismiss these ${list.length} notices`);
    row.append(gotIt);
  }
  return row;
}

// The expanded list of several new sign-ins, one entry each.
function buildSigninList(list) {
  const box = document.createElement('ul');
  box.id = 'security-signin-list';
  box.className = 'security-signin-list';
  box.setAttribute('aria-label', 'New sign-ins');
  for (const notice of list) {
    const entry = document.createElement('li');
    entry.className = 'security-signin-entry';
    entry.dataset.noticeId = toText(notice.id);
    entry.dataset.via = toText(notice.via);
    const { outcome, suffix } = signinOutcomeSuffix(notice);
    const text = document.createElement('span');
    text.className = 'security-notice-text';
    text.textContent = `${describeSigninEntry(notice)}${suffix}`;
    text.title = [toText(notice.userAgent), notice.at ? formatSecurityTimestamp(notice.at) : ''].filter(Boolean).join('\n');
    entry.append(text);
    const out = signinSignOutButton(notice, outcome);
    if (out) entry.append(out);
    box.append(entry);
  }
  return box;
}

export function renderSecurityNotices(now = Date.now()) {
  const banner = el('security-notice-banner');
  if (!banner) return;
  const rows = notices.map((notice) => {
    const row = document.createElement('div');
    row.className = 'security-notice-row';
    row.dataset.noticeId = toText(notice.id);
    const text = document.createElement('span');
    text.className = 'security-notice-text';
    text.textContent = securityNoticeText(notice, now);
    row.append(text);
    if (toText(notice.action) === 'rotate' || notice.id === SECURITY_NOTICE_IDS.rotateAfterUpgrade) {
      row.append(noticeButton('Generate new token', 'security-notice-rotate', openRotateFromNotice));
    }
    const dismiss = noticeButton('Dismiss', 'security-notice-dismiss', () => dismissSecurityNotice(notice.id));
    dismiss.setAttribute('aria-label', 'Dismiss this notice');
    row.append(dismiss);
    return row;
  });
  if (signins.length < 2) signinsExpanded = false;
  if (signins.length > 0) {
    rows.push(buildSigninSummary(signins));
    if (signinsExpanded) rows.push(buildSigninList(signins));
  }
  banner.replaceChildren(...rows);
  banner.classList.toggle('visible', rows.length > 0);
  banner.hidden = rows.length === 0;
}

function validSignins(list) {
  return (Array.isArray(list) ? list : []).filter((notice) => notice && toText(notice.id).startsWith('signin-'));
}

// The answer's sign-ins, with those the socket brought after the request
// went out (`sentAt`: signinArrivalSeq then) that the answer does not know
// of yet, newest first.
function withLaterArrivals(list, sentAt) {
  if (!Number.isFinite(sentAt)) return list;
  const known = new Set(list.map((notice) => notice.id));
  const later = [...signinArrivals.values()]
    .filter((entry) => entry.seq > sentAt && !known.has(entry.notice.id))
    .sort((a, b) => b.seq - a.seq)
    .map((entry) => entry.notice);
  return later.length ? [...later, ...list] : list;
}

function forgetArrivals(ids) {
  for (const id of ids) signinArrivals.delete(id);
}

function noteDismissed(ids) {
  for (const id of ids) {
    if (!id.startsWith('signin-')) continue;
    dismissedSignins.delete(id);
    dismissedSignins.add(id);
  }
  while (dismissedSignins.size > DISMISSED_SIGNINS_MAX) dismissedSignins.delete(dismissedSignins.values().next().value);
}

function undoDismissed(ids) {
  for (const id of ids) dismissedSignins.delete(id);
}

function notDismissed(list) {
  return dismissedSignins.size ? list.filter((notice) => !dismissedSignins.has(notice.id)) : list;
}

// What GET /api/auth/notices and a dismissal answer: every part it carries.
// `sentAt`: signinArrivalSeq when the request went out.
function applyNoticesPayload(payload, { sentAt = null } = {}) {
  if (!payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload.notices)) notices = payload.notices.filter((notice) => notice && toText(notice.id));
  if (Array.isArray(payload.signins)) signins = notDismissed(withLaterArrivals(validSignins(payload.signins), sentAt));
  if (Array.isArray(payload.recommendations)) recommendations = payload.recommendations.filter((entry) => entry && toText(entry.id));
  renderSecurityNotices();
  renderRecommendation();
  return true;
}

export async function refreshSecurityNotices() {
  if (IS_SHARED_VIEW) return [];
  const sentAt = signinArrivalSeq;
  const payload = await apiFetch('/api/auth/notices');
  if (payload && Array.isArray(payload.notices)) applyNoticesPayload(payload, { sentAt });
  return notices;
}

export async function dismissSecurityNotice(id) {
  const previous = { notices, signins };
  notices = notices.filter((notice) => notice.id !== id);
  signins = signins.filter((notice) => notice.id !== id);
  forgetArrivals([id]);
  noteDismissed([id]);
  renderSecurityNotices();
  const sentAt = signinArrivalSeq;
  const payload = await apiFetch(`/api/auth/notices/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' });
  if (!payload) {
    undoDismissed([id]);
    notices = previous.notices;
    signins = notDismissed(withLaterArrivals(previous.signins, sentAt));
    renderSecurityNotices();
    showTransientRelayNotice('The notice could not be dismissed. Try again.');
    return false;
  }
  applyNoticesPayload(payload, { sentAt });
  signinOutcomes.delete(id);
  return true;
}

/** "Got it" on the sign-in row: these notices, for this browser only, in one call. */
export async function dismissSignins(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(toText).filter((id) => id.startsWith('signin-')));
  if (wanted.size === 0) return false;
  const previous = signins;
  signins = signins.filter((notice) => !wanted.has(notice.id));
  signinsExpanded = false;
  forgetArrivals(wanted);
  noteDismissed(wanted);
  renderSecurityNotices();
  const sentAt = signinArrivalSeq;
  const payload = await apiFetch('/api/auth/notices/dismiss-signins', { method: 'POST', body: JSON.stringify({ ids: [...wanted] }) });
  if (!payload) {
    // Back as they were, after any that arrived meanwhile (newest first);
    // those dismissed here since stay off.
    undoDismissed(wanted);
    const kept = new Set(previous.map((notice) => notice.id));
    signins = notDismissed([...signins.filter((notice) => !kept.has(notice.id)), ...previous]);
    renderSecurityNotices();
    showTransientRelayNotice('The notices could not be dismissed. Try again.');
    return false;
  }
  // An answer made before a new sign-in arrived here keeps that sign-in.
  applyNoticesPayload(payload, { sentAt });
  for (const id of wanted) signinOutcomes.delete(id);
  return true;
}

/**
 * "Sign it out" on a new sign-in's row: that browser session ends at once.
 * One that is gone already says so.
 */
export async function signOutFromNotice(notice) {
  const id = toText(notice?.id);
  const sessionId = toText(notice?.sessionId);
  if (!id || !sessionId || signinOutcomes.get(id) === 'busy') return null;
  signinOutcomes.set(id, 'busy');
  renderSecurityNotices();
  let status = 0;
  const payload = await apiFetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    onErrorResponse: async (res) => { status = Number(res?.status) || 0; },
  });
  if (payload?.current === true) {
    // It was this very browser (signed in again here, say): its outbox goes
    // too, as with "Sign out this browser". Another browser's leaves it.
    void clearOutbox().catch(() => {});
    reportSignedOut(SELF_SIGNED_OUT_MESSAGE);
    return payload;
  }
  if (payload) {
    signinOutcomes.set(id, 'done');
    sessions = sessions.filter((row) => row.id !== sessionId);
    showTransientRelayNotice(signedOutNotice(toText(notice.label) || 'the browser', payload.effects));
  } else if (status === 404) {
    signinOutcomes.set(id, 'gone');
    showTransientRelayNotice(`${toText(notice.label) || 'That browser'} was already signed out.`);
  } else {
    signinOutcomes.delete(id);
    showTransientRelayNotice('The browser could not be signed out. Try again.');
  }
  renderSecurityNotices();
  renderBrowserSessions();
  return payload;
}

/** Socket `auth_new_signin` `{ notice }`: a browser signed in just now. */
export function noteNewSignIn(payload) {
  if (IS_SHARED_VIEW) return false;
  const notice = payload?.notice && typeof payload.notice === 'object' ? payload.notice : null;
  if (!notice || !toText(notice.id).startsWith('signin-')) return false;
  signinArrivalSeq += 1;
  signinArrivals.delete(notice.id);
  signinArrivals.set(notice.id, { seq: signinArrivalSeq, notice });
  while (signinArrivals.size > SIGNIN_ARRIVALS_MAX) signinArrivals.delete(signinArrivals.keys().next().value);
  signins = [notice, ...signins.filter((entry) => entry.id !== notice.id)];
  renderSecurityNotices();
  noteSigninLinkUsed(notice);
  // The list in Settings → Security gains the new browser.
  if (sessionsLoaded && el('settings-panel-security')?.hidden === false) {
    void loadBrowserSessions().then(() => renderBrowserSessions());
  }
  return true;
}

/** After the app started (bootstrap): the person's page only. */
export async function startSecurityNotices() {
  if (IS_SHARED_VIEW) return [];
  return refreshSecurityNotices();
}

/** Signed out: the banner goes with the app. */
export function hideSecurityNotices() {
  notices = [];
  signins = [];
  signinArrivals.clear();
  dismissedSignins.clear();
  signinsExpanded = false;
  recommendations = [];
  signinOutcomes.clear();
  renderSecurityNotices();
  renderRecommendation();
  clearSigninLink();
}

/** Test hook. */
export function resetSecuritySettingsForTests() {
  sessions = [];
  sessionsLoaded = false;
  sessionsError = '';
  ownerToken = null;
  pairedRelays = 0;
  tokenError = '';
  clearSigninLink();
  busy.clear();
  notices = [];
  signins = [];
  signinArrivals.clear();
  dismissedSignins.clear();
  signinsExpanded = false;
  recommendations = [];
  signinOutcomes.clear();
  ownerTokenUseSince = null;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(SETTINGS_TAB_SHOWN_EVENT, (event) => {
    // The QR code is up only while Security is on screen.
    if (event?.detail?.tab !== 'security') {
      hideSigninQr();
      return;
    }
    void refreshSecuritySection();
  });
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // Another tab, another app, the screen off: the QR code goes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hideSigninQr();
  });
}
