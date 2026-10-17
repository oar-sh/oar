// Follow modes for the live thinking bubble: 💭 thoughts, 📃 streamed answer,
// 🛠️ tool list. While a mode is armed the message pane keeps the tracked
// section's bottom edge pinned just above the composer as it grows, so the
// user can read a long reasoning stream without the answer/tool rows below
// pushing it away. Manual scrolling (wheel, touch, scroll keys, scrollbar)
// disarms the mode; typing in the composer does not. The mode is remembered
// per conversation for the life of the page.

import { isChatInteractionHeld } from './selection-guard.mjs';

export const THINKING_FOLLOW_MODES = Object.freeze(['thoughts', 'stream', 'tools']);
export const THINKING_FOLLOW_BOTTOM_GAP_PX = 16;

const FOLLOW_BUTTONS = Object.freeze([
  { mode: 'thoughts', icon: '💭', title: 'Follow the thoughts' },
  { mode: 'stream', icon: '📃', title: 'Follow the streamed answer' },
  { mode: 'tools', icon: '🛠️', title: 'Follow the tool list' },
]);

const TARGET_SELECTORS = Object.freeze({
  thoughts: '#thinking-thoughts > .thinking-thoughts-list',
  stream: '#thinking-stream',
  tools: '#thinking-activity',
});

// Keys a user presses to scroll the pane. Editable targets are excluded by the
// guard, so these only count when the pane itself (or nothing) has focus.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar']);
// A scroll event this close after our own scrollTop write is ours.
const PROGRAMMATIC_SCROLL_WINDOW_MS = 150;
const SCROLL_DRIFT_TOLERANCE_PX = 2;

const followModeByConversation = new Map();
let currentConversationIdResolver = () => '';
let onModeChanged = () => {};
let programmaticScrollTop = null;
let programmaticScrollAt = 0;
let applyScheduled = false;
let resizeObserver = null;
let mutationObserver = null;
let observedBubble = null;
let guardsInstalledOn = null;

function normalizeMode(mode) {
  const value = String(mode || '').trim();
  return THINKING_FOLLOW_MODES.includes(value) ? value : null;
}

function conversationKey(conversationId) {
  const explicit = String(conversationId || '').trim();
  if (explicit) return explicit;
  try { return String(currentConversationIdResolver() || '').trim(); } catch { return ''; }
}

export function getThinkingFollowMode(conversationId = null) {
  const key = conversationKey(conversationId);
  return key ? followModeByConversation.get(key) || null : null;
}

export function setThinkingFollowMode(conversationId, mode) {
  const key = conversationKey(conversationId);
  if (!key) return null;
  const next = normalizeMode(mode);
  const previous = followModeByConversation.get(key) || null;
  if (next) followModeByConversation.set(key, next);
  else followModeByConversation.delete(key);
  if (next !== previous) {
    try { onModeChanged({ conversationId: key, mode: next, previous }); } catch {}
  }
  return next;
}

/** Pressing the armed button disarms; pressing another switches. */
export function toggleThinkingFollowMode(conversationId, mode) {
  const current = getThinkingFollowMode(conversationId);
  const next = normalizeMode(mode);
  return setThinkingFollowMode(conversationId, current === next ? null : next);
}

export function disarmThinkingFollow(conversationId = null) {
  return setThinkingFollowMode(conversationId, null);
}

/** Markup for the three buttons; `mode` marks the armed one. */
export function renderThinkingFollowButtonsHtml(mode = null) {
  const active = normalizeMode(mode);
  const buttons = FOLLOW_BUTTONS.map(({ mode: value, icon, title }) => {
    const pressed = active === value;
    return `<button type="button" class="thinking-follow-btn${pressed ? ' active' : ''}" data-action="follow-thinking" data-follow="${value}" aria-pressed="${pressed ? 'true' : 'false'}" title="${title}" aria-label="${title}">${icon}</button>`;
  }).join('');
  return `<div class="thinking-follow-group" role="group" aria-label="Follow the live reply">${buttons}</div>`;
}

/** Update aria-pressed/active on an existing group without rebuilding it. */
export function syncThinkingFollowButtons(root = document, mode = getThinkingFollowMode()) {
  const active = normalizeMode(mode);
  const buttons = root?.querySelectorAll?.('.thinking-follow-btn[data-follow]') || [];
  for (const btn of buttons) {
    const pressed = btn.dataset.follow === active;
    btn.classList.toggle('active', pressed);
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
}

function resolveTarget(mode) {
  const selector = TARGET_SELECTORS[normalizeMode(mode)];
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  if (el.hidden || el.closest?.('[hidden]')) return null;
  // A collapsed <details> or an empty list has nothing to follow yet.
  const details = el.closest?.('details');
  if (details && !details.open) return null;
  if (!el.childElementCount && !String(el.textContent || '').trim()) return null;
  return el;
}

/**
 * scrollTop that puts `target`'s bottom edge `gapPx` above the scroller's
 * bottom edge. Pure for tests: takes rects/metrics rather than elements.
 */
export function computeFollowScrollTop({
  scrollTop,
  clientHeight,
  scrollHeight,
  scrollerTop,
  targetBottom,
  gapPx = THINKING_FOLLOW_BOTTOM_GAP_PX,
}) {
  const desiredBottomInScroller = clientHeight - gapPx;
  const targetBottomInScroller = targetBottom - scrollerTop;
  const next = scrollTop + (targetBottomInScroller - desiredBottomInScroller);
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(max, Math.round(next)));
}

