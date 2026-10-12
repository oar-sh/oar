// The header's ⋯ menu: one decision for its trigger and for every entry, with
// or without a conversation open. No DOM here; bootstrap.js applies the result.
//
// The menu holds two kinds of entries. Relay-wide ones (Settings, Restart web
// relay, Select Models, Check Usage, the queue, Day/Night, the PWA version)
// are shown whenever the app is signed in, so Settings can be reached on a
// fresh install, where no conversation exists yet. Per-conversation ones (Edit
// title, Share, Archive, Inspect tmux, Change CWD, Git changes, Kill session,
// Open on claude.ai) are hidden, not greyed, while nothing is open: an empty
// screen offers what can be done there and nothing else.
//
// The shared read-only view is its own branch: Day/Night only, whatever the
// conversation state, and the trigger stays usable even when the shared
// conversation failed to load.

export const CHAT_ACTIONS_MENU_TRIGGER_ID = 'chat-actions-menu-btn';

/** Entries that are text, not actions: `hidden` is applied, nothing else. */
export const CHAT_ACTIONS_MENU_META_IDS = Object.freeze([
  'chat-menu-pwa-version',
  'chat-menu-queue-status',
]);

/** Every entry the resolver decides, in menu order. */
export const CHAT_ACTIONS_MENU_ENTRY_IDS = Object.freeze([
  'chat-menu-pwa-version',
  'chat-menu-queue-status',
  'chat-menu-edit-title',
  'chat-menu-shared-theme-toggle',
  'chat-menu-usage',
  'chat-menu-compact',
  'chat-menu-share-conversation',
  'chat-menu-archive',
  'chat-menu-refresh-history',
  'chat-menu-inspect-tmux',
  'chat-menu-select-models',
  'chat-menu-change-cwd',
  'chat-menu-git-changes',
  'chat-menu-open-cloud-session',
  'chat-menu-settings',
  'chat-menu-restart-relay',
  'chat-menu-suspend-host',
  'chat-menu-kill-session',
]);

/** Entries that are never shown: retired actions kept in the markup. */
const ALWAYS_HIDDEN_IDS = new Set(['chat-menu-compact', 'chat-menu-refresh-history']);

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
} = {}) {
  const entries = {};
  if (sharedMode) {
    for (const id of CHAT_ACTIONS_MENU_ENTRY_IDS) entries[id] = hidden();
    entries['chat-menu-shared-theme-toggle'] = shown();
    return { trigger: { hidden: false, disabled: false }, entries };
  }

  const convId = String(conversationId || '').trim();
  const hasConversation = !!convId;
  const sessionId = String(sdkSessionId || conversation?.sdkSessionId || '').trim();
  const cloud = hasConversation && !!isCloud;
  const sessionUrl = String(cloudSessionUrl || '').trim();
  const perConversation = () => (hasConversation ? shown() : hidden());

  for (const id of CHAT_ACTIONS_MENU_ENTRY_IDS) entries[id] = shown();
  for (const id of ALWAYS_HIDDEN_IDS) entries[id] = hidden();
  entries['chat-menu-shared-theme-toggle'] = hidden();
  entries['chat-menu-edit-title'] = perConversation();
  entries['chat-menu-share-conversation'] = perConversation();
  entries['chat-menu-archive'] = perConversation();
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

/** The ids of the entries a state shows, in menu order. */
export function visibleChatActionsMenuEntryIds(state) {
  const entries = state?.entries || {};
  return CHAT_ACTIONS_MENU_ENTRY_IDS.filter((id) => entries[id] && !entries[id].hidden);
}
