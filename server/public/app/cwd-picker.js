import {
  currentConvId,
  conversations,
  workspaceRootPath,
  escHtml,
  getConversationWorkspaceState,
  getConversationCurrentWorkspaceRootPath,
  getRecentWorkspaceRoots,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLoading,
  showTransientRelayNotice,
} from './store.js';
import { updateWorkspaceRoot, relaunchSessionWorkerWithWorkspaceRoot } from './api-client.js';
import { getRepoBrowserLaunchCwdPath } from './attachments-view.js';

const LEGACY_KNOWN_CWD_HISTORY_KEY = 'copilot_known_cwds';

let changeCwdInFlight = false;

let deps = {
  applyConversationWorkspaceRootUpdate: () => {},
  refreshSessionWorkerStatus: async () => {},
};

export function initCwdPicker({
  applyConversationWorkspaceRootUpdate,
  refreshSessionWorkerStatus,
} = {}) {
  if (typeof applyConversationWorkspaceRootUpdate === 'function') {
    deps.applyConversationWorkspaceRootUpdate = applyConversationWorkspaceRootUpdate;
  }
  if (typeof refreshSessionWorkerStatus === 'function') {
    deps.refreshSessionWorkerStatus = refreshSessionWorkerStatus;
  }
}

export function normalizeKnownCwdPath(value) {
  const stripped = String(value || '').trim().replace(/[\\/]+$/, '');
  // Always restore the trailing backslash for Windows drive roots ("D:" → "D:\").
  // Without it, sending "D:" to the server causes path.resolve("D:") to return the
  // server's remembered CWD for drive D, not the drive root.
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

export function clearLegacyKnownCwdHistoryStorage() {
  try {
    localStorage.removeItem(LEGACY_KNOWN_CWD_HISTORY_KEY);
  } catch {}
}

function buildKnownCwdOptions() {
  const options = [];
  const seen = new Set();
  const add = (label, value, note = '') => {
    const pathValue = normalizeKnownCwdPath(value);
    if (!pathValue) return;
    const key = pathValue.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ label, path: pathValue, note });
  };

  const selectedCurrentCwd = getSelectedConversationCurrentCwd();
  add('Current session CWD', selectedCurrentCwd, 'Selected session');
  add('Relay workspace', workspaceRootPath, 'Relay host cwd');
  const browserCwd = normalizeKnownCwdPath(getRepoBrowserLaunchCwdPath());
  if (browserCwd && browserCwd.toLowerCase() !== normalizeKnownCwdPath(selectedCurrentCwd).toLowerCase()) {
    add('Current browser folder', browserCwd, 'From file explorer');
  }
  const history = getRecentWorkspaceRoots();
  history.forEach((pathValue, index) => {
    add(`Recent CWD ${index + 1}`, pathValue, 'Relay history');
  });
  return options;
}

function renderKnownCwdMenuItems(options, selectedPath) {
  if (!options.length) {
    return '<div class="change-cwd-menu-empty">No known CWDs available</div>';
  }
  const selectedKey = normalizeKnownCwdPath(selectedPath).toLowerCase();
  return options.map((option) => {
    const optionPath = normalizeKnownCwdPath(option.path);
    const selected = optionPath.toLowerCase() === selectedKey;
    return `
      <button class="change-cwd-menu-item${selected ? ' selected' : ''}" type="button" role="menuitemradio" aria-checked="${selected ? 'true' : 'false'}" tabindex="-1" data-path="${escHtml(optionPath)}" data-label="${escHtml(option.label || '')}" data-note="${escHtml(option.note || '')}" title="${escHtml(optionPath)}">
        <span class="change-cwd-menu-item-primary">${escHtml(option.label || 'Known CWD')}</span>
        <span class="change-cwd-menu-item-secondary">${escHtml(optionPath)}</span>
      </button>
    `;
  }).join('');
}

function getSelectedChangeCwdPath() {
  const input = document.getElementById('change-cwd-selected-path');
  return normalizeKnownCwdPath(input?.value || '');
}

