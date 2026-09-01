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
  summaryModalState,
} from './store.js';
import { updateWorkspaceRoot, relaunchSessionWorkerWithWorkspaceRoot } from './api-client.js';
import { getRepoBrowserLaunchCwdPath, openRepoBrowserForCwdPick } from './attachments-view.js';
import {
  resolveActiveOptionIndex,
  resolveCwdMenuPlacement,
  resolveTypeaheadIndex,
} from './cwd-menu-placement.mjs';
import {
  buildKnownCwdOptions as buildKnownCwdOptionsFromInputs,
  normalizeKnownCwdPath,
} from './known-cwd-options.mjs';

export { normalizeKnownCwdPath };

const LEGACY_KNOWN_CWD_HISTORY_KEY = 'copilot_known_cwds';
const MOBILE_PICKER_MEDIA_QUERY = '(max-width: 680px)';
const TYPEAHEAD_RESET_MS = 700;

let changeCwdInFlight = false;

// --- Known-CWD picker state -------------------------------------------------
// Invariant: nothing in this picker changes DOM layout, visibility or state on
// pointerdown/pointerup. Every state change happens in a click or keydown
// handler, so the synthetic click that follows a touch has nothing left to
// trigger and can never land on the action buttons below the panel.
let menuOpen = false;
let activeIndex = -1;
let typeaheadBuffer = '';
let typeaheadAt = 0;
let repositionBound = false;
let modalBodyBound = false;
let sawPointerDownInBody = false;

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

export function clearLegacyKnownCwdHistoryStorage() {
  try {
    localStorage.removeItem(LEGACY_KNOWN_CWD_HISTORY_KEY);
  } catch {}
}

function buildKnownCwdOptions() {
  return buildKnownCwdOptionsFromInputs({
    currentSessionCwd: getSelectedConversationCurrentCwd(),
    workspaceRootPath,
    browserCwd: getRepoBrowserLaunchCwdPath(),
    recentRoots: getRecentWorkspaceRoots(),
  });
}

