import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_ACTIONS_MENU_ENTRY_IDS,
  resolveChatActionsMenuState,
  visibleChatActionsMenuEntryIds,
} from './chat-actions-menu-state.mjs';

const RELAY_WIDE = [
  'chat-menu-pwa-version',
  'chat-menu-queue-status',
  'chat-menu-usage',
  'chat-menu-select-models',
  'chat-menu-settings',
  'chat-menu-restart-relay',
];

const PER_CONVERSATION = [
  'chat-menu-edit-title',
  'chat-menu-share-conversation',
  'chat-menu-archive',
  'chat-menu-inspect-tmux',
  'chat-menu-change-cwd',
  'chat-menu-git-changes',
  'chat-menu-kill-session',
];

const localConversation = {
  conversationId: 'conv_fixture_local',
  conversation: { id: 'conv_fixture_local', sdkSessionId: 'sess_fixture_1' },
  sdkSessionId: 'sess_fixture_1',
};

test('with no conversation the trigger works and only the relay-wide entries show', () => {
  const state = resolveChatActionsMenuState({ conversationId: null });
  assert.deepEqual(state.trigger, { hidden: false, disabled: false });
  assert.deepEqual(visibleChatActionsMenuEntryIds(state), RELAY_WIDE);
  for (const id of PER_CONVERSATION) {
    assert.equal(state.entries[id].hidden, true, `${id} is hidden without a conversation`);
  }
  assert.equal(state.entries['chat-menu-open-cloud-session'].hidden, true);
  assert.equal(state.entries['chat-menu-shared-theme-toggle'].hidden, true);
  assert.equal(state.entries['chat-menu-settings'].disabled, false);
});

test('every entry id the resolver knows has a decision', () => {
  const state = resolveChatActionsMenuState({});
  assert.deepEqual(Object.keys(state.entries).sort(), [...CHAT_ACTIONS_MENU_ENTRY_IDS].sort());
  for (const id of CHAT_ACTIONS_MENU_ENTRY_IDS) {
    assert.equal(typeof state.entries[id].hidden, 'boolean');
    assert.equal(typeof state.entries[id].disabled, 'boolean');
  }
});

test('a local conversation with a bound session shows every per-conversation entry', () => {
  const state = resolveChatActionsMenuState(localConversation);
  assert.deepEqual(state.trigger, { hidden: false, disabled: false });
  for (const id of [...RELAY_WIDE, ...PER_CONVERSATION]) {
    assert.equal(state.entries[id].hidden, false, `${id} shows with a conversation`);
    assert.equal(state.entries[id].disabled, false, `${id} is enabled with a bound session`);
  }
  // Retired actions stay out of the menu whatever is open.
  assert.equal(state.entries['chat-menu-compact'].hidden, true);
  assert.equal(state.entries['chat-menu-refresh-history'].hidden, true);
  assert.equal(state.entries['chat-menu-open-cloud-session'].hidden, true);
});

test('without a bound session Kill session is shown but disabled', () => {
  const state = resolveChatActionsMenuState({
    conversationId: 'conv_fixture_unbound',
    conversation: { id: 'conv_fixture_unbound', sdkSessionId: null },
    sdkSessionId: '',
  });
  assert.deepEqual(state.entries['chat-menu-kill-session'], { hidden: false, disabled: true });
});

test('a cloud conversation hides Change CWD and shows Open on claude.ai only with a link', () => {
  const noLink = resolveChatActionsMenuState({ ...localConversation, isCloud: true, cloudSessionUrl: null });
  assert.equal(noLink.entries['chat-menu-change-cwd'].hidden, true);
  assert.equal(noLink.entries['chat-menu-open-cloud-session'].hidden, true);
  const withLink = resolveChatActionsMenuState({
    ...localConversation,
    isCloud: true,
    cloudSessionUrl: 'https://claude.ai/code/session_fixture',
  });
  assert.equal(withLink.entries['chat-menu-open-cloud-session'].hidden, false);
  assert.equal(withLink.entries['chat-menu-change-cwd'].hidden, true);
  // The other per-conversation entries are unaffected by the provider.
  assert.equal(withLink.entries['chat-menu-git-changes'].hidden, false);
});

test('a switch from a cloud conversation to none leaves Change CWD hidden', () => {
  // The old DOM code un-hid the entry it had hidden for the cloud chat after
  // the header sync hid it for "nothing open"; the resolver has no memory, so
  // the second call decides from the current state alone.
  resolveChatActionsMenuState({ ...localConversation, isCloud: true });
  const after = resolveChatActionsMenuState({ conversationId: null, isCloud: false });
  assert.equal(after.entries['chat-menu-change-cwd'].hidden, true);
  assert.equal(after.entries['chat-menu-open-cloud-session'].hidden, true);
  // isCloud without a conversation (a stale flag) changes nothing either.
  const stale = resolveChatActionsMenuState({ conversationId: null, isCloud: true, cloudSessionUrl: 'https://claude.ai/code/x' });
  assert.equal(stale.entries['chat-menu-open-cloud-session'].hidden, true);
});

test('editing a title disables the trigger, but only while a conversation is open', () => {
  const editing = resolveChatActionsMenuState({ ...localConversation, editing: true });
  assert.deepEqual(editing.trigger, { hidden: false, disabled: true });
  const stray = resolveChatActionsMenuState({ conversationId: null, editing: true });
  assert.deepEqual(stray.trigger, { hidden: false, disabled: false });
});

test('the shared view shows Day/Night only and keeps the trigger usable', () => {
  for (const input of [
    { sharedMode: true },
    { sharedMode: true, ...localConversation },
    { sharedMode: true, ...localConversation, editing: true, suspendVisible: true, isCloud: true, cloudSessionUrl: 'https://claude.ai/code/x' },
  ]) {
    const state = resolveChatActionsMenuState(input);
    assert.deepEqual(state.trigger, { hidden: false, disabled: false });
    assert.deepEqual(visibleChatActionsMenuEntryIds(state), ['chat-menu-shared-theme-toggle']);
    assert.equal(state.entries['chat-menu-settings'].hidden, true);
    assert.equal(state.entries['chat-menu-settings'].disabled, true);
  }
});

test('Suspend host follows its own setting in every case', () => {
  for (const base of [{}, localConversation, { ...localConversation, isCloud: true }]) {
    assert.equal(resolveChatActionsMenuState({ ...base, suspendVisible: false }).entries['chat-menu-suspend-host'].hidden, true);
    assert.deepEqual(resolveChatActionsMenuState({ ...base, suspendVisible: true }).entries['chat-menu-suspend-host'], { hidden: false, disabled: false });
  }
  assert.equal(resolveChatActionsMenuState({ sharedMode: true, suspendVisible: true }).entries['chat-menu-suspend-host'].hidden, true);
});

test('a hidden entry is also disabled, so it can never take focus or a tap', () => {
  const state = resolveChatActionsMenuState({ conversationId: null });
  for (const id of CHAT_ACTIONS_MENU_ENTRY_IDS) {
    if (state.entries[id].hidden) assert.equal(state.entries[id].disabled, true, id);
  }
});
