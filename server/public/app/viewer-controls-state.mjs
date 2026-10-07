// When the fullscreen viewer's hovering controls are shown.
//
// A single tap on the content toggles them. While a video or audio file
// plays they also fade out on their own after a moment, as players do; any
// interaction brings them back and starts that clock again. Pausing shows
// them and stops the clock, so a paused player is never left bare. Images
// and text have no clock: their controls stay until the next tap.

export const CONTROLS_AUTO_HIDE_MS = 3000;

export function createControlsState({
  autoHideMs = CONTROLS_AUTO_HIDE_MS,
  onChange = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const state = { visible: true, playing: false, timer: null };

  const stopClock = () => {
    if (state.timer === null) return;
    clearTimeoutImpl(state.timer);
    state.timer = null;
  };

  const set = (visible) => {
    if (state.visible === visible) return;
    state.visible = visible;
    onChange(visible);
  };

  // The clock runs only while the controls are up and media plays.
  const armClock = () => {
    stopClock();
    if (!state.playing || !state.visible) return;
    state.timer = setTimeoutImpl(() => {
      state.timer = null;
      set(false);
    }, autoHideMs);
  };

  return {
    get visible() { return state.visible; },
    get playing() { return state.playing; },
    show() { set(true); armClock(); },
    hide() { stopClock(); set(false); },
    toggle() { if (state.visible) this.hide(); else this.show(); },
    /** The user touched a control or moved the mouse: keep the controls a while longer. */
    interaction() { if (state.visible) armClock(); else this.show(); },
    setPlaying(playing) {
      const next = playing === true;
      if (state.playing === next) return;
      state.playing = next;
      if (next) armClock();
      else { stopClock(); set(true); }
    },
    reset() { stopClock(); state.playing = false; set(true); },
    dispose() { stopClock(); },
  };
}
