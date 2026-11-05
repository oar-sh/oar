import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CHAT_ACTIONS_MENU_ENTRY_IDS,
  CHAT_ACTIONS_MENU_META_CHIP_IDS,
  CHAT_ACTIONS_MENU_TWIN_IDS,
  chatActionsMenuMetaChipLabels,
  resolveChatActionsMenuPlacement,
  resolveChatActionsMenuState,
  visibleChatActionsMenuEntryIds,
} from './chat-actions-menu-state.mjs';

const RELAY_WIDE = [
  'chat-menu-pwa-version',
  'chat-menu-queue-status',
  'chat-menu-theme-toggle',
  'chat-menu-usage',
  'chat-menu-select-models',
  'chat-menu-settings',
  'chat-menu-about',
  'chat-menu-restart-relay',
];

const PER_CONVERSATION = [
  'chat-menu-edit-title',
  'chat-menu-share-conversation',
  'chat-menu-preview-shared',
  'chat-menu-archive',
  'chat-menu-group',
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
  assert.deepEqual(state.entries['chat-menu-theme-toggle'], { hidden: false, disabled: false });
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
    assert.deepEqual(visibleChatActionsMenuEntryIds(state), ['chat-menu-theme-toggle']);
    assert.equal(state.entries['chat-menu-settings'].hidden, true);
    assert.equal(state.entries['chat-menu-settings'].disabled, true);
    // About is the owner's: a shared viewer never sees the relay's facts.
    assert.deepEqual(state.entries['chat-menu-about'], { hidden: true, disabled: true });
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

test('Stop sharing shows only for an open conversation with an active share', () => {
  assert.equal(resolveChatActionsMenuState(localConversation).entries['chat-menu-stop-sharing'].hidden, true);
  const shared = resolveChatActionsMenuState({ ...localConversation, hasActiveShare: true });
  assert.deepEqual(shared.entries['chat-menu-stop-sharing'], { hidden: false, disabled: false });
  // Share conversation stays: it copies the existing link.
  assert.equal(shared.entries['chat-menu-share-conversation'].hidden, false);
  assert.equal(resolveChatActionsMenuState({ conversationId: null, hasActiveShare: true }).entries['chat-menu-stop-sharing'].hidden, true);
  assert.equal(resolveChatActionsMenuState({ sharedMode: true, ...localConversation, hasActiveShare: true }).entries['chat-menu-stop-sharing'].hidden, true);
});

// The header's priority+ actions: a twin shows only while its header button
// does not fit (header-priority-actions.mjs hands in which ones that is).

test('before the header was measured the menu keeps Day/Night and Check Usage, and no other twin', () => {
  for (const input of [{}, localConversation]) {
    const state = resolveChatActionsMenuState(input);
    for (const id of CHAT_ACTIONS_MENU_TWIN_IDS) {
      const expected = id === 'chat-menu-theme-toggle' || id === 'chat-menu-usage';
      assert.equal(state.entries[id].hidden, !expected, id);
    }
  }
});

test('a measured header shows exactly the twins that did not fit', () => {
  const allInline = resolveChatActionsMenuState({ ...localConversation, headerMenuIds: [] });
  for (const id of CHAT_ACTIONS_MENU_TWIN_IDS) assert.equal(allInline.entries[id].hidden, true, id);
  // Every other entry is untouched by the fit.
  for (const id of PER_CONVERSATION) assert.equal(allInline.entries[id].hidden, false, id);
  assert.equal(allInline.entries['chat-menu-settings'].hidden, false);

  const narrow = resolveChatActionsMenuState({
    ...localConversation,
    headerMenuIds: ['chat-menu-context', 'chat-menu-usage', 'chat-menu-theme-toggle', 'chat-menu-fullscreen'],
  });
  const twinsShown = visibleChatActionsMenuEntryIds(narrow).filter((id) => CHAT_ACTIONS_MENU_TWIN_IDS.includes(id));
  // Menu order, not the order handed in.
  assert.deepEqual(twinsShown, ['chat-menu-context', 'chat-menu-theme-toggle', 'chat-menu-usage', 'chat-menu-fullscreen']);
  assert.deepEqual(narrow.entries['chat-menu-context'], { hidden: false, disabled: false });
  assert.deepEqual(narrow.entries['chat-menu-pins'], { hidden: true, disabled: true });
  // 📓 is the first twin, ahead of 📍, in the menu as in the header.
  assert.equal(CHAT_ACTIONS_MENU_TWIN_IDS[0], 'chat-menu-questions');
  const questions = resolveChatActionsMenuState({ ...localConversation, headerMenuIds: ['chat-menu-pins', 'chat-menu-questions'] });
  assert.deepEqual(
    visibleChatActionsMenuEntryIds(questions).filter((id) => CHAT_ACTIONS_MENU_TWIN_IDS.includes(id)),
    ['chat-menu-questions', 'chat-menu-pins'],
  );
});

test('twins are relay-wide: they follow the fit with no conversation open too', () => {
  const state = resolveChatActionsMenuState({ conversationId: null, headerMenuIds: ['chat-menu-search'] });
  assert.equal(state.entries['chat-menu-search'].hidden, false);
  assert.equal(state.entries['chat-menu-usage'].hidden, true);
});

test('the shared view: Day/Night in ︙ only while it does not fit, and no trigger with an empty menu', () => {
  const inMenu = resolveChatActionsMenuState({ sharedMode: true, headerMenuIds: ['chat-menu-theme-toggle', 'chat-menu-search'] });
  // A twin the shared view never offers stays hidden whatever the fit says.
  assert.deepEqual(visibleChatActionsMenuEntryIds(inMenu), ['chat-menu-theme-toggle']);
  assert.deepEqual(inMenu.trigger, { hidden: false, disabled: false });
  const inline = resolveChatActionsMenuState({ sharedMode: true, ...localConversation, headerMenuIds: [] });
  assert.deepEqual(visibleChatActionsMenuEntryIds(inline), []);
  assert.deepEqual(inline.trigger, { hidden: true, disabled: false });
});

test('the fullscreen twin is disabled where the browser cannot go fullscreen, as its header button', () => {
  const inMenu = { ...localConversation, headerMenuIds: ['chat-menu-fullscreen'] };
  assert.deepEqual(resolveChatActionsMenuState(inMenu).entries['chat-menu-fullscreen'], { hidden: false, disabled: false });
  assert.deepEqual(resolveChatActionsMenuState({ ...inMenu, fullscreenSupported: false }).entries['chat-menu-fullscreen'], { hidden: false, disabled: true });
  // Not in the menu: hidden, whatever the support.
  assert.deepEqual(resolveChatActionsMenuState({ ...localConversation, headerMenuIds: [], fullscreenSupported: false }).entries['chat-menu-fullscreen'], { hidden: true, disabled: true });
});

const META_CHIP_ENTRY_IDS = ['chat-menu-watching', 'chat-menu-schedules', 'chat-menu-origin'];
const ALL_CHIPS = { watching: true, schedules: true, origin: true };

test('phone landscape: the meta line\'s chips get ︙ entries, each only while the chip exists', () => {
  assert.deepEqual(Object.values(CHAT_ACTIONS_MENU_META_CHIP_IDS), META_CHIP_ENTRY_IDS);
  for (const id of META_CHIP_ENTRY_IDS) assert.ok(CHAT_ACTIONS_MENU_ENTRY_IDS.includes(id), id);
  const all = resolveChatActionsMenuState({ ...localConversation, phoneLandscape: true, metaChips: ALL_CHIPS });
  assert.deepEqual(visibleChatActionsMenuEntryIds(all).filter((id) => META_CHIP_ENTRY_IDS.includes(id)), META_CHIP_ENTRY_IDS);
  for (const id of META_CHIP_ENTRY_IDS) assert.deepEqual(all.entries[id], { hidden: false, disabled: false });
  const onlySchedules = resolveChatActionsMenuState({ ...localConversation, phoneLandscape: true, metaChips: { schedules: true } });
  assert.deepEqual(visibleChatActionsMenuEntryIds(onlySchedules).filter((id) => META_CHIP_ENTRY_IDS.includes(id)), ['chat-menu-schedules']);
});

test('the chip entries stay hidden where the meta line shows, with nothing open, and in the shared view', () => {
  const hiddenEntry = { hidden: true, disabled: true };
  const portrait = resolveChatActionsMenuState({ ...localConversation, phoneLandscape: false, metaChips: ALL_CHIPS });
  const nothingOpen = resolveChatActionsMenuState({ conversationId: null, phoneLandscape: true, metaChips: ALL_CHIPS });
  const shared = resolveChatActionsMenuState({ sharedMode: true, ...localConversation, phoneLandscape: true, metaChips: ALL_CHIPS });
  const noChips = resolveChatActionsMenuState({ ...localConversation, phoneLandscape: true });
  for (const state of [portrait, nothingOpen, shared, noChips]) {
    for (const id of META_CHIP_ENTRY_IDS) assert.deepEqual(state.entries[id], hiddenEntry, id);
  }
});

test('the chip entries\' labels', () => {
  assert.deepEqual(chatActionsMenuMetaChipLabels({ watching: 'watching 2 sessions', origin: 'Started by an agent in “Fern survey lead”' }), {
    watching: '👁 Watching 2 sessions…',
    schedules: '⏰ Schedules…',
    origin: '↗ Started by an agent in “Fern survey lead”',
  });
  assert.deepEqual(chatActionsMenuMetaChipLabels({}), { watching: '', schedules: '⏰ Schedules…', origin: '' });
});

test('the markup has the chip entries in ︙, hidden until decided', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<div id="chat-actions-menu" role="menu"');
  const end = html.indexOf('</div>\n        </div>', start);
  for (const id of META_CHIP_ENTRY_IDS) {
    const at = html.indexOf(`<button id="${id}" class="chat-actions-menu-item`, start);
    assert.ok(at > start && at < end, id);
    assert.match(html.slice(at, html.indexOf('</button>', at)), / hidden>/, id);
  }
});

