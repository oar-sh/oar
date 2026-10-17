// Settings → Sharing: every conversation with a public link, its access log,
// and the actions on a link (copy, renew, stop). The ⋯ menu's "Stop sharing"
// uses the same confirmation. The list lives in share-state.js; the socket's
// share events keep it current while the modal is open.

import { escHtml, openSummaryModal, closeSummaryModal, showTransientRelayNotice } from './store.js';
import {
  countStoredViewerIps,
  createConversationShareLink,
  forgetStoredViewerIps,
  loadConversationShareOpens,
  loadSharePathPrivacySetting,
  renewConversationShareLink,
  stopSharingConversation,
  updateSharePathPrivacySetting,
  updateShareSettings,
} from './api-client.js';
import { copyTextToClipboard } from './router.js';
import {
  applyShareSettings,
  forgetShare,
  getShareSettings,
  getShares,
  refreshShares,
  sharesLoaded,
  subscribeShares,
} from './share-state.js';
import { describeShare, describeShareOpen } from './share-format.mjs';

// conversation id -> { loading, error, opens, total, limit }
const expandedLogs = new Map();
const actionsInFlight = new Set();
let storeIpToggleBound = false;
let pathPrivacyBound = false;
// The mode on screen is the one last read or saved.
let savedPathPrivacyMode = '';

function settingsModalOpen() {
  return !!document.getElementById('settings-modal')?.classList.contains('visible');
}

function setStatus(text) {
  const status = document.getElementById('settings-shares-status');
  if (status) status.textContent = String(text || '');
}

function actionButton(label, className, onClick, { disabled = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onClick(button);
  });
  return button;
}

function buildOpensList(conversationId) {
  const state = expandedLogs.get(conversationId);
  const container = document.createElement('div');
  container.className = 'share-opens';
  container.dataset.conversationId = conversationId;
  if (!state || (state.loading && !state.opens)) {
    container.textContent = 'Loading the access log…';
    return container;
  }
  if (state.error) {
    container.textContent = `Could not load the access log: ${state.error}`;
    return container;
  }
  const opens = state.opens || [];
  if (!opens.length) {
    container.textContent = 'Nobody has opened this link yet.';
    return container;
  }
  for (const open of opens) {
    const row = document.createElement('div');
    row.className = 'share-open';
    const meta = document.createElement('div');
    meta.className = 'share-open-meta';
    meta.textContent = describeShareOpen(open);
    row.appendChild(meta);
    // A viewer's user agent is whatever their client sent: text only.
    const agent = document.createElement('div');
    agent.className = 'share-open-agent';
    agent.textContent = open.userAgent || 'no user agent';
    row.appendChild(agent);
    container.appendChild(row);
  }
  if (Number(state.total) > opens.length) {
    const more = document.createElement('div');
    more.className = 'settings-help';
    more.textContent = `The newest ${opens.length} of ${state.total} opens.`;
    container.appendChild(more);
  }
  return container;
}

function buildShareRow(share) {
  const id = share.conversationId;
  const busy = actionsInFlight.has(id);
  const row = document.createElement('div');
  row.className = 'share-row';
  row.dataset.conversationId = id;

  const head = document.createElement('div');
  head.className = 'share-row-head';
  row.appendChild(head);

  const main = document.createElement('div');
  main.className = 'share-row-main';
  head.appendChild(main);

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'share-row-title';
  title.textContent = share.title || 'Untitled conversation';
  title.title = 'Open this conversation';
  title.addEventListener('click', (event) => {
    event.preventDefault();
    window.closeSettingsModal?.();
    void window.openConversation?.(id, { restoreScroll: true });
  });
  main.appendChild(title);

  const detail = document.createElement('span');
  detail.className = 'preview-detail share-row-detail';
  detail.textContent = describeShare(share);
  main.appendChild(detail);

  const actions = document.createElement('div');
  actions.className = 'share-row-actions';
  head.appendChild(actions);
  actions.appendChild(actionButton('Copy link', 'share-copy', (button) => {
    void copyShareLink(share.shareUrl, button);
  }));
  actions.appendChild(actionButton('Renew link', 'share-renew', () => {
    openRenewShareConfirmation(id, share.title);
  }, { disabled: busy }));
  actions.appendChild(actionButton('Stop sharing', 'share-stop', () => {
    openStopSharingConfirmation(id, share.title);
  }, { disabled: busy }));
  const expanded = expandedLogs.has(id);
  const toggle = actionButton(expanded ? 'Hide access log' : 'Access log', 'share-log-toggle', () => {
    toggleAccessLog(id);
  });
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  actions.appendChild(toggle);

  if (expanded) row.appendChild(buildOpensList(id));
  return row;
}

