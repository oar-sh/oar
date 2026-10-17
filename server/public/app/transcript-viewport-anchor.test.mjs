import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureReadingBlock,
  captureTranscriptAnchor,
  createTranscriptResizeKeeper,
  focusedTranscriptTextField,
  resolveNearBottomThresholdPx,
  restoreReadingBlock,
  restoreTranscriptAnchor,
  revealFieldInTranscript,
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
    contains(node) { return node?.insideTranscript === true; },
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

// A field laid out at a fixed content offset inside the scroller (a question
// card's reply box), positioned like the rows.
function makeField(el, { contentTop, height = 40, tagName = 'TEXTAREA', type, inside = true, top = 100 }) {
  return {
    tagName,
    type,
    insideTranscript: inside,
    getBoundingClientRect: () => ({
      top: top + contentTop - el.scrollTop,
      bottom: top + contentTop + height - el.scrollTop,
    }),
  };
}

function isFullyVisible(el, field) {
  const container = el.getBoundingClientRect();
  const rect = field.getBoundingClientRect();
  return rect.top >= container.top && rect.bottom <= container.bottom;
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

function makeKeeperWithTimers(el, field) {
  const timers = [];
  const keeper = createTranscriptResizeKeeper({
    getElement: () => el,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
    getFocusedField: (scroller) => focusedTranscriptTextField(scroller, field),
  });
  const fireSettle = () => timers.filter(Boolean).forEach((fn) => fn());
  return { keeper, fireSettle };
}

test('the keyboard opening keeps a focused question field in view mid-transcript', () => {
  // Anchor row m6, far from the end; the reply box sits in the lower half.
  const el = makeScroller({ ...PORTRAIT, scrollTop: 2060 });
  const field = makeField(el, { contentTop: 2510 });
  const { keeper, fireSettle } = makeKeeperWithTimers(el, field);
  keeper.recordScroll();
  assert.ok(isFullyVisible(el, field));

  // Android with resizes-content: the keyboard halves the transcript and the
  // browser scrolls the focused field into view before the resize fires.
  el.clientHeight = 300;
  el.scrollTop = 2550 - 300 + 20;
  keeper.handleResize();
  assert.ok(isFullyVisible(el, field), 'still in view after the restore');

  fireSettle();
  assert.ok(isFullyVisible(el, field), 'still in view once the settle window closes');
});

test('the keyboard opening at the end keeps a field in an upper card in view', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 5400 });
  const field = makeField(el, { contentTop: 5500 });
  const { keeper, fireSettle } = makeKeeperWithTimers(el, field);
  keeper.recordScroll();
  assert.equal(keeper.committedAnchor().atBottom, true);

  el.clientHeight = 300;
  keeper.handleResize();
  assert.ok(isFullyVisible(el, field), 'the end pin must not push the field off the top');
  fireSettle();
  assert.ok(isFullyVisible(el, field));
});

test('with no focused transcript field the end pin behaves as before', () => {
  const el = makeScroller({ ...PORTRAIT, scrollTop: 5400 });
  // Focus outside the transcript (the composer) is not revealed.
  const composer = makeField(el, { contentTop: 5500, inside: false });
  const { keeper, fireSettle } = makeKeeperWithTimers(el, composer);
  keeper.recordScroll();
  el.clientHeight = 300;
  keeper.handleResize();
  fireSettle();
  assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight);
});

test('only keyboard fields inside the transcript count as focused', () => {
  const el = makeScroller({ ...PORTRAIT });
  const field = (props) => makeField(el, { contentTop: 0, ...props });
  assert.ok(focusedTranscriptTextField(el, field({ tagName: 'TEXTAREA' })));
  for (const type of ['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password']) {
    assert.ok(focusedTranscriptTextField(el, field({ tagName: 'INPUT', type })), `input type "${type}"`);
  }
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'range']) {
    assert.equal(focusedTranscriptTextField(el, field({ tagName: 'INPUT', type })), null, `input type "${type}"`);
  }
  assert.equal(focusedTranscriptTextField(el, field({ tagName: 'SELECT' })), null);
  assert.equal(focusedTranscriptTextField(el, field({ tagName: 'BUTTON' })), null);
  assert.ok(focusedTranscriptTextField(el, { ...field({ tagName: 'DIV' }), isContentEditable: true }));
  assert.equal(focusedTranscriptTextField(el, field({ tagName: 'TEXTAREA', inside: false })), null);
  assert.equal(focusedTranscriptTextField(el, el), null);
  assert.equal(focusedTranscriptTextField(el, null), null);
});

