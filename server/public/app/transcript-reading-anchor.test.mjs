import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureReadingAnchor,
  compareHistoryOrder,
  findReadingRowIndex,
  mergeTailPage,
  normalizeReadingAnchor,
  readingAnchorContentTop,
  readingAnchorHoldStep,
  readingAnchorScrollDelta,
  trimMessageWindow,
} from './transcript-reading-anchor.mjs';

// Rows of the given heights stacked from `start`, as the pane measures them.
function stack(heights, start = 0, prefix = 'row') {
  let top = start;
  return heights.map((height, index) => {
    const row = { messageId: `${prefix}-${index}`, top, bottom: top + height };
    top += height;
    return row;
  });
}

function messages(from, to) {
  const list = [];
  for (let index = from; index <= to; index += 1) {
    list.push({
      id: `note-${String(index).padStart(3, '0')}`,
      role: index % 2 ? 'user' : 'assistant',
      text: `line ${index}`,
      timestamp: new Date(Date.UTC(2031, 4, 2, 9, 0, index)).toISOString(),
    });
  }
  return list;
}

test('the row read is the first whose bottom is below the pane top', () => {
  const rows = stack([100, 50, 200, 80], -180);
  // Bottoms: -80, -30, 170, 250.
  assert.equal(findReadingRowIndex(rows.length, (i) => rows[i].bottom, 0), 2);
  assert.equal(findReadingRowIndex(rows.length, (i) => rows[i].bottom, -100), 0);
  assert.equal(findReadingRowIndex(rows.length, (i) => rows[i].bottom, 400), -1);
  assert.equal(findReadingRowIndex(0, () => 0, 0), -1);
});

test('a row whose bottom only touches the pane top is not the one read', () => {
  const rows = stack([100, 100], -100);
  assert.equal(findReadingRowIndex(rows.length, (i) => rows[i].bottom, 0), 1);
  assert.equal(findReadingRowIndex(rows.length, (i) => rows[i].bottom, -0.5), 1);
});

test('the binary search reads few rows of a long transcript', () => {
  const rows = stack(Array.from({ length: 1000 }, () => 40), -20_000);
  let reads = 0;
  const index = findReadingRowIndex(rows.length, (i) => { reads += 1; return rows[i].bottom; }, 0);
  assert.equal(index, 500);
  assert.ok(reads <= 11, `${reads} reads`);
});

test('the anchor is the row read and its offset from the pane top', () => {
  const rows = stack([100, 300, 60], -130);
  const anchor = captureReadingAnchor({ rowCount: rows.length, rowAt: (i) => rows[i], paneTop: 0 });
  assert.deepEqual(anchor, { messageId: 'row-1', offsetPx: -30, atTail: false });
  const pane = captureReadingAnchor({ rowCount: rows.length, rowAt: (i) => ({ ...rows[i], top: rows[i].top + 50, bottom: rows[i].bottom + 50 }), paneTop: 50, atTail: true });
  assert.deepEqual(pane, { messageId: 'row-1', offsetPx: -30, atTail: true });
  assert.equal(captureReadingAnchor({ rowCount: 0, rowAt: () => null, paneTop: 0 }), null);
});

test('restoring scrolls by the distance from the saved offset', () => {
  assert.equal(readingAnchorScrollDelta({ rowTop: 420, paneTop: 20, offsetPx: -30 }), 430);
  assert.equal(readingAnchorScrollDelta({ rowTop: 20, paneTop: 20, offsetPx: 0 }), 0);
});

// The row read was 30 px below the pane's top (at 100 px), the pane scrolled
// by 2000 px: the row's top sits at 2030 px in the content.
const SEEN = { rowContentTop: 2030, scrollTop: 2000 };

test('a row\'s content position is its offset in the pane plus the scroll', () => {
  assert.equal(readingAnchorContentTop({ rowTop: 130, paneTop: 100, scrollTop: 2000 }), 2030);
});

test('an image that grew above the row read is corrected for by exactly its height', () => {
  assert.deepEqual(
    readingAnchorHoldStep({ rowTop: 310, paneTop: 100, scrollTop: 2000, seen: SEEN }),
    { action: 'correct', delta: 180, rowContentTop: 2210 },
  );
});

test('growth below the row read only needs nothing', () => {
  // A reply streaming in at the end: the content is taller, the row is where it was.
  assert.deepEqual(
    readingAnchorHoldStep({ rowTop: 130, paneTop: 100, scrollTop: 2000, seen: SEEN }),
    { action: 'stay', delta: 0, rowContentTop: 2030 },
  );
  // Sub-pixel rounding is not a move.
  assert.equal(readingAnchorHoldStep({ rowTop: 130.6, paneTop: 100, scrollTop: 2000, seen: SEEN }).action, 'stay');
});

