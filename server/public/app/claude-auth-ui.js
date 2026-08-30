// Claude account management inside Settings → Providers → Claude.
//
// The relay drives the CLI's OAuth flow: Relogin starts a login session on the
// host, the authorize URL shows up here (openable on a phone — that is the
// point of the relay), and the code the user pastes back completes it.
//
// Every visible state comes from the `claude_auth_state` socket broadcast (same
// payload as GET /api/claude/auth/status), so the flow survives closing the
// modal, switching tabs, or being finished from a different device. Rendering
// is therefore idempotent: it reads the latest payload and never assumes a
// local step sequence.
//
// Secret hygiene: the pasted code is read from the input, sent once, and
// immediately cleared. It is never stored, logged, or put in a broadcast.

import {
  escHtml,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLoading,
  showTransientRelayNotice,
} from './store.js';
import { copyTextToClipboard } from './router.js';
import {
  getClaudeAuthStatus,
  startClaudeLogin,
  submitClaudeLoginCode,
  cancelClaudeLogin,
  claudeLogout,
} from './api-client.js';

const LOGIN_STATES = ['idle', 'starting', 'awaiting_code', 'exchanging', 'success', 'error'];
// States where a login session owns the CLI: Relogin/Logout stay disabled.
const BUSY_LOGIN_STATES = ['starting', 'awaiting_code', 'exchanging'];
const SUCCESS_COLLAPSE_MS = 2500;
const COPY_RESET_MS = 1500;

const PLAN_LABELS = {
  max: 'Max plan',
  pro: 'Pro plan',
  team: 'Team plan',
  enterprise: 'Enterprise plan',
  free: 'Free plan',
};

let authState = null;
let lastLoginState = 'idle';
let successCollapsed = false;
let successCollapseTimer = null;
// Client-side failures (request rejected before any broadcast) shown in the
// login area; cleared by the next real state transition.
let localError = '';
let reloginInFlight = false;
let submitInFlight = false;
let cancelInFlight = false;
let logoutInFlight = false;

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

function planLabel(status) {
  const subscription = String(status?.subscriptionType || '').trim().toLowerCase();
  if (subscription) {
    return PLAN_LABELS[subscription]
      || `${subscription.charAt(0).toUpperCase()}${subscription.slice(1)} plan`;
  }
  return String(status?.authMethod || '').trim();
}

function accountLineText(status) {
  if (!status) return 'Claude account status unavailable.';
  if (status.loggedIn !== true) {
    const error = String(status.error || '').trim();
    return error ? `Not logged in — ${error}` : 'Not logged in';
  }
  const email = String(status.email || '').trim() || 'unknown account';
  const plan = planLabel(status);
  return plan ? `Account: ${email} · ${plan}` : `Account: ${email}`;
}

function accountLineState(status) {
  if (!status) return 'error';
  if (status.loggedIn === true) return 'active';
  return String(status.error || '').trim() ? 'error' : 'unconfigured';
}

function loginStatusText(login, status) {
  const state = normalizeLoginState(login?.state);
  if (localError && (state === 'idle' || state === 'error')) return localError;
  switch (state) {
    case 'starting':
      return 'Starting login on the relay host…';
    case 'awaiting_code':
      return 'Open the login link, authorize on claude.ai, then paste the code below.';
    case 'exchanging':
      return 'Completing login… this takes a few seconds.';
    case 'success': {
      const email = String(status?.email || '').trim();
      return email ? `Logged in as ${email}.` : 'Logged in.';
    }
    case 'error':
      return String(login?.error || '').trim() || 'Login failed. Press Relogin to try again.';
    default:
      return '';
  }
}

