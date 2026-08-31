// Grok account management inside Settings → Providers → Grok.
//
// The relay drives the CLI's device-code flow: Sign in starts `grok login
// --device-auth` on the host, the authorize URL shows up here (openable on a
// phone — that is the point of the relay), and the CLI polls x.ai and finishes
// on its own. Nothing is ever pasted back, so this is the Claude flow minus a
// whole state: idle → starting → awaiting_authorization → success | error.
//
// Every visible state comes from the `grok_auth_state` socket broadcast (same
// payload as GET /api/grok/auth/status), so the flow survives closing the
// modal, switching tabs, or being finished from a different device. Rendering
// is therefore idempotent: it reads the latest payload and never assumes a
// local step sequence — success in particular arrives twice, once off the
// cached status and once when the confirming read lands.
//
// Secret hygiene: nothing secret transits the relay. The `user_code` is a
// public device code, shown only so it can be checked against what the browser
// displays, and the token is written by the CLI straight into ~/.grok/auth.json.

import {
  escHtml,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLoading,
  showTransientRelayNotice,
} from './store.js';
import { copyTextToClipboard } from './router.js';
import {
  getGrokAuthStatus,
  startGrokLogin,
  cancelGrokLogin,
  grokLogout,
} from './api-client.js';

const LOGIN_STATES = ['idle', 'starting', 'awaiting_authorization', 'success', 'error'];
// States where a login session owns the CLI: Sign in/Sign out stay disabled.
const BUSY_LOGIN_STATES = ['starting', 'awaiting_authorization'];
const SUCCESS_COLLAPSE_MS = 2500;
const COPY_RESET_MS = 1500;

let authState = null;
let lastLoginState = 'idle';
let successCollapsed = false;
let successCollapseTimer = null;
// Client-side failures (request rejected before any broadcast) shown in the
// login area; cleared by the next real state transition.
let localError = '';
let signInInFlight = false;
let cancelInFlight = false;
let logoutInFlight = false;
// Bumped by every request that changes the login state on the host. A status
// read that started before one of them captured the previous login snapshot,
// and applying it would rewind the panel — the chat "Sign in to Grok" CTA
// deliberately opens the settings modal (which refreshes) and starts a login in
// the same tick, so this ordering is routine rather than exotic.
let loginRequestSeq = 0;

function normalizeLoginState(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return LOGIN_STATES.includes(value) ? value : 'idle';
}

function currentLoginState() {
  return normalizeLoginState(authState?.login?.state);
}

function isLoginBusy() {
  return BUSY_LOGIN_STATES.includes(currentLoginState());
}

/**
 * `status.plan` is a billing *product* name ("GrokBuild"), often null, and
 * nothing the relay can read exposes the subscription tier — so the row is
 * composed from whatever of plan/usage/period actually arrived and falls back
 * to a bare "Signed in" rather than inventing a label.
 */
export function grokAccountLineText(status) {
  if (!status) return 'Grok account status unavailable.';
  // Before the first read the payload is a frozen placeholder with every key
  // present; "never looked" is not the same as "signed out".
  if (!status.checkedAt) return 'Checking the Grok account…';
  if (status.loggedIn !== true) {
    const error = String(status.error || '').trim();
    return error ? `Not signed in — ${error}` : 'Not signed in';
  }
  const parts = [];
  const plan = String(status.plan || '').trim();
  if (plan) parts.push(plan);
  // Number(null) is 0, which would render an absent quota as "0% used"; exactly
  // 0% is real data and must still show.
  const usage = status.usagePercent == null ? NaN : Number(status.usagePercent);
  if (Number.isFinite(usage)) {
    const period = String(status.periodType || '').trim();
    parts.push(`${Math.round(usage)}% of ${period ? `${period} ` : ''}quota used`);
  }
  const line = parts.length ? parts.join(' · ') : 'Signed in';
  // An elapsed expiry is not a logged-out verdict: the CLI refreshes the token
  // in place, so it is a hint that the next turn may ask for a new sign-in.
  return status.expired === true ? `${line} · token expired, may need a new sign-in` : line;
}

export function grokAccountLineState(status) {
  if (!status) return 'error';
  if (!status.checkedAt) return 'pending';
  if (status.loggedIn === true) return 'active';
  return String(status.error || '').trim() ? 'error' : 'unconfigured';
}

export function grokLoginStatusText(login, status) {
  const state = normalizeLoginState(login?.state);
  if (localError && (state === 'idle' || state === 'error')) return localError;
  switch (state) {
    case 'starting':
      return 'Starting the Grok sign-in on the relay host…';
    case 'awaiting_authorization':
      return 'Open the link below (a phone works), confirm the code, and this panel flips by itself.';
    case 'success': {
      const plan = String(status?.plan || '').trim();
      return plan ? `Signed in to Grok (${plan}).` : 'Signed in to Grok.';
    }
    case 'error':
      return String(login?.error || '').trim() || 'Sign-in failed. Press Sign in to try again.';
    default:
      return '';
  }
}

