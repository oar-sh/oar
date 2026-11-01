// Relay event subscriptions on the page: the header's "watching N sessions"
// chip with its list and Unsubscribe buttons (on the watcher), the "watched"
// badge in a watched session's header, and the "Watched by" line in its
// sidebar row's ⓘ menu.
// The relay sends the whole active list on every change (socket
// `relay_event_subscriptions`); the page loads it once at start.

import { apiFetch } from './api-client.js';
import { FONT_SCALE_CHANGE_EVENT, getUiScale } from './font-scaling.js';
import { isOpeningGestureClick } from './tap-actions.js';
import { conversations, currentConvId, escHtml, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';
import {
  renderWatchedBadgeHtml,
  renderWatchingChipHtml,
  renderWatchingPanelHtml,
  watchedInfoText,
  watchersOf,
  watchingChipHint,
  watchingChipText,
  watchingSummary,
} from './relay-event-view.mjs';

let subscriptions = [];
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

export function getRelayEventSubscriptions() {
  return subscriptions;
}

/** The watching chip's text for a conversation ("watching 2 sessions"), or '' when it has none. */
export function relayWatchingChipText(conversationId) {
  const id = String(conversationId || '').trim();
  if (IS_SHARED_VIEW || !id) return '';
  return watchingChipText(watchingSummary(subscriptions, id));
}

/**
 * Opens the watching chip's list, as a tap on the chip does, from elsewhere
 * (the ︙ entry in phone landscape). `anchor` places it while the chip is
 * not drawn.
 */
export function openRelayWatchPanel({ anchor = null } = {}) {
  ensurePanel();
  setPanelOpen(true, { anchor });
}

/** Closes the watching chip's list (back closes it before anything else). */
export function closeRelayWatchPanel() {
  if (panelOpen) setPanelOpen(false);
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

/** The line of the sidebar row's ⓘ menu for one conversation, or '': listed sessions only. */
export function relayEventWatchedInfoText(conversationId) {
  if (IS_SHARED_VIEW) return '';
  return watchedInfoText(watchersOf(subscriptions, conversationId, { includeAll: false }), { conversations, subscriptions });
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
// inside it would be cut off. Opened from ︙ (phone landscape, no chip
// drawn), it hangs from ︙ instead.
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
    if (!panelOpen || isOpeningGestureClick(event, panelOpenedAt)) return;
    // composedPath: an Unsubscribe click may have re-rendered the panel already.
    const path = event.composedPath();
    if (path.includes(panel) || (panelAnchor && path.includes(panelAnchor)) || path.some((node) => node instanceof Element && node.classList.contains('relay-watch-chip'))) return;
    setPanelOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!panelOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    const anchor = panelAnchor;
    setPanelOpen(false);
    const chip = document.querySelector('#chat-title-relay-events .relay-watch-chip');
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
  syncRelayEventHeader();
}

// A box to place against, or null: an element that is not drawn has none.
function drawnRect(element) {
  const rect = element?.getBoundingClientRect?.();
  return rect && (rect.width || rect.height) ? rect : null;
}

function placePanel() {
  const panel = document.getElementById('relay-watch-panel');
  const chip = document.querySelector('#chat-title-relay-events .relay-watch-chip');
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
  // The meta lines under the title live in #chat-title-meta (one sideways
  // scrolling row on a phone); the slot itself is the fallback.
  const slot = document.getElementById('chat-title-meta') || document.getElementById('chat-title-slot');
  if (!slot) return null;
  let line = document.getElementById('chat-title-relay-events');
  if (!line) {
    line = document.createElement('span');
    line.id = 'chat-title-relay-events';
    line.hidden = true;
    const origin = document.getElementById('chat-title-origin');
    if (origin?.parentNode === slot && origin.nextSibling) slot.insertBefore(line, origin.nextSibling);
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
  if (chipText) parts.push(renderWatchingChipHtml(summary, { panelOpen, escHtml }));
  const badge = renderWatchedBadgeHtml(watchers, { conversations, subscriptions, escHtml });
  if (badge) parts.push(badge);
  line.innerHTML = parts.join('');
  line.hidden = parts.length === 0;
  panel.innerHTML = panelOpen ? renderWatchingPanelHtml(summary, { conversations, escHtml }) : '';
  panel.hidden = !panelOpen;
  if (panelOpen) placePanel();
}
