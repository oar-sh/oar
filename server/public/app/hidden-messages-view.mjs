// Messages hidden from shared viewers: the per-conversation list, the 🙈
// header button with its count, and the list modal (the shared summary modal,
// kind 'hidden-messages') with Jump, Unhide and Unhide all. Fed by the
// conversation payload's `hiddenMessages` on load and by the
// `conversation_hidden_messages_updated` socket event (REPLACE semantics per
// conversation), so a message hidden on another device shows here without a
// reload. Once a conversation's list is known it is what a bubble's Hide /
// Unhide label is drawn from. Owner-only: nothing of it in the shared view.

import {
  IS_SHARED_VIEW,
  closeSummaryModal,
  escHtml,
  fmtDate,
  openSummaryModal,
  renderSummaryModalContent,
  showTransientRelayNotice,
  summaryModalState,
} from './store.js';
import { unhideAllMessagesFromShares, updateMessageShareVisibility } from './api-client.js';
import { jumpToPinnedMessage } from './pinned-messages-view.mjs';

export const HIDDEN_MESSAGES_MODAL_KIND = 'hidden-messages';

const hiddenByConversation = new Map();
// Ordered like the pin lists: an older list (a load that left before the
// change) must not win over the change's own socket event.
const hiddenRevisionByConversation = new Map();
// Conversations whose list arrived at least once (an empty one included).
const knownConversations = new Set();
const unhidesInFlight = new Set();
let unhideAllInFlight = false;
let confirmingUnhideAll = false;
let currentConversationId = null;
let modalBodyBound = false;
// conversation-view.js imports this module; it hands its side in through
// initHiddenMessagesView.
let handlers = {
  syncRenderedShareVisibility: null,
};

function normalizeHiddenMessages(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({ ...item, messageId: String(item?.messageId || '').trim() }))
    .filter((item) => item.messageId);
}

export function getConversationHiddenMessages(conversationId) {
  return hiddenByConversation.get(String(conversationId || '').trim()) || [];
}

// null while the conversation's list has not arrived: the caller falls back
// to what the message itself says.
export function isMessageHiddenFromShares(conversationId, messageId) {
  const conversationKey = String(conversationId || '').trim();
  const id = String(messageId || '').trim();
  if (!conversationKey || !id || !knownConversations.has(conversationKey)) return null;
  return getConversationHiddenMessages(conversationKey).some((item) => item.messageId === id);
}

export function hiddenCountLabel(count) {
  const total = Number(count) || 0;
  return total ? `${total} hidden from shared viewers` : '';
}

function roleLabel(role) {
  return String(role || '').trim().toLowerCase() === 'user' ? 'You' : 'Agent';
}

export function renderHiddenListHtml(list, { confirming = false, busy = false } = {}) {
  const items = normalizeHiddenMessages(list);
  if (!items.length) {
    return '<div class="pinned-empty">No hidden messages. Shared viewers see the whole conversation.</div>';
  }
  const count = items.length;
  const actionsHtml = confirming
    ? `<div class="hidden-unhide-all-confirm">
        <p>Show ${count === 1 ? 'this message' : `all ${count} messages`} to shared viewers again?</p>
        <div class="summary-modal-actions">
          <button type="button" class="chat-title-action-btn" data-hidden-unhide-all-confirm="1"${busy ? ' disabled' : ''}>${busy ? 'Unhiding…' : 'Unhide all'}</button>
          <button type="button" class="chat-title-action-btn" data-hidden-unhide-all-cancel="1"${busy ? ' disabled' : ''}>Cancel</button>
        </div>
      </div>`
    : `<div class="hidden-list-actions">
        <button type="button" class="chat-title-action-btn" data-hidden-unhide-all="1">Unhide all</button>
      </div>`;
  return `${actionsHtml}<div class="pinned-list">${items.map((item) => {
    const id = escHtml(item.messageId);
    const when = fmtDate(item.timestamp);
    const attachmentCount = Number(item.attachmentCount) || 0;
    const meta = [
      escHtml(roleLabel(item.role)),
      when ? escHtml(when) : '',
      attachmentCount ? `📎 ${attachmentCount}` : '',
    ].filter(Boolean).join(' · ');
    const preview = String(item.preview || '').trim();
    const previewHtml = preview
      ? escHtml(preview)
      : '<span class="pinned-row-no-text">(no text)</span>';
    const unhiding = unhidesInFlight.has(`${currentConversationId}:${item.messageId}`);
    return `
      <div class="pinned-row">
        <button type="button" class="pinned-row-jump" data-hidden-jump="${id}">
          <span class="pinned-row-meta">${meta}</span>
          <span class="pinned-row-preview">${previewHtml}</span>
        </button>
        <button type="button" class="hidden-row-unhide" data-hidden-unhide="${id}" title="Show this message to shared viewers again"${unhiding ? ' disabled' : ''}>${unhiding ? 'Unhiding…' : 'Unhide'}</button>
      </div>`;
  }).join('')}</div>`;
}