export function applyThinkingFollow({ force = false } = {}) {
  const mode = getThinkingFollowMode();
  if (!mode) return false;
  const scroller = document.getElementById('messages');
  const target = resolveTarget(mode);
  if (!scroller || !target) return false;
  if (!force && isChatInteractionHeld()) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const next = computeFollowScrollTop({
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    scrollerTop: scrollerRect.top,
    targetBottom: targetRect.bottom,
  });
  if (Math.abs(next - scroller.scrollTop) <= SCROLL_DRIFT_TOLERANCE_PX) {
    programmaticScrollTop = scroller.scrollTop;
    programmaticScrollAt = Date.now();
    return true;
  }
  programmaticScrollTop = next;
  programmaticScrollAt = Date.now();
  scroller.scrollTop = next;
  return true;
}

export function scheduleThinkingFollow() {
  if (!getThinkingFollowMode()) return;
  if (applyScheduled) return;
  applyScheduled = true;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  raf(() => {
    applyScheduled = false;
    applyThinkingFollow();
  });
}

/** Watch the live bubble so any growth re-pins the tracked section. */
export function observeThinkingBubble(bubbleEl) {
  if (!bubbleEl || bubbleEl === observedBubble) return;
  unobserveThinkingBubble();
  observedBubble = bubbleEl;
  // Guards go on lazily with the first live bubble, after the pane's own
  // scroll listeners (history paging) are in place.
  installThinkingFollowScrollGuards();
  if (typeof MutationObserver === 'function') {
    mutationObserver = new MutationObserver(() => scheduleThinkingFollow());
    mutationObserver.observe(bubbleEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden', 'class'] });
  }
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => scheduleThinkingFollow());
    resizeObserver.observe(bubbleEl);
    const scroller = document.getElementById('messages');
    if (scroller) resizeObserver.observe(scroller);
  }
}

export function unobserveThinkingBubble() {
  try { mutationObserver?.disconnect(); } catch {}
  try { resizeObserver?.disconnect(); } catch {}
  mutationObserver = null;
  resizeObserver = null;
  observedBubble = null;
}

function isEditableTarget(target) {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  return false;
}

function disarmFromUserScroll() {
  if (!getThinkingFollowMode()) return;
  disarmThinkingFollow();
  syncThinkingFollowButtons(document, null);
}

/**
 * Manual scrolling in the pane disarms the mode. Installed once per scroller;
 * the composer is outside the pane so typing never trips it.
 */
export function installThinkingFollowScrollGuards(scroller = document.getElementById('messages')) {
  if (!scroller || guardsInstalledOn === scroller) return;
  guardsInstalledOn = scroller;
  scroller.addEventListener('wheel', () => disarmFromUserScroll(), { passive: true });
  scroller.addEventListener('touchmove', () => disarmFromUserScroll(), { passive: true });
  // A pointer press on the scrollbar gutter (outside the content box).
  scroller.addEventListener('pointerdown', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    if (event.offsetX > scroller.clientWidth) disarmFromUserScroll();
  });
  scroller.addEventListener('scroll', () => {
    if (!getThinkingFollowMode()) return;
    const recent = Date.now() - programmaticScrollAt <= PROGRAMMATIC_SCROLL_WINDOW_MS;
    if (recent && programmaticScrollTop !== null && Math.abs(scroller.scrollTop - programmaticScrollTop) <= SCROLL_DRIFT_TOLERANCE_PX) return;
    if (recent) return;
    // Layout shifts move scrollTop too; only a move away from the pinned
    // position counts as the user taking over.
    if (programmaticScrollTop !== null && Math.abs(scroller.scrollTop - programmaticScrollTop) <= SCROLL_DRIFT_TOLERANCE_PX) return;
    disarmFromUserScroll();
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (!getThinkingFollowMode()) return;
    if (!SCROLL_KEYS.has(event.key)) return;
    if (isEditableTarget(event.target)) return;
    disarmFromUserScroll();
  });
}

export function initThinkingFollow({ getCurrentConversationId, onChange } = {}) {
  if (typeof getCurrentConversationId === 'function') currentConversationIdResolver = getCurrentConversationId;
  if (typeof onChange === 'function') onModeChanged = onChange;
}

export function __resetThinkingFollowForTests() {
  followModeByConversation.clear();
  programmaticScrollTop = null;
  programmaticScrollAt = 0;
  applyScheduled = false;
  unobserveThinkingBubble();
  guardsInstalledOn = null;
}
