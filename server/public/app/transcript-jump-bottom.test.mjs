import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HELD_BACK_ROWS_BADGE,
  JUMP_BUTTON_SHOW_SCREENS,
  JUMP_SMOOTH_MAX_SCREENS,
  countNewRows,
  followsEndThroughResize,
  isNearBottom,
  jumpBadgeText,
  jumpButtonPresentation,
  jumpScrollBehavior,
  nextJumpButtonState,
  shouldRepinOnResize,
  transcriptRowKey,
} from './transcript-jump-bottom.mjs';

const SCREEN = 800;
const NEAR = 48;
const at = (distance, rowKeys = []) => ({ distance, clientHeight: SCREEN, nearBottomPx: NEAR, rowKeys });

test('near the bottom is within the threshold', () => {
  assert.equal(isNearBottom(0, 48), true);
  assert.equal(isNearBottom(48, 48), true);
  assert.equal(isNearBottom(49, 48), false);
  assert.equal(isNearBottom(-5, 0), true);
});

test('the button stays hidden until the reader is about one screen above the end', () => {
  assert.equal(JUMP_BUTTON_SHOW_SCREENS, 1);
  assert.equal(nextJumpButtonState(null, at(0)).visible, false);
  assert.equal(nextJumpButtonState(null, at(NEAR)).visible, false);
  assert.equal(nextJumpButtonState(null, at(SCREEN / 2)).visible, false);
  assert.equal(nextJumpButtonState(null, at(SCREEN - 1)).visible, false);
  assert.equal(nextJumpButtonState(null, at(SCREEN)).visible, true);
  assert.equal(nextJumpButtonState(null, at(SCREEN * 4)).visible, true);
});

test('once shown it stays on the way back down and fades out only at the bottom', () => {
  let state = nextJumpButtonState(null, at(SCREEN * 2));
  assert.equal(state.visible, true);
  state = nextJumpButtonState(state, at(SCREEN / 3));
  assert.equal(state.visible, true);
  state = nextJumpButtonState(state, at(NEAR + 1));
  assert.equal(state.visible, true);
  state = nextJumpButtonState(state, at(NEAR));
  assert.deepEqual(state, { visible: false, baseline: null, count: 0, unseen: false, question: false, waiting: 0 });
});

test('a transcript with no height never shows the button', () => {
  assert.equal(nextJumpButtonState(null, { distance: 500, clientHeight: 0, nearBottomPx: 0 }).visible, false);
});

test('the badge counts the rows that arrived after the reader left the bottom', () => {
  let state = nextJumpButtonState(null, at(SCREEN * 2, ['msg:a', 'msg:b']));
  assert.deepEqual(state.baseline, ['msg:a', 'msg:b']);
  assert.equal(state.count, 0);
  state = nextJumpButtonState(state, at(SCREEN * 2.5, ['msg:a', 'msg:b', 'msg:c']));
  assert.equal(state.count, 1);
  state = nextJumpButtonState(state, at(SCREEN * 3, ['msg:a', 'msg:b', 'msg:c', 'live:c']));
  assert.equal(state.count, 2);
  // The live bubble gives way to the reply it streamed.
  state = nextJumpButtonState(state, at(SCREEN * 3, ['msg:a', 'msg:b', 'msg:c', 'msg:d']));
  assert.equal(state.count, 2);
  // Back at the bottom: cleared, and the next trip up starts from there.
  state = nextJumpButtonState(state, at(0, ['msg:a', 'msg:b', 'msg:c', 'msg:d']));
  assert.equal(state.count, 0);
  state = nextJumpButtonState(state, at(SCREEN, ['msg:a', 'msg:b', 'msg:c', 'msg:d']));
  assert.deepEqual(state.baseline, ['msg:a', 'msg:b', 'msg:c', 'msg:d']);
  assert.equal(state.count, 0);
});

