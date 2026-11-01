// The header's ︙ menu: one decision for its trigger and for every entry, with
// or without a conversation open. No DOM here; bootstrap.js applies the result.
//
// The menu holds two kinds of entries. Relay-wide ones (Settings, About OAR,
// Restart web relay, Select Models, Check Usage, the queue, Day/Night, the PWA
// version) are shown whenever the app is signed in, so Settings can be reached
// on a fresh install, where no conversation exists yet. Per-conversation ones
// (Edit title, Share, Stop sharing, Preview as shared, Archive, Inspect tmux,
// Change CWD, Git changes, Kill session, Open on claude.ai) are hidden, not
// greyed, while nothing is open: an empty screen offers what can be done there
// and nothing else.
//
// The shared read-only view is its own branch: Day/Night only, whatever the
// conversation state, and the trigger stays usable even when the shared
// conversation failed to load. Once Day/Night fits in the header the shared
// menu is empty and the trigger hides.
//
// The twins of the header's priority+ actions (pins, hidden, search, context,
// Day/Night, Check Usage, fullscreen) show only while their header button
// does not fit; the header's fit pass hands in which ones that is.
//
// A phone on its side hides the header's meta line, and with it the chips
// that open something (the watching chip's list, the schedule chip's list,
// the origin's conversation). There, and only for a chip the conversation
// has, the menu carries an entry that does the same.

export const CHAT_ACTIONS_MENU_TRIGGER_ID = 'chat-actions-menu-btn';

/** The stand-ins for the meta line's chips in phone landscape, by chip. */
export const CHAT_ACTIONS_MENU_META_CHIP_IDS = Object.freeze({
  watching: 'chat-menu-watching',
  schedules: 'chat-menu-schedules',
  origin: 'chat-menu-origin',
});

/** Entries that are text, not actions: `hidden` is applied, nothing else. */
export const CHAT_ACTIONS_MENU_META_IDS = Object.freeze([
  'chat-menu-pwa-version',
  'chat-menu-queue-status',
]);

/** Every entry the resolver decides, in menu order. */
export const CHAT_ACTIONS_MENU_ENTRY_IDS = Object.freeze([
  'chat-menu-pwa-version',
  'chat-menu-queue-status',
  'chat-menu-watching',
  'chat-menu-schedules',
  'chat-menu-origin',
  'chat-menu-edit-title',
  'chat-menu-pins',
  'chat-menu-hidden',
  'chat-menu-search',
  'chat-menu-context',
  'chat-menu-theme-toggle',
  'chat-menu-usage',
  'chat-menu-fullscreen',
  'chat-menu-compact',
  'chat-menu-share-conversation',
  'chat-menu-stop-sharing',
  'chat-menu-preview-shared',
  'chat-menu-archive',
  'chat-menu-group',
  'chat-menu-refresh-history',
  'chat-menu-inspect-tmux',
  'chat-menu-select-models',
  'chat-menu-change-cwd',
  'chat-menu-git-changes',
  'chat-menu-open-cloud-session',
  'chat-menu-settings',
  'chat-menu-about',
  'chat-menu-restart-relay',
  'chat-menu-suspend-host',
  'chat-menu-kill-session',
]);

/** Entries that are never shown: retired actions kept in the markup. */
const ALWAYS_HIDDEN_IDS = new Set(['chat-menu-compact', 'chat-menu-refresh-history']);

/**
 * The twins of the header's priority+ actions (header-priority-actions.mjs):
 * each shows here only while its header button does not fit. Kept in sync
 * with HEADER_PRIORITY_MENU_IDS by the tests.
 */
export const CHAT_ACTIONS_MENU_TWIN_IDS = Object.freeze([
  'chat-menu-pins',
  'chat-menu-hidden',
  'chat-menu-search',
  'chat-menu-context',
  'chat-menu-usage',
  'chat-menu-theme-toggle',
  'chat-menu-fullscreen',
]);

// Before the header was ever measured, the menu keeps the reach it always
// had: Day/Night and Check Usage. The other twins stay hidden, their header
// buttons show as they always did.
const UNMEASURED_TWIN_IDS = new Set(['chat-menu-theme-toggle', 'chat-menu-usage']);

// The shared read-only view offers Day/Night and nothing else.
const SHARED_TWIN_IDS = new Set(['chat-menu-theme-toggle']);

