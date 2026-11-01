// Typing mode on a phone turned sideways (body.phone-typing): while the
// on-screen keyboard is up, the composer's label row and the background-task
// line fold into two small floating buttons, so the few rows the keyboard
// leaves go to the transcript and the message box. DOM-free; the wiring is in
// phone-landscape-ui.js.
//
// The keyboard is up when the message box has the focus and the visible area
// is clearly shorter than the layout height. The layout height is the
// tallest visible height seen at the current width (composer-keyboard.mjs's
// baseline): on Android the keyboard shrinks the layout viewport with the
// visual one (interactive-widget=resizes-content), so window.innerHeight
// alone would never show it. A browser's URL bar coming and going moves the
// height by about 56px, well under the threshold. A turn of the phone seeds
// the new width's height from the old one (createPhoneTypingBaseline).

/** A visible area this much shorter has a keyboard under it (either test). */
export const PHONE_TYPING_MIN_SHRINK_PX = 150;
export const PHONE_TYPING_MIN_SHRINK_RATIO = 0.25;

/** Whether the visible height is clearly shorter than the layout height. */
export function isKeyboardShrink({ layoutHeight = 0, visualHeight = 0 } = {}) {
  const layout = Number(layoutHeight) || 0;
  const visual = Number(visualHeight) || 0;
  if (!(layout > 0) || !(visual > 0)) return false;
  const shrink = layout - visual;
  if (shrink <= 0) return false;
  return shrink > PHONE_TYPING_MIN_SHRINK_PX || shrink >= layout * PHONE_TYPING_MIN_SHRINK_RATIO;
}

/**
 * The layout height a turn of the phone should give, from the tallest height
 * seen before it (`previous`: `{ width, tallest }`), or 0 when the new width
 * is no turn of the old one. The bars (status, URL) cost about the same
 * either way up, so the old width less those bars:
 * `previous.width - (newWidth - previous.tallest)`.
 */
export function rotatedLayoutHeight(previous, newWidth) {
  const width = Math.round(Number(previous?.width) || 0);
  const tallest = Number(previous?.tallest) || 0;
  const next = Math.round(Number(newWidth) || 0);
  if (!(width > 0) || !(tallest > 0) || !(next > 0) || next === width) return 0;
  const wasPortrait = tallest > width;
  // Upright to sideways makes the width grow, and back makes it shrink.
  if (wasPortrait ? next <= width : next >= width) return 0;
  const estimate = width + tallest - next;
  if (!(estimate > 0)) return 0;
  // The estimate must stand the other way up than before.
  if (wasPortrait ? estimate >= next : estimate <= next) return 0;
  return estimate;
}

/**
 * The tallest visible height per width, like composer-keyboard.mjs's
 * baseline, but a turn of the phone starts the new width from the old one
 * (rotatedLayoutHeight) instead of from nothing: turned with the keyboard
 * up, the first height seen is already the short one, and typing mode would
 * stay off until the keyboard went down once. A height seen later that is
 * taller still wins.
 */
export function createPhoneTypingBaseline() {
  const tallestByWidth = new Map();
  let last = null;
  return {
    note(width, height) {
      const key = Math.round(Number(width) || 0);
      const value = Math.max(0, Number(height) || 0);
      let tallest = tallestByWidth.get(key) || 0;
      if (!tallest && last && last.width !== key) tallest = rotatedLayoutHeight(last, key);
      tallest = Math.max(tallest, value);
      tallestByWidth.set(key, tallest);
      last = { width: key, tallest };
      return tallest;
    },
  };
}

/**
 * Typing mode on or off.
 *
 * `held`: the ⚙ panel, opened in typing mode, is still open. Typing mode
 * then stays on until it closes, so the panel does not jump from above the
 * floating ⚙ to above the label row when a select in it takes the focus
 * from the message box and the keyboard goes down.
 *
 * @param {object} input
 * @param {boolean} [input.phoneLandscape] :root[data-phone-landscape]
 * @param {boolean} [input.inputFocused] #msg-input has the focus
 * @param {number} [input.layoutHeight] the tallest visible height at this width
 * @param {number} [input.visualHeight] window.visualViewport.height
 * @param {boolean} [input.held] typing mode is on and the ⚙ panel is open
 * @returns {boolean}
 */
export function resolvePhoneTyping({
  phoneLandscape = false,
  inputFocused = false,
  layoutHeight = 0,
  visualHeight = 0,
  held = false,
} = {}) {
  if (!phoneLandscape) return false;
  if (held) return true;
  if (!inputFocused) return false;
  return isKeyboardShrink({ layoutHeight, visualHeight });
}
