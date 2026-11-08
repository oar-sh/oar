// The fade on a tab strip that scrolls sideways (Settings, its provider tabs,
// the usage dialog's providers): the strip has no scrollbar, so the side with
// more tabs fades out. Marked from the strip's own scroll as `data-fade`
// ("right" at the start, "both" in between, "left" at the end, none when the
// strip fits or is not laid out); the CSS draws the mask from it.

import { FONT_SCALE_CHANGE_EVENT } from './font-scaling.js';

export const TAB_STRIP_SELECTOR = '.settings-tab-strip, .plan-usage-tab-strip, .context-tab-strip, .media-gallery-tabs, .media-gallery-chips';

// Sub-pixel scroll ends (a zoomed page) count as the end.
const EDGE_SLACK_PX = 1;

let watching = false;

/** The `data-fade` value for a strip's scroll metrics ('' for none). */
export function tabStripFadeState({ scrollLeft = 0, scrollWidth = 0, clientWidth = 0 } = {}) {
  const room = Number(scrollWidth) - Number(clientWidth);
  if (!(room > EDGE_SLACK_PX)) return '';
  const offset = Math.abs(Number(scrollLeft) || 0);
  const before = offset > EDGE_SLACK_PX;
  const after = offset < room - EDGE_SLACK_PX;
  if (before && after) return 'both';
  if (before) return 'left';
  return after ? 'right' : '';
}

export function syncTabStripFade(strip) {
  if (!strip?.setAttribute) return '';
  const state = tabStripFadeState(strip);
  if (state) {
    if (strip.getAttribute('data-fade') !== state) strip.setAttribute('data-fade', state);
  } else if (strip.hasAttribute('data-fade')) {
    strip.removeAttribute('data-fade');
  }
  return state;
}

function fadeWidth(strip) {
  try {
    // The CSS gives the strip the fade's width as its scroll padding.
    const value = parseFloat(getComputedStyle(strip).scrollPaddingLeft);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Scrolls the strip (and nothing around it) so `tab` shows whole and clear of
 * the fade; at either end the strip stops there, and that edge has none.
 */
export function revealTab(strip, tab) {
  if (!strip || !tab || !strip.contains(tab)) return;
  const room = strip.scrollWidth - strip.clientWidth;
  if (room > EDGE_SLACK_PX) {
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    const margin = fadeWidth(strip);
    const left = tabBox.left - stripBox.left - strip.clientLeft;
    const right = left + tabBox.width;
    let next = strip.scrollLeft;
    if (left - margin < 0) next += left - margin;
    else if (right + margin > strip.clientWidth) next += right + margin - strip.clientWidth;
    next = Math.max(0, Math.min(room, next));
    if (Math.abs(next - strip.scrollLeft) >= 0.5) strip.scrollLeft = next;
  }
  syncTabStripFade(strip);
}

/** Each strip under `root`: its selected tab in view, its fade marked. */
export function revealSelectedTabs(root = document) {
  if (!root?.querySelectorAll) return;
  const strips = root.matches?.(TAB_STRIP_SELECTOR) ? [root] : Array.from(root.querySelectorAll(TAB_STRIP_SELECTOR));
  for (const strip of strips) {
    const selected = strip.querySelector('[aria-selected="true"]');
    if (selected) revealTab(strip, selected);
    else syncTabStripFade(strip);
  }
}

/**
 * Once per page: a strip's scroll re-marks it (scroll does not bubble, so the
 * listener captures), and so does a resize or a turn of the phone.
 */
export function watchTabStripFades() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('scroll', (event) => {
    const strip = event.target;
    if (strip?.matches?.(TAB_STRIP_SELECTOR)) syncTabStripFade(strip);
  }, { capture: true, passive: true });
  if (typeof window !== 'undefined') {
    const syncAll = () => {
      for (const strip of document.querySelectorAll(TAB_STRIP_SELECTOR)) syncTabStripFade(strip);
    };
    window.addEventListener('resize', syncAll, { passive: true });
    // The zoom (font-scaling.js) resizes the tabs, not the window.
    window.addEventListener(FONT_SCALE_CHANGE_EVENT, () => requestAnimationFrame(syncAll));
  }
}
