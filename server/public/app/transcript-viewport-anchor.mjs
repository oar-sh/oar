// Keeps the transcript's reading position through layout changes that
// reflow the rows: phone rotation, the on-screen keyboard, a desktop window
// resize, a font-scale change. The browser only preserves scrollTop as a
// pixel count (and its own scroll anchoring pins the top-most row), so a
// reader sitting at the end of a portrait transcript lands screens above
// the end once the wider landscape rows shrink the content. A position is
// therefore described by content, not pixels: "at the bottom", or "this
// message is the top-most visible one, with this fraction of it scrolled
// past" — a fraction, because the rows themselves change height when the
// width changes, and a pixel offset would hide a whole shrunken row.

const BOTTOM_EPSILON_PX = 1;

/** Same rule the composer's follow-live logic uses: 8% of the viewport,
 *  clamped to 12–48 px. */
export function resolveNearBottomThresholdPx(clientHeight) {
  const viewportHeight = Number(clientHeight || 0);
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  return Math.min(48, Math.max(12, Math.floor(viewportHeight * 0.08)));
}

function distanceFromBottom(el) {
  return Math.max(0, Number(el.scrollHeight || 0) - Number(el.clientHeight || 0) - Number(el.scrollTop || 0));
}

function transcriptRows(el) {
  return Array.from(el.querySelectorAll('.msg[data-message-id]'));
}

/**
 * Describes where the reader is. `atBottom` uses the near-bottom threshold
 * rather than an exact pixel match: a reader a few pixels short of the end
 * still means "the end", and a rotation must not strand them above it.
 * Returns null for an empty transcript.
 */
export function captureTranscriptAnchor(el, { nearBottomThresholdPx = null } = {}) {
  if (!el) return null;
  const rows = transcriptRows(el);
  if (!rows.length) return null;
  const threshold = nearBottomThresholdPx !== null && Number.isFinite(Number(nearBottomThresholdPx))
    ? Math.max(0, Number(nearBottomThresholdPx))
    : Math.max(BOTTOM_EPSILON_PX, resolveNearBottomThresholdPx(el.clientHeight));
  const atBottom = distanceFromBottom(el) <= threshold;
  const containerRect = el.getBoundingClientRect();
  let anchorRow = null;
  let offsetTop = 0;
  let rowHeight = 0;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= containerRect.top + 1) continue;
    if (rect.top >= containerRect.bottom) break;
    anchorRow = row;
    offsetTop = rect.top - containerRect.top;
    rowHeight = Math.max(0, rect.bottom - rect.top);
    break;
  }
  const maxScroll = Math.max(1, Number(el.scrollHeight || 0) - Number(el.clientHeight || 0));
  return {
    atBottom,
    messageId: String(anchorRow?.dataset?.messageId || '').trim() || null,
    // Negative while the row's top is scrolled past the edge; scaled to the
    // row's height so the same share of it stays hidden after a reflow.
    offsetFraction: rowHeight > 0 ? offsetTop / rowHeight : 0,
    ratio: Math.min(1, Math.max(0, Number(el.scrollTop || 0) / maxScroll)),
  };
}

/**
 * Moves the scroller so the captured position holds in the current layout.
 * Bottom wins over the row anchor; a row that is no longer rendered falls
 * back to the proportional position. Returns true when scrollTop changed.
 */
export function restoreTranscriptAnchor(el, anchor) {
  if (!el || !anchor) return false;
  const before = Number(el.scrollTop || 0);
  if (anchor.atBottom) {
    el.scrollTop = Number(el.scrollHeight || 0);
    return Number(el.scrollTop || 0) !== before;
  }
  const messageId = String(anchor.messageId || '').trim();
  const row = messageId
    ? transcriptRows(el).find((node) => String(node.dataset?.messageId || '').trim() === messageId)
    : null;
  if (row) {
    const containerRect = el.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const targetOffset = Number(anchor.offsetFraction || 0) * Math.max(0, rect.bottom - rect.top);
    const delta = rect.top - containerRect.top - targetOffset;
    if (Math.abs(delta) > 0.5) el.scrollTop = before + delta;
    return Number(el.scrollTop || 0) !== before;
  }
  const maxScroll = Math.max(0, Number(el.scrollHeight || 0) - Number(el.clientHeight || 0));
  el.scrollTop = Math.round(maxScroll * Number(anchor.ratio || 0));
  return Number(el.scrollTop || 0) !== before;
}

/**
 * Tracks the position across resize storms. Scroll events commit the
 * reader's position; a resize re-applies the last committed position and
 * opens a settle window during which scroll events are ignored — they are
 * the browser's own anchoring and our re-pins, not the reader. Rotation on
 * a phone resizes in several steps (browser chrome animates), so the window
 * extends with every step and the position is re-applied once more when it
 * closes.
 */
export function createTranscriptResizeKeeper({
  getElement,
  settleMs = 500,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  capture = captureTranscriptAnchor,
  restore = restoreTranscriptAnchor,
} = {}) {
  let committed = null;
  let settleTimer = null;

  function element() {
    try { return typeof getElement === 'function' ? getElement() : null; } catch { return null; }
  }

  function recordScroll() {
    if (settleTimer !== null) return false;
    const el = element();
    if (!el) return false;
    const next = capture(el);
    if (next) committed = next;
    return Boolean(next);
  }

  function endSettle() {
    settleTimer = null;
    const el = element();
    if (el && committed) restore(el, committed);
  }

  function handleResize() {
    const el = element();
    if (!el) return false;
    if (!committed) {
      // Nothing committed yet (no scroll since load): the current position
      // is the best description we have.
      committed = capture(el);
    }
    if (settleTimer !== null) clearTimer(settleTimer);
    settleTimer = setTimer(endSettle, settleMs);
    return committed ? restore(el, committed) : false;
  }

  return {
    recordScroll,
    handleResize,
    isSettling: () => settleTimer !== null,
    committedAnchor: () => committed,
  };
}
