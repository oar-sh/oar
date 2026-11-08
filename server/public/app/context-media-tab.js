import { apiFetch } from './api-client.js';
import { mountMediaGallery } from './media-gallery-ui.js';
import { MEDIA_TEXT } from './media-gallery-model.mjs';
import { closeSummaryModal, escHtml, summaryModalState } from './store.js';

// The 🧠 modal's two categories: Context (what the modal always showed, and
// what it opens on) and Media (this session's gallery, with its count on the
// tab). The modal body is re-rendered as one string on every refresh, so the
// tab choice lives here and the gallery is mounted again into its panel.

const state = {
  conversationId: '',
  tab: 'context',
  count: null,
  gallery: null,
  bound: false,
  fetchJson: (url) => apiFetch(url),
};

/** A fresh open of 🧠 starts on Context. */
export function resetContextTab(conversationId = '') {
  destroyGallery();
  state.tab = 'context';
  state.conversationId = String(conversationId || '');
  state.count = null;
}

function countLabel(count) {
  return Number.isFinite(count) ? String(count) : '';
}

/** The tab strip and the two panels around the Context body. */
export function wrapContextBody(contextHtml, conversationId) {
  const id = String(conversationId || '');
  if (id !== state.conversationId) {
    state.conversationId = id;
    state.count = null;
  }
  if (!id) return contextHtml;
  const tab = state.tab === 'media' ? 'media' : 'context';
  const tabButton = (name, label, extra = '') => `<button type="button" class="context-tab" role="tab" data-context-tab="${name}" aria-selected="${tab === name}">${label}${extra}</button>`;
  return `<div class="context-tab-strip" role="tablist">${tabButton('context', `🧠 ${escHtml(MEDIA_TEXT.tabContext)}`)}${tabButton('media', `🖼️ ${escHtml(MEDIA_TEXT.tabMedia)}`, `<span class="context-tab-count" data-context-media-count>${escHtml(countLabel(state.count))}</span>`)}</div>`
    + `<div data-context-panel="context"${tab === 'context' ? '' : ' hidden'}>${contextHtml}</div>`
    + `<div data-context-panel="media"${tab === 'media' ? '' : ' hidden'}></div>`;
}

function body() {
  return document.getElementById('summary-modal-body');
}

function showCount() {
  const node = body()?.querySelector('[data-context-media-count]');
  if (node) node.textContent = countLabel(state.count);
}

function openInSession(media) {
  closeSummaryModal();
  void window.openConversation?.(media.conversationId, {
    aroundMessageId: media.messageId,
    focusMessageId: media.messageId,
  });
}

// One gallery per open of the modal: a re-render of the modal (Refresh, a
// socket-driven refresh) moves the same gallery into the new panel, with its
// pages and scroll; leaving the modal, or opening it for another session,
// destroys it (its observer and timers go with it).
function destroyGallery() {
  state.gallery?.destroy();
  state.gallery = null;
}

function mountMediaPanel() {
  const panel = body()?.querySelector('[data-context-panel="media"]');
  if (!panel || panel.hidden) return;
  if (state.gallery && state.gallery.conversationId === state.conversationId) {
    if (state.gallery.root.parentNode !== panel) panel.replaceChildren(state.gallery.root);
    return;
  }
  destroyGallery();
  const gallery = mountMediaGallery(panel, {
    conversationId: state.conversationId,
    onOpenInSession: openInSession,
    fetchJson: state.fetchJson,
    raiseViewer: true,
  });
  state.gallery = { ...gallery, conversationId: state.conversationId };
}

/** The modal was left (closed, or replaced by another kind): the gallery goes. */
export function leaveContextTab() {
  destroyGallery();
}

/** After each render of the modal: the count (asked once per open) and the gallery when Media is showing. */
export function afterContextRender({ fetchJson = (url) => apiFetch(url) } = {}) {
  state.fetchJson = fetchJson;
  if (!state.conversationId) return;
  if (state.count === null) {
    const conversationId = state.conversationId;
    void Promise.resolve(state.fetchJson(`/api/media/counts?conversationId=${encodeURIComponent(conversationId)}`))
      .then((counts) => {
        if (conversationId !== state.conversationId || !counts) return;
        state.count = Number(counts.media) || 0;
        showCount();
      })
      .catch(() => {});
  } else {
    showCount();
  }
  mountMediaPanel();
}

function selectTab(name) {
  const root = body();
  if (!root) return;
  state.tab = name === 'media' ? 'media' : 'context';
  root.querySelectorAll('[data-context-tab]').forEach((node) => {
    node.setAttribute('aria-selected', String(node.getAttribute('data-context-tab') === state.tab));
  });
  root.querySelectorAll('[data-context-panel]').forEach((node) => {
    node.hidden = node.getAttribute('data-context-panel') !== state.tab;
  });
  mountMediaPanel();
}

/** Once: the tab clicks, delegated on the modal body (its content is replaced on every render). */
export function initContextTabs() {
  if (state.bound) return;
  const root = body();
  if (!root) return;
  state.bound = true;
  root.addEventListener('click', (event) => {
    if (summaryModalState.kind !== 'context') return;
    const target = event.target instanceof Element ? event.target.closest('[data-context-tab]') : null;
    if (!target) return;
    selectTab(target.getAttribute('data-context-tab'));
  });
}

export function contextTabState() {
  return { ...state };
}
