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
const FIRST_INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart'];

/**
 * Lay the floor at the first touch or key, not at start-up: an entry a page
 * leaves through pushState before the user has done anything is one the
 * browser skips on back (its guard against pages that hijack the button),
 * so a floor laid at start-up would be stepped over. Before the first
 * interaction nothing a page does keeps back from leaving; from then on
 * the floor holds.
 */
export function armBackGuardOnFirstInteraction({ history, enabled = true, target, onFloor = null } = {}) {
  if (!enabled || !history || !target) return null;
  const state = { guard: null };
  const arm = () => {
    for (const eventName of FIRST_INTERACTION_EVENTS) target.removeEventListener(eventName, arm, true);
    if (state.guard) return;
    state.guard = installBackGuard({ history, enabled: true, onFloor });
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
 */
export function installBackGuard({ history, enabled = true, onFloor = null } = {}) {
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
      history.pushState({ [BACK_GUARD_APP]: true }, '');
      onFloor?.();
    },
  };
}
