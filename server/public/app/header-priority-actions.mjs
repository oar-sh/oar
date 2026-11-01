// The chat header's priority+ actions: which icon buttons sit in the header
// and which fall back into the ︙ menu when the header runs out of room.
//
// Every action exists twice in the markup: an inline header button and a twin
// entry in #chat-actions-menu. Nothing moves in the DOM; a pass toggles
// `hidden` on the pair, so listeners are bound once and the menu keeps its
// order. This module is DOM-free: bootstrap.js measures, calls
// fitHeaderPriorityActions and writes the result.
//
// Order is priority: the first entry is the LAST to overflow. Once one action
// does not fit, it and every later one go into the menu, so a lower priority
// action never "jumps" a higher one back into the header.

export const HEADER_PRIORITY_ACTIONS = Object.freeze([
  Object.freeze({ key: 'pins', inlineId: 'pinned-messages-btn', menuId: 'chat-menu-pins' }),
  Object.freeze({ key: 'hidden', inlineId: 'hidden-messages-btn', menuId: 'chat-menu-hidden' }),
  Object.freeze({ key: 'search', inlineId: 'message-search-btn', menuId: 'chat-menu-search' }),
  Object.freeze({ key: 'context', inlineId: 'context-btn', menuId: 'chat-menu-context' }),
  Object.freeze({ key: 'usage', inlineId: 'usage-btn', menuId: 'chat-menu-usage' }),
  Object.freeze({ key: 'theme', inlineId: 'theme-toggle-btn', menuId: 'chat-menu-theme-toggle' }),
  Object.freeze({ key: 'fullscreen', inlineId: 'fullscreen-btn', menuId: 'chat-menu-fullscreen' }),
]);

export const HEADER_PRIORITY_ACTION_KEYS = Object.freeze(HEADER_PRIORITY_ACTIONS.map((action) => action.key));

/** The twin menu entries, in priority order. */
export const HEADER_PRIORITY_MENU_IDS = Object.freeze(HEADER_PRIORITY_ACTIONS.map((action) => action.menuId));

/** The width the title keeps before any action is shown inline, in rem. */
export const HEADER_TITLE_MIN_REM = 8;

/** The window event that asks for a new pass (counts, availability). */
export const HEADER_ACTIONS_CHANGE_EVENT = 'oar:header-actions-change';

/**
 * Where the pending-question banner has a row of its own (the phone's header
 * CSS): there it takes nothing from the first row.
 */
export const HEADER_BANNER_OWN_ROW_QUERY = '(max-width: 680px)';

/**
 * The share of the header's content width the question banner may take on
 * the first row (its `max-width: 40%` in index.html): the title keeps the rest.
 */
export const HEADER_BANNER_MAX_SHARE = 0.4;

/**
 * The width of everything on the header's first row that never overflows:
 * its padding, ☰, the title's minimum, ︙, the question banner and the flex
 * gaps between them. Widths of 0 are elements that do not show. The banner
 * counts only while it shares the first row (`bannerOwnRow` false), and only
 * with its compact width ("❓ N"): the rest of it gives way before an action
 * does (resolveQuestionBannerMode).
 *
 * @param {object} input
 * @param {number} [input.padding] left plus right padding
 * @param {number} [input.titleMin] the width the title keeps
 * @param {number} [input.toggle] ☰
 * @param {number} [input.banner] the question banner's compact chip
 * @param {number} [input.menu] ︙ (its wrapper)
 * @param {number} [input.gap] the header's column gap
 * @param {boolean} [input.bannerOwnRow] the banner sits on a row of its own
 * @returns {number}
 */
export function headerReservedWidth({
  padding = 0,
  titleMin = 0,
  toggle = 0,
  banner = 0,
  menu = 0,
  gap = 0,
  bannerOwnRow = false,
} = {}) {
  const size = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  let width = size(padding) + size(titleMin) + size(menu);
  let items = 2; // the title and #chat-header-actions
  if (size(toggle)) {
    width += size(toggle);
    items += 1;
  }
  if (size(banner) && !bannerOwnRow) {
    width += size(banner);
    items += 1;
  }
  return width + size(gap) * (items - 1);
}

/**
 * How the question banner shows once the actions have their places:
 * - 'hidden': no banner;
 * - 'row': a row of its own (a phone held upright, or a header whose first
 *   row cannot hold even the chip next to ☰, the title's minimum and ︙),
 *   the whole text;
 * - 'compact': the chip "❓ N" on the first row (always on a phone on its
 *   side; elsewhere where the room cannot even hold "❓ N open questions");
 * - 'full': the whole text on the first row, ending in an ellipsis where
 *   the room is short.
 * The room is what the first row leaves it (the compact width the fit
 * reserved plus whatever the inline actions did not take), capped at
 * `maxShare` of the header's content width.
 *
 * @param {object} input
 * @param {boolean} [input.visible] the banner shows
 * @param {boolean} [input.ownRow] it sits on a row of its own
 * @param {boolean} [input.phoneLandscape] :root[data-phone-landscape]
 * @param {number} [input.room] the width the first row leaves it
 * @param {number} [input.compact] the chip's width: a room below it is 'row'
 * @param {number} [input.contentWidth] the header's width minus its padding
 * @param {number} [input.maxShare] HEADER_BANNER_MAX_SHARE
 * @param {number} [input.fullMin] "❓ N open questions" with the banner's padding and border
 * @returns {'hidden'|'row'|'compact'|'full'}
 */
