// The placeholder of a running OpenAI image turn, inside the live bubble
// (#thinking-indicator): an elapsed timer, the size, quality, count and
// model, and the newest partial of each image as the relay streams them
// (image_started, image_preview, image_preview_reset; owner pages only).
//
// It lives in the live bubble, so it goes with it: never stored, never in a
// share view (the relay sends shares no such event, and IS_SHARED_VIEW
// ignores them all the same), and never in the media gallery (which reads
// `.msg-bubble img`). The image area is sized by the size's aspect ratio from
// the start, so a partial arriving does not move the transcript.

import { BASE, IS_SHARED_VIEW, currentConvId } from './store.js';
import {
  formatImageElapsed,
  imageAspectRatio,
  imagePlaceholderDetails,
  reduceImageTurnState,
} from './openai-image-composer.mjs';

const LIVE_BUBBLE_ID = 'thinking-indicator';
const TICK_MS = 1000;

// The open conversation's image turn, or null.
let turn = null;
let timer = null;

function openConversationId() {
  return String(currentConvId || '').trim();
}

function liveBubbleFor(state) {
  if (typeof document === 'undefined' || !state) return null;
  const bubble = document.getElementById(LIVE_BUBBLE_ID);
  if (!bubble) return null;
  if (String(bubble.dataset.conversationId || '') !== state.conversationId) return null;
  const bubbleMessageId = String(bubble.dataset.messageId || '').trim();
  if (bubbleMessageId && bubbleMessageId !== state.messageId) return null;
  return bubble;
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function ensureTimer() {
  if (timer || typeof setInterval !== 'function') return;
  timer = setInterval(tick, TICK_MS);
  timer?.unref?.();
}

function tick() {
  const node = typeof document === 'undefined' ? null : document.querySelector('[data-image-placeholder]');
  if (!node || !turn) {
    stopTimer();
    return;
  }
  const clock = node.querySelector('[data-image-placeholder-timer]');
  const text = formatImageElapsed(Date.now() - (turn.startedAtMs ?? Date.now()));
  if (clock && clock.textContent !== text) clock.textContent = text;
}

function removePlaceholderNodes() {
  if (typeof document === 'undefined') return;
  for (const node of document.querySelectorAll('[data-image-placeholder]')) node.remove();
}

function buildPlaceholder(state) {
  const root = document.createElement('div');
  root.className = 'image-turn-placeholder';
  root.setAttribute('data-image-placeholder', '');
  root.setAttribute('role', 'status');
  root.innerHTML = `
    <div class="image-turn-placeholder-meta">
      <span class="image-turn-placeholder-label">Making the image</span>
      <span class="image-turn-placeholder-timer" data-image-placeholder-timer>0:00</span>
      <span class="image-turn-placeholder-retry" data-image-placeholder-retry hidden>trying again</span>
    </div>
    <div class="image-turn-placeholder-details" data-image-placeholder-details></div>
    <div class="image-turn-placeholder-grid" data-image-placeholder-grid></div>`;
  root.dataset.messageId = state.messageId;
  return root;
}

function syncGrid(grid, state) {
  const count = Math.max(1, Number(state.count) || 1);
  grid.dataset.count = String(count);
  const ratio = imageAspectRatio(state.size);
  while (grid.children.length > count) grid.lastElementChild.remove();
  for (let index = 0; index < count; index += 1) {
    let tile = grid.children[index];
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'image-turn-placeholder-tile';
      tile.dataset.imageIndex = String(index);
      grid.appendChild(tile);
    }
    if (tile.style.aspectRatio !== ratio) tile.style.aspectRatio = ratio;
    const partial = state.partials?.[index] || null;
    let img = tile.querySelector('img[data-image-placeholder-preview]');
    if (!partial) {
      img?.remove();
      tile.classList.remove('has-preview');
      continue;
    }
    if (!img) {
      img = document.createElement('img');
      img.setAttribute('data-image-placeholder-preview', '');
      img.dataset.imageIndex = String(index);
      img.alt = count > 1 ? `Preview of image ${index + 1}` : 'Preview of the image';
      img.decoding = 'async';
      tile.appendChild(img);
    }
    if (img.getAttribute('src') !== partial.url) img.setAttribute('src', partial.url);
    img.dataset.partialIndex = String(partial.partialIndex);
    tile.classList.add('has-preview');
  }
}

