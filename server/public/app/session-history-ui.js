// Wires session-history.mjs to the page: the popstate listener, the
// overlays it watches, the document title, and the hooks the open path calls
// (journal-view.js). Before initSessionHistory() runs (the shared reader, the
// unit tests) every hook here does nothing.

import { conversations } from './store.js';
import { closeContextMenu } from './context-menu.mjs';
import { isStatusViewActive, toggleStatusView } from './status-view.mjs';
import {
  armVisitBaseOnFirstInteraction,
  createGoneList,
  createOverlayWatch,
  createSessionHistory,
} from './session-history.mjs';

const PHONE_QUERY = '(max-width: 680px)';

let sessionHistory = null;
let baseTitle = '';
// The relay knew no conversation the page tried to open, and said so: the
// empty screen stays until the reader opens one (no question jumps in).
let autoOpenHeld = false;

function tabStorage() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

// Kept in the tab across reloads, as its history is.
const goneConversationIds = createGoneList({ storage: tabStorage() });

function isPhone() {
  try {
    return !!window.matchMedia?.(PHONE_QUERY)?.matches;
  } catch {
    return false;
  }
}

function titleFor(id) {
  if (!id) return baseTitle;
  return String(conversations[id]?.title || '').trim() || baseTitle;
}

function setDocumentTitle(id) {
  const next = titleFor(id);
  if (document.title !== next) document.title = next;
}

const isVisible = (element) => !!element?.classList?.contains('visible');
const isShown = (element) => !!element && !element.hidden;
const byId = (id) => () => document.getElementById(id);

/**
 * The Inbox's and Status's closer, told where to go back to: the session the
 * history stands on. One view opened from the other has no session of its
 * own to return to (the first one had already left it).
 */
function backToSession(close) {
  if (typeof close !== 'function') return undefined;
  return () => close({ returnTo: sessionHistory?.conversation || '' });
}

/**
 * Each overlay back closes before it switches sessions: `find()` names its
 * element (null while there is none: some are built on first use), `isOpen`
 * reads it. `closers` come from bootstrap.js, which holds most of them.
 * Opened in the same moment, the earlier one in this list lies below.
 */
function overlayDescriptors(closers) {
  return [
    { name: 'sidebar', find: byId('sidebar'), isOpen: (el) => isPhone() && !!el?.classList?.contains('open'), close: closers.closeSidebar },
    // The Inbox takes the transcript's place: back leaves it for the session it came from.
    { name: 'inbox', find: () => document.body, isOpen: (el) => !!el?.classList?.contains('inbox-view-active'), close: backToSession(closers.closeInboxView) },
    // Status the same way.
    { name: 'status', find: () => document.body, isOpen: (el) => !!el?.classList?.contains('status-view-active'), close: backToSession(closers.closeStatusView) },
    { name: 'composer-settings', find: byId('composer-settings'), isOpen: isShown, close: closers.closeComposerSettings },
    { name: 'chat-actions-menu', find: byId('chat-actions-menu'), isOpen: isShown, close: closers.closeChatActionsMenu },
    { name: 'summary-modal', find: byId('summary-modal'), isOpen: isVisible, close: closers.closeSummaryModal },
    // The Change CWD dialog's list of known folders (inside the summary modal).
    {
      name: 'change-cwd-menu',
      find: byId('change-cwd-menu'),
      isOpen: (el) => isShown(el) && isVisible(document.getElementById('summary-modal')),
      close: closers.closeChangeCwdMenu,
    },
    { name: 'settings-modal', find: byId('settings-modal'), isOpen: isVisible, close: closers.closeSettingsModal },
    { name: 'message-search-modal', find: byId('message-search-modal'), isOpen: isVisible, close: closers.closeMessageSearchModal },
    { name: 'repo-browser-modal', find: byId('repo-browser-modal'), isOpen: isVisible, close: closers.closeRepoBrowser },
    { name: 'new-conversation-model-modal', find: byId('new-conversation-model-modal'), isOpen: isVisible, close: closers.closeNewConversationModelModal },
    { name: 'git-changes-modal', find: byId('git-changes-modal'), isOpen: isVisible, close: closers.closeGitChangesModal },
    { name: 'git-diff-modal', find: byId('git-diff-modal'), isOpen: isVisible, close: closers.closeGitDiffViewer },
    { name: 'tmux-inspector-modal', find: byId('tmux-inspector-modal'), isOpen: isVisible, close: closers.closeTmuxInspector },
    { name: 'image-annotate-modal', find: byId('image-annotate-modal'), isOpen: isVisible, close: closers.closeAnnotateEditor },
    { name: 'relay-watch-panel', find: byId('relay-watch-panel'), isOpen: isShown, close: closers.closeRelayWatchPanel },
    { name: 'relay-schedule-panel', find: byId('relay-schedule-panel'), isOpen: isShown, close: closers.closeRelaySchedulePanel },
    { name: 'emoji-popup', find: byId('emoji-popup'), isOpen: isVisible, close: closers.closeEmojiPicker },
    // A row's menu (right-click, long press, ⓘ): on <body> while open.
    { name: 'context-menu', find: () => document.querySelector('body > .context-menu'), isOpen: (el) => !!el, close: closeContextMenu },
  ];
}

