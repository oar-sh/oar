// Telling a tap from everything else that happens on the viewer's content.
//
// A tap is one pointer that goes down and comes up in place, quickly. A drag
// (panning a zoomed image, selecting text), a pinch (a second pointer) and a
// long press are not taps. Neither is the first half of a double tap: the
// tap is reported only once the double-tap window has passed without a
// second pointer going down, so a double tap zooms without first flipping
// the controls. Taps on things that act by themselves (links, buttons, a
// player's own controls) are left to them.

export const TAP_MAX_MOVE_PX = 10;
export const TAP_MAX_DURATION_MS = 500;
export const DOUBLE_TAP_WINDOW_MS = 300;

const INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, summary, video, audio, [contenteditable], [data-no-viewer-tap]';

/**
 * Pure tap recognizer fed with pointer events of the shape
 * `{ type, pointerId, clientX, clientY, timeStamp, target }`. Calls `onTap`
 * with the final pointer position, `isInteractive(target)` says whether a
 * target handles taps itself (defaults to the usual controls), and
 * `hasSelection()` lets a text selection that ended under the pointer count
 * as a drag rather than a tap.
 */
export function createTapRecognizer({
  onTap,
  isInteractive = defaultIsInteractive,
  hasSelection = () => false,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const state = {
    active: null,        // the pointer being watched: { id, x, y, at }
    pointers: 0,         // pointers currently down
    pending: null,       // timer holding a tap until the double-tap window passes
    cancelled: false,    // a second pointer joined or the pointer moved too far
  };

  const dropPending = () => {
    if (state.pending === null) return;
    clearTimeoutImpl(state.pending);
    state.pending = null;
  };

  return {
    handle(event) {
      const type = String(event?.type || '');
      if (type === 'pointerdown') {
        state.pointers += 1;
        // A second pointer down while a tap waits to be reported: the start
        // of a double tap (or a pinch); either way not a single tap.
        if (state.pending !== null) {
          dropPending();
          state.cancelled = true;
          state.active = null;
          return;
        }
        if (state.pointers > 1) {
          state.cancelled = true;
          state.active = null;
          return;
        }
        if (isInteractive(event.target)) {
          state.active = null;
          return;
        }
        state.cancelled = false;
        state.active = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
        return;
      }
      if (type === 'pointermove') {
        if (!state.active || event.pointerId !== state.active.id) return;
        if (Math.hypot(event.clientX - state.active.x, event.clientY - state.active.y) > TAP_MAX_MOVE_PX) {
          state.cancelled = true;
          state.active = null;
        }
        return;
      }
      if (type === 'pointerup' || type === 'pointercancel') {
        state.pointers = Math.max(0, state.pointers - 1);
        const active = state.active;
        if (!active || event.pointerId !== active.id) {
          if (state.pointers === 0) state.cancelled = false;
          return;
        }
        state.active = null;
        if (type === 'pointercancel' || state.cancelled) { state.cancelled = false; return; }
        if (event.timeStamp - active.at > TAP_MAX_DURATION_MS) return;
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > TAP_MAX_MOVE_PX) return;
        if (hasSelection()) return;
        const point = { clientX: event.clientX, clientY: event.clientY };
        dropPending();
        state.pending = setTimeoutImpl(() => {
          state.pending = null;
          onTap?.(point);
        }, DOUBLE_TAP_WINDOW_MS);
      }
    },
    /** Forget a tap in flight, e.g. when the content is replaced. */
    cancel() {
      dropPending();
      state.active = null;
      state.cancelled = false;
      state.pointers = 0;
    },
  };
}

export function defaultIsInteractive(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
}