test('a scroll that no growth above the row explains is the reader: the hold lets go', () => {
  // A key, a drag of the scrollbar, a jump to the end: the row's content
  // position did not change, scrollTop did.
  assert.deepEqual(
    readingAnchorHoldStep({ rowTop: -110, paneTop: 100, scrollTop: 2240, seen: SEEN }),
    { action: 'release', delta: 0, rowContentTop: 2030 },
  );
});

test('growth above and a scroll by the reader in the same frame: the reader wins', () => {
  assert.equal(readingAnchorHoldStep({ rowTop: -90, paneTop: 100, scrollTop: 2400, seen: SEEN }).action, 'release');
});

test('a browser that anchored the scroll itself by what grew above needs nothing', () => {
  assert.deepEqual(
    readingAnchorHoldStep({ rowTop: 130, paneTop: 100, scrollTop: 2180, seen: SEEN }),
    { action: 'stay', delta: 0, rowContentTop: 2210 },
  );
});

test('stored anchors are read back or refused', () => {
  assert.deepEqual(normalizeReadingAnchor({ messageId: ' note-1 ', offsetPx: 12.6, atTail: false }), { messageId: 'note-1', offsetPx: 13, atTail: false });
  assert.deepEqual(normalizeReadingAnchor({ atTail: true }), { messageId: null, offsetPx: 0, atTail: true });
  assert.deepEqual(normalizeReadingAnchor({ messageId: 'note-2', offsetPx: 'x' }), { messageId: 'note-2', offsetPx: 0, atTail: false });
  assert.equal(normalizeReadingAnchor(null), null);
  assert.equal(normalizeReadingAnchor('note-1'), null);
  assert.equal(normalizeReadingAnchor({ offsetPx: 4 }), null);
});

test('a window within the cap is kept whole', () => {
  const list = messages(1, 30);
  const kept = trimMessageWindow(list, { cap: 100, anchorMessageId: 'note-005', hasMoreOlder: true });
  assert.equal(kept.trimmed, false);
  assert.equal(kept.messages, list);
  assert.equal(kept.hasMoreOlder, true);
  assert.equal(trimMessageWindow(messages(1, 3000), { cap: Infinity }).trimmed, false);
  assert.equal(trimMessageWindow(messages(1, 30), { cap: 0 }).trimmed, false);
});

test('a reader at the end keeps the newest messages', () => {
  const kept = trimMessageWindow(messages(1, 150), { cap: 100, atTail: true, anchorMessageId: 'note-010' });
  assert.equal(kept.messages.length, 100);
  assert.equal(kept.messages[0].id, 'note-051');
  assert.equal(kept.hasMoreOlder, true);
  assert.equal(kept.hasMoreNewer, false);
});

test('anyone else keeps the messages around the one read', () => {
  const middle = trimMessageWindow(messages(1, 300), { cap: 100, anchorMessageId: 'note-150' });
  assert.equal(middle.messages[0].id, 'note-100');
  assert.equal(middle.messages[99].id, 'note-199');
  assert.equal(middle.hasMoreOlder, true);
  assert.equal(middle.hasMoreNewer, true);
  const nearTop = trimMessageWindow(messages(1, 120), { cap: 100, anchorMessageId: 'note-012' });
  assert.equal(nearTop.messages[0].id, 'note-001');
  assert.equal(nearTop.hasMoreOlder, false);
  assert.equal(nearTop.hasMoreNewer, true);
  const nearEnd = trimMessageWindow(messages(1, 120), { cap: 100, anchorMessageId: 'note-118' });
  assert.equal(nearEnd.messages[99].id, 'note-120');
  assert.equal(nearEnd.hasMoreNewer, false);
});

test('an anchor no longer in the window keeps the newest', () => {
  const kept = trimMessageWindow(messages(1, 120), { cap: 100, anchorMessageId: 'gone' });
  assert.equal(kept.messages[0].id, 'note-021');
});

test('the newest page replaces changed rows and adds new ones in order', () => {
  const kept = messages(1, 40);
  const page = messages(31, 44).map((message) => (message.id === 'note-040' ? { ...message, text: 'the finished reply' } : message));
  const merged = mergeTailPage(kept, page, { pageHasMoreOlder: true });
  assert.equal(merged.messages.length, 44);
  assert.deepEqual(merged.changed, ['note-040']);
  assert.deepEqual(merged.added, ['note-041', 'note-042', 'note-043', 'note-044']);
  assert.equal(merged.messages[39].text, 'the finished reply');
  assert.equal(merged.messages[43].id, 'note-044');
  // The window it came from is left alone.
  assert.equal(kept[39].text, 'line 40');
});