test('a folded agent prompt and its reply are two rows, like any turn', () => {
  const prompt = transcriptRowKey({ messageId: 'msg_fixture_prompt' });
  const live = transcriptRowKey({ messageId: 'msg_fixture_prompt', live: true });
  const reply = transcriptRowKey({ messageId: 'msg_fixture_reply' });
  const baseline = ['msg:a'];
  assert.equal(countNewRows(baseline, ['msg:a', prompt]), 1);
  assert.equal(countNewRows(baseline, ['msg:a', prompt, live]), 2);
  assert.equal(countNewRows(baseline, ['msg:a', prompt, reply]), 2);
  // A fold's prompt id is no key of its own any more.
  assert.equal(transcriptRowKey({ messageId: 'msg_fixture_reply', exchangePromptId: 'msg_fixture_prompt' }), reply);
});

test('rows keep keys of their own, the live bubble apart from its prompt', () => {
  assert.equal(transcriptRowKey({ messageId: 'msg_fixture_a' }), 'msg:msg_fixture_a');
  assert.equal(transcriptRowKey({ messageId: 'msg_fixture_a', live: true }), 'live:msg_fixture_a');
  assert.equal(transcriptRowKey({ messageId: '  ' }), '');
  assert.equal(transcriptRowKey(), '');
});

test('older history paged in above and re-rendered rows are not counted', () => {
  assert.equal(countNewRows(['msg:c', 'msg:d'], ['msg:a', 'msg:b', 'msg:c', 'msg:d']), 0);
  assert.equal(countNewRows(['msg:c', 'msg:d'], ['msg:a', 'msg:c', 'msg:d', 'msg:e']), 1);
  assert.equal(countNewRows(['msg:c', 'msg:d'], ['msg:c', 'msg:d', 'msg:e', 'msg:e', '']), 1);
});

test('a transcript sharing no row with the baseline counts nothing; an empty baseline counts all', () => {
  assert.equal(countNewRows(['msg:a'], ['msg:x', 'msg:y']), 0);
  assert.equal(countNewRows([], ['msg:x', 'msg:y']), 2);
  assert.equal(countNewRows(null, null), 0);
});

test('the badge reads the count, capped at 99+', () => {
  assert.equal(jumpBadgeText(0), '');
  assert.equal(jumpBadgeText(-3), '');
  assert.equal(jumpBadgeText(1), '1');
  assert.equal(jumpBadgeText(99), '99');
  assert.equal(jumpBadgeText(100), '99+');
});

test('a click scrolls smoothly up to three screens away and jumps at once beyond', () => {
  assert.equal(JUMP_SMOOTH_MAX_SCREENS, 3);
  assert.equal(jumpScrollBehavior({ distance: SCREEN, clientHeight: SCREEN }), 'smooth');
  assert.equal(jumpScrollBehavior({ distance: SCREEN * 3, clientHeight: SCREEN }), 'smooth');
  assert.equal(jumpScrollBehavior({ distance: SCREEN * 3 + 1, clientHeight: SCREEN }), 'instant');
  assert.equal(jumpScrollBehavior({ distance: SCREEN, clientHeight: SCREEN, reducedMotion: true }), 'instant');
  assert.equal(jumpScrollBehavior({ distance: SCREEN, clientHeight: 0 }), 'instant');
});

test('a resize re-pins a reader who was following while scrollTop has not moved since', () => {
  // The background-task panel appears: the transcript shrinks from below,
  // scrollTop stays, and the reader is now the panel's height above the end.
  assert.equal(shouldRepinOnResize({ pinned: true, pinnedScrollTop: 1200, scrollTop: 1200, nearBottomNow: false }), true);
  assert.equal(shouldRepinOnResize({ pinned: false, pinnedScrollTop: 1200, scrollTop: 1200, nearBottomNow: false }), false);
  // scrollTop moved without a scroll event yet (a restored position): the
  // geometry decides.
  assert.equal(shouldRepinOnResize({ pinned: true, pinnedScrollTop: 1200, scrollTop: 300, nearBottomNow: false }), false);
  assert.equal(shouldRepinOnResize({ pinned: false, pinnedScrollTop: 1200, scrollTop: 1500, nearBottomNow: true }), true);
  // A reader who was not at the end and has not moved: a resize that brings
  // the end within the margin (the composer shrank) does not take them there.
  assert.equal(shouldRepinOnResize({ pinned: false, pinnedScrollTop: 1200, scrollTop: 1200, nearBottomNow: true }), false);
});

