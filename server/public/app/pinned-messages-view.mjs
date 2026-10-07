// Pinned messages: the per-conversation pin list, the 📍 header button with
// its count, and the list modal (the shared summary modal, kind
// 'pinned-messages'). Fed by the conversation payload's `pins` on load and by
// the `conversation_pins_updated` socket event (REPLACE semantics per
// conversation), so a pin set on another device shows here without a reload.
// This list is also what a bubble's Pin / Unpin label is drawn from.

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
import { updateMessagePin } from './api-client.js';

export const PINNED_MESSAGES_MODAL_KIND = 'pinned-messages';

const pinsByConversation = new Map();
// The relay numbers its pin lists. A conversation load that left before a pin
// change can arrive after the change's own socket event: the older list must
// not win, or the page would stay wrong until the next load.
const pinRevisionByConversation = new Map();
const pinTogglesInFlight = new Set();
let currentConversationId = null;
let modalBodyBound = false;
// The transcript lives in conversation-view.js and journal-view.js, which
// import this module; they hand their side in through initPinnedMessagesView.
let handlers = {
  openConversation: null,
  focusMessage: null,
  syncRenderedPinState: null,
};

function normalizePins(pins) {
  return (Array.isArray(pins) ? pins : [])
    .map((pin) => ({ ...pin, messageId: String(pin?.messageId || '').trim() }))
    .filter((pin) => pin.messageId);
}

export function getConversationPins(conversationId) {
  return pinsByConversation.get(String(conversationId || '').trim()) || [];
}

export function isMessagePinned(conversationId, messageId) {
  const id = String(messageId || '').trim();
  return !!id && getConversationPins(conversationId).some((pin) => pin.messageId === id);
}

export function pinnedCountLabel(count) {
  const total = Number(count) || 0;
  return total ? `${total} pinned` : '';
}

function pinRoleLabel(role) {
  return String(role || '').trim().toLowerCase() === 'user' ? 'You' : 'Agent';
}

export function renderPinnedListHtml(pins) {
  const list = normalizePins(pins);
  if (!list.length) {
    return '<div class="pinned-empty">No pinned messages. Use Pin on a message to add one.</div>';
  }
  return `<div class="pinned-list">${list.map((pin) => {
    const id = escHtml(pin.messageId);
    const when = fmtDate(pin.timestamp);
    const attachmentCount = Number(pin.attachmentCount) || 0;
    const meta = [
      escHtml(pinRoleLabel(pin.role)),
      when ? escHtml(when) : '',
      attachmentCount ? `📎 ${attachmentCount}` : '',
      pin.hiddenFromShares === true ? '<span class="pinned-row-chip">hidden from shared</span>' : '',
    ].filter(Boolean).join(' · ');
    const preview = String(pin.preview || '').trim();
    const previewHtml = preview
      ? escHtml(preview)
      : '<span class="pinned-row-no-text">(no text)</span>';
    return `
      <div class="pinned-row">
        <button type="button" class="pinned-row-jump" data-pin-jump="${id}">
          <span class="pinned-row-meta">${meta}</span>
          <span class="pinned-row-preview">${previewHtml}</span>
        </button>
        <button type="button" class="pinned-row-unpin" data-pin-unpin="${id}" title="Unpin" aria-label="Unpin">🗑</button>
      </div>`;
  }).join('')}</div>`;
}

function syncPinnedHeaderButton() {
  const button = document.getElementById('pinned-messages-btn');
  if (!button) return;
  const count = getConversationPins(currentConversationId).length;
  button.hidden = IS_SHARED_VIEW || !count;
  const countEl = button.querySelector('.header-icon-count');
  if (countEl) countEl.textContent = count ? String(count) : '';
  const label = count ? `Pinned messages (${count})` : 'Pinned messages';
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
}

function pinnedModalContent() {
  const pins = getConversationPins(currentConversationId);
  return {
    title: '📍 Pinned messages',
    subtitle: pinnedCountLabel(pins.length),
    bodyHtml: renderPinnedListHtml(pins),
    kind: PINNED_MESSAGES_MODAL_KIND,
  };
}

function syncCurrentConversationPins() {
  syncPinnedHeaderButton();
  if (summaryModalState.kind === PINNED_MESSAGES_MODAL_KIND) {
    renderSummaryModalContent(pinnedModalContent());
  }
  handlers.syncRenderedPinState?.(
    new Set(getConversationPins(currentConversationId).map((pin) => pin.messageId)),
  );
}

export function setConversationPins(conversationId, pins, revision = 0) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const nextRevision = Number(revision) || 0;
  if (nextRevision) {
    if (nextRevision < (pinRevisionByConversation.get(id) || 0)) return;
    pinRevisionByConversation.set(id, nextRevision);
  }
  const normalized = normalizePins(pins);
  // The list arrives with every conversation load, the live poll included: an
  // unchanged one must not redraw the open modal under the user's finger.
  if (JSON.stringify(normalized) === JSON.stringify(getConversationPins(id))) return;
  if (normalized.length) pinsByConversation.set(id, normalized);
  else pinsByConversation.delete(id);
  if (id === currentConversationId) syncCurrentConversationPins();
}

