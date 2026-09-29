// The Claude subscription's usage limit, as the open conversation sees it: a
// banner above the composer. Before the limit it warns ("usage at 96 %"); at
// the limit it says when the window resets; and when a turn of this
// conversation was paused there, it says when the turn carries on, with
// Resume now and Cancel.
//
// State arrives over the socket (`usage_limit_pause` per conversation,
// `claude_usage_limit` for the account), with the conversation payload, and
// with GET /api/status polls, so a client that missed an event catches up.

import { showTransientRelayNotice } from './store.js';
import { cancelUsageLimitPause, resumeUsageLimitPause } from './api-client.js';

const BANNER_ID = 'usage-limit-banner';
const DISMISSED_KEY = 'oar.usageLimitWarningDismissed';
// The CLI warns from 90 % on; a report below that is not worth a banner.
const WARNING_FROM = 0.9;

let account = null;
const pauses = new Map();
let currentConversationId = '';
let currentProviderType = '';
let actionInFlight = false;
let wakeTimer = null;

function isFuture(iso, nowMs) {
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) && at > nowMs;
}

/** "22:01" today, "Thu 2 Oct, 09:00" on another day. */
export function formatUsageLimitTime(iso, nowMs = Date.now()) {
  const at = new Date(String(iso || ''));
  if (Number.isNaN(at.getTime())) return '';
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date(nowMs).toDateString() === at.toDateString()) return clock;
  const day = at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${clock}`;
}

/** The pause of a conversation while it still holds the turn back. */
export function activeUsageLimitPause(conversationId, nowMs = Date.now()) {
  const pause = pauses.get(String(conversationId || '')) || null;
  if (!pause) return null;
  // One that resumes by itself is over once its time has come.
  if (pause.auto && !isFuture(pause.resumeAt, nowMs)) return null;
  return pause;
}

export function usageLimitPauseText(pause, nowMs = Date.now()) {
  if (!pause) return '';
  const label = String(pause.label || 'usage limit');
  if (pause.auto) {
    return `⏸ Paused at the Claude ${label} — carries on at ${formatUsageLimitTime(pause.resumeAt, nowMs)}`;
  }
  if (isFuture(pause.resetsAt, nowMs)) {
    return `⏸ Paused at the Claude ${label} — resets ${formatUsageLimitTime(pause.resetsAt, nowMs)}`;
  }
  if (!pause.resetsAt) return `⏸ Paused at the Claude ${label}`;
  return `⏸ Paused at the Claude ${label} — the limit has reset`;
}

/** The account's line: a warning before the limit, the reset at the limit. */
export function usageLimitAccountText(state, nowMs = Date.now()) {
  if (!state || !isFuture(state.resetsAt, nowMs) || state.isUsingOverage) return '';
  const label = String(state.label || 'usage limit');
  const resets = formatUsageLimitTime(state.resetsAt, nowMs);
  if (state.status === 'rejected') {
    return `Claude ${label} reached — resets ${resets}. A turn sent before that is paused until then.`;
  }
  const utilization = Number(state.utilization);
  if (state.status !== 'allowed_warning' || !Number.isFinite(utilization) || utilization < WARNING_FROM) return '';
  return `Claude usage at ${Math.round(utilization * 100)} % of the ${label} — resets ${resets}`;
}

function dismissedKey(state) {
  return state ? `${state.rateLimitType || ''}|${state.resetsAt || ''}|${state.status || ''}` : '';
}

function isDismissed(state) {
  try { return localStorage.getItem(DISMISSED_KEY) === dismissedKey(state); } catch { return false; }
}

function button(label, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `relay-toast-action ${className}`;
  btn.textContent = label;
  btn.disabled = actionInFlight;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void onClick();
  });
  return btn;
}

async function runPauseAction(action) {
  const conversationId = currentConversationId;
  if (actionInFlight || !conversationId) return;
  actionInFlight = true;
  renderUsageLimitBanner();
  try {
    const result = action === 'resume'
      ? await resumeUsageLimitPause(conversationId)
      : await cancelUsageLimitPause(conversationId);
    if (!result?.ok) {
      showTransientRelayNotice(action === 'resume' ? 'Failed to resume the paused turn.' : 'Failed to cancel the paused turn.', 5000);
      return;
    }
    pauses.delete(conversationId);
    if (action === 'resume') {
      showTransientRelayNotice(result.resumed ? 'Paused turn resumed.' : 'No turn was paused.', 4000);
    } else {
      showTransientRelayNotice(result.cancelled ? 'Paused turn cancelled.' : 'No turn was paused.', 4000);
    }
  } finally {
    actionInFlight = false;
    renderUsageLimitBanner();
  }
}

function dismissWarning() {
  try { localStorage.setItem(DISMISSED_KEY, dismissedKey(account)); } catch {}
  renderUsageLimitBanner();
}

// The banner says nothing about time passing, but it ends with it: wake up
// when the turn carries on or the window resets.
function syncWakeTimer(nowMs) {
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
  const pause = pauses.get(currentConversationId) || null;
  const times = [pause?.auto ? pause.resumeAt : pause?.resetsAt, account?.resetsAt]
    .map((iso) => Date.parse(String(iso || '')))
    .filter((at) => Number.isFinite(at) && at > nowMs);
  if (!times.length) return;
  const delay = Math.min(Math.min(...times) - nowMs + 500, 0x7fffffff);
  wakeTimer = setTimeout(() => renderUsageLimitBanner(), delay);
  wakeTimer?.unref?.();
}

export function renderUsageLimitBanner(nowMs = Date.now()) {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById(BANNER_ID);
  if (!banner) return;
  const children = [];
  const pause = activeUsageLimitPause(currentConversationId, nowMs);
  if (pause) {
    const text = document.createElement('span');
    text.className = 'usage-limit-text';
    text.textContent = usageLimitPauseText(pause, nowMs);
    children.push(text, button('Resume now', 'usage-limit-resume', () => runPauseAction('resume')), button('Cancel', 'usage-limit-cancel', () => runPauseAction('cancel')));
    banner.dataset.state = 'paused';
  } else {
    const line = currentConversationId && currentProviderType === 'claude' && !isDismissed(account)
      ? usageLimitAccountText(account, nowMs)
      : '';
    if (line) {
      const text = document.createElement('span');
      text.className = 'usage-limit-text';
      text.textContent = line;
      children.push(text, button('Hide', 'usage-limit-dismiss', async () => dismissWarning()));
      banner.dataset.state = account.status === 'rejected' ? 'reached' : 'warning';
    }
  }
  banner.replaceChildren(...children);
  banner.classList.toggle('visible', children.length > 0);
  banner.hidden = children.length === 0;
  if (!children.length) delete banner.dataset.state;
  syncWakeTimer(nowMs);
}

/** `usage_limit_pause`: one conversation's pause, or its end (`pause: null`). */
export function applyUsageLimitPause(payload) {
  const conversationId = String(payload?.conversationId || '').trim();
  if (!conversationId) return;
  if (payload.pause && typeof payload.pause === 'object') pauses.set(conversationId, payload.pause);
  else pauses.delete(conversationId);
  renderUsageLimitBanner();
}

/** `claude_usage_limit`: the account's latest report, or null past its reset. */
export function applyClaudeUsageLimit(state) {
  account = state && typeof state === 'object' ? state : null;
  renderUsageLimitBanner();
}

/** GET /api/status carries the account and every pause. */
export function applyUsageLimitFromStatus(status) {
  if (!status || typeof status !== 'object' || !('usageLimit' in status)) return;
  const usageLimit = status.usageLimit || {};
  account = usageLimit.account && typeof usageLimit.account === 'object' ? usageLimit.account : null;
  pauses.clear();
  for (const pause of (Array.isArray(usageLimit.pauses) ? usageLimit.pauses : [])) {
    const conversationId = String(pause?.conversationId || '').trim();
    if (conversationId) pauses.set(conversationId, pause);
  }
  renderUsageLimitBanner();
}

/** The conversation on screen, with what its payload said about a pause. */
export function setUsageLimitConversation(conversationId, { pause = undefined, providerType = '' } = {}) {
  currentConversationId = String(conversationId || '').trim();
  currentProviderType = String(providerType || '').trim().toLowerCase();
  if (currentConversationId && pause !== undefined) {
    if (pause && typeof pause === 'object') pauses.set(currentConversationId, pause);
    else pauses.delete(currentConversationId);
  }
  renderUsageLimitBanner();
}

export function initUsageLimitUi() {
  renderUsageLimitBanner();
}

export function __resetUsageLimitUiForTests() {
  account = null;
  pauses.clear();
  currentConversationId = '';
  currentProviderType = '';
  actionInFlight = false;
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
  try { localStorage.removeItem(DISMISSED_KEY); } catch {}
  renderUsageLimitBanner();
}
