import {
  currentConvId,
  conversations,
  escHtml,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLoading,
  renderSummaryModalContent,
  summaryModalState,
  showTransientRelayNotice,
} from './store.js';
import {
  killSessionWorker,
  requestRelayRestart,
  requestHostSuspend,
  getHostSuspendState,
  cancelHostSuspend,
  requestQueueEmpty,
  refreshWorkspaceRootHints,
} from './api-client.js';
import { isSuspendHostActionVisible } from './settings-modal.js';
import {
  applyHostSuspendState,
  describeHostSuspendBlocker,
  formatCountdown,
  isHostSuspendPending,
} from './host-suspend-ui.js';

let killSessionInFlight = false;
let restartRelayInFlight = false;
let suspendHostInFlight = false;
let emptyQueueInFlight = false;

let menuDeps = {
  lockChatActionsMenuShield: () => {},
  closeChatActionsMenu: () => {},
  syncQueueStatusMenuEntry: () => {},
  refreshSessionWorkerStatus: () => Promise.resolve(),
};

function getCurrentConversationSessionInfo() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return null;
  const conversation = conversations[convId] || {};
  const sdkSessionId = String(conversation.sdkSessionId || '').trim();
  if (!sdkSessionId) return null;
  const title = String(conversation.title || document.getElementById('chat-title')?.textContent || convId).trim() || convId;
  return {
    conversationId: convId,
    sdkSessionId,
    title,
  };
}

