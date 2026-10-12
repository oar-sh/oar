// The transcript's jump-to-bottom button, without the DOM: when it shows,
// what its badge counts, how far a click scrolls smoothly, and whether a
// resize of the transcript re-pins a reader who was following the end.
// transcript-jump-bottom-view.mjs reads the scroller and the rows and applies
// what this module decides.
//
// "At the bottom" is the composer's near-bottom rule (isMessagesNearBottom,
// resolveNearBottomThresholdPx); the caller passes its threshold in.

/** The button fades in once the reader is this many screens above the end. */
export const JUMP_BUTTON_SHOW_SCREENS = 1;
/** Further than this many screens a click jumps at once instead of scrolling. */
export const JUMP_SMOOTH_MAX_SCREENS = 3;
export const JUMP_BADGE_MAX = 99;

/**
 * One key per row the reader sees. Every row of a folded agent exchange
 * (its prompt, its replies, its live bubble) carries the prompt's id, so the
 * fold counts once however many of its rows are on the page. The live
 * bubble of a turn outside a fold has the prompt's id as its message id, so
 * it gets a key of its own.
 */
export function transcriptRowKey({ messageId = '', exchangePromptId = '', live = false } = {}) {
  const fold = String(exchangePromptId || '').trim();
  if (fold) return `fold:${fold}`;
  const id = String(messageId || '').trim();
  if (!id) return '';
  return live ? `live:${id}` : `msg:${id}`;
}

/**
 * Rows that arrived below the reader since `baselineKeys` was taken: keys
 * after the last row the baseline knows, not in the baseline, each once.
 * Older history paged in above, or a row re-rendered under a new node, is not
 * news. A transcript sharing no row with the baseline is another window (a
 * reload, a jump into the history): nothing is counted there.
 */
export function countNewRows(baselineKeys, currentKeys) {
  const baseline = new Set((baselineKeys || []).filter(Boolean));
  const current = (currentKeys || []).filter(Boolean);
  let lastKnown = -1;
  current.forEach((key, index) => {
    if (baseline.has(key)) lastKnown = index;
  });
  if (lastKnown < 0 && baseline.size) return 0;
  const fresh = new Set();
  for (const key of current.slice(lastKnown + 1)) {
    if (!baseline.has(key)) fresh.add(key);
  }
  return fresh.size;
}

export function isNearBottom(distance, nearBottomPx) {
  return Math.max(0, Number(distance) || 0) <= Math.max(0, Number(nearBottomPx) || 0);
}

/**
 * The button's next state from the scroller's geometry. At the bottom it
 * hides and forgets the baseline. Away from it, the rows on the page when the
 * reader left are the baseline the badge counts from; the button shows from
 * one screen above the end and, once shown, stays until the bottom.
 */
export function nextJumpButtonState(previous, { distance, clientHeight, nearBottomPx, rowKeys = [] } = {}) {
  if (isNearBottom(distance, nearBottomPx)) return { visible: false, baseline: null, count: 0 };
  const baseline = Array.isArray(previous?.baseline) ? previous.baseline : rowKeys.slice();
  const screens = Number(clientHeight) > 0 ? Number(distance) / Number(clientHeight) : 0;
  return {
    visible: previous?.visible === true || screens >= JUMP_BUTTON_SHOW_SCREENS,
    baseline,
    count: countNewRows(baseline, rowKeys),
  };
}

/** 'smooth' up to JUMP_SMOOTH_MAX_SCREENS above the end, else 'instant'. */
export function jumpScrollBehavior({ distance, clientHeight, reducedMotion = false } = {}) {
  if (reducedMotion) return 'instant';
  const height = Number(clientHeight);
  if (!(height > 0)) return 'instant';
  return Number(distance) / height <= JUMP_SMOOTH_MAX_SCREENS ? 'smooth' : 'instant';
}

export function jumpBadgeText(count) {
  const value = Math.max(0, Math.trunc(Number(count) || 0));
  if (!value) return '';
  return value > JUMP_BADGE_MAX ? `${JUMP_BADGE_MAX}+` : String(value);
}

/**
 * Whether a resize of the transcript (the composer or the background-task
 * panel growing under it) re-pins it to the end. The scroller shrinking from
 * below keeps scrollTop and fires no scroll event, so a reader who was
 * following is still described by the last scroll: `pinned` and the
 * scrollTop it was taken at. Once scrollTop has moved since (a restore, a
 * clamp, the browser's anchoring), the geometry as it is now decides.
 */
export function shouldRepinOnResize({ pinned, pinnedScrollTop, scrollTop, nearBottomNow }) {
  if (pinned && Number(scrollTop) === Number(pinnedScrollTop)) return true;
  return nearBottomNow === true;
}