test('reveal scrolls the least distance that shows the field whole', () => {
  // Viewport shows content 1000–1600; the reveal keeps an 8px margin.
  const below = makeScroller({ ...PORTRAIT, scrollTop: 1000 });
  assert.equal(revealFieldInTranscript(below, makeField(below, { contentTop: 1700 })), true);
  assert.equal(below.scrollTop, 1740 - 600 + 8, 'bottom-aligned');

  const above = makeScroller({ ...PORTRAIT, scrollTop: 1000 });
  assert.equal(revealFieldInTranscript(above, makeField(above, { contentTop: 900 })), true);
  assert.equal(above.scrollTop, 900 - 8, 'top-aligned');

  const visible = makeScroller({ ...PORTRAIT, scrollTop: 1000 });
  assert.equal(revealFieldInTranscript(visible, makeField(visible, { contentTop: 1200 })), false);
  assert.equal(visible.scrollTop, 1000);

  const tall = makeScroller({ ...PORTRAIT, scrollTop: 1000 });
  assert.equal(revealFieldInTranscript(tall, makeField(tall, { contentTop: 1300, height: 900 })), true);
  assert.equal(tall.scrollTop, 1300 - 8, 'taller than the viewport: top-aligned');
});

// A transcript of rows made of text blocks, for the reading-block anchor.
// Each row is { id, live, lead, blocks: [{ tag, text, height }] }: `lead` is
// what the row shows above its text (folded thoughts, a header).
function makeBlockTranscript({ rows, clientHeight = 400, scrollTop = 0, top = 100 }) {
  const el = { clientHeight, scrollTop, rows };
  const layout = () => {
    let offset = 0;
    return el.rows.map((row) => {
      const rowTop = offset;
      let blockOffset = rowTop + (row.lead || 0);
      const blocks = row.blocks.map((block) => {
        const blockTop = blockOffset;
        blockOffset += block.height;
        return {
          tagName: block.tag.toUpperCase(),
          textContent: block.text,
          getBoundingClientRect: () => ({ top: top + blockTop - el.scrollTop, bottom: top + blockTop + block.height - el.scrollTop }),
        };
      });
      offset = blockOffset;
      const rowBottom = offset;
      return {
        id: row.live ? 'thinking-indicator' : '',
        dataset: { messageId: row.id },
        getBoundingClientRect: () => ({ top: top + rowTop - el.scrollTop, bottom: top + rowBottom - el.scrollTop }),
        querySelectorAll: (selector) => blocks.filter((block) => selector.split(',').map((part) => part.trim().toUpperCase()).includes(block.tagName)),
      };
    });
  };
  Object.defineProperty(el, 'scrollHeight', { get: () => el.rows.reduce((sum, row) => sum + (row.lead || 0) + row.blocks.reduce((h, b) => h + b.height, 0), 0) });
  el.getBoundingClientRect = () => ({ top, bottom: top + el.clientHeight });
  el.querySelectorAll = () => layout();
  el.blockTop = (rowId, text, { live = false } = {}) => {
    const row = layout().find((candidate) => candidate.dataset.messageId === rowId && (candidate.id === 'thinking-indicator') === live);
    const block = row.querySelectorAll('p, pre').find((candidate) => candidate.textContent === text);
    return block.getBoundingClientRect().top - top;
  };
  return el;
}

const paragraphs = (prefix, count, height = 100) => Array.from({ length: count }, (_, index) => ({ tag: 'p', text: `${prefix} ${index}`, height }));

test('the reading block is the first one that starts inside the viewport', () => {
  const el = makeBlockTranscript({ rows: [{ id: 'm0', blocks: paragraphs('old', 6) }, { id: 'm1', blocks: paragraphs('new', 6) }], scrollTop: 260 });
  const anchor = captureReadingBlock(el);
  assert.deepEqual(anchor, { messageId: 'm0', live: false, tag: 'p', text: 'old 3', occurrence: 0, offset: 40, offsetFraction: null });
});