test('a live update that lands before the re-pin still follows the end', () => {
  const grown = { clientHeight: 351, observedClientHeight: 543, nearBottomPxAtObservedHeight: 43 };
  // At the end now: followed.
  assert.equal(followsEndThroughResize({ nearBottomNow: true, clientHeight: 500, observedClientHeight: 500, distanceAtObservedHeight: 0, nearBottomPxAtObservedHeight: 40 }), true);
  // The panel grew (543 to 351) and the observer has not had its round: at
  // the height it saw, the reader is at the end, so a reply streaming in now
  // follows too, whether or not the scroll that took them there was noted.
  assert.equal(followsEndThroughResize({ ...grown, nearBottomNow: false, distanceAtObservedHeight: 0 }), true);
  assert.equal(followsEndThroughResize({ ...grown, nearBottomNow: false, distanceAtObservedHeight: 43 }), true);
  // A reader who was above the end before the shrink is not taken along.
  assert.equal(followsEndThroughResize({ ...grown, nearBottomNow: false, distanceAtObservedHeight: 44 }), false);
  assert.equal(followsEndThroughResize({ ...grown, nearBottomNow: false, distanceAtObservedHeight: 900 }), false);
  // No shrink pending: a reader away from the end is away from it.
  assert.equal(followsEndThroughResize({ ...grown, clientHeight: 543, nearBottomNow: false, distanceAtObservedHeight: 0 }), false);
  assert.equal(followsEndThroughResize({ ...grown, clientHeight: 700, nearBottomNow: false, distanceAtObservedHeight: 0 }), false);
  assert.equal(followsEndThroughResize({ ...grown, observedClientHeight: null, nearBottomNow: false, distanceAtObservedHeight: null }), false);
});

test('a new row shows the button at any distance from the end', () => {
  // Half a screen up: the plain button would not show yet.
  let state = nextJumpButtonState(null, at(SCREEN / 2, ['msg:a']));
  assert.equal(state.visible, false);
  state = nextJumpButtonState(state, at(SCREEN / 2 + 120, ['msg:a', 'msg:b']));
  assert.equal(state.visible, true);
  assert.equal(state.count, 1);
  assert.equal(jumpButtonPresentation(state).state, 'new');
});

test('an update that was not followed marks the button until the bottom, without a row to count', () => {
  // A reply growing in its live bubble: the rows are the same.
  let state = nextJumpButtonState(null, at(SCREEN / 2, ['msg:a', 'live:a']));
  state = nextJumpButtonState(state, { ...at(SCREEN / 2 + 300, ['msg:a', 'live:a']), unseen: true });
  assert.equal(state.visible, true);
  assert.equal(state.count, 0);
  assert.equal(state.unseen, true);
  // It holds through later rounds that have nothing new to say.
  state = nextJumpButtonState(state, at(SCREEN / 2 + 300, ['msg:a', 'live:a']));
  assert.equal(state.unseen, true);
  assert.deepEqual(jumpButtonPresentation(state), {
    state: 'new',
    label: 'Jump to the latest message (new below)',
    badge: '',
    dot: true,
    announcement: 'New messages below.',
  });
  state = nextJumpButtonState(state, at(0, ['msg:a', 'live:a']));
  assert.deepEqual(state, { visible: false, baseline: null, count: 0, unseen: false, question: false, waiting: 0 });
});

test('a waiting question shows the button and clears with the question, not with the distance', () => {
  let state = nextJumpButtonState(null, { ...at(SCREEN / 2, ['msg:a']), question: true });
  assert.equal(state.visible, true);
  assert.equal(state.question, true);
  assert.equal(jumpButtonPresentation(state).state, 'question');
  // Answered elsewhere: the card is gone, the button stays as a plain one.
  state = nextJumpButtonState(state, { ...at(SCREEN / 2, ['msg:a']), question: false });
  assert.equal(state.question, false);
  assert.equal(state.visible, true);
  assert.equal(jumpButtonPresentation(state).state, 'plain');
  // At the bottom a question is on screen: nothing to mark.
  state = nextJumpButtonState(state, { ...at(NEAR, ['msg:a']), question: true });
  assert.deepEqual(state, { visible: false, baseline: null, count: 0, unseen: false, question: false, waiting: 0 });
});

