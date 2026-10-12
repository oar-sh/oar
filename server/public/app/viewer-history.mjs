// The system back gesture closes the viewer instead of leaving the app.
//
// Opening the viewer pushes one history entry marked as ours; back pops it
// and the pop closes the viewer. Closing by any other means (the × button,
// Escape, a swipe down) pops that entry itself so history is left as it
// was, and the pop that follows is recognised as our own and ignored. The
// address never changes: the entry carries only its state.

export const VIEWER_HISTORY_MARK = 'oarFileViewer';
const OWN_POP_WINDOW_MS = 1500;

// `mark` names the viewer's entry: two viewers (the file viewer and the
// sub-agent viewer) must never take each other's entry for their own.
export function createViewerHistory({ history, onBack, now = () => Date.now(), mark = VIEWER_HISTORY_MARK } = {}) {
  const state = { pushed: false, ownPopAt: 0 };
  return {
    get pushed() { return state.pushed; },
    /** The viewer came up: one entry, however many files it then shows. */
    opened() {
      if (state.pushed) return;
      history.pushState({ [mark]: true }, '');
      state.pushed = true;
    },
    /** The viewer went away by itself: take its entry back out of history. */
    closed() {
      if (!state.pushed) return;
      state.pushed = false;
      if (history.state?.[mark]) {
        state.ownPopAt = now();
        history.back();
      }
    },
    /** Feed every popstate here; the one answering our own back() is skipped. */
    onPopState() {
      if (state.ownPopAt && now() - state.ownPopAt < OWN_POP_WINDOW_MS) {
        state.ownPopAt = 0;
        return;
      }
      state.ownPopAt = 0;
      if (!state.pushed) return;
      state.pushed = false;
      onBack?.();
    },
  };
}