test('menu placement: hanging from ︙ inside the bounds, it stays where CSS put it', () => {
  const placement = resolveChatActionsMenuPlacement({
    rect: { left: 900, right: 1200, top: 60 },
    bounds: { left: 300, right: 1280, bottom: 800 },
    margin: 8,
  });
  assert.deepEqual(placement, { right: 0, maxWidth: null, maxHeight: 800 - 8 - 60 });
});

test('menu placement: a menu that would leave the screen on the left moves right (390px phone with a question)', () => {
  // As measured before the fix: x = -87 to 113 on a 390px screen.
  const placement = resolveChatActionsMenuPlacement({
    rect: { left: -87, right: 113, top: 70 },
    bounds: { left: 0, right: 390, bottom: 844 },
    margin: 8,
  });
  // Its left edge lands on 8: the right edge moves 95px to the right.
  assert.equal(placement.right, -95);
  assert.equal(placement.maxWidth, null);
  assert.equal(placement.maxHeight, 844 - 8 - 70);
});

test('menu placement: never under the sidebar (desktop at 150 %)', () => {
  // #main starts at 530; the menu hung from ︙ at 402 to 732.
  const placement = resolveChatActionsMenuPlacement({
    rect: { left: 402, right: 732, top: 132 },
    bounds: { left: 530, right: 1280, bottom: 800 },
    margin: 12,
  });
  const left = 732 - placement.right - 330;
  assert.equal(left, 542);
  assert.equal(placement.maxHeight, 800 - 12 - 132);
});

test('menu placement: off the right edge it moves left; wider than the room it narrows', () => {
  const pushed = resolveChatActionsMenuPlacement({ rect: { left: 300, right: 420, top: 10 }, bounds: { left: 0, right: 400, bottom: 300 }, margin: 8 });
  assert.equal(pushed.right, 28);
  const narrowed = resolveChatActionsMenuPlacement({ rect: { left: 0, right: 500, top: 10 }, bounds: { left: 100, right: 400, bottom: 300 }, margin: 10 });
  assert.equal(narrowed.maxWidth, 280);
  // Its right edge at 390, its left at 110.
  assert.equal(500 - narrowed.right, 390);
});

test('menu placement: the height is what is left below its top, with a floor', () => {
  // Phone landscape: 390px tall, the menu starts at 38.
  assert.equal(resolveChatActionsMenuPlacement({ rect: { left: 400, right: 620, top: 38 }, bounds: { left: 360, right: 844, bottom: 390 }, margin: 8 }).maxHeight, 344);
  assert.equal(resolveChatActionsMenuPlacement({ rect: { left: 0, right: 100, top: 380 }, bounds: { left: 0, right: 400, bottom: 390 }, margin: 8, minHeight: 120 }).maxHeight, 120);
});
