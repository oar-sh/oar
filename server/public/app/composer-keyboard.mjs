// When the composer may hold the focus without raising a phone's on-screen
// keyboard, without the DOM. A focused text field shows no keyboard until the
// user touches the page; the next tap anywhere that keeps the focus there
// brings it up. So a phone gets no focus at page load, and a tap that only
// scrolls (the transcript's ⌄) keeps the focus only while the keyboard is
// already up.
//
// Whether the keyboard is up is read from the visual viewport: with it open
// the visible area is a keyboard's height shorter than the tallest it has been
// at the same width. Android shrinks the layout with it
// (interactive-widget=resizes-content), iOS only the visual viewport; both
// show here. A rotation changes the width, so each width has its own tallest.

/** A visible area this much shorter than its tallest has a keyboard under it. */
export const KEYBOARD_MIN_SHRINK_PX = 100;
export const KEYBOARD_MIN_SHRINK_RATIO = 0.15;

/** The tallest visible height seen at each layout width. */
export function createViewportBaseline() {
  const tallestByWidth = new Map();
  return {
    note(width, height) {
      const key = Math.round(Number(width) || 0);
      const value = Math.max(0, Number(height) || 0);
      const tallest = Math.max(tallestByWidth.get(key) || 0, value);
      tallestByWidth.set(key, tallest);
      return tallest;
    },
  };
}

export function isOnScreenKeyboardOpen({ editableFocused = false, visibleHeight = 0, tallestHeight = 0 } = {}) {
  if (!editableFocused) return false;
  const visible = Number(visibleHeight) || 0;
  const tallest = Number(tallestHeight) || 0;
  if (!(visible > 0) || !(tallest > 0)) return false;
  const shrink = tallest - visible;
  return shrink >= Math.max(KEYBOARD_MIN_SHRINK_PX, tallest * KEYBOARD_MIN_SHRINK_RATIO);
}

/**
 * Whether a press on the ⌄ button keeps the focus where it is. A mouse raises
 * no keyboard, so the composer keeps it as it always has; a touch (or a pen,
 * or a pointer that does not say) keeps it only while the keyboard is open.
 */
export function shouldHoldFocusOnJump({ pointerType = '', keyboardOpen = false } = {}) {
  if (String(pointerType || '') === 'mouse') return true;
  return Boolean(keyboardOpen);
}

/** The composer takes the focus at page load on a desktop only. */
export function shouldAutofocusComposerOnLoad({ coarsePointer = false, phoneLayout = false } = {}) {
  return !coarsePointer && !phoneLayout;
}