function syncHiddenHeaderButton() {
  const button = document.getElementById('hidden-messages-btn');
  if (!button) return;
  const count = getConversationHiddenMessages(currentConversationId).length;
  button.hidden = IS_SHARED_VIEW || !count;
  const countEl = button.querySelector('.header-icon-count');
  if (countEl) countEl.textContent = count ? String(count) : '';
  const label = count ? `Hidden from shared viewers (${count})` : 'Hidden from shared viewers';
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
}

function hiddenModalContent() {
  const list = getConversationHiddenMessages(currentConversationId);
  return {
    title: '🙈 Hidden messages',
    subtitle: hiddenCountLabel(list.length),
    bodyHtml: renderHiddenListHtml(list, { confirming: confirmingUnhideAll, busy: unhideAllInFlight }),
    kind: HIDDEN_MESSAGES_MODAL_KIND,
  };
}

function rerenderOpenModal() {
  if (summaryModalState.kind === HIDDEN_MESSAGES_MODAL_KIND) {
    renderSummaryModalContent(hiddenModalContent());
  }
}

function syncCurrentConversationHiddenMessages() {
  syncHiddenHeaderButton();
  if (!getConversationHiddenMessages(currentConversationId).length) confirmingUnhideAll = false;
  rerenderOpenModal();
  if (knownConversations.has(String(currentConversationId || ''))) {
    handlers.syncRenderedShareVisibility?.(
      new Set(getConversationHiddenMessages(currentConversationId).map((item) => item.messageId)),
    );
  }
}

export function setConversationHiddenMessages(conversationId, list, revision = 0) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const nextRevision = Number(revision) || 0;
  if (nextRevision) {
    if (nextRevision < (hiddenRevisionByConversation.get(id) || 0)) return;
    hiddenRevisionByConversation.set(id, nextRevision);
  }
  const normalized = normalizeHiddenMessages(list);
  const wasKnown = knownConversations.has(id);
  knownConversations.add(id);
  // The list arrives with every conversation load, the live poll included: an
  // unchanged one must not redraw the open modal under the user's finger.
  if (wasKnown && JSON.stringify(normalized) === JSON.stringify(getConversationHiddenMessages(id))) return;
  if (normalized.length) hiddenByConversation.set(id, normalized);
  else hiddenByConversation.delete(id);
  if (id === currentConversationId) syncCurrentConversationHiddenMessages();
}

export function setHiddenMessagesConversation(conversationId) {
  const id = String(conversationId || '').trim() || null;
  if (id === currentConversationId) return;
  currentConversationId = id;
  confirmingUnhideAll = false;
  // The conversation was closed (deleted, new chat): its list goes with it.
  if (!id && summaryModalState.kind === HIDDEN_MESSAGES_MODAL_KIND) closeSummaryModal();
  syncCurrentConversationHiddenMessages();
}

export function openHiddenMessagesModal() {
  if (IS_SHARED_VIEW) return;
  confirmingUnhideAll = false;
  openSummaryModal(hiddenModalContent());
}

function refusalText(result, fallback) {
  return String(result?.error || '').trim() || fallback;
}

// The answer carries the conversation's whole hidden list, stored under that
// conversation's id: if the user has switched meanwhile, the open one is not
// touched.
export async function unhideHiddenMessage(conversationId, messageId) {
  const conversationKey = String(conversationId || '').trim();
  const targetMessageId = String(messageId || '').trim();
  if (!conversationKey || !targetMessageId) return;
  const flightKey = `${conversationKey}:${targetMessageId}`;
  if (unhidesInFlight.has(flightKey)) return;

  unhidesInFlight.add(flightKey);
  if (conversationKey === currentConversationId) rerenderOpenModal();
  const result = await updateMessageShareVisibility(conversationKey, targetMessageId, false);
  unhidesInFlight.delete(flightKey);
  if (!result?.ok) {
    if (conversationKey === currentConversationId) rerenderOpenModal();
    showTransientRelayNotice(refusalText(result, 'Could not unhide the message.'));
    return;
  }
  showTransientRelayNotice('Message visible to shared viewers.');
  if ('hiddenMessages' in result) {
    setConversationHiddenMessages(conversationKey, result.hiddenMessages, result.hiddenMessagesRevision);
  }
  if (conversationKey === currentConversationId) rerenderOpenModal();
}

