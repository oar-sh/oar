// Pending host suspend / relay restart, as every device sees it: an app-wide
// banner with a countdown and Cancel, plus the chat-actions menu labels.
// State arrives over the socket (`host_suspend_state`, `relay_shutdown_state`)
// and is also re-read from GET /api/status polls, so a client that missed an
// event still catches up. The banner ignores the per-device "Show Suspend
// host action" setting on purpose: a device with the action hidden must still
// be able to see and cancel a queued suspend.

import { showTransientRelayNotice } from './store.js';
import { cancelHostSuspend } from './api-client.js';
import {
  cancelQueuedRelayRestart,
  isRelayRestartRequestInFlight,
  keepWaitingForQueuedRelayRestart,
  noteRelayRestartStateForDialogs,
  openRestartNowConfirmation,
  refreshRelayRestartWaitedLabels,
  relayRestartHeadline,
  renderRelayRestartRow,
  setRelayRestartStateSink,
} from './relay-restart-ui.js';

const BANNER_ID = 'pending-action-banner';
const SUSPEND_MENU_ID = 'chat-menu-suspend-host';
const RESTART_MENU_ID = 'chat-menu-restart-relay';
const SUSPEND_MENU_LABEL = '💤 Suspend host';
const SUSPEND_MENU_PENDING_LABEL = '💤 Suspend pending…';
const RESTART_MENU_LABEL = '🌄 Restart web relay';
const RESTART_MENU_PENDING_LABEL = '🌄 Restart pending…';

let hostSuspendState = null;
let relayShutdownState = null;
let countdownTimer = null;
let waitedTimer = null;
let cancelInFlight = false;

export function getHostSuspendState() {
  return hostSuspendState;
}

export function getRelayShutdownState() {
  return relayShutdownState;
}

export function isHostSuspendPending(state = hostSuspendState) {
  const status = String(state?.status || '').trim();
  return status === 'queued' || status === 'countdown' || status === 'suspending';
}

export function isRelayShutdownPending(state = relayShutdownState) {
  const status = String(state?.status || '').trim();
  return status === 'queued' || status === 'shutting_down';
}