export function grokLoginStatusState(login) {
  const state = normalizeLoginState(login?.state);
  if (state === 'success') return 'active';
  if (state === 'error' || (localError && state === 'idle')) return 'error';
  return 'pending';
}

function setHidden(element, hidden) {
  if (element) element.hidden = !!hidden;
}

function setDisabled(element, disabled) {
  if (element) element.disabled = !!disabled;
}

function clearSuccessCollapseTimer() {
  if (successCollapseTimer === null) return;
  clearTimeout(successCollapseTimer);
  successCollapseTimer = null;
}

export function renderGrokAuthSection() {
  const section = document.getElementById('grok-auth-section');
  if (!section) return;
  const status = authState?.status || null;
  const login = authState?.login || {};
  const state = normalizeLoginState(login.state);

  const account = document.getElementById('grok-auth-account');
  if (account) {
    account.textContent = grokAccountLineText(status);
    account.dataset.state = grokAccountLineState(status);
  }

  const busy = BUSY_LOGIN_STATES.includes(state);
  setDisabled(document.getElementById('grok-auth-signin-btn'), busy || signInInFlight);
  setDisabled(
    document.getElementById('grok-auth-logout-btn'),
    busy || logoutInFlight || status?.loggedIn !== true,
  );

  // The success line lingers for a beat and then the whole area folds away;
  // `successCollapsed` keeps a later re-render (the second success broadcast,
  // or any sticky payload) from popping it back open.
  const areaVisible = (state !== 'idle' && !(state === 'success' && successCollapsed))
    || (!!localError && state === 'idle');
  setHidden(document.getElementById('grok-auth-login-area'), !areaVisible);

  const loginStatus = document.getElementById('grok-auth-login-status');
  if (loginStatus) {
    loginStatus.textContent = grokLoginStatusText(login, status);
    loginStatus.dataset.state = grokLoginStatusState(login);
  }

  const authUrl = String(login.authUrl || '').trim();
  const showUrl = state === 'awaiting_authorization' && !!authUrl;
  setHidden(document.getElementById('grok-auth-url-row'), !showUrl);
  const link = document.getElementById('grok-auth-url-link');
  if (link) {
    link.href = showUrl ? authUrl : '#';
    link.textContent = showUrl ? authUrl : 'Open the Grok sign-in page';
  }

  // Display only: the code rides in the URL already, and is shown so it can be
  // checked against what the browser puts on screen before confirming.
  const userCode = String(login.userCode || '').trim();
  const showCode = state === 'awaiting_authorization' && !!userCode;
  setHidden(document.getElementById('grok-auth-code-row'), !showCode);
  const codeEl = document.getElementById('grok-auth-user-code');
  if (codeEl) codeEl.textContent = showCode ? userCode : '';

  // Cancel while the CLI holds a session, Dismiss to clear a failed one — the
  // same route serves both, and it is kept out of the code row so a scrape that
  // never found the code still leaves the session cancellable.
  const showCancel = busy || state === 'error';
  setHidden(document.getElementById('grok-auth-actions-row'), !showCancel);
  const cancelButton = document.getElementById('grok-auth-cancel-btn');
  if (cancelButton) cancelButton.textContent = state === 'error' ? 'Dismiss' : 'Cancel';
  setDisabled(cancelButton, cancelInFlight);

  if (state === 'success' && !successCollapsed && successCollapseTimer === null) {
    successCollapseTimer = setTimeout(() => {
      successCollapseTimer = null;
      successCollapsed = true;
      renderGrokAuthSection();
    }, SUCCESS_COLLAPSE_MS);
  }
}

// Single entry point for every payload (GET response, POST response, socket
// broadcast). Transitions — not local expectations — reset the transient bits.
// Within one login session (same startedAt) states only ever move forward.
// Terminal outcomes share the top rank so neither can clobber the other.
const LOGIN_STATE_RANK = { starting: 1, awaiting_authorization: 2, success: 3, error: 3 };

function isStaleLoginPayload(currentLogin, incomingLogin, incomingState) {
  const currentRank = LOGIN_STATE_RANK[normalizeLoginState(currentLogin?.state)] || 0;
  const incomingRank = LOGIN_STATE_RANK[incomingState] || 0;
  if (!currentRank || !incomingRank) return false;
  if (!currentLogin?.startedAt || currentLogin.startedAt !== incomingLogin?.startedAt) return false;
  return incomingRank < currentRank;
}

