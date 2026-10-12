// The transcript's jump-to-bottom button, and the re-pin that keeps a reader
// who follows the end at the end when the transcript resizes under them.
// Decisions live in transcript-jump-bottom.mjs; this module reads the
// scroller and the rows and applies them.
//
// Following the end has no state of its own: every live update asks
// isMessagesAtBottom() before it appends and scrolls. When the composer grows
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
  isNearBottom,
  jumpBadgeText,
  jumpScrollBehavior,
  nextJumpButtonState,
  shouldRepinOnResize,
  transcriptRowKey,
} from './transcript-jump-bottom.mjs';

// The final snap of a smooth jump where the browser has no scrollend event.
const SMOOTH_JUMP_FALLBACK_MS = 900;
const BUTTON_LABEL = 'Jump to the latest message';

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
      exchangePromptId: node.dataset.agentExchangePromptId,
      live: node.id === 'thinking-indicator',
    });
    if (key) keys.push(key);
  }
  return keys;
}

function render(visible, count) {
  const button = document.getElementById('jump-to-bottom-btn');
  if (!button) return;
  button.classList.toggle('visible', visible);
  const badge = button.querySelector('.jump-to-bottom-badge');
  const text = visible ? jumpBadgeText(count) : '';
  if (badge) {
    badge.textContent = text;
    badge.hidden = !text;
  }
  const label = text ? `${BUTTON_LABEL} (${count} new)` : BUTTON_LABEL;
  if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
}

function update() {
  updateScheduled = false;
  const el = scroller();
  if (!el) return;
  const conversationId = String(currentConvId || '').trim();
  if (conversationId !== stateConversationId) {
    state = null;
    stateConversationId = conversationId;
  }
  if (!conversationId || jump) {
    render(false, 0);
    return;
  }
  const distance = distanceFromBottom(el);
  const nearBottomPx = resolveNearBottomThresholdPx(el.clientHeight);
  state = nextJumpButtonState(state, {
    distance,
    clientHeight: el.clientHeight,
    nearBottomPx,
    rowKeys: isNearBottom(distance, nearBottomPx) ? [] : rowKeys(el),
  });
  render(state.visible, state.count);
}

function scheduleUpdate() {
  if (updateScheduled) return;
  updateScheduled = true;
  requestAnimationFrame(update);
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
  render(false, 0);
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
  if (jump) {
    if (distanceFromBottom(el) <= 1) finishJump();
    return;
  }
  notePosition(el);
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
  if (typeof MutationObserver === 'function') {
    new MutationObserver(scheduleUpdate).observe(el, { childList: true });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(handleResize).observe(el);
  }
  scheduleUpdate();
}
