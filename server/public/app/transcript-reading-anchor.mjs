// Where a reader is in a conversation, kept across a switch to another one
// and across a page reload, and the window of loaded messages kept with it.
// No DOM here: the caller measures the rows and applies what is decided.
//
// A pixel scrollTop does not survive either trip. The rows on the page after
// a switch back are another set (the oldest dropped by the page-size cap,
// new ones written meanwhile at the end, a window centred on the place read
// after a reload), so the same pixel count lands on another message. The
// position is therefore a message and how far its top sits from the pane's
// top, or "at the end".
//
// Finer than the reading block of transcript-viewport-anchor.mjs, coarser
// than it too: that one is for rows rebuilt under the reader with other
// heights, and holds the text read. This one goes to localStorage, so it
// holds an id and an offset only.

import { sortConversationMessages } from './thread-order.mjs';

function messageIdOf(message) {
  return String(message?.id || '').trim();
}

/**
 * The index of the first row whose bottom edge is below the pane's top (the
 * row being read), or -1. `bottomAt(i)` is the row's bottom in the pane's
 * coordinates; rows are in page order, so their bottoms only grow and a
 * binary search reads a handful of them on a long transcript.
 */
export function findReadingRowIndex(rowCount, bottomAt, paneTop) {
  const count = Math.max(0, Math.trunc(Number(rowCount) || 0));
  let low = 0;
  let high = count;
  const edge = Number(paneTop) + 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (Number(bottomAt(mid)) > edge) high = mid;
    else low = mid + 1;
  }
  return low < count ? low : -1;
}

/**
 * The reader's position from the pane and its rows. `rowAt(i)` gives
 * `{ messageId, top, bottom }`; `atTail` is true when the reader is at the
 * end of a window that is the end of the conversation (they follow live
 * rows). Null when no row is on the page.
 */
export function captureReadingAnchor({ rowCount, rowAt, paneTop, atTail = false }) {
  const index = findReadingRowIndex(rowCount, (i) => rowAt(i)?.bottom, paneTop);
  if (index < 0) return null;
  const row = rowAt(index);
  const messageId = String(row?.messageId || '').trim();
  if (!messageId) return null;
  return {
    messageId,
    offsetPx: Math.round(Number(row.top) - Number(paneTop)),
    atTail: atTail === true,
  };
}

/** How far to scroll so the anchored row's top is at its saved offset again. */
export function readingAnchorScrollDelta({ rowTop, paneTop, offsetPx }) {
  return Number(rowTop) - Number(paneTop) - Number(offsetPx || 0);
}

/**
 * Where a row's top sits in the content, whatever the scroll: its distance
 * from the pane's top plus how far the pane is scrolled. It changes only when
 * something above the row changes height.
 */
export function readingAnchorContentTop({ rowTop, paneTop, scrollTop }) {
  return Number(rowTop) - Number(paneTop) + Number(scrollTop);
}

/**
 * One look at the anchored row while the images above it are still loading
 * (they grow from nothing to their height after the restore, and a browser
 * without scroll anchoring lets that push the row down). `seen` is the row's
 * content position and the pane's scrollTop as of the last look.
 *
 * The total height is no guide: growth below the row (a reply streaming in
 * at the end) changes it too, and a scroll in the same frame (a jump to the
 * end, a key, a drag of the scrollbar) would be taken back. So only the
 * row's own content position counts, and a scroll is told apart from it:
 * - 'stay': nothing above the row changed, or the browser's own scroll
 *   anchoring already scrolled by exactly what grew above it.
 * - 'correct': something above the row grew by `delta` and nothing else
 *   scrolled: scroll by `delta`.
 * - 'release': scrollTop changed for any other reason. That is the reader
 *   (or a jump, a send) and the place is theirs from now on, even when
 *   something above grew in the same frame.
 * `rowContentTop` is the position to remember for the next look.
 */
export function readingAnchorHoldStep({ rowTop, paneTop, scrollTop, seen, tolerancePx = 1 }) {
  const rowContentTop = readingAnchorContentTop({ rowTop, paneTop, scrollTop });
  const grewAbove = rowContentTop - Number(seen?.rowContentTop);
  const scrolled = Number(scrollTop) - Number(seen?.scrollTop);
  if (!Number.isFinite(grewAbove) || !Number.isFinite(scrolled)) return { action: 'release', delta: 0, rowContentTop };
  const grew = Math.abs(grewAbove) > tolerancePx;
  if (Math.abs(scrolled) > tolerancePx) {
    if (grew && Math.abs(scrolled - grewAbove) <= tolerancePx) return { action: 'stay', delta: 0, rowContentTop };
    return { action: 'release', delta: 0, rowContentTop };
  }
  if (grew) return { action: 'correct', delta: grewAbove, rowContentTop };
  return { action: 'stay', delta: 0, rowContentTop };
}

/** An anchor read back from storage, or null when it is not one. */
export function normalizeReadingAnchor(value) {
  if (!value || typeof value !== 'object') return null;
  const messageId = String(value.messageId || '').trim();
  const atTail = value.atTail === true;
  if (!messageId && !atTail) return null;
  const offset = Number(value.offsetPx);
  return {
    messageId: messageId || null,
    offsetPx: Number.isFinite(offset) ? Math.round(offset) : 0,
    atTail,
  };
}