function twinShown(id, { sharedMode, headerMenuIds }) {
  if (sharedMode && !SHARED_TWIN_IDS.has(id)) return false;
  if (!Array.isArray(headerMenuIds)) return UNMEASURED_TWIN_IDS.has(id);
  return headerMenuIds.includes(id);
}

const shown = (disabled = false) => ({ hidden: false, disabled: !!disabled });
const hidden = () => ({ hidden: true, disabled: true });

/**
 * @param {object} input
 * @param {boolean} [input.sharedMode] the shared read-only view
 * @param {string|null} [input.conversationId] the open conversation, if any
 * @param {object|null} [input.conversation] its record, if known
 * @param {string|null} [input.sdkSessionId] its bound session, if any
 * @param {boolean} [input.isCloud] it runs on Claude Cloud
 * @param {string|null} [input.cloudSessionUrl] its claude.ai session link, if reported
 * @param {boolean} [input.editing] its title is being edited
 * @param {boolean} [input.suspendVisible] the "show Suspend host" setting
 * @param {boolean} [input.hasActiveShare] it has a public share link
 * @param {string[]|null} [input.headerMenuIds] the twin entries the header's
 *   fit pass put into the menu (available and not fitting); null before the
 *   header was measured
 * @param {boolean} [input.fullscreenSupported] the browser can go fullscreen
 *   (requestFullscreen exists); the twin is disabled otherwise, as the header
 *   button is
 * @param {boolean} [input.phoneLandscape] :root[data-phone-landscape], where
 *   the header's meta line is hidden
 * @param {{ watching?: boolean, schedules?: boolean, origin?: boolean }} [input.metaChips]
 *   the meta line's chips the conversation has (a watching chip, a schedule
 *   chip, an origin that opens its conversation)
 * @returns {{ trigger: { hidden: boolean, disabled: boolean }, entries: Record<string, { hidden: boolean, disabled: boolean }> }}
 */
export function resolveChatActionsMenuState({
  sharedMode = false,
  conversationId = null,
  conversation = null,
  sdkSessionId = null,
  isCloud = false,
  cloudSessionUrl = null,
  editing = false,
  suspendVisible = false,
  hasActiveShare = false,
  headerMenuIds = null,
  fullscreenSupported = true,
  phoneLandscape = false,
  metaChips = null,
} = {}) {
  const entries = {};
  const twins = { sharedMode: !!sharedMode, headerMenuIds };
  if (sharedMode) {
    for (const id of CHAT_ACTIONS_MENU_ENTRY_IDS) entries[id] = hidden();
    for (const id of CHAT_ACTIONS_MENU_TWIN_IDS) entries[id] = twinShown(id, twins) ? shown() : hidden();
    // With Day/Night in the header there is nothing left to open.
    const empty = !CHAT_ACTIONS_MENU_ENTRY_IDS.some((id) => !entries[id].hidden);
    return { trigger: { hidden: empty, disabled: false }, entries };
  }

  const convId = String(conversationId || '').trim();
  const hasConversation = !!convId;
  const sessionId = String(sdkSessionId || conversation?.sdkSessionId || '').trim();
  const cloud = hasConversation && !!isCloud;
  const sessionUrl = String(cloudSessionUrl || '').trim();
  const perConversation = () => (hasConversation ? shown() : hidden());

  for (const id of CHAT_ACTIONS_MENU_ENTRY_IDS) entries[id] = shown();
  for (const id of ALWAYS_HIDDEN_IDS) entries[id] = hidden();
  for (const id of CHAT_ACTIONS_MENU_TWIN_IDS) entries[id] = twinShown(id, twins) ? shown() : hidden();
  // Offered where the browser has no fullscreen (iPhone): disabled, as its
  // header button is, rather than a live entry that does nothing.
  if (!entries['chat-menu-fullscreen'].hidden && !fullscreenSupported) entries['chat-menu-fullscreen'] = shown(true);
  // The meta line's chips, standing in where that line is hidden.
  for (const [chip, id] of Object.entries(CHAT_ACTIONS_MENU_META_CHIP_IDS)) {
    entries[id] = hasConversation && phoneLandscape && !!metaChips?.[chip] ? shown() : hidden();
  }
  entries['chat-menu-edit-title'] = perConversation();
  entries['chat-menu-share-conversation'] = perConversation();
  // Only a conversation with a live link has something to stop.
  entries['chat-menu-stop-sharing'] = hasConversation && hasActiveShare ? shown() : hidden();
  entries['chat-menu-preview-shared'] = perConversation();
  entries['chat-menu-archive'] = perConversation();
  entries['chat-menu-group'] = perConversation();
  entries['chat-menu-inspect-tmux'] = perConversation();
  entries['chat-menu-git-changes'] = perConversation();
  // A cloud session has no working directory on the relay host to change.
  entries['chat-menu-change-cwd'] = hasConversation && !cloud ? shown() : hidden();
  entries['chat-menu-open-cloud-session'] = cloud && sessionUrl ? shown() : hidden();
  entries['chat-menu-suspend-host'] = suspendVisible ? shown() : hidden();
  // Kill needs a bound session; the entry stays visible so the user sees why
  // it is not available (today's rule).
  entries['chat-menu-kill-session'] = hasConversation ? shown(!sessionId) : hidden();

  return {
    // Only a title edit in progress holds the trigger; with nothing open there
    // is no title, so the trigger can never be stuck disabled.
    trigger: { hidden: false, disabled: hasConversation && !!editing },
    entries,
  };
}