export function renderSharedConversationsSection() {
  const list = document.getElementById('settings-shares-list');
  const empty = document.getElementById('settings-shares-empty');
  if (!list) return;
  const shares = getShares();
  // Logs of shares that are gone are dropped with them.
  for (const id of expandedLogs.keys()) {
    if (!shares.some((share) => share.conversationId === id)) expandedLogs.delete(id);
  }
  list.replaceChildren(...shares.map(buildShareRow));
  if (empty) {
    empty.hidden = shares.length > 0;
    empty.textContent = sharesLoaded() ? 'No conversation is shared right now.' : 'Loading shared conversations…';
  }
  const toggle = document.getElementById('settings-shares-store-ip');
  if (toggle) toggle.checked = getShareSettings().storeViewerIp;
}

async function loadAccessLog(conversationId) {
  const previous = expandedLogs.get(conversationId) || {};
  expandedLogs.set(conversationId, { ...previous, loading: true, error: '' });
  try {
    const payload = await loadConversationShareOpens(conversationId);
    if (!expandedLogs.has(conversationId)) return;
    expandedLogs.set(conversationId, {
      loading: false,
      error: '',
      opens: Array.isArray(payload?.opens) ? payload.opens : [],
      total: Number(payload?.total || 0),
      limit: Number(payload?.limit || 0),
    });
  } catch (error) {
    if (!expandedLogs.has(conversationId)) return;
    expandedLogs.set(conversationId, { ...previous, loading: false, error: error?.message || 'unknown error' });
  }
  renderSharedConversationsSection();
}

function toggleAccessLog(conversationId) {
  if (expandedLogs.has(conversationId)) {
    expandedLogs.delete(conversationId);
    renderSharedConversationsSection();
    return;
  }
  expandedLogs.set(conversationId, { loading: true });
  renderSharedConversationsSection();
  void loadAccessLog(conversationId);
}

async function copyShareLink(url, button) {
  const link = String(url || '').trim();
  if (!link) return;
  try {
    const copied = await copyTextToClipboard(link);
    if (!copied) throw new Error('not copied');
    const previous = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = previous; }, 1500);
  } catch {
    showTransientRelayNotice(link, 8000);
  }
}

function bindStoreIpToggle() {
  if (storeIpToggleBound) return;
  const toggle = document.getElementById('settings-shares-store-ip');
  if (!toggle) return;
  storeIpToggleBound = true;
  toggle.addEventListener('change', async () => {
    const wanted = toggle.checked;
    toggle.disabled = true;
    setStatus('Saving…');
    try {
      const result = await updateShareSettings({ storeViewerIp: wanted });
      if (result) applyShareSettings(result);
      setStatus(wanted ? 'New log entries keep the viewer\'s IP address.' : 'New log entries keep no IP address.');
      if (!wanted) void offerToForgetStoredViewerIps();
    } catch (error) {
      toggle.checked = !wanted;
      setStatus(`Not saved: ${error?.message || 'unknown error'}`);
    } finally {
      toggle.disabled = false;
    }
  });
}

// "Paths and file names": what every shared link shows of the relay's paths
// (shared/share-path-privacy.mjs). The relay filters on its side; this only
// reads and writes the mode.
function pathPrivacyRadios() {
  return [...document.querySelectorAll('input[name="settings-shares-path-privacy"]')];
}

