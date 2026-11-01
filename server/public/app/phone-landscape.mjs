// "Phone landscape": a touch phone turned sideways. Its width is often over
// 680px, so it gets the desktop layout; :root[data-phone-landscape] lets the
// stylesheet and the views treat it as the phone it is (one-line header,
// typing mode, no composer focus on a session pick, the list closing after a
// pick).
//
// The same phone as :root[data-phone-screen] (the screen's short side is
// 500px or less) with a coarse pointer, held in landscape. The orientation
// comes from the screen, never from the viewport: the on-screen keyboard
// shrinks the viewport (interactive-widget=resizes-content), and a portrait
// phone mid-typing would read as landscape.

export const PHONE_SCREEN_MAX_SHORT_SIDE_PX = 500;
export const PHONE_LANDSCAPE_ATTRIBUTE = 'data-phone-landscape';
/** Fired on window when the attribute flips. */
export const PHONE_LANDSCAPE_CHANGE_EVENT = 'oar:phone-landscape-change';

/**
 * @param {object} input
 * @param {boolean} [input.coarsePointer] `(pointer: coarse)` matches
 * @param {number} [input.screenWidth] screen.width
 * @param {number} [input.screenHeight] screen.height
 * @param {string} [input.orientationType] screen.orientation.type, when known
 * @param {number|null} [input.orientationAngle] window.orientation (old iOS), when known
 * @returns {boolean}
 */
export function isPhoneLandscape({
  coarsePointer = false,
  screenWidth = 0,
  screenHeight = 0,
  orientationType = '',
  orientationAngle = null,
} = {}) {
  if (!coarsePointer) return false;
  const width = Number(screenWidth) || 0;
  const height = Number(screenHeight) || 0;
  const shortSide = Math.min(width, height);
  if (!(shortSide > 0) || shortSide > PHONE_SCREEN_MAX_SHORT_SIDE_PX) return false;
  const type = String(orientationType || '');
  if (type.startsWith('landscape')) return true;
  if (type.startsWith('portrait')) return false;
  // iOS before 16.4 has no screen.orientation and never swaps screen.width
  // and screen.height; its window.orientation is 90 or -90 on the side.
  const angle = Number(orientationAngle);
  if (orientationAngle !== null && orientationAngle !== undefined && Number.isFinite(angle)) {
    return Math.abs(angle) === 90;
  }
  return width > height;
}

/** The inputs of isPhoneLandscape, read from a window. */
export function readPhoneLandscapeInputs(win = globalThis.window) {
  if (!win) return {};
  let coarsePointer = false;
  try { coarsePointer = !!win.matchMedia?.('(pointer: coarse)')?.matches; } catch {}
  const screenRef = win.screen || {};
  const rawAngle = win.orientation;
  return {
    coarsePointer,
    screenWidth: Number(screenRef.width) || 0,
    screenHeight: Number(screenRef.height) || 0,
    orientationType: String(screenRef.orientation?.type || ''),
    orientationAngle: typeof rawAngle === 'number' ? rawAngle : null,
  };
}

/**
 * Sets or clears :root[data-phone-landscape] from the window; announces a
 * flip with PHONE_LANDSCAPE_CHANGE_EVENT. Returns the current value.
 */
export function syncPhoneLandscapeAttribute(win = globalThis.window) {
  const root = win?.document?.documentElement;
  if (!root) return false;
  const next = isPhoneLandscape(readPhoneLandscapeInputs(win));
  const before = root.hasAttribute(PHONE_LANDSCAPE_ATTRIBUTE);
  if (next !== before) {
    root.toggleAttribute(PHONE_LANDSCAPE_ATTRIBUTE, next);
    try {
      if (typeof win.CustomEvent === 'function') {
        win.dispatchEvent(new win.CustomEvent(PHONE_LANDSCAPE_CHANGE_EVENT, { detail: { phoneLandscape: next } }));
      }
    } catch {}
  }
  return next;
}

/** Whether the page is in phone landscape now (the attribute). */
export function isPhoneLandscapeLayout(doc = globalThis.document) {
  return !!doc?.documentElement?.hasAttribute?.(PHONE_LANDSCAPE_ATTRIBUTE);
}

/**
 * Whether a pick from the session list collapses the list. On a portrait
 * phone the list is an overlay that openConversation closes; a phone turned
 * sideways has the desktop's persistent list, which a pick now collapses too.
 */
export function shouldCollapseListAfterPick({ phoneLandscape = false, overlayList = false, listOpen = false } = {}) {
  return !!phoneLandscape && !overlayList && !!listOpen;
}