/**
 * Draws the open conversation's image turn into its live bubble, or takes
 * the placeholder away when there is none (or the bubble is another turn's).
 * Called after each event and whenever the live bubble is (re)built.
 */
export function renderImageTurnPlaceholder() {
  if (typeof document === 'undefined') return;
  const state = turn && turn.conversationId === openConversationId() ? turn : null;
  const bubble = liveBubbleFor(state);
  if (!state || !bubble) {
    removePlaceholderNodes();
    if (!state) stopTimer();
    return;
  }
  const host = bubble.querySelector('.thinking-bubble') || bubble;
  let node = host.querySelector('[data-image-placeholder]');
  if (node && node.dataset.messageId !== state.messageId) {
    node.remove();
    node = null;
  }
  if (!node) {
    node = buildPlaceholder(state);
    const header = host.querySelector('.thinking-bubble-header');
    if (header) header.after(node);
    else host.prepend(node);
  }
  node.dataset.attempt = String(state.attempt);
  const details = node.querySelector('[data-image-placeholder-details]');
  const detailText = imagePlaceholderDetails(state);
  if (details && details.textContent !== detailText) details.textContent = detailText;
  const retry = node.querySelector('[data-image-placeholder-retry]');
  if (retry) retry.hidden = !state.retrying;
  const grid = node.querySelector('[data-image-placeholder-grid]');
  if (grid) syncGrid(grid, state);
  tick();
  ensureTimer();
}

function accept(payload) {
  if (IS_SHARED_VIEW || !payload || typeof payload !== 'object') return false;
  const conversationId = String(payload.conversationId || '').trim();
  return !!conversationId && conversationId === openConversationId();
}

function apply(type, payload) {
  if (!accept(payload)) return;
  // Another turn of the open conversation replaces the one held.
  const held = turn && turn.conversationId === payload.conversationId ? turn : null;
  turn = reduceImageTurnState(held, type, payload, { base: BASE });
  renderImageTurnPlaceholder();
}

/** `image_started` { conversationId, messageId, attempt, size, quality, count, model, startedAt }. */
export function handleImageStarted(payload) {
  apply('started', payload);
}

/** `image_preview` { conversationId, messageId, attempt, imageIndex, partialIndex, contentUrl, … }. */
export function handleImagePreview(payload) {
  apply('preview', payload);
}

/** `image_preview_reset` { conversationId, messageId, attempt, reason }. */
export function handleImagePreviewReset(payload) {
  if (!accept(payload)) return;
  if (!turn || turn.messageId !== String(payload.messageId || '').trim()) return;
  apply('reset', payload);
}

/**
 * A running image turn the page learns of from the conversation's in-flight
 * snapshot (opened or reconnected mid-turn): the timer runs from the turn's
 * own start. What the relay sent live for the same turn is kept; `image`
 * (optional) carries the turn's size, quality, count, model, attempt and
 * startedAt, and `previews` its newest partials, when the snapshot has them.
 */
export function noteInFlightImageTurn({ conversationId, messageId, startedAt, model = '', image = null } = {}) {
  if (IS_SHARED_VIEW) return;
  const convId = String(conversationId || '').trim();
  const msgId = String(messageId || '').trim();
  if (!convId || !msgId || convId !== openConversationId()) return;
  const held = turn && turn.conversationId === convId && turn.messageId === msgId ? turn : null;
  const info = image && typeof image === 'object' ? image : {};
  // What the live events said wins over the snapshot.
  let next = held || reduceImageTurnState(null, 'started', {
    conversationId: convId,
    messageId: msgId,
    attempt: info.attempt,
    size: info.size,
    quality: info.quality,
    count: info.count,
    model: info.model || model,
    startedAt: info.startedAt || startedAt,
  }, { base: BASE });
  for (const preview of Array.isArray(info.previews) ? info.previews : []) {
    next = reduceImageTurnState(next, 'preview', { ...preview, conversationId: convId, messageId: msgId }, { base: BASE });
  }
  turn = next;
  renderImageTurnPlaceholder();
}

/** The turn ended or the page left it: the placeholder goes. */
export function clearImageTurnPlaceholder(messageId = '') {
  const id = String(messageId || '').trim();
  if (id && turn && turn.messageId !== id) return;
  turn = null;
  removePlaceholderNodes();
  stopTimer();
}

/** For tests: the held turn state. */
export function imageTurnPlaceholderState() {
  return turn;
}