function loginStatusState(login) {
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

function clearCodeInput() {
  const input = document.getElementById('claude-auth-code-input');
  if (input) input.value = '';
}

export function renderClaudeAuthSection() {
  const section = document.getElementById('claude-auth-section');
  if (!section) return;
  const status = authState?.status || null;
  const login = authState?.login || {};
  const state = normalizeLoginState(login.state);

  const account = document.getElementById('claude-auth-account');
  if (account) {
    account.textContent = accountLineText(status);
    account.dataset.state = accountLineState(status);
  }

  const busy = BUSY_LOGIN_STATES.includes(state);
  setDisabled(document.getElementById('claude-auth-relogin-btn'), busy || reloginInFlight);
  setDisabled(
    document.getElementById('claude-auth-logout-btn'),
    busy || logoutInFlight || status?.loggedIn !== true,
  );

  // The success line lingers for a beat and then the whole area folds away;
  // `successCollapsed` keeps a later re-render (same sticky payload) from
  // popping it back open.
  const areaVisible = (state !== 'idle' && !(state === 'success' && successCollapsed))
    || (!!localError && state === 'idle');
  setHidden(document.getElementById('claude-auth-login-area'), !areaVisible);

  const loginStatus = document.getElementById('claude-auth-login-status');
  if (loginStatus) {
    loginStatus.textContent = loginStatusText(login, status);
    loginStatus.dataset.state = loginStatusState(login);
  }

  const authUrl = String(login.authUrl || '').trim();
  const showUrl = state === 'awaiting_code' && !!authUrl;
  setHidden(document.getElementById('claude-auth-url-row'), !showUrl);
  const link = document.getElementById('claude-auth-url-link');
  if (link) {
    link.href = showUrl ? authUrl : '#';
    link.textContent = showUrl ? authUrl : 'Open the Claude login page';
  }

  const showCode = state === 'awaiting_code' || state === 'exchanging';
  setHidden(document.getElementById('claude-auth-code-row'), !showCode);
  const codeBusy = state === 'exchanging' || submitInFlight;
  setDisabled(document.getElementById('claude-auth-code-input'), codeBusy);
  setDisabled(document.getElementById('claude-auth-submit-btn'), codeBusy);
  setDisabled(document.getElementById('claude-auth-cancel-btn'), cancelInFlight);

  if (state === 'success' && !successCollapsed && successCollapseTimer === null) {
    successCollapseTimer = setTimeout(() => {
      successCollapseTimer = null;
      successCollapsed = true;
      renderClaudeAuthSection();
    }, SUCCESS_COLLAPSE_MS);
  }
}

// Single entry point for every payload (GET response, POST response, socket
// broadcast). Transitions — not local expectations — reset the transient bits.
// Within one login session (same startedAt) states only ever move forward.
// Terminal outcomes share the top rank so neither can clobber the other.
const LOGIN_STATE_RANK = { starting: 1, awaiting_code: 2, exchanging: 3, success: 4, error: 4 };

function isStaleLoginPayload(currentLogin, incomingLogin, incomingState) {
  const currentRank = LOGIN_STATE_RANK[normalizeLoginState(currentLogin?.state)] || 0;
  const incomingRank = LOGIN_STATE_RANK[incomingState] || 0;
  if (!currentRank || !incomingRank) return false;
  if (!currentLogin?.startedAt || currentLogin.startedAt !== incomingLogin?.startedAt) return false;
  return incomingRank < currentRank;
}

export function applyClaudeAuthState(payload) {
  if (!payload || typeof payload !== 'object') return authState;
  const login = payload.login && typeof payload.login === 'object' ? payload.login : {};
  const nextState = normalizeLoginState(login.state);
  // A socket broadcast can outrun the HTTP response that triggered it (e.g. the
  // awaiting_code push with the auth URL lands before POST login/start returns
  // its "starting" snapshot). Never let the older snapshot regress the UI.
  if (isStaleLoginPayload(authState?.login, login, nextState)) return authState;
  authState = {
    status: payload.status && typeof payload.status === 'object' ? payload.status : null,
    login: { ...login, state: nextState },
    runningClaudeWorkers: Number(payload.runningClaudeWorkers || 0) || 0,
  };
  if (nextState !== lastLoginState) {
    lastLoginState = nextState;
    localError = '';
    clearSuccessCollapseTimer();
    successCollapsed = false;
    if (nextState !== 'awaiting_code' && nextState !== 'exchanging') clearCodeInput();
    // A fresh login rewrote the host credentials: pull the new account line.
    if (nextState === 'success') void refreshClaudeAuthSection();
  }
  renderClaudeAuthSection();
  return authState;
}

export async function refreshClaudeAuthSection() {
  const payload = await getClaudeAuthStatus();
  if (!payload) {
    const account = document.getElementById('claude-auth-account');
    if (account) {
      account.textContent = 'Unable to load the Claude account status.';
      account.dataset.state = 'error';
    }
    return null;
  }
  return applyClaudeAuthState(payload);
}

export async function startClaudeRelogin() {
  if (reloginInFlight || isLoginBusy()) return;
  reloginInFlight = true;
  localError = '';
  renderClaudeAuthSection();
  try {
    applyClaudeAuthState(await startClaudeLogin());
  } catch (error) {
    localError = String(error?.message || 'Failed to start the Claude login.');
  } finally {
    reloginInFlight = false;
    renderClaudeAuthSection();
  }
}

export async function submitClaudeLoginCodeFromInput() {
  if (submitInFlight) return;
  const input = document.getElementById('claude-auth-code-input');
  const code = String(input?.value || '').trim();
  if (!code) {
    showTransientRelayNotice('Paste the code from claude.ai first.');
    return;
  }
  // Clear before the request so the code never lingers in the DOM.
  if (input) input.value = '';
  submitInFlight = true;
  renderClaudeAuthSection();
  try {
    applyClaudeAuthState(await submitClaudeLoginCode(code));
  } catch (error) {
    localError = String(error?.message || 'The login code was rejected.');
    await refreshClaudeAuthSection().catch(() => {});
  } finally {
    submitInFlight = false;
    renderClaudeAuthSection();
  }
}

export function handleClaudeLoginCodeKey(event) {
  if (event?.key !== 'Enter') return;
  event.preventDefault();
  void submitClaudeLoginCodeFromInput();
}

export async function cancelClaudeRelogin() {
  if (cancelInFlight) return;
  cancelInFlight = true;
  renderClaudeAuthSection();
  try {
    clearCodeInput();
    applyClaudeAuthState(await cancelClaudeLogin());
  } catch (error) {
    localError = String(error?.message || 'Failed to cancel the Claude login.');
    await refreshClaudeAuthSection().catch(() => {});
  } finally {
    cancelInFlight = false;
    renderClaudeAuthSection();
  }
}

export async function copyClaudeLoginUrl() {
  const url = String(authState?.login?.authUrl || '').trim();
  if (!url) return;
  let copied = false;
  try {
    copied = await copyTextToClipboard(url);
  } catch {
    copied = false;
  }
  const button = document.getElementById('claude-auth-copy-btn');
  if (button) {
    button.textContent = copied ? '✓ Copied' : 'Copy failed';
    clearTimeout(button.__claudeAuthCopyTimer);
    button.__claudeAuthCopyTimer = setTimeout(() => {
      button.textContent = 'Copy link';
    }, COPY_RESET_MS);
  }
  // Without a clipboard (plain http on some browsers) at least surface the URL.
  if (!copied) showTransientRelayNotice(url, 10000);
}

export async function openClaudeLogoutConfirmation() {
  if (logoutInFlight) return;
  // Fresh read: the worker count in the warning must not be a stale number.
  let payload = null;
  try {
    payload = await getClaudeAuthStatus();
  } catch {
    payload = null;
  }
  if (payload) applyClaudeAuthState(payload);
  const status = authState?.status || null;
  if (isLoginBusy()) {
    showTransientRelayNotice('Finish or cancel the Claude login in progress first.');
    return;
  }
  if (status?.loggedIn !== true) {
    showTransientRelayNotice('No Claude account is logged in on the relay host.');
    return;
  }
  const email = String(status.email || '').trim() || 'this Claude account';
  const workers = Number(authState?.runningClaudeWorkers || 0) || 0;
  const workerNote = workers > 0
    ? `${workers} Claude worker${workers === 1 ? '' : 's'} ${workers === 1 ? 'is' : 'are'} currently running; `
      + 'they keep their sessions, but new Claude turns will fail until you log in again.'
    : 'No Claude workers are running right now; new Claude turns will fail until you log in again.';
  openSummaryModal({
    title: 'Log out of Claude',
    subtitle: email,
    kind: 'claude-logout',
    bodyHtml: `
      <p>Log out of <strong>${escHtml(email)}</strong>?</p>
      <p>${escHtml(workerNote)}</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmClaudeLogout()">Log out</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export async function confirmClaudeLogout() {
  if (logoutInFlight) return;
  logoutInFlight = true;
  setSummaryModalLoading(true);
  try {
    const payload = await claudeLogout();
    closeSummaryModal();
    applyClaudeAuthState(payload);
    showTransientRelayNotice('Logged out of Claude on the relay host.');
  } catch (error) {
    closeSummaryModal();
    alert(error?.message || 'Failed to log out of Claude.');
    await refreshClaudeAuthSection().catch(() => {});
  } finally {
    logoutInFlight = false;
    setSummaryModalLoading(false);
    renderClaudeAuthSection();
  }
}
