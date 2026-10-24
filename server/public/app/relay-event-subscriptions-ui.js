// Relay event subscriptions on the page: the header's "watching N sessions"
// chip with its list and Unsubscribe buttons (on the watcher), and the
// "watched" badge (on a watched session, in the header and the sidebar).
// The relay sends the whole active list on every change (socket
// `relay_event_subscriptions`); the page loads it once at start.

import { apiFetch } from './api-client.js';
import { conversations, currentConvId, escHtml, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';
import {
  renderWatchedBadgeHtml,
  renderWatchingPanelHtml,
  watchersOf,
  watchingChipHint,
  watchingChipText,
  watchingSummary,
} from './relay-event-view.mjs';

let subscriptions = [];
let renderedChipKey = '';
let panelOpen = false;
let panelConversationId = '';
const changeListeners = new Set();

export function getRelayEventSubscriptions() {
  return subscriptions;
}

/** Runs after every change of the list (the sidebar re-renders its badges). */
export function onRelayEventSubscriptionsChanged(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function applyRelayEventSubscriptions(list) {
  subscriptions = Array.isArray(list) ? list.filter((sub) => sub && typeof sub === 'object') : [];
  syncRelayEventHeader();
  for (const listener of changeListeners) {
    try { listener(subscriptions); } catch {}
  }
}

export async function loadRelayEventSubscriptions() {
  if (IS_SHARED_VIEW) return;
  const response = await apiFetch('/api/relay-events/subscriptions');
  if (response && Array.isArray(response.subscriptions)) applyRelayEventSubscriptions(response.subscriptions);
}

/** The sidebar's badge for one conversation: listed sessions only. */
export function relayEventWatchedMarkerHtml(conversationId) {
  if (IS_SHARED_VIEW) return '';
  return renderWatchedBadgeHtml(watchersOf(subscriptions, conversationId, { includeAll: false }), { conversations, subscriptions, escHtml });
}

async function unsubscribe(subscriptionId, button) {
  if (!subscriptionId) return;
  if (button) button.disabled = true;
  const response = await apiFetch(`/api/relay-events/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
  if (!response?.ok) {
    if (button) button.disabled = false;
    showTransientRelayNotice?.('The subscription could not be ended. Try again in a moment.');
    return;
  }
  // The socket brings the new list; this page does not wait for it.
  applyRelayEventSubscriptions(subscriptions.filter((sub) => sub.id !== subscriptionId));
}

// The list opens as a fixed popover on <body>, placed under the chip: the
// title slot clips its overflow (that keeps the title's ellipsis), so a panel
// inside it would be cut off.
function ensurePanel() {
  let panel = document.getElementById('relay-watch-panel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'relay-watch-panel';
  panel.className = 'relay-watch-panel';
  panel.hidden = true;
  document.body.appendChild(panel);
  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const unsubscribeButton = target?.closest?.('.relay-watch-unsubscribe');
    if (!unsubscribeButton) return;
    void unsubscribe(unsubscribeButton.getAttribute('data-subscription-id'), unsubscribeButton);
  });
  document.addEventListener('click', (event) => {
    if (!panelOpen) return;
    // composedPath: an Unsubscribe click may have re-rendered the panel already.
    const path = event.composedPath();
    if (path.includes(panel) || path.some((node) => node instanceof Element && node.classList.contains('relay-watch-chip'))) return;
    setPanelOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!panelOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    setPanelOpen(false);
    document.querySelector('#chat-title-relay-events .relay-watch-chip')?.focus?.();
  }, true);
  window.addEventListener('resize', () => { if (panelOpen) placePanel(); });
  return panel;
}

function setPanelOpen(open) {
  panelOpen = Boolean(open);
  renderedChipKey = '';
  syncRelayEventHeader();
}

function placePanel() {
  const panel = document.getElementById('relay-watch-panel');
  const chip = document.querySelector('#chat-title-relay-events .relay-watch-chip');
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
  let line = document.getElementById('chat-title-relay-events');
  if (!line) {
    line = document.createElement('span');
    line.id = 'chat-title-relay-events';
    line.hidden = true;
    const origin = document.getElementById('chat-title-origin');
    if (origin?.nextSibling) slot.insertBefore(line, origin.nextSibling);
    else slot.appendChild(line);
    line.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest?.('.relay-watch-chip')) {
        event.stopPropagation();
        setPanelOpen(!panelOpen);
      }
    });
  }
  return line;
}

/** The header's chip and badge for the conversation on screen. Idempotent. */
export function syncRelayEventHeader() {
  const line = ensureHeaderElements();
  if (!line) return;
  const panel = ensurePanel();
  const id = String(currentConvId || '').trim();
  // Another conversation on screen closes the list.
  if (id !== panelConversationId) panelOpen = false;
  panelConversationId = id;
  if (IS_SHARED_VIEW || !id) {
    line.hidden = true;
    line.innerHTML = '';
    panel.hidden = true;
    panel.innerHTML = '';
    renderedChipKey = '';
    return;
  }
  const summary = watchingSummary(subscriptions, id);
  const chipText = watchingChipText(summary);
  const chipHint = chipText ? watchingChipHint(summary) : '';
  const watchers = watchersOf(subscriptions, id, { includeAll: true });
  if (!chipText) panelOpen = false;
  const key = JSON.stringify([id, chipText, chipHint, panelOpen, summary.subscriptions.map((sub) => [sub.id, sub.sessions, sub.events]), watchers]);
  if (key === renderedChipKey) return;
  renderedChipKey = key;
  const parts = [];
  if (chipText) {
    const where = summary.relays.length ? ` (also on ${summary.relays.join(', ')})` : '';
    parts.push(`<button type="button" class="relay-watch-chip" aria-expanded="${panelOpen ? 'true' : 'false'}" aria-controls="relay-watch-panel" title="${escHtml(`Event subscriptions of this conversation${where}`)}">👁 ${escHtml(chipText)}${chipHint ? ` <span class="relay-watch-hint">${escHtml(chipHint)}</span>` : ''}</button>`);
  }
  const badge = renderWatchedBadgeHtml(watchers, { conversations, subscriptions, escHtml });
  if (badge) parts.push(badge);
  line.innerHTML = parts.join('');
  line.hidden = parts.length === 0;
  panel.innerHTML = panelOpen ? renderWatchingPanelHtml(summary, { conversations, escHtml }) : '';
  panel.hidden = !panelOpen;
  if (panelOpen) placePanel();
}