/** "0:27" style remaining time from a fireAt ISO string; null when not counting. */
export function formatCountdown(fireAt, nowMs = Date.now()) {
  const target = Date.parse(String(fireAt || ''));
  if (!Number.isFinite(target)) return null;
  const remaining = Math.max(0, Math.ceil((target - nowMs) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** One human line per blocker, e.g. "sidebar polish — 2 background agents: …". */
export function describeHostSuspendBlocker(blocker) {
  if (!blocker || typeof blocker !== 'object') return '';
  const title = String(blocker.title || '').trim();
  const detail = String(blocker.detail || '').trim();
  switch (String(blocker.kind || '')) {
    case 'turn':
      return `${title || 'a session'} — ${detail || 'turn running'}`;
    case 'background':
      return `${title || 'a session'} — ${detail || 'background agents running'}`;
    case 'ci':
      return `CI ${title ? `in ${title}` : ''} — ${detail || 'runs open'}`.replace(/\s+—/, ' —');
    case 'ci-unknown':
      return detail || `CI state of ${title || 'a repository'} unknown`;
    case 'ci-checking':
      return detail || 'Checking CI state';
    case 'error':
      return detail || 'Activity check failed';
    default:
      return [title, detail].filter(Boolean).join(' — ');
  }
}

/** Short banner summary: first two blockers, "+N more". */
export function summarizeHostSuspendBlockers(blockers) {
  const list = (Array.isArray(blockers) ? blockers : []).map(describeHostSuspendBlocker).filter(Boolean);
  if (!list.length) return '';
  const shown = list.slice(0, 2);
  const rest = list.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; +${rest} more` : '');
}

export function hostSuspendBannerText(state, nowMs = Date.now()) {
  if (!isHostSuspendPending(state)) return '';
  const status = String(state.status || '');
  if (status === 'suspending') return '💤 Suspending host now…';
  if (status === 'countdown') {
    const countdown = formatCountdown(state.fireAt, nowMs);
    return countdown ? `💤 Everything is idle — suspending host in ${countdown}` : '💤 Everything is idle — suspending host shortly';
  }
  const summary = summarizeHostSuspendBlockers(state.blockers);
  return summary
    ? `💤 Suspend queued — waiting for: ${summary}`
    : '💤 Suspend queued — waiting for running agents to finish';
}

/** The restart row's headline (relay-restart-ui.js renders the whole row). */
export function relayShutdownBannerText(state) {
  if (!isRelayShutdownPending(state)) return '';
  return relayRestartHeadline(state);
}

function ensureBanner() {
  let banner = document.getElementById(BANNER_ID);
  if (banner) return banner;
  banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  document.body?.appendChild(banner);
  return banner;
}

function bannerRow({ text, cancelLabel, onCancel, key }) {
  const row = document.createElement('div');
  row.className = 'pending-action-row';
  row.dataset.pending = key;
  const label = document.createElement('span');
  label.className = 'pending-action-text';
  label.textContent = text;
  row.appendChild(label);
  if (cancelLabel && typeof onCancel === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'relay-toast-action pending-action-cancel';
    btn.textContent = cancelLabel;
    btn.disabled = cancelInFlight;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void onCancel();
    });
    row.appendChild(btn);
  }
  return row;
}

async function runCancelHostSuspend() {
  if (cancelInFlight) return;
  cancelInFlight = true;
  renderPendingActionBanner();
  try {
    const result = await cancelHostSuspend();
    if (!result?.ok) {
      showTransientRelayNotice('Failed to cancel the queued suspend.', 5000);
      return;
    }
    if (result.state) applyHostSuspendState(result.state);
    showTransientRelayNotice(result.cancelled ? 'Queued host suspend cancelled.' : 'No host suspend was pending.', 4000);
  } finally {
    cancelInFlight = false;
    renderPendingActionBanner();
  }
}

function syncCountdownTimer() {
  const needsTicker = isHostSuspendPending() && String(hostSuspendState?.status || '') === 'countdown' && hostSuspendState?.fireAt;
  if (needsTicker && !countdownTimer) {
    countdownTimer = setInterval(() => renderPendingActionBanner(), 1000);
  } else if (!needsTicker && countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  // The restart's waited time ticks in place: rebuilding the row every
  // second would swallow a click on its buttons.
  const needsWaitedTicker = String(relayShutdownState?.status || '') === 'queued';
  if (needsWaitedTicker && !waitedTimer) {
    waitedTimer = setInterval(() => refreshRelayRestartWaitedLabels(relayShutdownState), 15_000);
    waitedTimer?.unref?.();
  } else if (!needsWaitedTicker && waitedTimer) {
    clearInterval(waitedTimer);
    waitedTimer = null;
  }
}

const relayRestartHandlers = {
  onOpen: (conversationId) => {
    if (conversationId && typeof window.openConversation === 'function') void window.openConversation(conversationId);
  },
  onRestartNow: () => openRestartNowConfirmation(relayShutdownState),
  onKeepWaiting: () => keepWaitingForQueuedRelayRestart(),
  onCancel: () => cancelQueuedRelayRestart(),
};

export function renderPendingActionBanner() {
  if (typeof document === 'undefined') return;
  const rows = [];
  if (isHostSuspendPending()) {
    rows.push(bannerRow({
      key: 'host-suspend',
      text: hostSuspendBannerText(hostSuspendState),
      cancelLabel: String(hostSuspendState?.status || '') === 'suspending' ? '' : 'Cancel',
      onCancel: runCancelHostSuspend,
    }));
  }
  if (isRelayShutdownPending()) {
    rows.push(renderRelayRestartRow(relayShutdownState, {
      handlers: relayRestartHandlers,
      busy: isRelayRestartRequestInFlight(),
    }));
  }
  const banner = document.getElementById(BANNER_ID) || (rows.length ? ensureBanner() : null);
  if (!banner) return;
  banner.replaceChildren(...rows);
  banner.classList.toggle('visible', rows.length > 0);
  banner.hidden = rows.length === 0;
  syncMenuLabels();
  syncCountdownTimer();
}

function syncMenuLabels() {
  const suspendBtn = document.getElementById(SUSPEND_MENU_ID);
  if (suspendBtn) suspendBtn.textContent = isHostSuspendPending() ? SUSPEND_MENU_PENDING_LABEL : SUSPEND_MENU_LABEL;
  const restartBtn = document.getElementById(RESTART_MENU_ID);
  if (restartBtn) restartBtn.textContent = isRelayShutdownPending() ? RESTART_MENU_PENDING_LABEL : RESTART_MENU_LABEL;
}

export function applyHostSuspendState(state) {
  const previous = hostSuspendState;
  hostSuspendState = state && typeof state === 'object' ? state : null;
  if (isHostSuspendPending(previous) && !isHostSuspendPending(hostSuspendState) && hostSuspendState?.lastError) {
    showTransientRelayNotice(`Host suspend failed: ${hostSuspendState.lastError}`, 8000);
  }
  renderPendingActionBanner();
}

export function applyRelayShutdownState(state) {
  relayShutdownState = state && typeof state === 'object' ? state : null;
  noteRelayRestartStateForDialogs(relayShutdownState);
  renderPendingActionBanner();
}

/** GET /api/status carries both states; the poll keeps late clients honest. */
export function applyPendingActionsFromStatus(status) {
  if (!status || typeof status !== 'object') return;
  if ('hostSuspend' in status) hostSuspendState = status.hostSuspend || null;
  if ('relayShutdown' in status) {
    const next = status.relayShutdown ? { ...status.relayShutdown } : null;
    if (next && !next.queue) {
      next.queue = {
        pendingCount: Number(status.pendingCount || 0),
        processingCount: Number(status.processingCount || 0),
        parkedCount: Number(status.parkedCount || 0),
      };
    }
    relayShutdownState = next;
  }
  renderPendingActionBanner();
}

export function initHostSuspendUi() {
  // A cancel, keep-waiting or restart-now answer carries the new state.
  setRelayRestartStateSink((state, { rerenderOnly = false } = {}) => {
    if (rerenderOnly) renderPendingActionBanner();
    else applyRelayShutdownState(state);
  });
  renderPendingActionBanner();
}

export function __resetHostSuspendUiForTests() {
  hostSuspendState = null;
  relayShutdownState = null;
  cancelInFlight = false;
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (waitedTimer) { clearInterval(waitedTimer); waitedTimer = null; }
  document.getElementById(BANNER_ID)?.remove();
  syncMenuLabels();
}
