import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNoConversationState, SETUP_HEADING, SETUP_TEXT } from './no-conversation-state.mjs';

const notReady = { known: true, anyReady: false, ready: [], copilot: 'unknown' };
const ready = { known: true, anyReady: true, ready: ['claude'], copilot: 'unknown' };
const unknown = { known: false, anyReady: false, ready: [], copilot: 'unknown' };

const ids = (state) => state.actions.map((action) => action.id);
const primaryIds = (state) => state.actions.filter((action) => action.primary).map((action) => action.id);

test('with no provider ready the screen points to Settings → Providers, whatever else exists', () => {
  for (const conversationCount of [0, 3]) {
    for (const mobile of [false, true]) {
      const state = resolveNoConversationState({ readiness: notReady, conversationCount, mobile });
      assert.equal(state.variant, 'setup');
      assert.equal(state.heading, SETUP_HEADING);
      assert.equal(state.text, SETUP_TEXT);
      assert.match(state.text, /Settings → Providers/);
      assert.match(state.text, /Copilot CLI/);
      assert.deepEqual(ids(state), ['empty-state-open-settings', 'empty-state-new-chat']);
      assert.deepEqual(primaryIds(state), ['empty-state-open-settings']);
      assert.equal(state.actions[0].action, 'open-settings');
      assert.equal(state.actions[0].label, 'Open Settings');
      assert.equal(state.actions[1].action, 'new-chat');
    }
  }
});

test('a ready relay with no conversations invites the first chat', () => {
  const state = resolveNoConversationState({ readiness: ready, conversationCount: 0 });
  assert.equal(state.variant, 'first-chat');
  assert.equal(state.heading, 'Start your first chat');
  assert.deepEqual(ids(state), ['empty-state-new-chat', 'empty-state-open-settings']);
  assert.deepEqual(primaryIds(state), ['empty-state-new-chat']);
  const settings = state.actions.find((action) => action.id === 'empty-state-open-settings');
  assert.equal(settings.link, true);
  assert.equal(settings.label, 'Settings');
});

test('a ready relay with conversations asks to pick one; the phone also offers the list', () => {
  const desktop = resolveNoConversationState({ readiness: ready, conversationCount: 2, mobile: false });
  assert.equal(desktop.variant, 'pick');
  assert.equal(desktop.heading, 'No conversation open');
  assert.match(desktop.text, /Pick one from the list or start a new one/);
  assert.deepEqual(ids(desktop), ['empty-state-new-chat', 'empty-state-open-settings']);
  const phone = resolveNoConversationState({ readiness: ready, conversationCount: 2, mobile: true });
  assert.equal(phone.variant, 'pick');
  assert.deepEqual(ids(phone), ['empty-state-new-chat', 'empty-state-show-conversations', 'empty-state-open-settings']);
  assert.equal(phone.actions[1].action, 'show-conversations');
  assert.deepEqual(primaryIds(phone), ['empty-state-new-chat']);
});

test('Show conversations belongs to pick only', () => {
  for (const readiness of [notReady, ready, unknown]) {
    const state = resolveNoConversationState({ readiness, conversationCount: 0, mobile: true });
    assert.equal(ids(state).includes('empty-state-show-conversations'), false, state.variant);
  }
});

test('an unknown or missing readiness answer counts as ready', () => {
  assert.equal(resolveNoConversationState({ readiness: unknown, conversationCount: 0 }).variant, 'first-chat');
  assert.equal(resolveNoConversationState({ readiness: null, conversationCount: 1 }).variant, 'pick');
  assert.equal(resolveNoConversationState({}).variant, 'first-chat');
  assert.equal(resolveNoConversationState({ readiness: ready, conversationCount: -4 }).variant, 'first-chat');
});
