// In the installed app, the system back button with nothing left to go back
// to closes the app. There is no way for a page to send itself to the
// background instead, but it can make sure that moment never comes: one
// entry marked as the floor is kept beneath the app's own entry, and when
// back lands on the floor the app's entry is pushed again at once. Back
// still closes the file viewer (which pushes its own entry above); only the
// last step out is swallowed. A browser tab keeps its back button: this is
// for the installed app alone.

export const BACK_GUARD_FLOOR = 'oarBackGuardFloor';
export const BACK_GUARD_APP = 'oarApp';
// Every entry the app writes carries its place in the stack, so a pop tells
// back from forward (session-history.mjs, viewer-history.mjs).
export const HISTORY_POSITION = 'oarPos';
// The visit's base (the floor, the phone's session list) is laid: a reload
// on any later entry must not lay it again.
export const VISIT_LAID = 'oarLaid';
// The place in the stack of the visit's lowest own entry (the phone's list,
// else the first session): back from above it stays in the app.
export const VISIT_BASE = 'oarBase';
export const FIRST_INTERACTION_EVENTS = Object.freeze(['pointerdown', 'keydown', 'touchstart']);

/** The marks every later entry of the visit carries over from the one below. */
export function inheritedVisitMarks(state) {
  const marks = {};
  if (!state || typeof state !== 'object') return marks;
  if (state[BACK_GUARD_APP]) marks[BACK_GUARD_APP] = true;
  if (state[VISIT_LAID]) marks[VISIT_LAID] = state[VISIT_LAID];
  if (Number.isFinite(state[VISIT_BASE])) marks[VISIT_BASE] = state[VISIT_BASE];
  return marks;
}

/**
 * Lay the floor at the first touch or key, not at start-up: an entry a page
 * leaves through pushState before the user has done anything is one the
 * browser skips on back (its guard against pages that hijack the button),
 * so a floor laid at start-up would be stepped over. Before the first
 * interaction nothing a page does keeps back from leaving; from then on
 * the floor holds.
 */
export function armBackGuardOnFirstInteraction({ history, enabled = true, target, onFloor = null, entryAgain = null } = {}) {
  if (!enabled || !history || !target) return null;
  const state = { guard: null };
  const arm = () => {
    for (const eventName of FIRST_INTERACTION_EVENTS) target.removeEventListener(eventName, arm, true);
    if (state.guard) return;
    state.guard = installBackGuard({ history, enabled: true, onFloor, entryAgain });
    target.addEventListener('popstate', () => state.guard.onPopState());
  };
  for (const eventName of FIRST_INTERACTION_EVENTS) target.addEventListener(eventName, arm, true);
  return { get armed() { return Boolean(state.guard); } };
}

/**
 * `onFloor` is told each time back lands on the floor and is swallowed.
 * The entry pushed again then is pushed without a touch, so the browser
 * lets the next back leave unless the user touches the app in between:
 * one swallowed press, then the app closes — the pattern phones use, and
 * the moment to say "press back again to close".
 *
 * `entryAgain` names the entry pushed back above the floor: `{ state, url }`
 * (the session list on a phone, else the session on screen). Without it a
 * bare app entry goes back up.
 */
export function installBackGuard({ history, enabled = true, onFloor = null, entryAgain = null } = {}) {
  if (!enabled || !history) return null;
  const current = history.state && typeof history.state === 'object' ? history.state : {};
  // After a reload on the app's entry the floor already lies beneath it.
  if (!current[BACK_GUARD_FLOOR] && !current[BACK_GUARD_APP]) {
    history.replaceState({ ...current, [BACK_GUARD_FLOOR]: true }, '');
    history.pushState({ [BACK_GUARD_APP]: true }, '');
  }
  return {
    /** Feed every popstate here. */
    onPopState() {
      if (!history.state?.[BACK_GUARD_FLOOR]) return;
      const again = typeof entryAgain === 'function' ? entryAgain() : null;
      if (again?.state && again.url) history.pushState({ ...again.state, [BACK_GUARD_APP]: true }, '', again.url);
      else if (again?.state) history.pushState({ ...again.state, [BACK_GUARD_APP]: true }, '');
      else history.pushState({ [BACK_GUARD_APP]: true }, '');
      onFloor?.();
    },
  };
}
