// A swipe across the viewer: one pointer, moving mostly along one axis.
//
// The axis is decided once the pointer has moved a little, and stays: a
// drag that started sideways is a sideways drag even if it wanders. Each
// axis can be switched off for the moment (sideways while an image is
// zoomed in, since that is a pan; downwards while text is scrolled). The
// content follows the finger through `onMove`; on release the drag is a
// swipe when it went far enough or fast enough, else it springs back.

export const SWIPE_LOCK_PX = 12;
export const SWIPE_THRESHOLD_PX = 80;
export const SWIPE_FLICK_PX_PER_MS = 0.45;
export const SWIPE_MIN_FLICK_PX = 30;

export function createSwipeRecognizer({
  onStart = () => {},
  onMove = () => {},
  onEnd = () => {},
  canStart = () => true,
  horizontalEnabled = () => true,
  verticalEnabled = () => false,
  lockPx = SWIPE_LOCK_PX,
  thresholdPx = SWIPE_THRESHOLD_PX,
  flickPxPerMs = SWIPE_FLICK_PX_PER_MS,
  minFlickPx = SWIPE_MIN_FLICK_PX,
} = {}) {
  const state = { pointer: null, pointers: 0 };

  const finish = (event, { cancelled = false } = {}) => {
    const p = state.pointer;
    state.pointer = null;
    if (!p || !p.axis) return;
    const dx = event ? event.clientX - p.x : 0;
    const dy = event ? event.clientY - p.y : 0;
    const along = p.axis === 'x' ? dx : dy;
    // Velocity from the last two samples; a finger that paused before
    // lifting has none.
    const dt = event ? event.timeStamp - p.lastAt : Infinity;
    const velocity = dt > 0 && dt < 100 && Number.isFinite(dt)
      ? ((p.axis === 'x' ? event.clientX - p.lastX : event.clientY - p.lastY) / dt)
      : 0;
    const farEnough = Math.abs(along) > thresholdPx;
    const flicked = Math.abs(along) > minFlickPx && Math.abs(velocity) > flickPxPerMs
      && Math.sign(velocity) === Math.sign(along);
    let swipe = null;
    if (!cancelled && (farEnough || flicked)) {
      swipe = p.axis === 'x' ? (along < 0 ? 'left' : 'right') : (along < 0 ? 'up' : 'down');
    }
    onEnd({ axis: p.axis, dx, dy, swipe, cancelled });
  };

  return {
    handle(event) {
      const type = String(event?.type || '');
      if (type === 'pointerdown') {
        state.pointers += 1;
        if (state.pointers > 1) {
          // A second finger: a pinch, not a swipe.
          finish(null, { cancelled: true });
          return;
        }
        if (!canStart(event)) return;
        state.pointer = {
          id: event.pointerId,
          x: event.clientX, y: event.clientY,
          lastX: event.clientX, lastY: event.clientY, lastAt: event.timeStamp,
          axis: null,
        };
        return;
      }
      const p = state.pointer;
      if (type === 'pointermove') {
        if (!p || event.pointerId !== p.id) return;
        const dx = event.clientX - p.x;
        const dy = event.clientY - p.y;
        if (!p.axis) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < lockPx) return;
          const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
          if ((axis === 'x' && !horizontalEnabled()) || (axis === 'y' && !verticalEnabled())) {
            state.pointer = null;
            return;
          }
          p.axis = axis;
          onStart({ axis });
        }
        p.lastX = event.clientX;
        p.lastY = event.clientY;
        p.lastAt = event.timeStamp;
        onMove({ axis: p.axis, dx, dy });
        return;
      }
      if (type === 'pointerup' || type === 'pointercancel') {
        state.pointers = Math.max(0, state.pointers - 1);
        if (!p || event.pointerId !== p.id) return;
        finish(event, { cancelled: type === 'pointercancel' });
      }
    },
    /** True while a swipe is being tracked along an axis. */
    get active() { return Boolean(state.pointer?.axis); },
    cancel() {
      finish(null, { cancelled: true });
      state.pointers = 0;
    },
  };
}