test('a block taller than the viewport is the reading block, by the share of it scrolled past', () => {
  const el = makeBlockTranscript({
    rows: [{ id: 'm0', blocks: [{ tag: 'p', text: 'intro', height: 100 }, { tag: 'pre', text: 'code', height: 1000 }, { tag: 'p', text: 'outro', height: 100 }] }],
    scrollTop: 350,
  });
  const anchor = captureReadingBlock(el);
  assert.equal(anchor.text, 'code');
  assert.equal(anchor.offsetFraction, -0.25);
  // It comes back twice as tall: the same quarter of it stays hidden.
  el.rows[0].blocks[1].height = 2000;
  assert.equal(restoreReadingBlock(el, anchor), true);
  assert.equal(el.blockTop('m0', 'code'), -500);
});

test('a reload that changes what the rows show above their text keeps the block where it was', () => {
  const el = makeBlockTranscript({ rows: [{ id: 'm0', lead: 30, blocks: paragraphs('old', 6) }, { id: 'm1', lead: 30, blocks: paragraphs('new', 6) }], scrollTop: 790 });
  const anchor = captureReadingBlock(el);
  assert.equal(anchor.text, 'new 2');
  const before = el.blockTop('m1', 'new 2');
  // Rebuilt: the first row gained a tool line, the second folded its thoughts.
  el.rows = [{ id: 'm0', lead: 96, blocks: paragraphs('old', 6) }, { id: 'm1', lead: 8, blocks: paragraphs('new', 6) }];
  assert.notEqual(el.blockTop('m1', 'new 2'), before);
  assert.equal(restoreReadingBlock(el, anchor), true);
  assert.equal(el.blockTop('m1', 'new 2'), before);
});

test('a block read in the live bubble is found in the reply that takes its place', () => {
  const prompt = { id: 'q1', blocks: [{ tag: 'p', text: 'the question', height: 60 }] };
  const el = makeBlockTranscript({
    rows: [{ id: 'm0', blocks: paragraphs('old', 5) }, prompt, { id: 'q1', live: true, lead: 220, blocks: paragraphs('reply', 8) }],
    scrollTop: 1040,
  });
  const anchor = captureReadingBlock(el);
  assert.equal(anchor.live, true);
  assert.equal(anchor.messageId, 'q1');
  assert.equal(anchor.text, 'reply 3');
  const before = el.blockTop('q1', 'reply 3', { live: true });
  // While the turn runs, the bubble itself is where it is looked for.
  assert.equal(restoreReadingBlock(el, anchor), true);
  assert.equal(el.blockTop('q1', 'reply 3', { live: true }), before);
  // The turn ended: the reply is a row of its own, its thoughts folded.
  el.rows = [{ id: 'm0', blocks: paragraphs('old', 5) }, prompt, { id: 'a1', lead: 40, blocks: paragraphs('reply', 8) }];
  assert.equal(restoreReadingBlock(el, anchor), true);
  assert.equal(el.blockTop('a1', 'reply 3'), before);
});

test('the same line twice in a row: the one that was read is restored', () => {
  const blocks = [{ tag: 'p', text: 'again', height: 100 }, { tag: 'p', text: 'between', height: 300 }, { tag: 'p', text: 'again', height: 100 }, { tag: 'p', text: 'tail', height: 600 }];
  const el = makeBlockTranscript({ rows: [{ id: 'm0', blocks }], scrollTop: 380 });
  const anchor = captureReadingBlock(el);
  assert.equal(anchor.text, 'again');
  assert.equal(anchor.occurrence, 1);
  el.rows = [{ id: 'm0', lead: 50, blocks }];
  assert.equal(restoreReadingBlock(el, anchor), true);
  assert.equal(el.scrollTop, 430);
});

test('no block in view, or a block that is gone: nothing is restored and the caller falls back', () => {
  const el = makeBlockTranscript({ rows: [{ id: 'm0', blocks: paragraphs('old', 6) }], scrollTop: 100 });
  const anchor = captureReadingBlock(el);
  el.rows = [{ id: 'm0', blocks: paragraphs('rewritten', 6) }];
  assert.equal(restoreReadingBlock(el, anchor), false);
  assert.equal(el.scrollTop, 100);
  el.rows = [{ id: 'other', blocks: paragraphs('old', 6) }];
  assert.equal(restoreReadingBlock(el, anchor), false);
  assert.equal(restoreReadingBlock(el, null), false);
  assert.equal(captureReadingBlock(makeBlockTranscript({ rows: [{ id: 'm0', lead: 900, blocks: [] }] })), null);
  assert.equal(captureReadingBlock(null), null);
});

