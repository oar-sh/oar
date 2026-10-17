// The transcript's jump-to-bottom button, and the re-pin that keeps a reader
// who follows the end at the end when the transcript resizes under them.
// Decisions live in transcript-jump-bottom.mjs; this module reads the
// scroller and the rows and applies them.
//
// The transcript moves by itself in two cases only: the reader is at the
// end, or the reader has just sent something. Both are asked here, before
// the row is put on the page: followsTranscriptEnd() by every live update,
// ownSendFollows() by the reader's own sends. "At the end" is one margin
// everywhere (resolveNearBottomThresholdPx). An update that is not followed
// leaves the transcript where it is; what it added marks the button.
//
// Following the end has no state of its own: every live update asks
// followsTranscriptEnd() before it appends and scrolls. When the composer grows
// (the background-task panel appears or opens, a banner, a taller draft) the
// transcript shrinks from below, scrollTop stays and no scroll event fires,
// so the reader is left that many pixels above the end and the next update
// stops following. The ResizeObserver here puts them back before paint.

import { currentConvId, isMessagesNearBottom, scrollBottom } from './store.js';
import { isConversationWindowAtTail } from './conversation-view.js';
import { disarmThinkingFollow, getThinkingFollowMode, syncThinkingFollowButtons } from './thinking-follow.js';
import { resolveNearBottomThresholdPx } from './transcript-viewport-anchor.mjs';
import {
  createViewportBaseline,
  isOnScreenKeyboardOpen,
  shouldHoldFocusOnJump,
} from './composer-keyboard.mjs';
import {
  isScrollOnSendEnabled,
  isNearBottom,
  jumpButtonPresentation,
  jumpScrollBehavior,
  nextJumpButtonState,
  shouldRepinOnResize,
  transcriptRowKey,
} from './transcript-jump-bottom.mjs';

// The final snap of a smooth jump where the browser has no scrollend event.
const SMOOTH_JUMP_FALLBACK_MS = 900;
// A card that waits for the reader: a question or an approval, or a board
// whose actions are still open.
const WAITING_CARD_SELECTOR = '.relay-question-container, .relay-board-inline .relay-board-actions';
const STATUS_ID = 'jump-to-bottom-status';

let initialized = false;
let state = null;
let stateConversationId = '';
// The reader followed the end as of the last scroll event, at this scrollTop.
let pinned = true;
let pinnedScrollTop = 0;
// The transcript's height as of the last ResizeObserver round.
let observedClientHeight = null;
let jump = null;
let updateScheduled = false;
let loadConversationEnd = null;
// Counts the times the reader left the end: a scroll that took the position
// up and away from it, whatever caused it (a wheel, a drag, a key with the
// focus anywhere, the scrollbar). An input that moves nothing is none: a
// wheel notch at the end, a key typed into a card. What scrolls to the end on
// the reader's behalf after their own send checks that this has not happened
// since.
let readerMoveEpoch = 0;
let lastScrollTop = 0;
const endLeftListeners = new Set();

function scroller() {
  return document.getElementById('messages');
}