export function openKillSessionConfirmation() {
  const info = getCurrentConversationSessionInfo();
  if (!info) {
    showTransientRelayNotice('No active session is bound to this conversation.');
    return;
  }
  const escapedTitle = escHtml(info.title);
  openSummaryModal({
    title: 'Kill session',
    subtitle: info.sdkSessionId,
    kind: 'kill-session',
    bodyHtml: `
      <p>Kill the session for <strong>${escapedTitle}</strong>?</p>
      <p>This stops the current worker and any active turn will need a manual retry or a new message.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmKillCurrentSession()">☠️ Kill session</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export async function confirmKillCurrentSession() {
  if (killSessionInFlight) return;
  const info = getCurrentConversationSessionInfo();
  if (!info) {
    closeSummaryModal();
    showTransientRelayNotice('No active session is bound to this conversation.');
    return;
  }
  killSessionInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await killSessionWorker(info.sdkSessionId, {
      conversationId: info.conversationId,
      title: info.title,
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to kill session');
      return;
    }
    const statusText = result.processStatus === 'killed'
      ? 'Session killed.'
      : 'Session state cleared; no live worker process was found.';
    showTransientRelayNotice(statusText);
    await menuDeps.refreshSessionWorkerStatus().catch(() => {});
  } finally {
    killSessionInFlight = false;
    setSummaryModalLoading(false);
  }
}

export function openRestartRelayConfirmation() {
  openSummaryModal({
    title: 'Restart web relay',
    subtitle: 'Queues restart via /api/relay/shutdown',
    kind: 'restart-relay',
    bodyHtml: `
      <p>Queue a manual relay restart now?</p>
      <p>The restart waits until the current turn is idle, so it does not interrupt an in-flight turn immediately.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="confirmRestartWebRelay()">🌄 Restart web relay</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export function openEmptyQueueConfirmation() {
  menuDeps.lockChatActionsMenuShield(350);
  menuDeps.closeChatActionsMenu();
  openSummaryModal({
    title: 'Empty queue',
    subtitle: 'Calls localhost /api/queue/empty',
    kind: 'empty-queue',
    bodyHtml: `
      <p>Drop all queue rows in pending, processing, and parked states?</p>
      <p>This is a local maintenance action and cannot be undone.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="confirmEmptyQueue()">🚮 Empty queue</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

const SUSPEND_MODAL_KIND = 'suspend-host';

/**
 * Body of the Suspend host modal for one activity snapshot. Pure so the three
 * shapes (idle, busy, already pending) are unit-testable without a DOM.
 */
export function renderSuspendHostModalBody({ state = null, blockers = [], supported = true } = {}) {
  const list = Array.isArray(blockers) ? blockers : [];
  const items = list.map((b) => `<li>${escHtml(describeHostSuspendBlocker(b))}</li>`).join('');
  if (!supported) {
    return `
      <p>Host suspend is only available when the relay runs on Windows.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Close</button>
      </div>`;
  }
  if (isHostSuspendPending(state)) {
    const status = String(state?.status || '');
    const countdown = status === 'countdown' ? formatCountdown(state.fireAt) : null;
    const headline = status === 'suspending'
      ? '<p>The host is suspending now.</p>'
      : status === 'countdown'
        ? `<p>Everything is idle. The host suspends in <strong>${escHtml(countdown || 'a moment')}</strong> unless you cancel.</p>`
        : '<p>A suspend is already queued. The PC will not go to sleep until these finish, then after 2 minutes of quiet:</p>';
    return `
      ${headline}
      ${items ? `<ul class="suspend-host-blockers">${items}</ul>` : ''}
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" onclick="cancelQueuedHostSuspend()"${status === 'suspending' ? ' disabled data-keep-disabled="1"' : ''}>Cancel queued suspend</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Close</button>
      </div>`;
  }
  if (!list.length) {
    return `
      <p>Put this PC to sleep?</p>
      <p>Nothing is running. The host suspends <strong>30 seconds</strong> after you confirm; a banner with a countdown lets you cancel until then.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="confirmSuspendHost()">💤 Suspend host</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>`;
  }
  return `
    <p><strong>Agents are still active.</strong> The PC will not suspend until these finish, then after 2 minutes of quiet:</p>
    <ul class="suspend-host-blockers">${items}</ul>
    <p>You can cancel the queued suspend from the banner or this menu at any time.</p>
    <div class="summary-modal-actions">
      <button class="chat-title-action-btn" type="button" onclick="confirmSuspendHost()">💤 Suspend when idle</button>
      <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
    </div>`;
}

async function loadSuspendHostModal() {
  const result = await getHostSuspendState();
  if (summaryModalState.kind !== SUSPEND_MODAL_KIND) return;
  if (!result?.ok) {
    renderSummaryModalContent({
      title: 'Suspend host',
      subtitle: 'Suspend-to-RAM once agents are done',
      kind: SUSPEND_MODAL_KIND,
      refresh: loadSuspendHostModal,
      bodyHtml: `
        <div class="summary-error">Could not read what is running right now.</div>
        <div class="summary-modal-actions">
          <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Close</button>
        </div>`,
    });
    return;
  }
  if (result.state) applyHostSuspendState(result.state);
  renderSummaryModalContent({
    title: 'Suspend host',
    subtitle: isHostSuspendPending(result.state) ? 'Suspend queued' : 'Suspend-to-RAM once agents are done',
    kind: SUSPEND_MODAL_KIND,
    refresh: loadSuspendHostModal,
    bodyHtml: renderSuspendHostModalBody({
      state: result.state,
      blockers: result.blockers,
      supported: result.supported !== false,
    }),
  });
}

export function openSuspendHostConfirmation() {
  if (!isSuspendHostActionVisible() && !isHostSuspendPending()) return;
  menuDeps.lockChatActionsMenuShield(350);
  menuDeps.closeChatActionsMenu();
  openSummaryModal({
    title: 'Suspend host',
    subtitle: 'Suspend-to-RAM once agents are done',
    kind: SUSPEND_MODAL_KIND,
    refresh: loadSuspendHostModal,
    bodyHtml: '<div class="summary-loading">Checking what is still running…</div>',
  });
  setSummaryModalLoading(true);
  loadSuspendHostModal().catch(() => {
    if (summaryModalState.kind !== SUSPEND_MODAL_KIND) return;
    renderSummaryModalContent({
      title: 'Suspend host',
      kind: SUSPEND_MODAL_KIND,
      bodyHtml: `
        <div class="summary-error">Could not read what is running right now.</div>
        <div class="summary-modal-actions">
          <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Close</button>
        </div>`,
    });
  });
  window.setTimeout(() => {
    const modal = document.getElementById('summary-modal');
    const classVisible = !!modal?.classList?.contains('visible');
    const ariaVisible = String(modal?.getAttribute('aria-hidden') || 'true') === 'false';
    const displayVisible = modal ? window.getComputedStyle(modal).display !== 'none' : false;
    if (classVisible && ariaVisible && displayVisible) return;
    const confirmed = window.confirm('Put this PC to sleep once all agents are done?\n\nThe suspend is queued and fires after everything has been idle.');
    if (!confirmed) return;
    confirmSuspendHost().catch(() => {});
  }, 90);
}

export async function confirmSuspendHost() {
  if (!isSuspendHostActionVisible()) return;
  if (suspendHostInFlight) return;
  suspendHostInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestHostSuspend({
      reason: 'manual-suspend',
      requestedBy: 'localhost-api',
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to queue host suspend');
      return;
    }
    if (result.state) applyHostSuspendState(result.state);
    const status = String(result.state?.status || '');
    if (result.alreadyPending) {
      showTransientRelayNotice('A host suspend is already queued.', 5000);
    } else if (status === 'countdown') {
      showTransientRelayNotice('Host suspend queued: everything is idle, sleeping in 30 seconds. Cancel from the banner.', 7000);
    } else {
      showTransientRelayNotice('Host suspend queued: the PC sleeps once all agents are done.', 7000);
    }
  } finally {
    suspendHostInFlight = false;
    setSummaryModalLoading(false);
  }
}

export async function cancelQueuedHostSuspend() {
  if (suspendHostInFlight) return;
  suspendHostInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await cancelHostSuspend();
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to cancel the queued host suspend');
      return;
    }
    if (result.state) applyHostSuspendState(result.state);
    showTransientRelayNotice(result.cancelled ? 'Queued host suspend cancelled.' : 'No host suspend was pending.', 4000);
  } finally {
    suspendHostInFlight = false;
    setSummaryModalLoading(false);
  }
}

export async function confirmEmptyQueue() {
  if (emptyQueueInFlight) return;
  emptyQueueInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestQueueEmpty({
      reason: 'manual-empty-queue',
      requestedBy: 'localhost-api',
    });
    closeSummaryModal();
    if (!result?.ok) {
      alert('Failed to empty queue');
      return;
    }
    const droppedCount = Number(result.droppedCount || 0);
    if (droppedCount <= 0) {
      showTransientRelayNotice('Queue is already empty.');
    } else {
      showTransientRelayNotice(`Queue emptied: dropped ${droppedCount} row${droppedCount === 1 ? '' : 's'}.`, 6000);
    }
    const status = await refreshWorkspaceRootHints();
    menuDeps.syncQueueStatusMenuEntry(status);
  } finally {
    emptyQueueInFlight = false;
    setSummaryModalLoading(false);
  }
}

export async function confirmRestartWebRelay() {
  if (restartRelayInFlight) return;
  restartRelayInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = await requestRelayRestart({
      reason: 'manual-restart',
      requestedBy: 'localhost-api',
      restart: true,
    });
    closeSummaryModal();
    // Restart can close the connection before the browser receives JSON.
    if (!result) {
      showTransientRelayNotice('Relay restart requested. Connection may briefly drop while it restarts.', 7000);
      return;
    }
    if (!result.ok) {
      alert('Failed to queue relay restart');
      return;
    }
    if (result.accepted === false) {
      showTransientRelayNotice('Relay is already shutting down/restarting.', 7000);
      return;
    }
    const queue = result.queue || {};
    showTransientRelayNotice(
      `Relay restart queued (pending=${Number(queue.pendingCount || 0)}, processing=${Number(queue.processingCount || 0)}).`,
      7000,
    );
  } finally {
    restartRelayInFlight = false;
    setSummaryModalLoading(false);
  }
}

export function initActionConfirmations({
  lockChatActionsMenuShield,
  closeChatActionsMenu,
  syncQueueStatusMenuEntry,
  refreshSessionWorkerStatus,
  exposeOnWindow = true,
} = {}) {
  menuDeps = {
    lockChatActionsMenuShield: typeof lockChatActionsMenuShield === 'function' ? lockChatActionsMenuShield : menuDeps.lockChatActionsMenuShield,
    closeChatActionsMenu: typeof closeChatActionsMenu === 'function' ? closeChatActionsMenu : menuDeps.closeChatActionsMenu,
    syncQueueStatusMenuEntry: typeof syncQueueStatusMenuEntry === 'function' ? syncQueueStatusMenuEntry : menuDeps.syncQueueStatusMenuEntry,
    refreshSessionWorkerStatus: typeof refreshSessionWorkerStatus === 'function' ? refreshSessionWorkerStatus : menuDeps.refreshSessionWorkerStatus,
  };
  if (!exposeOnWindow) return;
  window.openKillSessionConfirmation = openKillSessionConfirmation;
  window.openRestartRelayConfirmation = openRestartRelayConfirmation;
  window.openEmptyQueueConfirmation = openEmptyQueueConfirmation;
  window.openSuspendHostConfirmation = openSuspendHostConfirmation;
  window.confirmKillCurrentSession = confirmKillCurrentSession;
  window.confirmRestartWebRelay = confirmRestartWebRelay;
  window.confirmSuspendHost = confirmSuspendHost;
  window.cancelQueuedHostSuspend = cancelQueuedHostSuspend;
  window.confirmEmptyQueue = confirmEmptyQueue;
}
