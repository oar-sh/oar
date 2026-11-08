import { mountMediaGallery } from './media-gallery-ui.js';
import { MEDIA_TEXT } from './media-gallery-model.mjs';
import { currentConvId, setCurrentConv } from './store.js';

// The global 🖼️ Media view: the media of every session of the relay, in the
// transcript's place like the Inbox (the sidebar stays on a desktop). Back,
// the menu entry again, or picking a session leaves it.

let active = false;
let gallery = null;
let previousConversationId = '';

export function isMediaViewActive() {
  return active;
}

/** Leaves the view without opening anything (openConversation calls it first). */
export function leaveMediaView() {
  if (!active) return false;
  active = false;
  gallery?.destroy();
  gallery = null;
  document.body.classList.remove('media-view-active');
  document.getElementById('input-area')?.removeAttribute('hidden');
  document.getElementById('pending-question-banner')?.removeAttribute('hidden');
  window.renderConvList?.();
  return true;
}

async function showNothingOpen() {
  const { clearOpenConversation } = await import('./journal-view.js');
  clearOpenConversation({ history: false });
}

function openInSession(media) {
  previousConversationId = '';
  void window.openConversation?.(media.conversationId, {
    aroundMessageId: media.messageId,
    focusMessageId: media.messageId,
  });
}

/**
 * Opens the view, or leaves it for the conversation it was opened from
 * (`returnTo` when it stored none, as the Inbox does).
 */
export async function toggleMediaView({ returnTo = '', leaveOthers = () => {}, fetchJson } = {}) {
  if (active) {
    leaveMediaView();
    const restoreId = previousConversationId || String(returnTo || '').trim();
    previousConversationId = '';
    if (restoreId) await window.openConversation?.(restoreId, { restoreScroll: true });
    else await showNothingOpen();
    return;
  }
  leaveOthers();
  previousConversationId = String(currentConvId || '').trim();
  active = true;
  setCurrentConv(null);
  window.renderConvList?.();
  document.body.classList.add('media-view-active');
  document.getElementById('pending-question-banner')?.setAttribute('hidden', '');
  document.getElementById('input-area')?.setAttribute('hidden', '');
  for (const id of ['chat-title-cwd', 'chat-title-session-usage']) {
    const node = document.getElementById(id);
    if (node) {
      node.textContent = '';
      node.hidden = true;
    }
  }
  const title = document.getElementById('chat-title');
  if (title) title.textContent = `🖼️ ${MEDIA_TEXT.title}`;
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
  const host = document.getElementById('messages');
  if (!host) return;
  host.scrollTop = 0;
  gallery = mountMediaGallery(host, { global: true, onOpenInSession: openInSession, ...(fetchJson ? { fetchJson } : {}) });
}
