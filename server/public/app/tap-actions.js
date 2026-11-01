// Shared touch/click activation helpers for the header menus (chat actions menu,
// sidebar toggle, theme button, tmux inspector menu).
//
// These activate on `pointerup` and then swallow the follow-up synthetic click on
// the *same* element. That is only safe when the surrounding menu is an overlay
// that does not reflow siblings AND the caller arms a full-screen shield (see
// lockChatActionsMenuShield in bootstrap.js) so the delayed compatibility click
// cannot land on whatever is underneath.
//
// New code should prefer plain `click` activation instead — see cwd-picker.js,
// which does all of its state changes in click/keydown handlers so no synthetic
// click can ever leak to another element.

export function bindTapAction(element, handler) {
  if (!element || element.dataset.tapBound === '1') return;
  element.dataset.tapBound = '1';
  let suppressClickUntil = 0;
  const markSuppressed = (ms = 450) => {
    suppressClickUntil = Date.now() + Math.max(200, Number(ms) || 450);
  };
  element.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    markSuppressed();
    handler(event);
  });
  element.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    handler(event);
  });
}

// The ︙ menu's shield (see lockChatActionsMenuShield in bootstrap.js).
export const CHAT_ACTIONS_MENU_SHIELD_ID = 'chat-actions-menu-backdrop';
// Longer than the shield's lock and the gap between a touch's pointerup and
// its compatibility click.
export const OPENING_CLICK_GRACE_MS = 400;

/**
 * True for the click that belongs to the gesture which opened a popover, so
 * a document-level "click outside closes it" handler must leave it alone.
 * A ︙ entry runs on pointerup and closes the menu; the touch's compatibility
 * click then lands on the menu's shield and bubbles to `document`, where it
 * would close the popover that entry has just opened. Later clicks on the
 * shield (a tap beside the open ︙ menu) still count as outside.
 *
 * `openedAt` is the Date.now() of the opening, 0 when unknown.
 */
export function isOpeningGestureClick(event, openedAt, now = Date.now()) {
  const opened = Number(openedAt) || 0;
  if (opened <= 0) return false;
  const sinceOpen = now - opened;
  if (sinceOpen < 0 || sinceOpen >= OPENING_CLICK_GRACE_MS) return false;
  return event?.target?.id === CHAT_ACTIONS_MENU_SHIELD_ID;
}

/**
 * The one click a touch still owes after a ︙ entry ran on its pointerup.
 * The browser hit-tests that compatibility click when it fires, a few ms
 * later, so it lands on whatever the entry opened: a dialog's backdrop
 * (which closes on a click on itself) or the shield (whose click reaches
 * `document`, where a list closes on a click outside it). `arm()` on the
 * pointerup; the next pointer click within the window is that click.
 */
export function createGhostClickGuard({ now = () => Date.now() } = {}) {
  let until = 0;
  return {
    arm(ms = OPENING_CLICK_GRACE_MS) {
      until = now() + Math.max(0, Number(ms) || 0);
    },
    // Disarms on the first click it sees, swallowed or not.
    take(event) {
      if (!until) return false;
      const live = now() < until;
      until = 0;
      // detail 0: Enter or Space on a button, or a script, never a touch.
      return live && Number(event?.detail) !== 0;
    },
  };
}

const ghostClickGuard = createGhostClickGuard();
let ghostClickListenerBound = false;

function swallowGhostClickAfterTouch(event) {
  // A mouse's click goes to the entry it pressed, which drops it itself.
  if (!event || event.pointerType === 'mouse') return;
  ghostClickGuard.arm();
  if (ghostClickListenerBound || typeof window === 'undefined') return;
  ghostClickListenerBound = true;
  window.addEventListener('click', (clickEvent) => {
    if (!ghostClickGuard.take(clickEvent)) return;
    clickEvent.preventDefault();
    clickEvent.stopImmediatePropagation();
  }, true);
}

export function bindMenuAction(element, handler) {
  if (!element || element.dataset.menuTapBound === '1') return;
  element.dataset.menuTapBound = '1';
  let suppressClickUntil = 0;
  const markSuppressed = (ms = 450) => {
    suppressClickUntil = Date.now() + Math.max(200, Number(ms) || 450);
  };
  element.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    markSuppressed();
    swallowGhostClickAfterTouch(event);
    handler(event);
  }, true);
  element.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    handler(event);
  }, true);
}
