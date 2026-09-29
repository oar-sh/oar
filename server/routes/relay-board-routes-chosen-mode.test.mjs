import test from 'node:test';
import assert from 'node:assert/strict';

import { registerRelayBoardRoutes } from './relay-board-routes.mjs';
import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';

// A board of a plan turn, a conversation that is in plan mode, and fakes that
// keep what the route writes.
function setup({ conversation = {}, actions } = {}) {
  const state = {
    conversation: {
      id: 'conv-1',
      status: 'active',
      preferred_relay_mode: 'plan',
      preferred_model: 'model-a',
      preferred_reasoning_effort: 'low',
      ...conversation,
    },
    board: {
      id: 'board-1',
      status: 'pending',
      conversationId: 'conv-1',
      mode: 'plan',
      body: '1. Rename the module',
      actions: actions || [
        { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
        { id: 'interactive', label: 'Stop here and prompt myself' },
        { id: 'exit_only', label: 'Stop here' },
      ],
    },
    queued: [],
    events: [],
  };
  const settle = (status) => (actionId) => { state.board = { ...state.board, status, selectedAction: actionId }; };
  const deps = makeRouteDeps({
    io: { emit: (name, payload) => state.events.push({ name, payload }) },
    db: { transaction: (fn) => (...args) => fn(...args), prepare: () => ({ run() {} }) },
    uuidv4: () => 'follow-up-1',
    DEFAULT_RELAY_MODE: 'agent',
    normalizeRelayMode: (value) => {
      const mode = String(value || '').trim().toLowerCase();
      return ['plan', 'ask', 'agent', 'autopilot'].includes(mode) ? mode : null;
    },
    resolveRequestedModel: (model) => ({ ok: true, model, modelVariantId: model, reasoningEffort: null }),
    formatRelayBoardRow: (row) => row,
    stmts: {
      getBoard: { get: () => state.board },
      markBoardAction: { run: settle('acted') },
      dismissBoard: { run: settle('dismissed') },
      getLatestConversationModel: { get: () => ({ model: 'model-a' }) },
      insertMsg: { run() {} },
      updateConvTime: { run() {} },
      insertQ: { run: (...args) => state.queued.push(args) },
      getConvAnyStatus: { get: () => (state.conversation ? { ...state.conversation } : null) },
      updateConvPreferences: {
        run: (mode, model, effort) => {
          state.conversation = { ...state.conversation, preferred_relay_mode: mode, preferred_model: model, preferred_reasoning_effort: effort };
        },
      },
    },
  });
  const routes = captureRoutes(deps, registerRelayBoardRoutes);
  const act = (actionId) => invokeRoute(routes, 'POST', '/api/relay-board/:id/action', {
    params: { id: 'board-1' },
    body: { actionId, clientId: 'page-1' },
  });
  const preferenceEvents = () => state.events.filter((event) => event.name === 'conversation_preferences_updated');
  return { state, act, preferenceEvents };
}

test('"Implement in autopilot" puts the session into autopilot and tells every page', async () => {
  const { state, act, preferenceEvents } = setup();
  const { status, body } = await act('autopilot');
  assert.equal(status, 200);
  assert.equal(body.queuedMessageId, 'follow-up-1');
  assert.equal(state.queued.length, 1);
  assert.equal(state.conversation.preferred_relay_mode, 'autopilot');
  // The model and the effort are not part of the choice.
  assert.equal(state.conversation.preferred_model, 'model-a');
  assert.equal(state.conversation.preferred_reasoning_effort, 'low');
  const [event] = preferenceEvents();
  assert.equal(event.payload.conversationId, 'conv-1');
  assert.equal(event.payload.preferredRelayMode, 'autopilot');
  assert.equal(event.payload.preferredModel, 'model-a');
  // The page that pressed the button skips events it sent itself.
  assert.equal(event.payload.senderClientId, null);
});

test('"Stop here and prompt myself" puts the session into agent mode', async () => {
  const { state, act, preferenceEvents } = setup();
  const { status } = await act('interactive');
  assert.equal(status, 200);
  assert.equal(state.conversation.preferred_relay_mode, 'agent');
  assert.equal(preferenceEvents().length, 1);
});

test('"Stop here" queues nothing and leaves the session in plan mode', async () => {
  const { state, act, preferenceEvents } = setup();
  const { status, body } = await act('exit_only');
  assert.equal(status, 200);
  assert.equal(body.queuedMessageId, null);
  assert.equal(state.queued.length, 0);
  assert.equal(state.conversation.preferred_relay_mode, 'plan');
  assert.equal(preferenceEvents().length, 0);
});

test('a session that is in the chosen mode already is not written again', async () => {
  const { state, act, preferenceEvents } = setup({ conversation: { preferred_relay_mode: 'autopilot' } });
  const { status } = await act('autopilot');
  assert.equal(status, 200);
  assert.equal(state.queued.length, 1);
  assert.equal(preferenceEvents().length, 0);
});

test('the follow-up is queued when the conversation row cannot be read', async () => {
  const { state, act, preferenceEvents } = setup();
  state.conversation = null;
  const { status, body } = await act('autopilot');
  assert.equal(status, 200);
  assert.equal(body.queuedMessageId, 'follow-up-1');
  assert.equal(state.queued.length, 1);
  assert.equal(preferenceEvents().length, 0);
});