// Where the overlays built on first use appear: the panels and the row menu
// on <body>, the folder list inside the summary modal.
const OVERLAY_HOSTS = [
  ['body', { attributes: true, attributeFilter: ['class'], childList: true }],
  ['summary-modal', { attributes: true, attributeFilter: ['class', 'hidden'], childList: true, subtree: true }],
];

function watchOverlays(closers) {
  const overlays = overlayDescriptors(closers)
    .filter((descriptor) => typeof descriptor.close === 'function')
    .map((descriptor) => ({
      name: descriptor.name,
      find: descriptor.find,
      isOpen: () => {
        const element = descriptor.find();
        return !!element && descriptor.isOpen(element);
      },
      close: () => descriptor.close(),
    }));
  const watch = createOverlayWatch({
    overlays,
    onOpened: (overlay) => sessionHistory?.overlayOpened(overlay),
    onClosed: (name) => sessionHistory?.overlayClosed(name),
  });
  if (typeof MutationObserver === 'function') {
    const observed = new WeakSet();
    let observer = null;
    const observe = (element, options = { attributes: true, attributeFilter: ['class', 'hidden'] }) => {
      if (!element || observed.has(element)) return;
      observed.add(element);
      observer.observe(element, options);
    };
    // An overlay's element built since: watched from now on.
    const observeOverlays = () => {
      for (const overlay of overlays) {
        const element = overlay.find();
        if (element && element !== document.body) observe(element);
      }
    };
    observer = new MutationObserver(() => {
      observeOverlays();
      watch.check();
    });
    for (const [id, options] of OVERLAY_HOSTS) {
      observe(id === 'body' ? document.body : document.getElementById(id), options);
    }
    observeOverlays();
  }
  // The sidebar is an overlay on a phone only.
  try {
    window.matchMedia?.(PHONE_QUERY)?.addEventListener?.('change', () => watch.check());
  } catch {}
}

// Leaving Status goes back to the conversation it was opened from, or else
// to `returnTo`.
function closeStatusViewDefault({ returnTo = '' } = {}) {
  if (isStatusViewActive()) void toggleStatusView({ returnTo });
}

export function initSessionHistory({ openConversation, ...given } = {}) {
  if (sessionHistory || typeof window === 'undefined' || !window.history) return sessionHistory;
  const closers = { closeStatusView: closeStatusViewDefault, ...given };
  baseTitle = document.title;
  sessionHistory = createSessionHistory({
    history: window.history,
    location: window.location,
    open: (id) => {
      void Promise.resolve(openConversation?.(id, { history: 'none' })).catch(() => {});
    },
    isGone: (id) => goneConversationIds.has(id),
    // Only where the list is an overlay: on a wide screen (a phone turned)
    // openSidebar would un-collapse the desktop sidebar for good.
    onList: () => { if (isPhone()) closers.openSidebar?.(); },
    onLeaveList: () => closers.closeSidebar?.(),
    setTitle: setDocumentTitle,
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle),
  });
  window.addEventListener('popstate', () => sessionHistory.onPopState());
  watchOverlays(closers);
  return sessionHistory;
}

/** After the back guard's arming, so the list entry lies above its floor. */
export function armSessionHistoryOnFirstInteraction(target = window) {
  if (!sessionHistory) return null;
  return armVisitBaseOnFirstInteraction({ target, sessionHistory, isPhone });
}

/** The entry the back guard pushes again above its floor. */
export function sessionHistoryEntryAgain() {
  return sessionHistory ? sessionHistory.entryAgain() : null;
}

/** openConversation's hook: `mode` is 'push' (default), 'replace' or 'none'. */
export function noteConversationShown(id, mode = 'push') {
  if (String(id || '').trim()) autoOpenHeld = false;
  sessionHistory?.shown(id, { mode: mode || 'push' });
}

/** Nothing is open any more (the open one was deleted). */
export function noteConversationCleared() {
  sessionHistory?.shown(null, { mode: 'replace' });
}

/** A deleted conversation: back and forward step over its entries. */
export function noteConversationGone(id) {
  goneConversationIds.add(id);
}

/**
 * The relay knows no conversation `id` (deleted elsewhere, a wrong link):
 * its entries are stepped over from now on. True when back or forward led
 * onto it and history steps on past it; false when the caller clears the
 * view (and with it the entry and the address).
 */
export function noteConversationMissing(id) {
  goneConversationIds.add(id);
  // Nothing opens by itself after the notice, until the reader opens one.
  autoOpenHeld = true;
  return sessionHistory ? sessionHistory.missing(id) : false;
}

/**
 * True after an unknown conversation left the view empty and said so, until
 * the next conversation opens: a waiting question does not open its own in
 * the meantime (ask-user-view.js).
 */
export function isConversationAutoOpenHeld() {
  return autoOpenHeld;
}

/**
 * The session the history stands on: the one the Inbox or Status was opened
 * over, though the store holds none while either shows.
 */
export function sessionHistoryConversation() {
  return sessionHistory?.conversation || '';
}

/** The open conversation was renamed. */
export function syncSessionDocumentTitle() {
  if (sessionHistory) setDocumentTitle(sessionHistory.conversation);
}
