// Relay schedules on the page: the header's "N scheduled" chip with its list
// and Cancel buttons (on a conversation a schedule fires into or that set
// one), and the "scheduled" marker on the sidebar row of a conversation a
// schedule fires into. The relay sends the whole active list on every change
// (socket `relay_schedules`); the page loads it once at start.

import { apiFetch } from './api-client.js';
import { conversations, currentConvId, escHtml, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';
import {
  nextScheduledAt,
  renderScheduledBadgeHtml,
  renderSchedulePanelHtml,
  scheduleChipText,
  schedulesOf,
} from './relay-schedule-view.mjs';

let schedules = [];
let renderedChipKey = '';
let panelOpen = false;
let panelConversationId = '';
const changeListeners = new Set();

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

/** The sidebar's marker for one conversation. */
export function relayScheduleMarkerHtml(conversationId) {
  if (IS_SHARED_VIEW) return '';
  return renderScheduledBadgeHtml(schedules, conversationId, { escHtml });
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
// list: the title slot clips its overflow.
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
    if (!panelOpen) return;
    // composedPath: a Cancel click may have re-rendered the panel already.
    const path = event.composedPath();
    if (path.includes(panel) || path.some((node) => node instanceof Element && node.classList.contains('relay-schedule-chip'))) return;
    setPanelOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!panelOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    setPanelOpen(false);
    document.querySelector('#chat-title-relay-schedules .relay-schedule-chip')?.focus?.();
  }, true);
  window.addEventListener('resize', () => { if (panelOpen) placePanel(); });
  return panel;
}

function setPanelOpen(open) {
  panelOpen = Boolean(open);
  renderedChipKey = '';
  syncRelayScheduleHeader();
}

function placePanel() {
  const panel = document.getElementById('relay-schedule-panel');
  const chip = document.querySelector('#chat-title-relay-schedules .relay-schedule-chip');
  if (!panel || panel.hidden) return;
  const rect = chip?.getBoundingClientRect?.();
  if (!rect || (!rect.width && !rect.height)) {
    panel.hidden = true;
    return;
  }
  const margin = 8;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const top = Math.round(rect.bottom + 4);
  panel.style.top = `${top}px`;
  panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - margin)}px`;
  panel.style.left = '0px';
  const width = panel.offsetWidth;
  const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
  panel.style.left = `${Math.round(left)}px`;
}

function ensureHeaderElements() {
  const slot = document.getElementById('chat-title-slot');
  if (!slot) return null;
  let line = document.getElementById('chat-title-relay-schedules');
  if (!line) {
    line = document.createElement('span');
    line.id = 'chat-title-relay-schedules';
    line.hidden = true;
    const after = document.getElementById('chat-title-relay-events') || document.getElementById('chat-title-origin');
    if (after?.nextSibling) slot.insertBefore(line, after.nextSibling);
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
  line.innerHTML = `<button type="button" class="relay-watch-chip relay-schedule-chip" aria-expanded="${panelOpen ? 'true' : 'false'}" aria-controls="relay-schedule-panel" title="Prompts the relay queues at set times (agents set them with relay_tool schedule)">⏰ ${escHtml(chipText)}${nextText ? ` <span class="relay-watch-hint">next ${escHtml(nextText)}</span>` : ''}</button>`;
  line.hidden = false;
  panel.innerHTML = panelOpen ? renderSchedulePanelHtml(schedules, id, { conversations, escHtml }) : '';
  panel.hidden = !panelOpen;
  if (panelOpen) placePanel();
}
