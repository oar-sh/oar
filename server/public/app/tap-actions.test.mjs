import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_ACTIONS_MENU_SHIELD_ID,
  createGhostClickGuard,
  isOpeningGestureClick,
  OPENING_CLICK_GRACE_MS,
} from './tap-actions.js';

const click = (id, extra = {}) => ({ target: { id }, detail: 1, isTrusted: true, ...extra });

test('the click of the touch that opened a popover from ︙ lands on the shield and is ignored', () => {
  const openedAt = 10_000;
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), openedAt, openedAt + 6), true);
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), openedAt, openedAt + OPENING_CLICK_GRACE_MS - 1), true);
});

test('a later tap on the shield counts as outside again', () => {
  const openedAt = 10_000;
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), openedAt, openedAt + OPENING_CLICK_GRACE_MS), false);
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), openedAt, openedAt + 5_000), false);
});

test('a click anywhere else is outside, even right after the opening', () => {
  const openedAt = 10_000;
  assert.equal(isOpeningGestureClick(click('messages'), openedAt, openedAt + 6), false);
  assert.equal(isOpeningGestureClick({ target: null }, openedAt, openedAt + 6), false);
  assert.equal(isOpeningGestureClick(null, openedAt, openedAt + 6), false);
});

test('no known opening, or a clock that went back, never hides a click', () => {
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), 0, 6), false);
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), undefined, 6), false);
  assert.equal(isOpeningGestureClick(click(CHAT_ACTIONS_MENU_SHIELD_ID), 10_000, 9_000), false);
});

test('after a touch ran a ︙ entry, the next pointer click in the window is swallowed, once', () => {
  let clock = 1_000;
  const guard = createGhostClickGuard({ now: () => clock });
  assert.equal(guard.take({ detail: 1 }), false, 'nothing armed');
  guard.arm();
  clock += 6;
  assert.equal(guard.take({ detail: 1 }), true, 'the compatibility click');
  clock += 50;
  assert.equal(guard.take({ detail: 1 }), false, 'a second click is the user’s');
});

test('the guard lets a keyboard click through and gives up after the window', () => {
  let clock = 1_000;
  const guard = createGhostClickGuard({ now: () => clock });
  guard.arm();
  assert.equal(guard.take({ detail: 0 }), false, 'Enter or Space');
  assert.equal(guard.take({ detail: 1 }), false, 'disarmed by the first click');
  guard.arm();
  clock += OPENING_CLICK_GRACE_MS;
  assert.equal(guard.take({ detail: 1 }), false, 'too late: a new tap');
});