/**
 * The labels of the meta line's stand-ins: "👁 Watching 2 sessions…" (from the
 * watching chip's text), "⏰ Schedules…", and the origin's line ("Started by
 * an agent in “title”"). An entry with no text gets ''.
 *
 * @param {{ watching?: string, origin?: string }} input
 * @returns {{ watching: string, schedules: string, origin: string }}
 */
export function chatActionsMenuMetaChipLabels({ watching = '', origin = '' } = {}) {
  const watchingText = String(watching || '').trim();
  const originText = String(origin || '').trim();
  return {
    watching: watchingText ? `👁 ${watchingText.charAt(0).toUpperCase()}${watchingText.slice(1)}…` : '',
    schedules: '⏰ Schedules…',
    origin: originText ? `↗ ${originText}` : '',
  };
}

/**
 * Where the open menu goes. It hangs from ︙ with its right edge on the
 * button's; this keeps it inside `bounds` (the viewport and #main, so never
 * off-screen and never under the sidebar) with `margin` to spare, narrows it
 * when even that is too wide, and caps its height at what is left below its
 * top (the menu then scrolls).
 *
 * @param {object} input
 * @param {{ left: number, right: number, top: number }} input.rect the menu's box as CSS placed it
 * @param {{ left: number, right: number, bottom: number }} input.bounds the area it must stay in
 * @param {number} [input.margin] the gap it keeps from the bounds
 * @param {number} [input.minHeight] the height it keeps at least
 * @returns {{ right: number, maxWidth: number|null, maxHeight: number }}
 *   `right`: how far to move its right edge to the left of where CSS put it
 *   (negative: to the right); `maxWidth`: null when it fits as it is
 */
export function resolveChatActionsMenuPlacement({ rect, bounds, margin = 8, minHeight = 120 } = {}) {
  const left = Number(rect?.left) || 0;
  const right = Number(rect?.right) || 0;
  const top = Number(rect?.top) || 0;
  const width = Math.max(0, right - left);
  const minLeft = (Number(bounds?.left) || 0) + margin;
  const maxRight = (Number(bounds?.right) || 0) - margin;
  const room = Math.max(0, maxRight - minLeft);
  const fitWidth = Math.min(width, room);
  let nextLeft = right - fitWidth;
  if (nextLeft + fitWidth > maxRight) nextLeft = maxRight - fitWidth;
  if (nextLeft < minLeft) nextLeft = minLeft;
  const nextRight = nextLeft + fitWidth;
  const bottom = Number(bounds?.bottom) || 0;
  return {
    right: Math.round((right - nextRight) * 100) / 100,
    maxWidth: width > room ? Math.floor(room) : null,
    maxHeight: Math.floor(Math.max(minHeight, bottom - margin - top)),
  };
}

/** The ids of the entries a state shows, in menu order. */
export function visibleChatActionsMenuEntryIds(state) {
  const entries = state?.entries || {};
  return CHAT_ACTIONS_MENU_ENTRY_IDS.filter((id) => entries[id] && !entries[id].hidden);
}