function renderKnownCwdMenuItems(options, selectedPath) {
  if (!options.length) {
    return '<div class="change-cwd-menu-empty">No known CWDs available</div>';
  }
  const selectedKey = normalizeKnownCwdPath(selectedPath).toLowerCase();
  // role="option" divs, not buttons: a <button> is an invalid listbox child, and
  // under aria-activedescendant the options must not be focusable.
  return options.map((option, index) => {
    const optionPath = normalizeKnownCwdPath(option.path);
    const selected = optionPath.toLowerCase() === selectedKey;
    return `
      <div class="change-cwd-menu-item${selected ? ' selected' : ''}" role="option" id="change-cwd-option-${index}" aria-selected="${selected ? 'true' : 'false'}" data-path="${escHtml(optionPath)}" data-label="${escHtml(option.label || '')}" data-note="${escHtml(option.note || '')}" title="${escHtml(optionPath)}">
        <span class="change-cwd-menu-item-primary">${escHtml(option.label || 'Known CWD')}</span>
        <span class="change-cwd-menu-item-secondary">${escHtml(optionPath)}</span>
      </div>
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

function getPickerEls() {
  return {
    modalBody: document.getElementById('summary-modal-body'),
    picker: document.getElementById('change-cwd-picker'),
    trigger: document.getElementById('change-cwd-menu-trigger'),
    triggerText: document.getElementById('change-cwd-trigger-text'),
    panel: document.getElementById('change-cwd-menu'),
    backdrop: document.getElementById('change-cwd-menu-backdrop'),
    selectionInput: document.getElementById('change-cwd-selected-path'),
    manualInput: document.getElementById('change-cwd-manual-path'),
  };
}

function getOptionEls() {
  const panel = document.getElementById('change-cwd-menu');
  return Array.from(panel?.querySelectorAll('.change-cwd-menu-item[data-path]') || []);
}

function isMobilePickerViewport() {
  try {
    return !!window.matchMedia?.(MOBILE_PICKER_MEDIA_QUERY)?.matches;
  } catch {
    return false;
  }
}

function positionChangeCwdMenu() {
  const { trigger, panel } = getPickerEls();
  if (!trigger || !panel || panel.hidden) return;
  if (isMobilePickerViewport()) {
    // The bottom-sheet layout comes entirely from the media query. Inline styles
    // set by a previous desktop-width render would otherwise override it.
    panel.style.removeProperty('left');
    panel.style.removeProperty('top');
    panel.style.removeProperty('width');
    panel.style.removeProperty('max-height');
    return;
  }
  const triggerRect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;
  // Two passes: size the panel first so its natural height can be measured,
  // then anchor it (and possibly flip it above the trigger).
  panel.style.left = `${Math.round(triggerRect.left)}px`;
  panel.style.top = '0px';
  panel.style.width = `${Math.round(triggerRect.width)}px`;
  panel.style.removeProperty('max-height');
  const placement = resolveCwdMenuPlacement({
    triggerRect,
    viewportWidth,
    viewportHeight,
    panelHeight: panel.scrollHeight,
  });
  panel.style.left = `${Math.round(placement.left)}px`;
  panel.style.top = `${Math.round(placement.top)}px`;
  panel.style.width = `${Math.round(placement.width)}px`;
  panel.style.maxHeight = `${Math.round(placement.maxHeight)}px`;
}

function bindRepositionListeners() {
  if (repositionBound) return;
  repositionBound = true;
  // Capture phase so scrolling inside .summary-body (which does not bubble) counts.
  window.addEventListener('scroll', positionChangeCwdMenu, true);
  window.addEventListener('resize', positionChangeCwdMenu);
  window.visualViewport?.addEventListener?.('resize', positionChangeCwdMenu);
  window.visualViewport?.addEventListener?.('scroll', positionChangeCwdMenu);
}

function unbindRepositionListeners() {
  if (!repositionBound) return;
  repositionBound = false;
  window.removeEventListener('scroll', positionChangeCwdMenu, true);
  window.removeEventListener('resize', positionChangeCwdMenu);
  window.visualViewport?.removeEventListener?.('resize', positionChangeCwdMenu);
  window.visualViewport?.removeEventListener?.('scroll', positionChangeCwdMenu);
}

function setActiveOption(index, { scroll = true } = {}) {
  const { trigger } = getPickerEls();
  const items = getOptionEls();
  activeIndex = Number.isInteger(index) && index >= 0 && index < items.length ? index : -1;
  items.forEach((item, itemIndex) => {
    item.classList.toggle('active', itemIndex === activeIndex);
  });
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null;
  if (trigger) {
    if (activeItem?.id) trigger.setAttribute('aria-activedescendant', activeItem.id);
    else trigger.removeAttribute('aria-activedescendant');
  }
  if (activeItem && scroll) activeItem.scrollIntoView({ block: 'nearest' });
}

function getSelectedOptionIndex() {
  const selectedPath = getSelectedChangeCwdPath().toLowerCase();
  if (!selectedPath) return -1;
  return getOptionEls().findIndex((item) => (
    normalizeKnownCwdPath(item.getAttribute('data-path') || '').toLowerCase() === selectedPath
  ));
}

function moveActiveOption(delta) {
  setActiveOption(resolveActiveOptionIndex(activeIndex, delta, getOptionEls().length));
}

function openChangeCwdMenu() {
  const { trigger, panel, backdrop, manualInput } = getPickerEls();
  if (!trigger || !panel || !getOptionEls().length) return;
  menuOpen = true;
  panel.hidden = false;
  if (backdrop) backdrop.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  // Drop the virtual keyboard so it cannot resize the viewport under the sheet.
  if (isMobilePickerViewport()) manualInput?.blur?.();
  positionChangeCwdMenu();
  const selectedIndex = getSelectedOptionIndex();
  setActiveOption(selectedIndex >= 0 ? selectedIndex : 0);
  bindRepositionListeners();
}

function closeChangeCwdMenu({ focusTrigger = false } = {}) {
  const { trigger, panel, backdrop } = getPickerEls();
  menuOpen = false;
  typeaheadBuffer = '';
  if (panel) panel.hidden = true;
  if (backdrop) backdrop.hidden = true;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }
  for (const item of getOptionEls()) item.classList.remove('active');
  activeIndex = -1;
  unbindRepositionListeners();
  if (focusTrigger) trigger?.focus?.({ preventScroll: true });
}

function commitOptionElement(item) {
  const { selectionInput } = getPickerEls();
  if (!item || !selectionInput) return;
  selectionInput.value = normalizeKnownCwdPath(item.getAttribute('data-path') || '');
  syncChangeCwdPickerView();
  closeChangeCwdMenu({ focusTrigger: true });
}

function handleTriggerTypeahead(event) {
  const now = Date.now();
  if (now - typeaheadAt > TYPEAHEAD_RESET_MS) typeaheadBuffer = '';
  typeaheadAt = now;
  typeaheadBuffer += event.key.toLowerCase();
  const entries = getOptionEls().map((item) => ({
    label: item.getAttribute('data-label') || '',
    path: item.getAttribute('data-path') || '',
  }));
  // Re-search from the current option when the buffer grows, so repeated
  // keystrokes refine the match instead of skipping past it.
  const from = typeaheadBuffer.length > 1 ? activeIndex - 1 : activeIndex;
  const match = resolveTypeaheadIndex(entries, typeaheadBuffer, from);
  if (match >= 0) setActiveOption(match);
}

function handleTriggerKeydown(event) {
  const items = getOptionEls();
  if (!items.length) return;
  const key = event.key;

  if (key === 'Escape') {
    if (!menuOpen) return;
    event.preventDefault();
    event.stopPropagation();
    closeChangeCwdMenu({ focusTrigger: true });
    return;
  }
  if (key === 'Tab') {
    // Let focus move naturally; just collapse without committing.
    if (menuOpen) closeChangeCwdMenu();
    return;
  }
  if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
    // The trigger is a native <button>, so suppress the click it would emit.
    event.preventDefault();
    event.stopPropagation();
    if (!menuOpen) openChangeCwdMenu();
    else if (activeIndex >= 0) commitOptionElement(items[activeIndex]);
    else closeChangeCwdMenu({ focusTrigger: true });
    return;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    if (key === 'ArrowUp' && event.altKey) {
      if (menuOpen) closeChangeCwdMenu({ focusTrigger: true });
      return;
    }
    if (!menuOpen) {
      openChangeCwdMenu();
      if (getSelectedOptionIndex() < 0) setActiveOption(key === 'ArrowUp' ? items.length - 1 : 0);
      return;
    }
    moveActiveOption(key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (key === 'Home' || key === 'End') {
    event.preventDefault();
    event.stopPropagation();
    if (!menuOpen) openChangeCwdMenu();
    setActiveOption(key === 'Home' ? 0 : items.length - 1);
    return;
  }
  if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    event.stopPropagation();
    if (!menuOpen) openChangeCwdMenu();
    handleTriggerTypeahead(event);
  }
}

function syncChangeCwdPickerView() {
  const { triggerText, trigger } = getPickerEls();
  const details = document.getElementById('change-cwd-details');
  const manualPath = getManualChangeCwdPath();
  const manualKey = manualPath.toLowerCase();
  const selectedPath = getSelectedChangeCwdPath();
  const selectedKey = selectedPath.toLowerCase();
  let selectedItem = null;
  let manualMatchItem = null;
  for (const item of getOptionEls()) {
    const itemPath = normalizeKnownCwdPath(item.getAttribute('data-path') || '');
    const itemKey = itemPath.toLowerCase();
    const selected = !!itemKey && itemKey === selectedKey;
    const manualMatch = !!itemKey && !!manualKey && itemKey === manualKey;
    item.classList.toggle('selected', selected || manualMatch);
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) selectedItem = item;
    if (manualMatch) manualMatchItem = item;
  }
  if (triggerText) {
    triggerText.textContent = selectedPath || 'Select a known CWD';
    if (trigger) trigger.title = selectedPath || 'Select a known CWD';
  }
  if (details) {
    if (manualPath) {
      const matchLabel = String(manualMatchItem?.getAttribute('data-label') || '').trim();
      details.textContent = matchLabel
        ? `Manual path: ${manualPath} — same as "${matchLabel}"`
        : `Manual path: ${manualPath}`;
      return;
    }
    if (!selectedPath) {
      details.textContent = 'No known CWDs are available yet.';
      return;
    }
    const label = String(selectedItem?.getAttribute('data-label') || '').trim();
    const note = String(selectedItem?.getAttribute('data-note') || '').trim();
    const labelPrefix = label ? `${label}: ` : '';
    const noteSuffix = note ? ` (${note})` : '';
    details.textContent = `${labelPrefix}${selectedPath}${noteSuffix}`;
  }
}

function bindChangeCwdPicker() {
  const { modalBody, trigger, panel, backdrop, selectionInput, manualInput } = getPickerEls();
  if (!modalBody || !trigger || !panel || !selectionInput) return;

  // #summary-modal-body outlives every modal, so it is bound exactly once. Its
  // handlers no-op unless the change-cwd picker is the modal currently mounted.
  if (!modalBodyBound) {
    modalBodyBound = true;
    modalBody.addEventListener('pointerdown', () => { sawPointerDownInBody = true; }, true);
    modalBody.addEventListener('pointercancel', () => { sawPointerDownInBody = false; }, true);
    modalBody.addEventListener('click', (event) => {
      if (summaryModalState.kind !== 'change-cwd') return;
      const armed = sawPointerDownInBody;
      sawPointerDownInBody = false;
      // event.detail === 0 means keyboard or programmatic activation.
      if (event.detail === 0 || armed) return;
      // A trusted click with no matching pointerdown in this modal is a ghost:
      // the gesture that produced it started somewhere else (e.g. on the chat
      // menu item that opened this modal). Drop it.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, true);
    modalBody.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !menuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      closeChangeCwdMenu({ focusTrigger: true });
    });
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menuOpen) closeChangeCwdMenu({ focusTrigger: true });
    else openChangeCwdMenu();
  });
  trigger.addEventListener('keydown', handleTriggerKeydown);

  // Delegated: the only pointer-driven activation path in this picker.
  panel.addEventListener('click', (event) => {
    const item = event.target?.closest?.('.change-cwd-menu-item[data-path]');
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    commitOptionElement(item);
  });
  panel.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    const item = event.target?.closest?.('.change-cwd-menu-item[data-path]');
    if (!item) return;
    const index = getOptionEls().indexOf(item);
    if (index >= 0 && index !== activeIndex) setActiveOption(index, { scroll: false });
  });

  backdrop?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeChangeCwdMenu();
  });

  manualInput?.addEventListener('input', () => {
    syncChangeCwdPickerView();
  });

  document.getElementById('change-cwd-browse-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menuOpen) closeChangeCwdMenu();
    // The picked path lands in the manual input, which already wins over the
    // known-CWD selection in getEffectiveChangeCwdPath.
    openRepoBrowserForCwdPick((pickedPath) => {
      const { manualInput: manual } = getPickerEls();
      if (manual) manual.value = pickedPath;
      syncChangeCwdPickerView();
    });
  });

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
      <div class="change-cwd-picker" style="margin-bottom:10px">
        <label class="change-cwd-picker-label" for="change-cwd-manual-path">Manual path</label>
        <div class="cwd-browse-row">
          <input id="change-cwd-manual-path" class="change-cwd-manual-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Manual path">
          <button id="change-cwd-browse-btn" class="cwd-browse-btn" type="button" title="Pick a folder with the file explorer" aria-label="Pick a folder with the file explorer">📁</button>
        </div>
      </div>
      <div id="change-cwd-picker" class="change-cwd-picker">
        <span id="change-cwd-picker-label" class="change-cwd-picker-label">Known CWDs</span>
        <input id="change-cwd-selected-path" type="hidden" value="${escHtml(defaultPath)}">
        <button id="change-cwd-menu-trigger" class="change-cwd-menu-trigger" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="change-cwd-menu" aria-labelledby="change-cwd-picker-label change-cwd-trigger-text"${options.length ? '' : ' disabled'}>
          <span id="change-cwd-trigger-text" class="change-cwd-menu-trigger-text">Select a known CWD</span>
          <span class="change-cwd-menu-trigger-caret" aria-hidden="true">▾</span>
        </button>
        <div id="change-cwd-menu-backdrop" class="change-cwd-menu-backdrop" hidden></div>
        <div id="change-cwd-menu" class="change-cwd-menu-panel" role="listbox" aria-labelledby="change-cwd-picker-label" hidden>
          ${menuItemsHtml}
        </div>
      </div>
      <div id="change-cwd-details" style="margin-top:10px;font-size:0.78rem;color:var(--muted);line-height:1.45;word-break:break-word"></div>
      <div class="summary-modal-actions" id="change-cwd-actions">
        <button class="summary-btn" type="button" onclick="confirmChangeCwd()">🗂️ Save next-launch CWD</button>
        <button class="summary-btn" type="button" ${launchableSessionId ? 'onclick="confirmChangeCwdAndLaunch()"' : 'disabled data-keep-disabled="1"'} title="${escHtml(launchDisabledReason || 'Set the CWD and (re)launch the current session worker')}">🚀 Set new CWD and (re)launch</button>
        <button class="summary-close" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
  // Bind synchronously: the picker must be live from the first frame. Stray
  // clicks are handled structurally (see bindChangeCwdPicker), not by a timer.
  sawPointerDownInBody = false;
  bindChangeCwdPicker();
}

function newChangeCwdRequestId() {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return `cwd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      ? await relaunchSessionWorkerWithWorkspaceRoot(currentConvId, targetPath, newChangeCwdRequestId())
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
      showTransientRelayNotice(result.workspaceRootApplied === false
        ? `CWD saved as ${updatedPath}, but the running CLI kept its current directory. Stop it and launch again to apply.`
        : `CWD set to ${updatedPath} and CLI relaunched.`);
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