/**
 * The part of a loaded window kept for a switch back: at most `cap` messages
 * (no cap when it is not a positive finite number). A reader at the end keeps
 * the newest; anyone else keeps the messages around the one they read, half
 * above and half below, so either direction can be read on without a fetch.
 * Rows cut off on a side mean there is more on that side to load.
 */
export function trimMessageWindow(messages, {
  cap = Infinity,
  anchorMessageId = '',
  atTail = false,
  hasMoreOlder = false,
  hasMoreNewer = false,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Number(cap);
  if (!(limit > 0) || !Number.isFinite(limit) || list.length <= limit) {
    return { messages: list, hasMoreOlder: !!hasMoreOlder, hasMoreNewer: !!hasMoreNewer, trimmed: false };
  }
  const keep = Math.trunc(limit);
  const ordered = sortConversationMessages(list);
  const anchorId = String(anchorMessageId || '').trim();
  const anchorIndex = !atTail && anchorId ? ordered.findIndex((message) => messageIdOf(message) === anchorId) : -1;
  let start;
  if (anchorIndex < 0) {
    start = ordered.length - keep;
  } else {
    start = Math.max(0, anchorIndex - Math.floor(keep / 2));
    start = Math.min(start, ordered.length - keep);
  }
  const end = start + keep;
  return {
    messages: ordered.slice(start, end),
    hasMoreOlder: !!hasMoreOlder || start > 0,
    hasMoreNewer: !!hasMoreNewer || end < ordered.length,
    trimmed: true,
  };
}

function timestampMsOf(message) {
  const ms = Date.parse(message?.timestamp || 0);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The relay's history order: timestamp in ms, then id by localeCompare (as
 * conversation-history-page.mjs pages it). The page's range is measured in
 * this order, not in the thread order the transcript is drawn in: the relay
 * cuts its pages by it, so a row inside the page's range in this order is a
 * row the relay would have put on the page.
 */
export function compareHistoryOrder(a, b) {
  const aMs = timestampMsOf(a);
  const bMs = timestampMsOf(b);
  if (aMs !== bMs) return aMs - bMs;
  return messageIdOf(a).localeCompare(messageIdOf(b));
}

/**
 * The newest page of a conversation merged into a kept window that reaches
 * the end. A message of the page replaces the one with its id (its text may
 * have changed since: a reply that was still streaming), the others join in
 * conversation order. Null when the page does not meet the window: more rows
 * were written than the page holds, and the rows between are unknown.
 * `changed` and `added` are the ids the page brought that differ from, or
 * are missing in, the window (`sameMessage` decides what differs).
 * The page is the truth for its own range, from its oldest row to its
 * newest in the relay's order: a window row inside it that the page lacks
 * was deleted while the reader was away and is dropped (`removed`). Rows
 * older than the page are kept, the page says nothing about them; so are
 * rows newer than it, which the socket may have brought after the page was
 * read. With `windowPredatesPage` every window row was there before the page
 * was asked for (the caller merged a window read before the request, or no
 * live row arrived while it was on its way): the page, which ends at the
 * conversation's end, then is the truth up to that end, and a newer window
 * row it lacks was deleted too (the relay's own follow-up dropped by a
 * Cancel, say: the newest row of the conversation).
 */
export function mergeTailPage(windowMessages, pageMessages, {
  pageHasMoreOlder = false,
  windowPredatesPage = false,
  sameMessage = (a, b) => JSON.stringify(a) === JSON.stringify(b),
} = {}) {
  const kept = Array.isArray(windowMessages) ? windowMessages : [];
  const page = Array.isArray(pageMessages) ? pageMessages : [];
  const keptById = new Map();
  for (const message of kept) {
    const id = messageIdOf(message);
    if (id) keptById.set(id, message);
  }
  const meets = !pageHasMoreOlder || page.some((message) => keptById.has(messageIdOf(message)));
  if (!meets) return null;
  const changed = [];
  const added = [];
  const pageById = new Map();
  for (const message of page) {
    const id = messageIdOf(message);
    if (!id) continue;
    pageById.set(id, message);
    if (!keptById.has(id)) added.push(id);
    else if (!sameMessage(keptById.get(id), message)) changed.push(id);
  }
  let oldest = null;
  let newest = null;
  for (const message of pageById.values()) {
    if (!oldest || compareHistoryOrder(message, oldest) < 0) oldest = message;
    if (!newest || compareHistoryOrder(message, newest) > 0) newest = message;
  }
  // An empty page that is the whole conversation (meets without a shared
  // row) holds nothing: every window row is gone, when the window predates it.
  const insidePage = (message) => {
    if (!oldest) return windowPredatesPage && !pageHasMoreOlder;
    if (compareHistoryOrder(message, oldest) < 0) return false;
    return windowPredatesPage || compareHistoryOrder(message, newest) <= 0;
  };
  const removed = [];
  const merged = [];
  for (const message of kept) {
    const id = messageIdOf(message);
    if (pageById.has(id)) {
      merged.push(pageById.get(id));
    } else if (id && insidePage(message)) {
      removed.push(id);
    } else {
      merged.push(message);
    }
  }
  for (const id of added) merged.push(pageById.get(id));
  return {
    messages: added.length ? sortConversationMessages(merged) : merged,
    changed,
    added,
    removed,
  };
}