test('a code block is the same block with and without its Copy button', () => {
  const pre = (withButton) => {
    const node = {
      tagName: 'PRE',
      textContent: withButton ? 'npm testCopy' : 'npm test',
      querySelector: (selector) => (withButton && selector === 'button' ? {} : null),
      cloneNode: () => ({ textContent: 'npm test', querySelectorAll: () => [{ remove() {} }] }),
      getBoundingClientRect: () => ({ top: 150, bottom: 250 }),
    };
    return node;
  };
  const transcript = (withButton, id, live) => {
    const block = pre(withButton);
    const row = {
      id: live ? 'thinking-indicator' : '',
      dataset: { messageId: id },
      getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      querySelectorAll: () => [block],
    };
    const prompt = { id: '', dataset: { messageId: 'q1' }, getBoundingClientRect: () => ({ top: 0, bottom: 100 }), querySelectorAll: () => [] };
    return { scrollTop: 500, getBoundingClientRect: () => ({ top: 100, bottom: 500 }), querySelectorAll: () => [prompt, row] };
  };
  const anchor = captureReadingBlock(transcript(false, 'q1', true));
  assert.equal(anchor.text, 'npm test');
  assert.equal(anchor.live, true);
  // The reply's block holds the button; it is still found.
  assert.equal(restoreReadingBlock(transcript(true, 'a1', false), anchor), true);
  assert.equal(captureReadingBlock(transcript(true, 'a1', false)).text, 'npm test');
});

test('a block inside a closed fold is neither read nor restored to, though the browser gives it a box', () => {
  // What Chromium reports for a paragraph inside a closed <details>: a box
  // of its full height, and checkVisibility() false.
  const block = (text, visible) => ({
    tagName: 'P',
    textContent: text,
    checkVisibility: () => visible,
    getBoundingClientRect: () => ({ top: 120, bottom: 420 }),
  });
  const transcript = (blocks) => {
    const row = { id: '', dataset: { messageId: 'm0' }, getBoundingClientRect: () => ({ top: 100, bottom: 800 }), querySelectorAll: () => blocks };
    return { scrollTop: 300, getBoundingClientRect: () => ({ top: 100, bottom: 700 }), querySelectorAll: () => [row] };
  };
  const el = transcript([block('folded thought', false), block('the reply', true)]);
  assert.equal(captureReadingBlock(el).text, 'the reply');
  const folded = { messageId: 'm0', tag: 'p', text: 'folded thought', occurrence: 0, offset: 0, offsetFraction: null };
  assert.equal(restoreReadingBlock(el, folded), false);
  assert.equal(el.scrollTop, 300);
  // A browser without checkVisibility: the closed fold around it says so.
  const legacy = { tagName: 'P', textContent: 'folded thought', closest: (selector) => (selector.includes('details:not([open])') ? {} : null), getBoundingClientRect: () => ({ top: 120, bottom: 420 }) };
  assert.equal(captureReadingBlock(transcript([legacy, block('the reply', true)])).text, 'the reply');
});

test('the keeper lets go of the end when content lands unfollowed, so a resize does not go there', () => {
  const el = makeScroller({ rowHeights: Array(10).fill(300), clientHeight: 600, scrollTop: 2400 });
  const keeper = createTranscriptResizeKeeper({ getElement: () => el, setTimer: () => 1, clearTimer: () => {} });
  keeper.recordScroll();
  assert.equal(keeper.committedAnchor().atBottom, true);
  // Three rows land and are not followed; no scroll event tells the keeper.
  el.rowHeights.push(300, 300, 300);
  assert.equal(keeper.recordEndLeft(), true);
  assert.equal(keeper.committedAnchor().atBottom, false);
  el.clientHeight = 500;
  keeper.handleResize();
  assert.equal(el.scrollTop, 2400);
});