function setPathPrivacyStatus(text) {
  const status = document.getElementById('settings-shares-path-privacy-status');
  if (status) status.textContent = String(text || '');
}

function showPathPrivacyMode(mode) {
  for (const radio of pathPrivacyRadios()) radio.checked = radio.value === mode;
}

function bindPathPrivacy() {
  if (pathPrivacyBound) return;
  const radios = pathPrivacyRadios();
  if (!radios.length) return;
  pathPrivacyBound = true;
  for (const radio of radios) {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const wanted = radio.value;
      const previous = savedPathPrivacyMode;
      for (const entry of radios) entry.disabled = true;
      setPathPrivacyStatus('Saving…');
      try {
        const result = await updateSharePathPrivacySetting(wanted);
        savedPathPrivacyMode = String(result?.mode || wanted);
        showPathPrivacyMode(savedPathPrivacyMode);
        setPathPrivacyStatus('Saved. Shared links show it from their next refresh.');
      } catch (error) {
        showPathPrivacyMode(previous);
        setPathPrivacyStatus(`Not saved: ${error?.message || 'unknown error'}`);
      } finally {
        for (const entry of radios) entry.disabled = false;
      }
    });
  }
}

async function refreshPathPrivacy() {
  bindPathPrivacy();
  try {
    const result = await loadSharePathPrivacySetting();
    const mode = String(result?.mode || '');
    if (!mode) return;
    savedPathPrivacyMode = mode;
    showPathPrivacyMode(mode);
  } catch (error) {
    setPathPrivacyStatus(`Could not read the setting: ${error?.message || 'unknown error'}`);
  }
}

// IP storage just went off: the addresses logged before can go too. Asked
// only when there are any; No leaves them.
async function offerToForgetStoredViewerIps() {
  let count = 0;
  try {
    count = Number((await countStoredViewerIps())?.count || 0);
  } catch {
    return;
  }
  if (!(count > 0)) return;
  openSummaryModal({
    title: 'Stored IP addresses',
    kind: 'share-forget-ips',
    bodyHtml: confirmationBody({
      question: `Also remove the ${count} IP address${count === 1 ? '' : 'es'} already stored?`,
      detail: 'They go from every access log entry and from the status log of shared reads. The entries stay, and viewers are still counted apart.',
      confirmLabel: 'Remove them',
      cancelLabel: 'Keep them',
      confirmId: 'share-forget-ips-confirm',
      danger: true,
    }),
  });
  bindConfirmation('share-forget-ips-confirm', async () => {
    try {
      await forgetStoredViewerIps();
      setStatus('New log entries keep no IP address, and the stored ones are removed.');
    } catch (error) {
      setStatus(`The stored addresses were not removed: ${error?.message || 'unknown error'}`);
    }
    reloadExpandedAccessLogs();
  });
}

function reloadExpandedAccessLogs() {
  for (const id of expandedLogs.keys()) void loadAccessLog(id);
}

/** The stored addresses were removed (here or on another device). */
export function handleViewerIpsForgotten() {
  if (settingsModalOpen()) reloadExpandedAccessLogs();
}

/** Settings opened: read the list again (the socket may have missed events). */
export async function refreshSharedConversationsSection() {
  bindStoreIpToggle();
  setPathPrivacyStatus('');
  void refreshPathPrivacy();
  setStatus('');
  renderSharedConversationsSection();
  try {
    await refreshShares();
  } catch (error) {
    const empty = document.getElementById('settings-shares-empty');
    if (empty && !getShares().length) {
      empty.hidden = false;
      empty.textContent = `Could not load the shared conversations: ${error?.message || 'unknown error'}`;
    }
    return;
  }
  for (const id of expandedLogs.keys()) void loadAccessLog(id);
}

/** A share was opened somewhere: new counts, and the open log if shown. */
export function handleShareOpened(conversationId) {
  void refreshShares().catch(() => {});
  const id = String(conversationId || '').trim();
  if (id && expandedLogs.has(id) && settingsModalOpen()) void loadAccessLog(id);
}