export function resolveQuestionBannerMode({
  visible = false,
  ownRow = false,
  phoneLandscape = false,
  room = 0,
  compact = 0,
  contentWidth = Infinity,
  maxShare = HEADER_BANNER_MAX_SHARE,
  fullMin = 0,
} = {}) {
  if (!visible) return 'hidden';
  if (ownRow) return 'row';
  if (phoneLandscape) return 'compact';
  // Not even the chip fits on the first row: it would push ︙ off the
  // screen, so the banner takes a row of its own (an unmeasured room does not).
  if (Number.isFinite(Number(room)) && Number(room) < (Number(compact) || 0)) return 'row';
  const share = Number(maxShare);
  const width = Number(contentWidth);
  const cap = Number.isFinite(share) && share > 0 && Number.isFinite(width) ? width * share : Infinity;
  // An unmeasured room (NaN) is the chip: it is the width the fit reserved.
  const space = Math.min(Number(room), cap);
  return space >= Math.max(0, Number(fullMin) || 0) ? 'full' : 'compact';
}

/**
 * Whether each action may show at all, in the header or in the menu. Distinct
 * from the fit question, which is only about WHERE an available action shows.
 *
 * @param {object} input
 * @param {boolean} [input.sharedMode] the shared read-only view: Day/Night only
 * @param {number} [input.pinCount] pins of the open conversation
 * @param {number} [input.hiddenCount] messages hidden from shared viewers
 * @param {boolean} [input.fullscreenAvailable] pwa-install.js's verdict (a phone, not installed)
 * @returns {Record<string, boolean>}
 */
export function resolveHeaderActionAvailability({
  sharedMode = false,
  pinCount = 0,
  hiddenCount = 0,
  fullscreenAvailable = false,
} = {}) {
  if (sharedMode) {
    return { pins: false, hidden: false, search: false, context: false, usage: false, theme: true, fullscreen: false };
  }
  return {
    pins: Number(pinCount) > 0,
    hidden: Number(hiddenCount) > 0,
    search: true,
    context: true,
    usage: true,
    theme: true,
    fullscreen: !!fullscreenAvailable,
  };
}

/**
 * The fit decision. `available` is the width the inline actions may use in
 * total; each inline action costs its width plus `gap`. An action whose width
 * is unknown (not a finite number) counts as 0. An `available` that is not a
 * finite number means the header could not be measured: every available
 * action then goes into the menu, which always reaches all of them.
 *
 * @param {object} input
 * @param {Record<string, number>} input.widths the inline buttons' widths, by key
 * @param {number} [input.gap] the gap after each inline button
 * @param {number} input.available the width left for the inline actions
 * @param {Record<string, boolean>} input.availability from resolveHeaderActionAvailability
 * @param {string[]} [input.order] priority order (default: HEADER_PRIORITY_ACTION_KEYS)
 * @returns {{ inline: string[], menu: string[], unavailable: string[], used: number }}
 *   `used` is the width the inline actions take, their gaps included
 */
export function fitHeaderPriorityActions({
  widths = {},
  gap = 0,
  available,
  availability = {},
  order = HEADER_PRIORITY_ACTION_KEYS,
} = {}) {
  const inline = [];
  const menu = [];
  const unavailable = [];
  const room = Number(available);
  const step = Math.max(0, Number(gap) || 0);
  let overflowing = !Number.isFinite(room);
  let used = 0;
  let inlineUsed = 0;
  for (const key of order) {
    if (!availability[key]) {
      // Spends no width, so it never pushes an available action out.
      unavailable.push(key);
      continue;
    }
    const width = Number(widths[key]);
    used += (Number.isFinite(width) && width > 0 ? width : 0) + step;
    if (!overflowing && used <= room) {
      inline.push(key);
      inlineUsed = used;
    } else {
      overflowing = true;
      menu.push(key);
    }
  }
  return { inline, menu, unavailable, used: inlineUsed };
}

/** The menu ids of the keys a fit put into the menu. */
export function headerPriorityMenuIdsFor(keys) {
  const wanted = new Set(keys || []);
  return HEADER_PRIORITY_ACTIONS.filter((action) => wanted.has(action.key)).map((action) => action.menuId);
}

/**
 * Asks for a new pass. Views that change an action's availability (pin and
 * hidden counts, fullscreen) call this; a no-op outside a browser.
 */
export function notifyHeaderActionsChanged() {
  const target = typeof window !== 'undefined' ? window : null;
  if (!target || typeof target.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  try {
    target.dispatchEvent(new CustomEvent(HEADER_ACTIONS_CHANGE_EVENT));
  } catch {}
}
