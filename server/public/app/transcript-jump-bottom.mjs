// The transcript's jump-to-bottom button, without the DOM: when it shows,
// which of its three states it is in (plain, something new below, a question
// waits below), what its badge counts, how far a click scrolls smoothly, and
// whether a resize of the transcript re-pins a reader who was following the
// end.
// transcript-jump-bottom-view.mjs reads the scroller and the rows and applies
// what this module decides.
//
// "At the bottom" is the composer's near-bottom rule (isMessagesNearBottom,
// resolveNearBottomThresholdPx); the caller passes its threshold in.
//
// Also here: the setting that decides whether the reader's own send jumps to
// the end.

/** The button fades in once the reader is this many screens above the end. */
export const JUMP_BUTTON_SHOW_SCREENS = 1;
/** Further than this many screens a click jumps at once instead of scrolling. */
export const JUMP_SMOOTH_MAX_SCREENS = 3;
export const JUMP_BADGE_MAX = 99;

/**
 * One key per row the reader sees. The live bubble of a turn has the
 * prompt's id as its message id, so it gets a key of its own. A folded agent
 * prompt is a row like any other: its reply shows below it and counts too.
 */
export function transcriptRowKey({ messageId = '', live = false } = {}) {
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
 * reader left are the baseline the badge counts from; the plain button shows
 * from one screen above the end and, once shown, stays until the bottom.
 *
 * The transcript does not move under a reader who is away from the end, so
 * the button is how they learn of what landed there, at any distance:
 * `unseen` is a live update that was not followed (it holds until the
 * bottom: a reply growing in its bubble adds no row to count), `question` a
 * card waiting for an answer below the viewport (as it is now: answered
 * elsewhere, it is gone).
 */
export function nextJumpButtonState(previous, {
  distance,
  clientHeight,
  nearBottomPx,
  rowKeys = [],
  unseen = false,
  question = false,
  windowAtTail = true,
  waiting = 0,
} = {}) {
  // Live rows held back for a window that ends above the conversation's end
  // (transcript-island.mjs): the bottom of the page is not the end, so the
  // button stays while they wait.
  const waitingNow = windowAtTail ? 0 : Math.max(0, Math.trunc(Number(waiting) || 0));
  if (isNearBottom(distance, nearBottomPx) && !waitingNow) {
    return { visible: false, baseline: null, count: 0, unseen: false, question: false, waiting: 0 };
  }
  // Below such a window the rows put on the page are the newer pages, older
  // than anything live: they are not counted, and the baseline is taken once
  // the window meets the end.
  const baseline = !windowAtTail ? null : (Array.isArray(previous?.baseline) ? previous.baseline : rowKeys.slice());
  const screens = Number(clientHeight) > 0 ? Number(distance) / Number(clientHeight) : 0;
  const count = windowAtTail ? countNewRows(baseline, rowKeys) : 0;
  const unseenNow = previous?.unseen === true || unseen === true;
  const questionNow = question === true;
  return {
    visible: previous?.visible === true || screens >= JUMP_BUTTON_SHOW_SCREENS || count > 0 || waitingNow > 0 || unseenNow || questionNow,
    baseline,
    count,
    unseen: unseenNow,
    question: questionNow,
    waiting: waitingNow,
  };
}

/**
 * The state before a live update that does not follow the end changes the
 * transcript: the baseline is taken now, from the rows before it, if there
 * is none yet. Otherwise it is taken by the next frame's nextJumpButtonState,
 * by then with the update's row in it, and a row that lands between the
 * reader's scroll away and that frame (one frame, or a tenth of a second on
 * a busy page) is not counted.
 */
export function baselineBeforeUpdate(previous, rowKeys = []) {
  if (Array.isArray(previous?.baseline)) return previous;
  return {
    visible: previous?.visible === true,
    baseline: rowKeys.slice(),
    count: 0,
    unseen: previous?.unseen === true,
    question: previous?.question === true,
    waiting: 0,
  };
}

export const JUMP_BUTTON_LABEL = 'Jump to the latest message';
export const JUMP_BUTTON_QUESTION_LABEL = 'A question is waiting for your answer. Jump to it';
export const JUMP_QUESTION_BADGE = '?';

/**
 * How the rows held back for a window above the end show on the badge:
 * 'count' adds them to the count, 'dot' draws the dot of news without a row.
 */
export const HELD_BACK_ROWS_BADGE = 'count';

/**
 * How a state looks and reads. `state` is 'plain', 'new' or 'question'; a
 * waiting question wins over news. `badge` is the count, '?' for a question,
 * or empty: with `dot`, an empty badge is drawn as a dot (news without a row
 * to count). `waiting` rows are held back below the page
 * (HELD_BACK_ROWS_BADGE). `announcement` is what a screen reader is told
 * when the state is entered; the label alone is only read when the button is
 * focused.
 */
export function jumpButtonPresentation({ visible = false, count = 0, unseen = false, question = false, waiting = 0 } = {}, { heldBackRowsBadge = HELD_BACK_ROWS_BADGE } = {}) {
  if (!visible) return { state: 'plain', label: JUMP_BUTTON_LABEL, badge: '', dot: false, announcement: '' };
  if (question) {
    return {
      state: 'question',
      label: JUMP_BUTTON_QUESTION_LABEL,
      badge: JUMP_QUESTION_BADGE,
      dot: false,
      announcement: 'A question is waiting for your answer below.',
    };
  }
  const held = Math.max(0, Math.trunc(Number(waiting) || 0));
  const counted = Math.max(0, Math.trunc(Number(count) || 0)) + (heldBackRowsBadge === 'count' ? held : 0);
  const badge = jumpBadgeText(counted);
  if (badge) {
    return {
      state: 'new',
      label: `${JUMP_BUTTON_LABEL} (${counted} new)`,
      badge,
      dot: false,
      announcement: 'New messages below.',
    };
  }
  if (unseen || held > 0) {
    return {
      state: 'new',
      label: `${JUMP_BUTTON_LABEL} (new below)`,
      badge: '',
      dot: true,
      announcement: 'New messages below.',
    };
  }
  return { state: 'plain', label: JUMP_BUTTON_LABEL, badge: '', dot: false, announcement: '' };
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
 * below keeps scrollTop and fires no scroll event, so the reader is still
 * described by the last note of their position: `pinned` (they followed the
 * end, by a scroll event or when the content last changed) and the scrollTop
 * it was taken at. While scrollTop is that one, the note alone decides: a
 * reader who was not at the end is never taken there by a resize. Once
 * scrollTop has moved since (a restore, a clamp, the browser's anchoring),
 * the note is stale and the geometry as it is now decides.
 */
export function shouldRepinOnResize({ pinned, pinnedScrollTop, scrollTop, nearBottomNow }) {
  if (Number(scrollTop) === Number(pinnedScrollTop)) return pinned === true;
  return nearBottomNow === true;
}

/**
 * Whether a live update follows the end. A reader at the end now is
 * followed. So is one the re-pin above is on its way to: the transcript
 * shrank from below (`clientHeight` under the height the last
 * ResizeObserver round saw) and at that height the reader is at the end.
 * An update that lands between the shrink and that round would otherwise
 * find them the panel's height above the end, stay put, and leave them
 * there. The geometry decides, not the last note of the position: a scroll
 * to the end (the update before) is noted only by its scroll event a frame
 * later, and the shrink and this update can both land before it.
 */
export function followsEndThroughResize({ nearBottomNow, clientHeight, observedClientHeight, distanceAtObservedHeight, nearBottomPxAtObservedHeight }) {
  if (nearBottomNow === true) return true;
  if (!(Number(clientHeight) < Number(observedClientHeight))) return false;
  return isNearBottom(distanceAtObservedHeight, nearBottomPxAtObservedHeight);
}

// "Jump to the end when I send a message" (Settings › General). A setting of
// this browser, kept in localStorage like the theme. On unless switched off:
// with it off, the reader's own send follows the same rule as everything
// else and only scrolls a transcript that is at its end already. The
// document and the storage are passed in by the tests.

export const SCROLL_ON_SEND_STORAGE_KEY = 'copilot_scroll_on_send';
export const SCROLL_ON_SEND_TOGGLE_ID = 'scroll-on-send-toggle';

/** Anything but an explicit off is on: a missing or damaged value included. */
export function parseScrollOnSendSetting(stored) {
  const value = String(stored ?? '').trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false';
}

export function serializeScrollOnSendSetting(enabled) {
  return enabled ? '1' : '0';
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function isScrollOnSendEnabled(store = storage()) {
  try {
    return parseScrollOnSendSetting(store?.getItem(SCROLL_ON_SEND_STORAGE_KEY));
  } catch {
    return true;
  }
}

export function syncScrollOnSendToggle(doc = globalThis.document, store = storage()) {
  const checkbox = doc?.getElementById?.(SCROLL_ON_SEND_TOGGLE_ID);
  if (checkbox) checkbox.checked = isScrollOnSendEnabled(store);
}

export function updateScrollOnSendSetting(enabled, { doc = globalThis.document, store = storage() } = {}) {
  try { store?.setItem(SCROLL_ON_SEND_STORAGE_KEY, serializeScrollOnSendSetting(!!enabled)); } catch {}
  syncScrollOnSendToggle(doc, store);
}
