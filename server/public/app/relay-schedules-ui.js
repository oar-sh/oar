// Relay schedules on the page: the header's "N scheduled" chip with its list
// and Cancel buttons (on a conversation a schedule fires into or that set
// one), and the "Scheduled" line in the sidebar row's ⓘ menu of a
// conversation a schedule fires into. The relay sends the whole active list on every change
// (socket `relay_schedules`); the page loads it once at start.

import { apiFetch } from './api-client.js';
import { FONT_SCALE_CHANGE_EVENT, getUiScale } from './font-scaling.js';
import { isOpeningGestureClick } from './tap-actions.js';
import { conversations, currentConvId, escHtml, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';
import {
  nextScheduledAt,
  renderScheduleChipHtml,
  renderSchedulePanelHtml,
  scheduleChipText,
  scheduledInfoText,
  schedulesOf,
} from './relay-schedule-view.mjs';

let schedules = [];
let renderedChipKey = '';
let panelOpen = false;
let panelConversationId = '';
// What the open list hangs from when the chip has no box (phone landscape
// hides the meta line): the ︙ button its menu entry was picked from.
let panelAnchor = null;
// When the list last opened: the touch that opened it from ︙ still has its
// click to come.
let panelOpenedAt = 0;
const changeListeners = new Set();

/** The schedule chip's text for a conversation ("2 scheduled"), or '' when it has none. */
export function relayScheduleChipText(conversationId) {
  const id = String(conversationId || '').trim();
  if (IS_SHARED_VIEW || !id) return '';
  return scheduleChipText(schedulesOf(schedules, id));
}

/**
 * Opens the schedule chip's list, as a tap on the chip does, from elsewhere
 * (the ︙ entry in phone landscape). `anchor` places it while the chip is
 * not drawn.
 */
export function openRelaySchedulePanel({ anchor = null } = {}) {
  ensurePanel();
  setPanelOpen(true, { anchor });
}

/** Closes the schedule chip's list (back closes it before anything else). */
export function closeRelaySchedulePanel() {
  if (panelOpen) setPanelOpen(false);
}

/** Runs after every change of the list (the sidebar re-renders its markers). */
export function onRelaySchedulesChanged(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function applyRelaySchedules(list) {
  schedules = Array.isArray(list) ? list.filter((schedule) => schedule && typeof schedule === 'object') : [];
  syncRelayScheduleHeader();
  for (const listener of changeListeners) {
    try { listener(schedules); } catch {}
  }
}

export async function loadRelaySchedules() {
  if (IS_SHARED_VIEW) return;
  const response = await apiFetch('/api/relay-schedules');
  if (response && Array.isArray(response.schedules)) applyRelaySchedules(response.schedules);
}

/** The line of the sidebar row's ⓘ menu for one conversation, or ''. */
export function relayScheduleInfoText(conversationId) {
  if (IS_SHARED_VIEW) return '';
  return scheduledInfoText(schedules, conversationId);
}

async function cancelSchedule(scheduleId, button) {
  if (!scheduleId) return;
  if (button) button.disabled = true;
  const response = await apiFetch(`/api/relay-schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
  if (!response?.ok) {
    if (button) button.disabled = false;
    showTransientRelayNotice?.('The schedule could not be cancelled. Try again in a moment.');
    return;
  }
  // The socket brings the new list; this page does not wait for it.
  applyRelaySchedules(schedules.filter((schedule) => schedule.id !== scheduleId));
}

// A fixed popover on <body>, placed under the chip, like the subscriptions'
// list: the title slot clips its overflow. Opened from ︙ (phone landscape,
// no chip drawn), it hangs from ︙ instead.
function ensurePanel() {
  let panel = document.getElementById('relay-schedule-panel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'relay-schedule-panel';
  panel.className = 'relay-watch-panel';
  panel.hidden = true;
  document.body.appendChild(panel);
  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const cancelButton = target?.closest?.('.relay-schedule-cancel');
    if (!cancelButton) return;
    void cancelSchedule(cancelButton.getAttribute('data-schedule-id'), cancelButton);
  });
  document.addEventListener('click', (event) => {
    if (!panelOpen || isOpeningGestureClick(event, panelOpenedAt)) return;
    // composedPath: a Cancel click may have re-rendered the panel already.
    const path = event.composedPath();
    if (path.includes(panel) || (panelAnchor && path.includes(panelAnchor)) || path.some((node) => node instanceof Element && node.classList.contains('relay-schedule-chip'))) return;
    setPanelOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!panelOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    const anchor = panelAnchor;
    setPanelOpen(false);
    const chip = document.querySelector('#chat-title-relay-schedules .relay-schedule-chip');
    (chip?.getClientRects?.().length ? chip : anchor || chip)?.focus?.();
  }, true);
  window.addEventListener('resize', () => { if (panelOpen) placePanel(); });
  window.addEventListener(FONT_SCALE_CHANGE_EVENT, () => { if (panelOpen) placePanel(); });
  return panel;
}

function setPanelOpen(open, { anchor = null } = {}) {
  if (open && !panelOpen) panelOpenedAt = Date.now();
  panelOpen = Boolean(open);
  panelAnchor = panelOpen ? anchor : null;
  renderedChipKey = '';
  syncRelayScheduleHeader();
}

// A box to place against, or null: an element that is not drawn has none.
function drawnRect(element) {
  const rect = element?.getBoundingClientRect?.();
  return rect && (rect.width || rect.height) ? rect : null;
}

function placePanel() {
  const panel = document.getElementById('relay-schedule-panel');
  const chip = document.querySelector('#chat-title-relay-schedules .relay-schedule-chip');
  if (!panel || panel.hidden) return;
  // Under the chip; with no chip drawn, under the anchor, right edges lined up.
  const chipRect = drawnRect(chip);
  const rect = chipRect || drawnRect(panelAnchor);
  if (!rect) {
    panel.hidden = true;
    return;
  }
  // 8px edge, 4px gap and a 120px floor at 100 %, scaled with the zoom.
  const scale = getUiScale();
  const margin = 8 * scale;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const top = Math.round(rect.bottom + 4 * scale);
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${Math.round(Math.max(120 * scale, window.innerHeight - top - margin))}px`;
  panel.style.left = '0px';
  const width = panel.offsetWidth;
  const preferred = chipRect ? rect.left : rect.right - width;
  const left = Math.max(margin, Math.min(preferred, viewportWidth - width - margin));
  panel.style.left = `${Math.round(left)}px`;
}

function ensureHeaderElements() {
  // Beside the other meta lines in #chat-title-meta; the slot is the fallback.
  const slot = document.getElementById('chat-title-meta') || document.getElementById('chat-title-slot');
  if (!slot) return null;
  let line = document.getElementById('chat-title-relay-schedules');
  if (!line) {
    line = document.createElement('span');
    line.id = 'chat-title-relay-schedules';
    line.hidden = true;
    const after = document.getElementById('chat-title-relay-events') || document.getElementById('chat-title-origin');
    if (after?.parentNode === slot && after.nextSibling) slot.insertBefore(line, after.nextSibling);
    else slot.appendChild(line);
    line.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest?.('.relay-schedule-chip')) {
        event.stopPropagation();
        setPanelOpen(!panelOpen);
      }
    });
  }
  return line;
}

/** The header's chip for the conversation on screen. Idempotent. */
export function syncRelayScheduleHeader() {
  const line = ensureHeaderElements();
  if (!line) return;
  const panel = ensurePanel();
  const id = String(currentConvId || '').trim();
  // Another conversation on screen closes the list.
  if (id !== panelConversationId) panelOpen = false;
  panelConversationId = id;
  const mine = IS_SHARED_VIEW || !id ? [] : schedulesOf(schedules, id);
  const chipText = scheduleChipText(mine);
  if (!chipText) panelOpen = false;
  const key = JSON.stringify([id, chipText, panelOpen, mine.map((schedule) => [schedule.id, schedule.nextFireAt, schedule.skippedCount || 0])]);
  if (key === renderedChipKey) return;
  renderedChipKey = key;
  if (!chipText) {
    line.hidden = true;
    line.innerHTML = '';
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  const next = nextScheduledAt(mine);
  const nextText = next ? new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  line.innerHTML = renderScheduleChipHtml(mine, { panelOpen, nextText, escHtml });
  line.hidden = false;
  panel.innerHTML = panelOpen ? renderSchedulePanelHtml(schedules, id, { conversations, escHtml }) : '';
  panel.hidden = !panelOpen;
  if (panelOpen) placePanel();
}