export function applyGrokAuthState(payload) {
  if (!payload || typeof payload !== 'object') return authState;
  const login = payload.login && typeof payload.login === 'object' ? payload.login : {};
  const nextState = normalizeLoginState(login.state);
  // A socket broadcast can outrun the HTTP response that triggered it (the
  // awaiting_authorization push with the device URL lands before POST
  // login/start returns its "starting" snapshot). Never let the older snapshot
  // regress the UI.
  if (isStaleLoginPayload(authState?.login, login, nextState)) return authState;
  authState = {
    status: payload.status && typeof payload.status === 'object' ? payload.status : null,
    login: { ...login, state: nextState },
    runningGrokWorkers: Number(payload.runningGrokWorkers || 0) || 0,
  };
  if (nextState !== lastLoginState) {
    lastLoginState = nextState;
    localError = '';
    clearSuccessCollapseTimer();
    successCollapsed = false;
    // The relay re-emits `success` once the confirming status read lands, but a
    // client whose socket is asleep would otherwise sit on the cached (still
    // signed-out) account line.
    if (nextState === 'success') void refreshGrokAuthSection();
  }
  renderGrokAuthSection();
  return authState;
}

export async function refreshGrokAuthSection() {
  const seq = loginRequestSeq;
  const payload = await getGrokAuthStatus();
  if (!payload) {
    const account = document.getElementById('grok-auth-account');
    if (account) {
      account.textContent = 'Unable to load the Grok account status.';
      account.dataset.state = 'error';
    }
    return null;
  }
  // A login or cancel issued while this read was in flight already produced a
  // newer login state: take the account half and leave the login half alone.
  if (seq !== loginRequestSeq) return applyGrokAuthState({ ...payload, login: authState?.login || {} });
  return applyGrokAuthState(payload);
}

export async function startGrokSignIn() {
  if (signInInFlight || isLoginBusy()) return;
  signInInFlight = true;
  loginRequestSeq += 1;
  localError = '';
  renderGrokAuthSection();
  try {
    applyGrokAuthState(await startGrokLogin());
  } catch (error) {
    localError = String(error?.message || 'Failed to start the Grok sign-in.');
  } finally {
    signInInFlight = false;
    renderGrokAuthSection();
  }
}

export async function cancelGrokSignIn() {
  if (cancelInFlight) return;
  cancelInFlight = true;
  loginRequestSeq += 1;
  renderGrokAuthSection();
  try {
    applyGrokAuthState(await cancelGrokLogin());
  } catch (error) {
    localError = String(error?.message || 'Failed to cancel the Grok sign-in.');
    await refreshGrokAuthSection().catch(() => {});
  } finally {
    cancelInFlight = false;
    renderGrokAuthSection();
  }
}

export async function copyGrokLoginUrl() {
  const url = String(authState?.login?.authUrl || '').trim();
  if (!url) return;
  let copied = false;
  try {
    copied = await copyTextToClipboard(url);
  } catch {
    copied = false;
  }
  const button = document.getElementById('grok-auth-copy-btn');
  if (button) {
    button.textContent = copied ? '✓ Copied' : 'Copy failed';
    clearTimeout(button.__grokAuthCopyTimer);
    button.__grokAuthCopyTimer = setTimeout(() => {
      button.textContent = 'Copy link';
    }, COPY_RESET_MS);
  }
  // Without a clipboard (plain http on some browsers) at least surface the URL.
  if (!copied) showTransientRelayNotice(url, 10000);
}

export async function openGrokLogoutConfirmation() {
  if (logoutInFlight) return;
  // Fresh read: the worker count in the warning must not be a stale number.
  let payload = null;
  try {
    payload = await getGrokAuthStatus();
  } catch {
    payload = null;
  }
  if (payload) applyGrokAuthState(payload);
  const status = authState?.status || null;
  if (isLoginBusy()) {
    showTransientRelayNotice('Finish or cancel the Grok sign-in in progress first.');
    return;
  }
  if (status?.loggedIn !== true) {
    showTransientRelayNotice('No Grok account is signed in on the relay host.');
    return;
  }
  const account = String(status.plan || '').trim() || 'this Grok account';
  const workers = Number(authState?.runningGrokWorkers || 0) || 0;
  const workerNote = workers > 0
    ? `${workers} Grok worker${workers === 1 ? '' : 's'} ${workers === 1 ? 'is' : 'are'} currently running; `
      + 'they keep their sessions, but new Grok turns will fail until you sign in again.'
    : 'No Grok workers are running right now; new Grok turns will fail until you sign in again.';
  openSummaryModal({
    title: 'Sign out of Grok',
    subtitle: account,
    kind: 'grok-logout',
    bodyHtml: `
      <p>Sign out of <strong>${escHtml(account)}</strong> on the relay host?</p>
      <p>${escHtml(workerNote)}</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmGrokLogout()">Sign out</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export async function confirmGrokLogout() {
  if (logoutInFlight) return;
  logoutInFlight = true;
  setSummaryModalLoading(true);
  try {
    const payload = await grokLogout();
    closeSummaryModal();
    applyGrokAuthState(payload);
    showTransientRelayNotice('Signed out of Grok on the relay host.');
  } catch (error) {
    closeSummaryModal();
    alert(error?.message || 'Failed to sign out of Grok.');
    await refreshGrokAuthSection().catch(() => {});
  } finally {
    logoutInFlight = false;
    setSummaryModalLoading(false);
    renderGrokAuthSection();
  }
}
