import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureTranscriptAnchor,
  createTranscriptResizeKeeper,
  resolveNearBottomThresholdPx,
  restoreTranscriptAnchor,
} from './transcript-viewport-anchor.mjs';

// A scroller whose rows are stacked blocks of the given heights. Rotation is
// modelled by swapping the row heights and the viewport height, which is
// what a reflow to a different width does to a transcript.
function makeScroller({ rowHeights, clientHeight, scrollTop = 0, top = 100 }) {
  const el = {
    clientHeight,
    scrollTop,
    rowHeights: [...rowHeights],
    get scrollHeight() { return this.rowHeights.reduce((sum, h) => sum + h, 0); },
    getBoundingClientRect() { return { top, bottom: top + this.clientHeight }; },
    querySelectorAll() {
      let offset = 0;
      return this.rowHeights.map((height, index) => {
        const rowTop = offset;
        offset += height;
        return {
          dataset: { messageId: `m${index}` },
          getBoundingClientRect: () => ({
            top: top + rowTop - el.scrollTop,
            bottom: top + rowTop + height - el.scrollTop,
          }),
        };
      });
    },
  };
  // Browsers clamp assignments to the scrollable range.
  return new Proxy(el, {
    set(target, key, value) {
      if (key === 'scrollTop') {
        const max = Math.max(0, target.scrollHeight - target.clientHeight);
        target.scrollTop = Math.min(max, Math.max(0, Number(value)));
        return true;
      }
      target[key] = value;
      return true;
    },
  });
}

const PORTRAIT = { rowHeights: Array(20).fill(300), clientHeight: 600 };
const LANDSCAPE = { rowHeights: Array(20).fill(150), clientHeight: 200 };

// Chrome's own scroll anchoring scales scrollTop with the reflow (live
// probe: 5987 → 4894 on a portrait→landscape rotation), which keeps the
// top-most row but not the end.
function rotate(el, layout) {
  const previousHeight = el.scrollHeight;
  el.rowHeights = [...layout.rowHeights];
  el.clientHeight = layout.clientHeight;
  el.scrollTop = Math.round((el.scrollTop * el.scrollHeight) / previousHeight);
}

test('near-bottom threshold is 8% of the viewport clamped to 12–48px', () => {
  assert.equal(resolveNearBottomThresholdPx(0), 0);
  assert.equal(resolveNearBottomThresholdPx(100), 12);
  assert.equal(resolveNearBottomThresholdPx(400), 32);
  assert.equal(resolveNearBottomThresholdPx(2000), 48);
});

test('a reader at the end stays at the end through a rotation and back', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 5400 });
  const anchor = captureTranscriptAnchor(el);
  assert.equal(anchor.atBottom, true);

  rotate(el, LANDSCAPE);
  assert.ok(el.scrollHeight - el.clientHeight - el.scrollTop > 0, 'the raw pixel position is no longer the end');
  assert.equal(restoreTranscriptAnchor(el, anchor), true);
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight);

  rotate(el, PORTRAIT);
  restoreTranscriptAnchor(el, anchor);
  assert.equal(el.scrollTop, 5400);
});

test('a few pixels short of the end still counts as the end', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 5400 - 20 });
  assert.equal(captureTranscriptAnchor(el).atBottom, true);
  const far = makeScroller({ ...PORTRAIT, scrollTop: 5400 - 200 });
  assert.equal(captureTranscriptAnchor(far).atBottom, false);
});

test('mid-history keeps the same share of the top-most row hidden after a reflow', () => {
  // Rows m6 (1800–2100) and m7 (2100–2400): scrolled to 2060, the last 40px
  // of m6 are still visible, so m6 is the anchor with 260/300 scrolled past.
  const el = makeScroller({ ...PORTRAIT, scrollTop: 2060 });
  const anchor = captureTranscriptAnchor(el);
  assert.equal(anchor.atBottom, false);
  assert.equal(anchor.messageId, 'm6');
  assert.ok(Math.abs(anchor.offsetFraction - (-260 / 300)) < 1e-9);

  rotate(el, LANDSCAPE);
  restoreTranscriptAnchor(el, anchor);
  // m6 now spans 900–1050: the same 260/300 share hidden is 130px.
  assert.equal(el.scrollTop, 900 + 130);

  rotate(el, PORTRAIT);
  restoreTranscriptAnchor(el, anchor);
  assert.equal(el.scrollTop, 2060);
});

test('a partially scrolled-off row is the anchor, with a negative offset', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 320 });
  const anchor = captureTranscriptAnchor(el);
  assert.equal(anchor.messageId, 'm1');
  assert.ok(Math.abs(anchor.offsetFraction - (-20 / 300)) < 1e-9);
});

test('a row that is no longer rendered falls back to the proportional position', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 2700 });
  const anchor = captureTranscriptAnchor(el);
  assert.equal(anchor.ratio, 0.5);
  el.rowHeights = Array(10).fill(300);
  el.querySelectorAll = () => [];
  restoreTranscriptAnchor(el, anchor);
  assert.equal(el.scrollTop, (3000 - 600) * 0.5);
});

test('an empty transcript yields no anchor and restore is a no-op', () => {
  const el = makeScroller({ rowHeights: [], clientHeight: 600 });
  assert.equal(captureTranscriptAnchor(el), null);
  assert.equal(restoreTranscriptAnchor(el, null), false);
});

test('the keeper commits reader scrolls, re-pins on resize, and ignores scrolls while settling', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 5400 });
  const timers = [];
  const keeper = createTranscriptResizeKeeper({
    getElement: () => el,
    settleMs: 500,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
  });

  keeper.recordScroll();
  assert.equal(keeper.committedAnchor().atBottom, true);

  // Rotation step 1: the browser's anchoring leaves the reader above the end.
  rotate(el, LANDSCAPE);
  el.scrollTop = 2400;
  keeper.handleResize();
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight, 're-pinned to the end');
  assert.equal(keeper.isSettling(), true);

  // The browser's anchoring scroll event during the storm must not commit.
  el.scrollTop = 1000;
  keeper.recordScroll();
  assert.equal(keeper.committedAnchor().atBottom, true);

  // Rotation step 2 extends the settle window and re-pins again.
  keeper.handleResize();
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight);
  assert.equal(timers.filter(Boolean).length, 1, 'one live settle timer');

  // Settle: one final re-pin, then scrolls commit again.
  el.scrollTop = 900;
  timers.filter(Boolean)[0]();
  assert.equal(keeper.isSettling(), false);
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight);
  el.scrollTop = 1200;
  keeper.recordScroll();
  assert.equal(keeper.committedAnchor().atBottom, false);
  assert.equal(keeper.committedAnchor().messageId, 'm8');
});

test('a resize before any scroll uses the current position as the anchor', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 5400 });
  const keeper = createTranscriptResizeKeeper({ getElement: () => el, setTimer: () => 1, clearTimer: () => {} });
  rotate(el, LANDSCAPE);
  el.scrollTop = 2400;
  // Captured in the post-rotation layout, so the reader is not at the end;
  // the keeper can only do better once it has seen a scroll.
  keeper.handleResize();
  assert.equal(keeper.committedAnchor().messageId, 'm16');
});