function confirmationBody({ question, detail, confirmLabel, confirmId, danger, cancelLabel = 'Cancel' }) {
  return `
      <p>${question}</p>
      <p>${detail}</p>
      <div class="summary-modal-actions">
        <button id="${confirmId}" class="chat-title-action-btn${danger ? ' danger-btn' : ''}" type="button">${confirmLabel}</button>
        <button class="chat-title-action-btn" type="button" data-share-confirm-cancel>${cancelLabel}</button>
      </div>
    `;
}

function bindConfirmation(confirmId, run) {
  const body = document.getElementById('summary-modal-body');
  const confirm = document.getElementById(confirmId);
  body?.querySelector('[data-share-confirm-cancel]')?.addEventListener('click', () => closeSummaryModal());
  confirm?.addEventListener('click', async () => {
    if (confirm.disabled) return;
    confirm.disabled = true;
    try {
      await run();
    } finally {
      closeSummaryModal();
    }
  });
}

async function runShareAction(conversationId, action) {
  if (actionsInFlight.has(conversationId)) return;
  actionsInFlight.add(conversationId);
  renderSharedConversationsSection();
  try {
    await action();
  } finally {
    actionsInFlight.delete(conversationId);
    renderSharedConversationsSection();
  }
}

export function openStopSharingConfirmation(conversationId, title = '') {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const name = escHtml(String(title || '').trim() || 'this conversation');
  openSummaryModal({
    title: 'Stop sharing',
    kind: 'share-stop',
    bodyHtml: confirmationBody({
      question: `Stop sharing <strong>${name}</strong>?`,
      detail: 'The link stops working at once, also for anyone reading it right now, and its access log is deleted.',
      confirmLabel: '⛔ Stop sharing',
      confirmId: 'share-stop-confirm',
      danger: true,
    }),
  });
  bindConfirmation('share-stop-confirm', () => runShareAction(id, async () => {
    try {
      await stopSharingConversation(id);
      forgetShare(id);
      expandedLogs.delete(id);
      showTransientRelayNotice('Sharing stopped. The link no longer works.');
    } catch (error) {
      showTransientRelayNotice(`Could not stop sharing: ${error?.message || 'unknown error'}`);
    }
    await refreshShares().catch(() => {});
  }));
}

export function openRenewShareConfirmation(conversationId, title = '') {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const name = escHtml(String(title || '').trim() || 'this conversation');
  openSummaryModal({
    title: 'Renew link',
    kind: 'share-renew',
    bodyHtml: confirmationBody({
      question: `Give <strong>${name}</strong> a new link?`,
      detail: 'The current link stops working at once. The access log carries over to the new link.',
      confirmLabel: '🔁 Renew link',
      confirmId: 'share-renew-confirm',
      danger: false,
    }),
  });
  bindConfirmation('share-renew-confirm', () => runShareAction(id, async () => {
    try {
      const result = await renewConversationShareLink(id);
      const url = String(result?.shareUrl || '').trim();
      let copied = false;
      try { copied = url ? await copyTextToClipboard(url) : false; } catch {}
      showTransientRelayNotice(copied
        ? 'New link copied to clipboard. The old link no longer works.'
        : `New link: ${url}`, copied ? 4000 : 10000);
    } catch (error) {
      showTransientRelayNotice(`Could not renew the link: ${error?.message || 'unknown error'}`);
    }
    await refreshShares().catch(() => {});
  }));
}

/** ⋯ → Share conversation: the link, made if there is none, to the clipboard. */
export async function shareConversationFromMenu(conversationId) {
  const result = await createConversationShareLink(conversationId);
  const shareUrl = String(result?.shareUrl || '').trim();
  if (!shareUrl) {
    showTransientRelayNotice(result?.error || 'Could not create share link.');
    return;
  }
  const copied = await copyTextToClipboard(shareUrl).catch(() => false);
  showTransientRelayNotice(copied ? 'Share link copied to clipboard.' : shareUrl);
  void refreshShares().catch(() => {});
}

subscribeShares(() => {
  if (!settingsModalOpen()) return;
  renderSharedConversationsSection();
});
