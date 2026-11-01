import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHONE_TYPING_MIN_SHRINK_PX,
  PHONE_TYPING_MIN_SHRINK_RATIO,
  createPhoneTypingBaseline,
  isKeyboardShrink,
  resolvePhoneTyping,
  rotatedLayoutHeight,
} from './phone-typing-state.mjs';

// A phone on its side: 412px tall with nothing under it, about 190px with the keyboard up.
const keyboardUp = { phoneLandscape: true, inputFocused: true, layoutHeight: 412, visualHeight: 190 };

test('the thresholds: a quarter shorter, or more than 150px', () => {
  assert.equal(PHONE_TYPING_MIN_SHRINK_PX, 150);
  assert.equal(PHONE_TYPING_MIN_SHRINK_RATIO, 0.25);
  // A quarter of 412px is 103px.
  assert.equal(isKeyboardShrink({ layoutHeight: 412, visualHeight: 309 }), true);
  assert.equal(isKeyboardShrink({ layoutHeight: 412, visualHeight: 312 }), false);
  // On a tall layout the 150px test comes first.
  assert.equal(isKeyboardShrink({ layoutHeight: 1000, visualHeight: 849 }), true);
  assert.equal(isKeyboardShrink({ layoutHeight: 1000, visualHeight: 850 }), false);
});

test('a URL bar coming and going is no keyboard', () => {
  assert.equal(isKeyboardShrink({ layoutHeight: 412, visualHeight: 356 }), false);
  assert.equal(isKeyboardShrink({ layoutHeight: 356, visualHeight: 412 }), false);
});

test('unknown heights are no keyboard', () => {
  assert.equal(isKeyboardShrink({ layoutHeight: 0, visualHeight: 190 }), false);
  assert.equal(isKeyboardShrink({ layoutHeight: 412, visualHeight: 0 }), false);
  assert.equal(isKeyboardShrink({ layoutHeight: Number.NaN, visualHeight: 190 }), false);
  assert.equal(isKeyboardShrink(), false);
});

test('typing mode: phone landscape, the message box focused, and the keyboard up', () => {
  assert.equal(resolvePhoneTyping(keyboardUp), true);
  assert.equal(resolvePhoneTyping({ ...keyboardUp, phoneLandscape: false }), false);
  assert.equal(resolvePhoneTyping({ ...keyboardUp, inputFocused: false }), false);
  // Focused with the keyboard down (Android's back key hides it, the focus stays).
  assert.equal(resolvePhoneTyping({ ...keyboardUp, visualHeight: 412 }), false);
  assert.equal(resolvePhoneTyping(), false);
});

test('a hold keeps typing mode while a panel it opened is open, in phone landscape only', () => {
  assert.equal(resolvePhoneTyping({ ...keyboardUp, inputFocused: false, visualHeight: 412, held: true }), true);
  assert.equal(resolvePhoneTyping({ ...keyboardUp, phoneLandscape: false, held: true }), false);
});

test('a turn with the keyboard up starts from the old height, so typing mode comes at once', () => {
  const baseline = createPhoneTypingBaseline();
  // Upright, keyboard down: 390 wide, 750 tall.
  assert.equal(baseline.note(390, 750), 750);
  // Turned with the keyboard up: the first height at 844 is already the short one.
  const layoutHeight = baseline.note(844, 160);
  assert.equal(layoutHeight, 390 + 750 - 844);
  assert.equal(resolvePhoneTyping({ phoneLandscape: true, inputFocused: true, layoutHeight, visualHeight: 160 }), true);
  // The keyboard going down later shows the real height, which wins.
  assert.equal(baseline.note(844, 320), 320);
  assert.equal(baseline.note(844, 160), 320);
  // A width seen before keeps its own height.
  assert.equal(baseline.note(390, 400), 750);
});

test('a turn back upright starts from the sideways height', () => {
  const baseline = createPhoneTypingBaseline();
  baseline.note(844, 320);
  assert.equal(baseline.note(390, 420), 844 + 320 - 390);
});

test('a width change that is no turn starts from nothing', () => {
  // A desktop window made narrower or wider stays the same way up.
  assert.equal(rotatedLayoutHeight({ width: 1280, tallest: 800 }, 1200), 0);
  assert.equal(rotatedLayoutHeight({ width: 1280, tallest: 800 }, 1400), 0);
  assert.equal(rotatedLayoutHeight({ width: 390, tallest: 750 }, 380), 0);
  assert.equal(rotatedLayoutHeight({ width: 390, tallest: 750 }, 390), 0);
  assert.equal(rotatedLayoutHeight(null, 844), 0);
  const baseline = createPhoneTypingBaseline();
  baseline.note(1280, 800);
  assert.equal(baseline.note(1200, 700), 700);
});