function skippedPreview(conversationKey, messageId) {
  const item = getConversationHiddenMessages(conversationKey).find((entry) => entry.messageId === messageId);
  const preview = String(item?.preview || '').trim();
  if (!preview) return '';
  const points = Array.from(preview);
  return points.length > 40 ? `${points.slice(0, 39).join('').trimEnd()}…` : preview;
}

export async function unhideAllHiddenMessages(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey || unhideAllInFlight) return;
  unhideAllInFlight = true;
  if (conversationKey === currentConversationId) rerenderOpenModal();
  const result = await unhideAllMessagesFromShares(conversationKey);
  unhideAllInFlight = false;
  if (conversationKey === currentConversationId) confirmingUnhideAll = false;
  if (!result?.ok) {
    if (conversationKey === currentConversationId) rerenderOpenModal();
    showTransientRelayNotice(refusalText(result, 'Could not unhide the messages.'));
    return;
  }
  const unhidden = Array.isArray(result.unhidden) ? result.unhidden.length : 0;
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  if (skipped.length) {
    // Named before the new list replaces the old one: the preview is in the old.
    const names = skipped
      .map((entry) => skippedPreview(conversationKey, String(entry?.messageId || '').trim()))
      .map((preview) => (preview ? `“${preview}”` : 'one message'))
      .join(', ');
    const lead = unhidden
      ? `${unhidden} message${unhidden === 1 ? '' : 's'} unhidden. `
      : '';
    showTransientRelayNotice(`${lead}Still hidden until its turn finishes: ${names}.`, 8000);
  } else {
    showTransientRelayNotice(unhidden
      ? `${unhidden} message${unhidden === 1 ? '' : 's'} visible to shared viewers.`
      : 'No hidden messages left.');
  }
  if ('hiddenMessages' in result) {
    setConversationHiddenMessages(conversationKey, result.hiddenMessages, result.hiddenMessagesRevision);
  }
  if (conversationKey === currentConversationId) rerenderOpenModal();
}

function handleHiddenModalClick(event) {
  if (summaryModalState.kind !== HIDDEN_MESSAGES_MODAL_KIND) return;
  const target = event.target instanceof Element ? event.target : null;
  const unhideBtn = target?.closest('[data-hidden-unhide]');
  if (unhideBtn) {
    event.preventDefault();
    void unhideHiddenMessage(currentConversationId, unhideBtn.getAttribute('data-hidden-unhide'));
    return;
  }
  if (target?.closest('[data-hidden-unhide-all]')) {
    event.preventDefault();
    confirmingUnhideAll = true;
    rerenderOpenModal();
    return;
  }
  if (target?.closest('[data-hidden-unhide-all-cancel]')) {
    event.preventDefault();
    confirmingUnhideAll = false;
    rerenderOpenModal();
    return;
  }
  if (target?.closest('[data-hidden-unhide-all-confirm]')) {
    event.preventDefault();
    void unhideAllHiddenMessages(currentConversationId);
    return;
  }
  const jumpBtn = target?.closest('[data-hidden-jump]');
  if (jumpBtn) {
    event.preventDefault();
    // The pin list's jump: scroll there, or load the window around it.
    void jumpToPinnedMessage(jumpBtn.getAttribute('data-hidden-jump'));
  }
}

export function initHiddenMessagesView(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  const button = document.getElementById('hidden-messages-btn');
  if (button && button.dataset.bound !== '1') {
    button.dataset.bound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      openHiddenMessagesModal();
    });
  }
  // #summary-modal-body outlives every modal, so it is bound exactly once; the
  // handler no-ops unless the hidden list is the modal currently mounted.
  const modalBody = document.getElementById('summary-modal-body');
  if (modalBody && !modalBodyBound) {
    modalBodyBound = true;
    modalBody.addEventListener('click', handleHiddenModalClick);
  }
  syncHiddenHeaderButton();
}