test('a message of the page missing between kept rows takes its place', () => {
  const kept = messages(1, 10).filter((message) => message.id !== 'note-009');
  const merged = mergeTailPage(kept, messages(5, 10), { pageHasMoreOlder: true });
  assert.deepEqual(merged.added, ['note-009']);
  assert.deepEqual(merged.messages.map((m) => m.id).slice(-3), ['note-008', 'note-009', 'note-010']);
});

test('a page that does not meet the window is refused', () => {
  assert.equal(mergeTailPage(messages(1, 20), messages(41, 60), { pageHasMoreOlder: true }), null);
  // The whole conversation in one page always meets it.
  const whole = mergeTailPage(messages(5, 6), messages(1, 3), { pageHasMoreOlder: false });
  assert.equal(whole.messages.length, 5);
});

test('nothing changed: no ids, same order', () => {
  const kept = messages(1, 20);
  const merged = mergeTailPage(kept, messages(11, 20), { pageHasMoreOlder: true });
  assert.deepEqual(merged.changed, []);
  assert.deepEqual(merged.added, []);
  assert.deepEqual(merged.messages.map((m) => m.id), kept.map((m) => m.id));
});

test('a window row inside the page range that the page lacks was deleted and is dropped', () => {
  const kept = messages(1, 30);
  const page = messages(21, 32).filter((message) => message.id !== 'note-025');
  const merged = mergeTailPage(kept, page, { pageHasMoreOlder: true });
  assert.deepEqual(merged.removed, ['note-025']);
  assert.equal(merged.messages.some((message) => message.id === 'note-025'), false);
  assert.equal(merged.messages.length, 31);
  assert.deepEqual(merged.added, ['note-031', 'note-032']);
});

test('window rows older than the page are kept: the page says nothing about them', () => {
  const kept = messages(1, 30);
  const merged = mergeTailPage(kept, messages(21, 30), { pageHasMoreOlder: true });
  assert.deepEqual(merged.removed, []);
  assert.deepEqual(merged.messages.map((m) => m.id), kept.map((m) => m.id));
});

test('window rows newer than the page are kept: the socket brought them after it was read', () => {
  const kept = messages(1, 30);
  const merged = mergeTailPage(kept, messages(21, 28), { pageHasMoreOlder: true });
  assert.deepEqual(merged.removed, []);
  assert.equal(merged.messages.length, 30);
});

test('a window that predates the page loses a newer row the page lacks: it was deleted', () => {
  // The newest row of the conversation (a held follow-up a Cancel dropped) is
  // gone from the relay; the page, read after every window row arrived, ends
  // below it.
  const kept = messages(1, 30);
  const merged = mergeTailPage(kept, messages(21, 29), { pageHasMoreOlder: true, windowPredatesPage: true });
  assert.deepEqual(merged.removed, ['note-030']);
  assert.equal(merged.messages.length, 29);
  assert.equal(merged.messages.at(-1).id, 'note-029');
  // Rows older than the page still say nothing about the page and stay.
  assert.equal(merged.messages[0].id, 'note-001');
});

test('a window that predates a page of the whole conversation keeps only what the page has', () => {
  const merged = mergeTailPage(messages(1, 3), messages(1, 2), { pageHasMoreOlder: false, windowPredatesPage: true });
  assert.deepEqual(merged.removed, ['note-003']);
  // An empty conversation: every window row is gone.
  const empty = mergeTailPage(messages(1, 2), [], { pageHasMoreOlder: false, windowPredatesPage: true });
  assert.deepEqual(empty.removed, ['note-001', 'note-002']);
  assert.deepEqual(empty.messages, []);
  // Without the promise an empty page drops nothing.
  assert.deepEqual(mergeTailPage(messages(1, 2), [], { pageHasMoreOlder: false }).removed, []);
});

test('on the boundary timestamp the range is cut by id, as the relay pages', () => {
  const at = '2031-05-02T09:00:20.000Z';
  const before = { id: 'note-a', role: 'user', text: 'tie before', timestamp: at };
  const oldest = { id: 'note-b', role: 'assistant', text: 'tie oldest', timestamp: at };
  const after = { id: 'note-c', role: 'user', text: 'tie after', timestamp: at };
  const newest = { id: 'note-d', role: 'assistant', text: 'newest', timestamp: '2031-05-02T09:00:21.000Z' };
  assert.ok(compareHistoryOrder(before, oldest) < 0);
  assert.ok(compareHistoryOrder(after, oldest) > 0);
  assert.equal(compareHistoryOrder(oldest, { ...oldest }), 0);
  const merged = mergeTailPage([...messages(1, 19), before, oldest, after, newest], [oldest, newest], { pageHasMoreOlder: true });
  // Same timestamp, smaller id: before the page, kept. Larger id: inside, gone.
  assert.deepEqual(merged.removed, ['note-c']);
  assert.ok(merged.messages.some((m) => m.id === 'note-a'));
  assert.ok(merged.messages.some((m) => m.id === 'note-b'));
});