export function setPinsConversation(conversationId) {
  const id = String(conversationId || '').trim() || null;
  if (id === currentConversationId) return;
  currentConversationId = id;
  // The conversation was closed (deleted, new chat): its list goes with it.
  if (!id && summaryModalState.kind === PINNED_MESSAGES_MODAL_KIND) closeSummaryModal();
  syncCurrentConversationPins();
}

export function openPinnedMessagesModal() {
  if (IS_SHARED_VIEW) return;
  openSummaryModal(pinnedModalContent());
}

function setPinButtonBusy(messageId, busy, pinned) {
  const button = document.querySelector(`.msg-pin-btn[data-message-id="${CSS.escape(messageId)}"]`);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy
    ? (pinned ? 'Unpinning…' : 'Pinning…')
    : (pinned ? 'Unpin' : 'Pin');
}

// `pinned` is the state the control showed when it was pressed; the request
// asks for the opposite. The answer carries the conversation's whole pin list,
// stored under that conversation's id: if the user has switched conversations
// meanwhile, the open one is not touched.
export async function toggleMessagePin(conversationId, messageId, pinned) {
  const conversationKey = String(conversationId || '').trim();
  const targetMessageId = String(messageId || '').trim();
  if (!conversationKey || !targetMessageId) return;
  const flightKey = `${conversationKey}:${targetMessageId}`;
  if (pinTogglesInFlight.has(flightKey)) return;

  pinTogglesInFlight.add(flightKey);
  setPinButtonBusy(targetMessageId, true, pinned);
  const result = await updateMessagePin(conversationKey, targetMessageId, !pinned);
  pinTogglesInFlight.delete(flightKey);
  if (!result?.ok) {
    if (conversationKey === currentConversationId) setPinButtonBusy(targetMessageId, false, pinned);
    showTransientRelayNotice(String(result?.error || '').trim() || (pinned
      ? 'Could not unpin the message.'
      : 'Could not pin the message.'));
    return;
  }

  showTransientRelayNotice(result.pinned ? 'Message pinned.' : 'Message unpinned.');
  if (conversationKey === currentConversationId) setPinButtonBusy(targetMessageId, false, result.pinned === true);
  setConversationPins(conversationKey, result.pins, result.pinsRevision);
}

function isMessageOnPage(messageId) {
  return !!document.querySelector(`#messages .msg[data-message-id="${CSS.escape(messageId)}"]`);
}

// On the page already: scroll there. Otherwise the path message search takes:
// the relay answers with the messages around the target and the history
// loaders page on from that window in both directions.
export async function jumpToPinnedMessage(messageId) {
  const targetMessageId = String(messageId || '').trim();
  const conversationId = currentConversationId;
  if (!targetMessageId || !conversationId) return;
  closeSummaryModal();
  if (handlers.focusMessage?.(targetMessageId)) return;

  await handlers.openConversation?.(conversationId, {
    aroundMessageId: targetMessageId,
    focusMessageId: targetMessageId,
  });
  if (currentConversationId !== conversationId || isMessageOnPage(targetMessageId)) return;
  showTransientRelayNotice('That message is no longer in this conversation.');
  // A message the relay no longer has answers with an empty window; put the
  // end of the conversation back instead of leaving the page blank.
  if (!document.querySelector('#messages .msg[data-message-id]')) {
    await handlers.openConversation?.(conversationId);
  }
}

function handlePinnedModalClick(event) {
  if (summaryModalState.kind !== PINNED_MESSAGES_MODAL_KIND) return;
  const target = event.target instanceof Element ? event.target : null;
  const unpinBtn = target?.closest('[data-pin-unpin]');
  if (unpinBtn) {
    event.preventDefault();
    void toggleMessagePin(currentConversationId, unpinBtn.getAttribute('data-pin-unpin'), true);
    return;
  }
  const jumpBtn = target?.closest('[data-pin-jump]');
  if (jumpBtn) {
    event.preventDefault();
    void jumpToPinnedMessage(jumpBtn.getAttribute('data-pin-jump'));
  }
}

export function initPinnedMessagesView(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  const button = document.getElementById('pinned-messages-btn');
  if (button && button.dataset.bound !== '1') {
    button.dataset.bound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      openPinnedMessagesModal();
    });
  }
  // #summary-modal-body outlives every modal, so it is bound exactly once; the
  // handler no-ops unless the pin list is the modal currently mounted.
  const modalBody = document.getElementById('summary-modal-body');
  if (modalBody && !modalBodyBound) {
    modalBodyBound = true;
    modalBody.addEventListener('click', handlePinnedModalClick);
  }
  syncPinnedHeaderButton();
}
