import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createViewportBaseline,
  isOnScreenKeyboardOpen,
  shouldAutofocusComposerOnLoad,
  shouldHoldFocusOnJump,
} from './composer-keyboard.mjs';

test('the baseline keeps the tallest height per width', () => {
  const baseline = createViewportBaseline();
  assert.equal(baseline.note(390, 760), 760);
  assert.equal(baseline.note(390, 440), 760);
  assert.equal(baseline.note(390, 790), 790);
  // Rotated: a width of its own.
  assert.equal(baseline.note(844, 330), 330);
  assert.equal(baseline.note(390.4, 500), 790);
});

test('a keyboard is open when a focused field sits in a visibly shorter viewport', () => {
  // A phone keyboard takes a third of the height or more.
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: true, visibleHeight: 440, tallestHeight: 760 }), true);
  // Landscape: a short viewport and a keyboard that takes most of it.
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: true, visibleHeight: 150, tallestHeight: 330 }), true);
});

test('no keyboard when nothing is focused or the viewport is its full height', () => {
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: false, visibleHeight: 440, tallestHeight: 760 }), false);
  // Focused at page load: no keyboard shows, and the height says so.
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: true, visibleHeight: 760, tallestHeight: 760 }), false);
  // The browser's address bar sliding away is not a keyboard.
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: true, visibleHeight: 704, tallestHeight: 760 }), false);
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: true, visibleHeight: 0, tallestHeight: 760 }), false);
  assert.equal(isOnScreenKeyboardOpen({ editableFocused: true, visibleHeight: 400, tallestHeight: 0 }), false);
  assert.equal(isOnScreenKeyboardOpen(), false);
});

test('a mouse press on ⌄ always keeps the composer focused', () => {
  assert.equal(shouldHoldFocusOnJump({ pointerType: 'mouse', keyboardOpen: false }), true);
  assert.equal(shouldHoldFocusOnJump({ pointerType: 'mouse', keyboardOpen: true }), true);
});

test('a tap on ⌄ keeps the focus only while the keyboard is open', () => {
  assert.equal(shouldHoldFocusOnJump({ pointerType: 'touch', keyboardOpen: true }), true);
  assert.equal(shouldHoldFocusOnJump({ pointerType: 'touch', keyboardOpen: false }), false);
  assert.equal(shouldHoldFocusOnJump({ pointerType: 'pen', keyboardOpen: false }), false);
  // A pointer that does not say what it is is treated like a finger.
  assert.equal(shouldHoldFocusOnJump({ pointerType: '', keyboardOpen: false }), false);
  assert.equal(shouldHoldFocusOnJump(), false);
});

test('the composer is focused at page load on a desktop only', () => {
  assert.equal(shouldAutofocusComposerOnLoad({ coarsePointer: false, phoneLayout: false }), true);
  assert.equal(shouldAutofocusComposerOnLoad({ coarsePointer: true, phoneLayout: false }), false);
  assert.equal(shouldAutofocusComposerOnLoad({ coarsePointer: false, phoneLayout: true }), false);
  assert.equal(shouldAutofocusComposerOnLoad({ coarsePointer: true, phoneLayout: true }), false);
});
