import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JUMP_BUTTON_SHOW_SCREENS,
  JUMP_SMOOTH_MAX_SCREENS,
  countNewRows,
  isNearBottom,
  jumpBadgeText,
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
  assert.deepEqual(state, { visible: false, baseline: null, count: 0 });
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

test('a folded agent exchange counts as one row, its prompt, reply and live bubble together', () => {
  const prompt = transcriptRowKey({ messageId: 'msg_fixture_prompt', exchangePromptId: 'msg_fixture_prompt' });
  const live = transcriptRowKey({ messageId: 'msg_fixture_prompt', exchangePromptId: 'msg_fixture_prompt', live: true });
  const reply = transcriptRowKey({ messageId: 'msg_fixture_reply', exchangePromptId: 'msg_fixture_prompt' });
  assert.equal(prompt, live);
  assert.equal(prompt, reply);
  const baseline = ['msg:a'];
  assert.equal(countNewRows(baseline, ['msg:a', prompt, live]), 1);
  assert.equal(countNewRows(baseline, ['msg:a', prompt, reply]), 1);
  assert.equal(countNewRows(baseline, ['msg:a', prompt, reply, 'msg:b']), 2);
  // Two exchanges are two rows.
  const other = transcriptRowKey({ messageId: 'msg_fixture_other', exchangePromptId: 'msg_fixture_other' });
  assert.equal(countNewRows(baseline, ['msg:a', prompt, reply, other, other]), 2);
});

test('an exchange already on the page when the reader left is not news when its reply folds in', () => {
  const fold = transcriptRowKey({ messageId: 'msg_fixture_prompt', exchangePromptId: 'msg_fixture_prompt' });
  assert.equal(countNewRows(['msg:a', fold], ['msg:a', fold, fold]), 0);
});

test('rows outside a fold keep keys of their own, the live bubble apart from its prompt', () => {
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
});