function distanceFromBottom(el) {
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

function rowKeys(el) {
  const keys = [];
  for (const node of el.children) {
    if (!node.classList?.contains('msg')) continue;
    const key = transcriptRowKey({
      messageId: node.dataset.messageId,
      live: node.id === 'thinking-indicator',
    });
    if (key) keys.push(key);
  }
  return keys;
}

// Whether a waiting card lies wholly below what the reader sees.
function questionWaitingBelow(el) {
  const bottom = el.getBoundingClientRect().bottom;
  for (const card of el.querySelectorAll(WAITING_CARD_SELECTOR)) {
    if (card.getBoundingClientRect().top >= bottom) return true;
  }
  return false;
}

// What a screen reader hears when the button changes its state: the button's
// own label is only read once it has the focus.
function statusRegion(button) {
  let region = document.getElementById(STATUS_ID);
  if (region || !button?.parentNode) return region;
  region = document.createElement('div');
  region.id = STATUS_ID;
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;';
  button.parentNode.insertBefore(region, button.nextSibling);
  return region;
}

function render(next) {
  const button = document.getElementById('jump-to-bottom-btn');
  if (!button) return;
  const shown = jumpButtonPresentation(next || {});
  button.classList.toggle('visible', next?.visible === true);
  if (button.dataset.state !== shown.state) button.dataset.state = shown.state;
  const badge = button.querySelector('.jump-to-bottom-badge');
  if (badge) {
    if (badge.textContent !== shown.badge) badge.textContent = shown.badge;
    badge.classList.toggle('jump-to-bottom-badge-dot', shown.dot);
    badge.hidden = !shown.badge && !shown.dot;
  }
  if (button.getAttribute('aria-label') !== shown.label) {
    button.setAttribute('aria-label', shown.label);
    button.title = shown.label;
  }
  const region = statusRegion(button);
  if (region && region.textContent !== shown.announcement) region.textContent = shown.announcement;
}

function syncStateConversation() {
  const conversationId = String(currentConvId || '').trim();
  if (conversationId !== stateConversationId) {
    state = null;
    stateConversationId = conversationId;
  }
  return conversationId;
}

function update() {
  updateScheduled = false;
  const el = scroller();
  if (!el) return;
  const conversationId = syncStateConversation();
  if (!conversationId || jump) {
    render(null);
    return;
  }
  notePositionAfterContentChange(el);
  const distance = distanceFromBottom(el);
  const nearBottomPx = resolveNearBottomThresholdPx(el.clientHeight);
  const away = !isNearBottom(distance, nearBottomPx);
  state = nextJumpButtonState(state, {
    distance,
    clientHeight: el.clientHeight,
    nearBottomPx,
    rowKeys: away ? rowKeys(el) : [],
    question: away && questionWaitingBelow(el),
  });
  render(state);
}

function scheduleUpdate() {
  if (updateScheduled) return;
  updateScheduled = true;
  requestAnimationFrame(update);
}

/** A card or a board was put on the page, or taken off it. */
export function refreshJumpButton() {
  scheduleUpdate();
}

/**
 * `listener` runs when a reader who followed the end is found away from it
 * without having scrolled: content landed that was not followed. Whoever
 * keeps "at the end" from the last scroll event lets go of it then.
 */
export function onTranscriptEndLeft(listener) {
  if (typeof listener === 'function') endLeftListeners.add(listener);
}

/**
 * Asked by every live update before it changes the transcript: true when
 * the reader is at the end and the update scrolls with it. Otherwise the
 * transcript stays where it is. Only a question: what was really added says
 * so itself (a row is counted, anything else calls noteTranscriptNews()).
 */
export function followsTranscriptEnd() {
  return isMessagesNearBottom();
}

/**
 * Something landed below a reader who is not at the end and added no row to
 * count (a reply growing in its bubble, a thought, a tool line): the button
 * says that there is news until the reader is at the end again.
 */
export function noteTranscriptNews() {
  const el = scroller();
  if (!el || !syncStateConversation()) return;
  state = {
    visible: state?.visible === true,
    baseline: Array.isArray(state?.baseline) ? state.baseline : rowKeys(el),
    count: state?.count || 0,
    unseen: true,
    question: state?.question === true,
  };
  scheduleUpdate();
}

/**
 * The reader sends something themselves (the composer, a steer, Resend, an
 * answer on a card, a board's action): taken at that moment, before anything
 * is awaited. Nothing a relay or an agent puts into the conversation comes
 * here.
 */
export function beginOwnSend() {
  return { conversationId: String(currentConvId || '').trim(), epoch: readerMoveEpoch, follows: false };
}

/**
 * A send from the new-chat screen has no conversation; the relay's answer
 * creates it. Named here once it is on screen, so the send goes on in it and
 * in no other.
 */
export function nameOwnSendConversation(send, conversationId) {
  if (send && !send.conversationId) send.conversationId = String(conversationId || '').trim();
}

// The send is still the last thing the reader did to this conversation's
// position: it is on screen, and they have not scrolled away since.
function ownSendHolds(send) {
  return !!send
    && send.conversationId === String(currentConvId || '').trim()
    && send.epoch === readerMoveEpoch;
}

/**
 * Whether what the send puts on the page is followed to the end; asked
 * before each row and each step. A reader who is at the end is followed like
 * with anything else, whatever became of the send. The send adds one right
 * to that: while it holds, it takes the reader to the end from wherever they
 * are (unless that is switched off in the settings) and keeps them there
 * through the layout that follows it. Once the reader has scrolled away, or
 * another conversation is on screen, that right is gone.
 */
export function ownSendFollows(send) {
  const atEnd = isMessagesNearBottom();
  if (!ownSendHolds(send)) return atEnd;
  send.follows = send.follows || atEnd || isScrollOnSendEnabled();
  return send.follows;
}

/**
 * To the end after the reader's own send, and again through the layout that
 * follows it (the bubble's separator, a picture that loads, the composer
 * shrinking back): each step asks again.
 */
export function scrollAfterOwnSend(send) {
  const step = () => { if (ownSendFollows(send)) scrollBottom(); };
  step();
  requestAnimationFrame(step);
  setTimeout(step, 120);
}

// A scroll event is dispatched a frame after the scroll, before that frame's
// ResizeObserver round: when the composer grew in between, the transcript
// has already shrunk, and the reader would read as having left the end. So
// the position is judged at the height the observer last saw; a resize it
// has not handled yet is its own to judge.
function notePosition(el) {
  const height = observedClientHeight ?? el.clientHeight;
  const distance = Math.max(0, el.scrollHeight - height - el.scrollTop);
  pinned = isNearBottom(distance, resolveNearBottomThresholdPx(height));
  pinnedScrollTop = el.scrollTop;
}

// The content changed without a scroll event. A reader who followed the end
// and is away from it now was not followed (rows landed while they held a
// selection, a card grew): a later resize must not take them to the end.
function notePositionAfterContentChange(el) {
  const followed = pinned;
  notePosition(el);
  if (!followed || pinned) return;
  for (const listener of endLeftListeners) {
    try { listener(); } catch {}
  }
}

function endJump() {
  if (!jump) return;
  jump.cleanup();
  jump = null;
}

// Rows that landed during the animation were not followed (the reader was
// not at the end yet): the end is wherever it is now.
function finishJump() {
  endJump();
  const el = scroller();
  scrollBottom();
  if (el) notePosition(el);
  state = null;
  scheduleUpdate();
}

function startSmoothJump(el) {
  endJump();
  // A wheel or a touch during the animation is the reader taking over.
  const takeOver = () => {
    endJump();
    notePosition(el);
    scheduleUpdate();
  };
  const timer = setTimeout(finishJump, SMOOTH_JUMP_FALLBACK_MS);
  el.addEventListener('scrollend', finishJump);
  el.addEventListener('wheel', takeOver, { passive: true });
  el.addEventListener('touchstart', takeOver, { passive: true });
  jump = {
    cleanup() {
      clearTimeout(timer);
      el.removeEventListener('scrollend', finishJump);
      el.removeEventListener('wheel', takeOver);
      el.removeEventListener('touchstart', takeOver);
    },
  };
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function jumpTranscriptToBottom() {
  const el = scroller();
  if (!el) return;
  // The end wins over a followed section of the live bubble.
  if (getThinkingFollowMode()) {
    disarmThinkingFollow();
    syncThinkingFollowButtons(document, null);
  }
  state = null;
  render(null);
  // A window in the middle of the history (a search result, a pin) ends
  // above the conversation's end: the end is loaded instead.
  if (loadConversationEnd && !isConversationWindowAtTail()) {
    endJump();
    jump = { cleanup() {} };
    void Promise.resolve()
      .then(() => loadConversationEnd())
      .catch(() => {})
      .finally(finishJump);
    return;
  }
  const behavior = jumpScrollBehavior({
    distance: distanceFromBottom(el),
    clientHeight: el.clientHeight,
    reducedMotion: prefersReducedMotion(),
  });
  if (behavior === 'smooth') startSmoothJump(el);
  else finishJump();
}

function handleScroll() {
  const el = scroller();
  if (!el) return;
  const movedUp = el.scrollTop < lastScrollTop - 1;
  lastScrollTop = el.scrollTop;
  if (jump) {
    if (distanceFromBottom(el) <= 1) finishJump();
    return;
  }
  notePosition(el);
  // `pinned` is "at the end" as of this scroll. A clamp (the page got
  // shorter) also takes scrollTop down, and ends at the end.
  if (movedUp && !pinned) readerMoveEpoch += 1;
  scheduleUpdate();
}

function handleResize() {
  const el = scroller();
  if (!el) return;
  // A followed section of the live bubble pins itself (thinking-follow.js).
  if (!jump && !getThinkingFollowMode() && distanceFromBottom(el) > 0 && shouldRepinOnResize({
    pinned,
    pinnedScrollTop,
    scrollTop: el.scrollTop,
    nearBottomNow: isMessagesNearBottom(),
  })) {
    scrollBottom();
  }
  observedClientHeight = el.clientHeight;
  notePosition(el);
  scheduleUpdate();
}

const viewportBaseline = createViewportBaseline();

function noteViewport() {
  const height = window.visualViewport?.height || window.innerHeight || 0;
  return { height, tallest: viewportBaseline.note(window.innerWidth || 0, height) };
}

function isEditableElement(node) {
  return !!node && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable === true);
}

// A tap that keeps a focused field focused raises the phone's keyboard even
// when none was showing (the composer can be focused with the keyboard
// down). So the button holds the focus for a mouse, or while the keyboard is
// open; otherwise the field lets it go.
function handleButtonPointerDown(event) {
  const active = document.activeElement;
  const { height, tallest } = noteViewport();
  const keyboardOpen = isOnScreenKeyboardOpen({
    editableFocused: isEditableElement(active),
    visibleHeight: height,
    tallestHeight: tallest,
  });
  if (shouldHoldFocusOnJump({ pointerType: event.pointerType, keyboardOpen })) {
    event.preventDefault();
    return;
  }
  if (isEditableElement(active)) {
    try { active.blur(); } catch {}
  }
}

/**
 * `loadEnd` loads the conversation's end in place of a history window; the
 * button calls it when the page holds a window in the middle of the history.
 */
export function initTranscriptJumpToBottom({ loadEnd } = {}) {
  if (typeof loadEnd === 'function') loadConversationEnd = loadEnd;
  if (initialized) return;
  const el = scroller();
  const button = document.getElementById('jump-to-bottom-btn');
  if (!el || !button) return;
  initialized = true;
  lastScrollTop = el.scrollTop;
  pinnedScrollTop = el.scrollTop;
  observedClientHeight = el.clientHeight;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    jumpTranscriptToBottom();
  });
  // With the keyboard open, a tap must not take the composer's focus (and
  // with it the keyboard) away; with it closed, it must not raise it.
  button.addEventListener('pointerdown', handleButtonPointerDown);
  noteViewport();
  window.visualViewport?.addEventListener?.('resize', noteViewport, { passive: true });
  window.addEventListener('resize', noteViewport, { passive: true });
  el.addEventListener('scroll', handleScroll, { passive: true });
  // The whole subtree: the button shows at any distance once something new
  // is below, so it also has to go when the end comes back to the reader
  // without a scroll (the live bubble folding its thoughts, a row shrinking).
  if (typeof MutationObserver === 'function') {
    new MutationObserver(scheduleUpdate).observe(el, { childList: true, subtree: true, characterData: true });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(handleResize).observe(el);
  }
  scheduleUpdate();
}