function getManualChangeCwdPath() {
  const input = document.getElementById('change-cwd-manual-path');
  return normalizeKnownCwdPath(input?.value || '');
}

function getEffectiveChangeCwdPath() {
  return getManualChangeCwdPath() || getSelectedChangeCwdPath();
}

function closeChangeCwdMenu() {
  const menu = document.getElementById('change-cwd-menu');
  const trigger = document.getElementById('change-cwd-menu-trigger');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function syncChangeCwdPickerView() {
  const trigger = document.getElementById('change-cwd-menu-trigger');
  const details = document.getElementById('change-cwd-details');
  const menu = document.getElementById('change-cwd-menu');
  const manualPath = getManualChangeCwdPath();
  const selectedPath = getSelectedChangeCwdPath();
  const itemNodes = Array.from(menu?.querySelectorAll('.change-cwd-menu-item[data-path]') || []);
  let selectedItem = null;
  for (const item of itemNodes) {
    const itemPath = normalizeKnownCwdPath(item.getAttribute('data-path') || '');
    const selected = itemPath && itemPath.toLowerCase() === selectedPath.toLowerCase();
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-checked', selected ? 'true' : 'false');
    if (selected) selectedItem = item;
  }
  if (trigger) {
    if (selectedPath) {
      trigger.textContent = selectedPath;
      trigger.title = selectedPath;
    } else {
      trigger.textContent = 'Select a known CWD';
      trigger.title = 'Select a known CWD';
    }
  }
  if (details) {
    const label = String(selectedItem?.getAttribute('data-label') || '').trim();
    const note = String(selectedItem?.getAttribute('data-note') || '').trim();
    if (manualPath) {
      details.textContent = `Manual path: ${manualPath}`;
      return;
    }
    if (!selectedPath) {
      details.textContent = 'No known CWDs are available yet.';
      return;
    }
    const labelPrefix = label ? `${label}: ` : '';
    const noteSuffix = note ? ` (${note})` : '';
    details.textContent = `${labelPrefix}${selectedPath}${noteSuffix}`;
  }
}

function bindChangeCwdPicker() {
  const modalBody = document.getElementById('summary-modal-body');
  const manualInput = document.getElementById('change-cwd-manual-path');
  const trigger = document.getElementById('change-cwd-menu-trigger');
  const menu = document.getElementById('change-cwd-menu');
  const selectionInput = document.getElementById('change-cwd-selected-path');
  if (!modalBody || !trigger || !menu || !selectionInput) return;
  if (modalBody.dataset.changeCwdPickerModalBound !== '1') {
    modalBody.dataset.changeCwdPickerModalBound = '1';
    modalBody.addEventListener('click', (event) => {
      const picker = document.getElementById('change-cwd-picker');
      if (!picker || picker.contains(event.target)) return;
      closeChangeCwdMenu();
    });
    modalBody.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const activeMenu = document.getElementById('change-cwd-menu');
      if (!activeMenu || activeMenu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      closeChangeCwdMenu();
    });
  }
  bindTapAction(trigger, (event) => {
    event.preventDefault();
    event.stopPropagation();
    const willOpen = !!menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  trigger.addEventListener('keydown', (event) => {
    if (!['Enter', ' ', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      closeChangeCwdMenu();
      return;
    }
    const willOpen = !!menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });
  menu.addEventListener('keydown', (event) => {
    // This is a touch-first picker: keep virtual/mobile keyboard events from
    // activating a menu item behind the browser's native focus handling.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      closeChangeCwdMenu();
      trigger.focus();
    }
  });
  for (const item of menu.querySelectorAll('.change-cwd-menu-item[data-path]')) {
    bindMenuAction(item, (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pathValue = normalizeKnownCwdPath(item.getAttribute('data-path') || '');
      selectionInput.value = pathValue;
      syncChangeCwdPickerView();
      closeChangeCwdMenu();
    });
  }
  if (manualInput && manualInput.dataset.changeCwdInputBound !== '1') {
    manualInput.dataset.changeCwdInputBound = '1';
    manualInput.addEventListener('input', () => {
      syncChangeCwdPickerView();
    });
  }
  syncChangeCwdPickerView();
}

function getSelectedConversationWorkspaceState() {
  return getConversationWorkspaceState(currentConvId) || null;
}

function getSelectedConversationCurrentCwd() {
  return normalizeKnownCwdPath(getConversationCurrentWorkspaceRootPath(currentConvId) || '');
}

export function syncChatHeaderWorkspaceLabel() {
  const labelEl = document.getElementById('chat-title-cwd');
  if (!labelEl) return;
  const convId = String(currentConvId || '').trim();
  const cwd = getSelectedConversationCurrentCwd();
  if (!convId || !cwd) {
    labelEl.hidden = true;
    labelEl.textContent = '';
    labelEl.removeAttribute('title');
    return;
  }
  labelEl.hidden = false;
  labelEl.textContent = cwd;
  labelEl.title = cwd;
}

function getCurrentLaunchableSessionId() {
  const conversation = conversations?.[currentConvId] || null;
  return String(conversation?.sdkSessionId || conversation?.sdk_session_id || '').trim();
}

function isSelectedSessionRunning() {
  const conversation = conversations?.[currentConvId] || null;
  const status = String(conversation?.runtimeSessionStatus || conversation?.runtime_session_status || '').trim().toLowerCase();
  return ['starting', 'ready', 'processing'].includes(status);
}

export function openChangeCwdModal() {
  const options = buildKnownCwdOptions();
  const workspaceState = getSelectedConversationWorkspaceState();
  const currentCwd = normalizeKnownCwdPath(workspaceState?.currentWorkspaceRootPath || '');
  const nextLaunchCwd = normalizeKnownCwdPath(workspaceState?.configuredWorkspaceRootPath || '');
  const defaultPath = nextLaunchCwd || normalizeKnownCwdPath(getRepoBrowserLaunchCwdPath()) || currentCwd || normalizeKnownCwdPath(workspaceRootPath) || options[0]?.path || '';
  const menuItemsHtml = renderKnownCwdMenuItems(options, defaultPath);
  const launchableSessionId = getCurrentLaunchableSessionId();
  const launchDisabledReason = !launchableSessionId
    ? 'Open a conversation with a bound session before launching.'
    : (isSelectedSessionRunning() ? 'Ready sessions will restart in the selected CWD. Active turns must finish first.' : '');
  openSummaryModal({
    title: 'Change CWD',
    subtitle: 'Select a known launch directory',
    kind: 'change-cwd',
    bodyHtml: `
      <p style="margin-bottom:10px;color:var(--muted);line-height:1.45">
        Pick the selected session's launch directory. An idle CLI restarts in the selected CWD; active turns must finish first.
      </p>
      <div style="display:grid;gap:4px;margin-bottom:10px;font-size:0.78rem;color:var(--muted)">
        <div><strong style="color:var(--text)">Current CWD:</strong> ${escHtml(currentCwd || 'Unknown')}</div>
        <div><strong style="color:var(--text)">Next launch:</strong> ${escHtml(nextLaunchCwd || currentCwd || 'Unknown')}</div>
      </div>
      <label class="change-cwd-picker" style="margin-bottom:10px;font-size:0.84rem;color:var(--muted)">
        <span>Manual path</span>
        <input id="change-cwd-manual-path" class="change-cwd-manual-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Manual path">
      </label>
      <label id="change-cwd-picker" class="change-cwd-picker" style="font-size:0.84rem;color:var(--muted)">
        <span>Known CWDs</span>
        <input id="change-cwd-selected-path" type="hidden" value="${escHtml(defaultPath)}">
        <button id="change-cwd-menu-trigger" class="change-cwd-menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="change-cwd-menu">Select a known CWD</button>
        <div id="change-cwd-menu" class="change-cwd-menu-panel" role="menu" tabindex="-1" hidden>
          ${menuItemsHtml}
        </div>
      </label>
      <div id="change-cwd-details" style="margin-top:10px;font-size:0.78rem;color:var(--muted);line-height:1.45;word-break:break-word"></div>
      <div class="summary-modal-actions" id="change-cwd-actions">
        <button class="summary-btn" type="button" onclick="confirmChangeCwd()">🗂️ Save next-launch CWD</button>
        <button class="summary-btn" type="button" ${launchableSessionId ? 'onclick="confirmChangeCwdAndLaunch()"' : 'disabled'} title="${escHtml(launchDisabledReason || 'Set the CWD and (re)launch the current session worker')}">🚀 Set new CWD and (re)launch</button>
        <button class="summary-close" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
  // Shield the action buttons from stray click events that arrive just after the
  // modal opens (e.g. click fires after pointerup-triggered modal in some browsers,
  // or the 300ms synthetic touch-click lands on a button at the same coordinates).
  const cwdActionsEl = document.getElementById('change-cwd-actions');
  if (cwdActionsEl) cwdActionsEl.style.pointerEvents = 'none';
  window.setTimeout(() => {
    bindChangeCwdPicker();
    const el = document.getElementById('change-cwd-actions');
    if (el) el.style.pointerEvents = '';
  }, 350);
}

export async function confirmChangeCwd() {
  await submitChangeCwd(false);
}

export async function confirmChangeCwdAndLaunch() {
  await submitChangeCwd(true);
}

async function submitChangeCwd(launchAfterChange = false) {
  if (changeCwdInFlight) return;
  const targetPath = getEffectiveChangeCwdPath();
  if (!targetPath) {
    alert('Enter a manual path or select a known CWD first.');
    return;
  }
  const launchableSessionId = launchAfterChange ? getCurrentLaunchableSessionId() : '';
  if (launchAfterChange && !launchableSessionId) {
    alert('Open a conversation with a bound session before launching.');
    return;
  }
  changeCwdInFlight = true;
  setSummaryModalLoading(true);
  try {
    const result = launchAfterChange
      ? await relaunchSessionWorkerWithWorkspaceRoot(currentConvId, targetPath)
      : await updateWorkspaceRoot(targetPath, currentConvId);
    if (!result) {
      alert('Failed to update the launch CWD');
      return;
    }
    deps.applyConversationWorkspaceRootUpdate({
      conversationId: currentConvId,
      ...result,
    });
    const updatedPath = result.configuredWorkspaceRootPath || result.currentWorkspaceRootPath || result.workspaceRootPath || targetPath;
    if (launchAfterChange) {
      closeSummaryModal();
      showTransientRelayNotice(`CWD set to ${updatedPath} and CLI (re)launch requested.`);
      await deps.refreshSessionWorkerStatus().catch(() => {});
      return;
    }
    closeSummaryModal();
    showTransientRelayNotice(isSelectedSessionRunning()
      ? `Next launch CWD saved as ${updatedPath}. The running CLI keeps its current CWD.`
      : `Next launch CWD saved as ${updatedPath}.`);
  } catch (error) {
    alert(error?.message || 'Failed to update the launch CWD');
  } finally {
    changeCwdInFlight = false;
    setSummaryModalLoading(false);
  }
}

export function bindTapAction(element, handler) {
  if (!element || element.dataset.tapBound === '1') return;
  element.dataset.tapBound = '1';
  let suppressClickUntil = 0;
  const markSuppressed = (ms = 450) => {
    suppressClickUntil = Date.now() + Math.max(200, Number(ms) || 450);
  };
  element.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    markSuppressed();
    handler(event);
  });
  element.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    handler(event);
  });
}

export function bindMenuAction(element, handler) {
  if (!element || element.dataset.menuTapBound === '1') return;
  element.dataset.menuTapBound = '1';
  let suppressClickUntil = 0;
  const markSuppressed = (ms = 450) => {
    suppressClickUntil = Date.now() + Math.max(200, Number(ms) || 450);
  };
  element.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    markSuppressed();
    handler(event);
  }, true);
  element.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    handler(event);
  }, true);
}