test('how each state looks and reads', () => {
  const plain = { state: 'plain', label: 'Jump to the latest message', badge: '', dot: false, announcement: '' };
  assert.deepEqual(jumpButtonPresentation(), plain);
  assert.deepEqual(jumpButtonPresentation({ visible: true }), plain);
  // Hidden: plain whatever it knew.
  assert.deepEqual(jumpButtonPresentation({ visible: false, count: 3, unseen: true, question: true }), plain);
  assert.deepEqual(jumpButtonPresentation({ visible: true, count: 3, unseen: true }), {
    state: 'new',
    label: 'Jump to the latest message (3 new)',
    badge: '3',
    dot: false,
    announcement: 'New messages below.',
  });
  assert.equal(jumpButtonPresentation({ visible: true, count: 250 }).badge, '99+');
  // A question wins over news.
  assert.deepEqual(jumpButtonPresentation({ visible: true, count: 3, unseen: true, question: true }), {
    state: 'question',
    label: 'A question is waiting for your answer. Jump to it',
    badge: '?',
    dot: false,
    announcement: 'A question is waiting for your answer below.',
  });
});

test('rows held back below a window above the end keep the button, counted, at the bottom of the page too', () => {
  // The reader is at the bottom of the window: not at the end.
  let state = nextJumpButtonState(null, { ...at(0, ['msg:a']), windowAtTail: false, waiting: 3 });
  assert.equal(state.visible, true);
  assert.equal(state.waiting, 3);
  assert.equal(state.count, 0);
  assert.deepEqual(jumpButtonPresentation(state), {
    state: 'new',
    label: 'Jump to the latest message (3 new)',
    badge: '3',
    dot: false,
    announcement: 'New messages below.',
  });
  // The newer pages put on the page are history: not counted, and no
  // baseline is taken from them.
  state = nextJumpButtonState(state, { ...at(SCREEN * 2, ['msg:a', 'msg:b', 'msg:c']), windowAtTail: false, waiting: 3 });
  assert.equal(state.count, 0);
  assert.equal(state.baseline, null);
  assert.equal(jumpButtonPresentation(state).badge, '3');
  // The window meets the end: what waited is on the page, the baseline is
  // the page as it is, and a row after it counts as before.
  state = nextJumpButtonState(state, { ...at(SCREEN * 2, ['msg:a', 'msg:b', 'msg:c', 'msg:d']), windowAtTail: true, waiting: 3 });
  assert.equal(state.waiting, 0);
  assert.deepEqual(state.baseline, ['msg:a', 'msg:b', 'msg:c', 'msg:d']);
  assert.equal(jumpButtonPresentation(state).badge, '');
  state = nextJumpButtonState(state, at(SCREEN * 2, ['msg:a', 'msg:b', 'msg:c', 'msg:d', 'msg:e']));
  assert.equal(jumpButtonPresentation(state).badge, '1');
  // Without anything waiting, the bottom of a window above the end hides the
  // button as before.
  assert.equal(nextJumpButtonState(null, { ...at(0, ['msg:a']), windowAtTail: false, waiting: 0 }).visible, false);
});

test('held-back rows are a count by default; the dot is one switch away', () => {
  assert.equal(HELD_BACK_ROWS_BADGE, 'count');
  const state = { visible: true, count: 1, waiting: 2 };
  assert.equal(jumpButtonPresentation(state).badge, '3');
  const dot = jumpButtonPresentation({ visible: true, waiting: 2 }, { heldBackRowsBadge: 'dot' });
  assert.equal(dot.badge, '');
  assert.equal(dot.dot, true);
  assert.equal(dot.state, 'new');
  // A question still wins.
  assert.equal(jumpButtonPresentation({ visible: true, waiting: 2, question: true }).badge, '?');
});
