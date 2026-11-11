import test from 'node:test';
import assert from 'node:assert/strict';

import { registerRelayBoardRoutes } from './relay-board-routes.mjs';
import { makeRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';

// A board of a plan turn, a conversation that is in plan mode, and fakes that
// keep what the route writes.
function setup({ conversation = {}, actions, deps: extraDeps = {} } = {}) {
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
      boardType: 'plan_ready',
      title: 'Plan ready for review',
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
    messages: [],
    events: [],
    settled: [],
  };
  // Like the real statements: only a pending card is settled.
  const settle = (status) => (actionId) => {
    if (state.board.status !== 'pending') return { changes: 0 };
    state.board = { ...state.board, status, selectedAction: actionId };
    return { changes: 1 };
  };
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
    relayEventService: { noteBoardSettled: (conversationId, detail) => state.settled.push({ conversationId, ...detail }) },
    ...extraDeps,
    stmts: {
      getBoard: { get: () => state.board },
      markBoardAction: { run: settle('acted') },
      dismissBoard: { run: settle('dismissed') },
      getLatestConversationModel: { get: () => ({ model: 'model-a' }) },
      insertMsg: { run: (...args) => state.messages.push(args) },
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

// The queue insert's reasoning-effort argument.
const queuedEffort = (state) => state.queued[0][6];

test('the follow-up runs with the conversation\'s effort when the model id carries none', async () => {
  const { state, act } = setup();
  const { status } = await act('autopilot');
  assert.equal(status, 200);
  assert.equal(queuedEffort(state), 'low');
});

test('a conversation effort the model lacks is clamped to its nearest level', async () => {
  const { state, act } = setup({
    conversation: { preferred_reasoning_effort: 'max' },
    deps: {
      resolveRequestedReasoningEffort: (_model, effort) => (['low', 'medium', 'high'].includes(effort)
        ? { ok: true, effort, supported: ['low', 'medium', 'high'] }
        : { ok: false, error: 'Unsupported reasoning effort', supported: ['none', 'low', 'medium', 'high'] }),
    },
  });
  await act('autopilot');
  assert.equal(queuedEffort(state), 'high');
});

test('an effort carried by the model\'s variant id still wins', async () => {
  const { state, act } = setup({
    deps: {
      resolveRequestedModel: (model) => ({ ok: true, model, modelVariantId: `${model}-medium`, reasoningEffort: 'medium' }),
    },
  });
  await act('autopilot');
  assert.equal(queuedEffort(state), 'medium');
});

// ─── Approve plan ──────────────────────────────────────────────────

const APPROVE_LINE = 'Plan approved by the user. Do not implement. Finish only the plan-only steps you were given, then stop.';
// The queue insert's relay mode and prompt.
const queuedMode = (state) => state.queued[0][8];
const queuedText = (state) => state.queued[0][9];

test('"Approve plan" queues exactly its line in agent mode and leaves the session in plan', async () => {
  const { state, act, preferenceEvents } = setup({
    actions: [
      { id: 'approve_only', label: 'Approve plan', mode: 'agent', prompt: 'something else' },
      { id: 'autopilot', label: 'Implement in autopilot', mode: 'autopilot' },
    ],
  });
  const { status, body } = await act('approve_only');
  assert.equal(status, 200);
  assert.equal(body.queuedMessageId, 'follow-up-1');
  assert.equal(queuedText(state), APPROVE_LINE, 'exactly the line, whatever the stored entry carries');
  assert.equal(queuedMode(state), 'agent', 'the one turn runs with write access');
  assert.equal(state.messages[0][5], 'agent');
  // The saved mode stays plan: the next message plans again.
  assert.equal(state.conversation.preferred_relay_mode, 'plan');
  assert.equal(preferenceEvents().length, 0);
  assert.equal(state.board.status, 'acted');
  assert.equal(state.board.selectedAction, 'approve_only');
  const echo = state.events.find((event) => event.name === 'user_message');
  assert.equal(echo.payload.message.mode, 'agent');
});

test('a plan card stored before "Approve plan" existed takes it', async () => {
  const { state, act } = setup();
  const { status } = await act('approve_only');
  assert.equal(status, 200);
  assert.equal(queuedText(state), APPROVE_LINE);
  assert.equal(state.board.selectedAction, 'approve_only');
  assert.equal(state.conversation.preferred_relay_mode, 'plan');
});

test('a card that is no plan card does not take "Approve plan" unless it lists it', async () => {
  const { state, act } = setup();
  state.board = { ...state.board, boardType: 'generic' };
  const { status } = await act('approve_only');
  assert.equal(status, 400);
  assert.equal(state.queued.length, 0);
  assert.equal(state.board.status, 'pending');
});

test('no follow-up carries the plan any more', async () => {
  for (const [id, line] of [
    ['autopilot', 'Please implement the approved plan now.'],
    ['interactive', 'I approved the plan. Let\'s proceed interactively with implementation.'],
    ['autopilot_fleet', 'Please implement the approved plan using autopilot_fleet where useful.'],
  ]) {
    const { state, act } = setup({
      actions: [{ id: id, label: id, mode: id === 'interactive' ? 'agent' : 'autopilot' }],
    });
    const { status } = await act(id);
    assert.equal(status, 200, id);
    assert.equal(queuedText(state), line, id);
    assert.doesNotMatch(queuedText(state), /Plan summary|Rename the module/, id);
  }
});

test('an old interactive entry without a mode still goes on in agent mode', async () => {
  const { state, act } = setup();
  await act('interactive');
  assert.equal(queuedMode(state), 'agent');
  assert.equal(state.conversation.preferred_relay_mode, 'agent');
});

test('a card settled meanwhile queues nothing and records no settle', async () => {
  const { state, act } = setup();
  // Read as pending, settled by the other view before the update ran.
  const settledElsewhere = { ...state.board, status: 'acted', selectedAction: 'autopilot' };
  let reads = 0;
  const originalBoard = state.board;
  Object.defineProperty(state, 'board', {
    configurable: true,
    get: () => (reads++ === 0 ? originalBoard : settledElsewhere),
    set: () => {},
  });
  const { status, body } = await act('approve_only');
  assert.equal(status, 409);
  assert.equal(body.board.selectedAction, 'autopilot');
  assert.equal(state.queued.length, 0);
  assert.equal(state.messages.length, 0);
  assert.equal(state.settled.length, 0);
});

test('a second press finds the card settled', async () => {
  const { state, act } = setup();
  assert.equal((await act('approve_only')).status, 200);
  const again = await act('autopilot');
  assert.equal(again.status, 409);
  assert.equal(state.queued.length, 1);
  assert.equal(state.settled.length, 1);
});

test('a card of a deleted conversation is not acted on', async () => {
  const { state, act } = setup({ conversation: { status: 'deleted' } });
  const { status } = await act('approve_only');
  assert.equal(status, 404);
  assert.equal(state.queued.length, 0);
  assert.equal(state.board.status, 'pending');
  assert.equal(state.settled.length, 0);
});

test('an action the relay does not know only settles the card', async () => {
  const { state, act, preferenceEvents } = setup({
    actions: [{ id: 'keep_planning', label: 'Keep Planning', mode: null }],
  });
  const { status, body } = await act('keep_planning');
  assert.equal(status, 200);
  assert.equal(body.queuedMessageId, null);
  assert.equal(state.queued.length, 0);
  assert.equal(preferenceEvents().length, 0);
  assert.equal(state.board.status, 'acted');
  assert.equal(state.settled.length, 1);
});

test('every settle is noted for the session\'s subscribers, "Stop here" included', async () => {
  for (const [id, queued] of [['approve_only', true], ['autopilot', true], ['interactive', true], ['exit_only', false]]) {
    const { state, act } = setup();
    assert.equal((await act(id)).status, 200, id);
    assert.equal(state.settled.length, 1, id);
    const [note] = state.settled;
    assert.equal(note.conversationId, 'conv-1');
    assert.equal(note.boardId, 'board-1');
    assert.equal(note.boardType, 'plan_ready');
    assert.equal(note.action, id);
    assert.equal(note.title, 'Plan ready for review');
    assert.equal(note.queuedMessageId, queued ? 'follow-up-1' : null, id);
  }
  const { state, act } = setup();
  await act('approve_only');
  assert.equal(state.settled[0].actionLabel, 'Approve plan');
});
test('a plan-only session\'s new plan card recommends "Approve plan", whatever was asked', async () => {
  const run = async ({ planOnly, boardType = 'plan_ready' }) => {
    const inserted = [];
    const deps = makeRouteDeps({
      io: { emit() {} },
      uuidv4: () => 'board-new',
      DEFAULT_RELAY_MODE: 'agent',
      normalizeRelayMode: (value) => (['plan', 'agent', 'autopilot'].includes(String(value || '')) ? String(value) : null),
      formatRelayBoardRow: (row) => row,
      stmts: {
        findQById: { get: () => ({ id: 'q-1', status: 'processing', conversation_id: 'conv-1', relay_mode: 'plan' }) },
        findBoardByMessageType: { get: () => null },
        insertBoard: { run: (...args) => inserted.push(args) },
        getBoard: { get: () => ({ id: 'board-new' }) },
        getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', plan_only: planOnly ? 1 : null }) },
      },
    });
    const routes = captureRoutes(deps, registerRelayBoardRoutes);
    const { status } = await invokeRoute(routes, 'POST', '/api/relay-board', {
      body: { queueId: 'q-1', conversationId: 'conv-1', boardType, actions: ['autopilot_fleet', 'exit_only'], recommendedAction: 'autopilot_fleet' },
    });
    assert.equal(status, 200);
    // insertBoard's recommended_action argument.
    return inserted[0][9];
  };
  assert.equal(await run({ planOnly: true }), 'approve_only');
  assert.equal(await run({ planOnly: false }), 'autopilot_fleet');
  assert.equal(await run({ planOnly: true, boardType: 'generic' }), 'autopilot_fleet');
});
// ─── The plan on a new card ───────────────────────────────────────────

async function storedBoardBody({ body, context }) {
  const inserted = [];
  const deps = makeRouteDeps({
    io: { emit() {} },
    uuidv4: () => 'board-new',
    DEFAULT_RELAY_MODE: 'agent',
    normalizeRelayMode: (value) => (['plan', 'agent', 'autopilot'].includes(String(value || '')) ? String(value) : null),
    formatRelayBoardRow: (row) => row,
    stmts: {
      findQById: { get: () => ({ id: 'q-1', status: 'processing', conversation_id: 'conv-1', relay_mode: 'plan' }) },
      findBoardByMessageType: { get: () => null },
      insertBoard: { run: (...args) => inserted.push(args) },
      getBoard: { get: () => ({ id: 'board-new' }) },
      getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', plan_only: null }) },
    },
  });
  const routes = captureRoutes(deps, registerRelayBoardRoutes);
  const { status } = await invokeRoute(routes, 'POST', '/api/relay-board', {
    body: { queueId: 'q-1', conversationId: 'conv-1', boardType: 'plan_ready', title: 'T'.repeat(13_000), body, context },
  });
  assert.equal(status, 200);
  // insertBoard's title and body arguments.
  return { title: inserted[0][6], body: inserted[0][7] };
}

test('a plan longer than 12,000 characters is stored whole', async () => {
  const plan = `# Plan\n\n${'1. A step of the plan, written out in full.\n'.repeat(560)}Last line of the plan.`;
  assert.ok(plan.length > 24_000);
  const stored = await storedBoardBody({ body: plan });
  assert.equal(stored.body, plan);
  assert.equal(stored.title.length, 12_000, 'the title keeps its limit');
});

test('a plan past 200,000 characters is cut at a line break and says how much is missing', async () => {
  const line = '1. A step of the plan, written out in full.\n';
  const plan = line.repeat(Math.ceil(250_000 / line.length)).trimEnd();
  const stored = await storedBoardBody({ body: plan, context: { source: 'exit_plan_mode', planFilePath: '/home/dev/plans/long.md' } });
  const [kept, note] = stored.body.split('\n\n… cut here: ');
  assert.ok(kept.length <= 200_000 && kept.length > 199_000);
  assert.ok(kept.endsWith('written out in full.'), 'no step is cut in two');
  assert.equal(note, `${plan.length - kept.length} more characters; the whole plan is in \`/home/dev/plans/long.md\`.`);

  const unnamed = await storedBoardBody({ body: plan });
  assert.ok(unnamed.body.endsWith(`… cut here: ${plan.length - kept.length} more characters.`));

  const oneLine = await storedBoardBody({ body: 'x'.repeat(250_000) });
  assert.ok(oneLine.body.startsWith('x'.repeat(200_000)));
  assert.ok(oneLine.body.endsWith('\n\n… cut here: 50000 more characters.'));
});

test('a cut inside a code block closes the block, so the note is not shown as code', async () => {
  const code = `Steps:\n\n\`\`\`\`sh\n${'echo one more line of the script\n'.repeat(8_000)}\`\`\`\`\n\nDone.`;
  assert.ok(code.length > 200_000);
  const stored = await storedBoardBody({ body: code });
  assert.match(stored.body, /echo one more line of the script\n````\n\n… cut here: \d+ more characters\.$/);
  // A block closed before the cut needs nothing.
  const closed = await storedBoardBody({ body: `\`\`\`sh\necho done\n\`\`\`\n\n${'A step of the plan.\n'.repeat(13_000)}` });
  assert.match(closed.body, /A step of the plan\.\n\n… cut here: \d+ more characters\.$/);
});

test('the block closed after a cut is the one that is open: nested, tilde and labelled fences', async () => {
  const filler = 'echo one more line of the script\n'.repeat(8_000);
  const closedWith = async (head) => {
    const stored = await storedBoardBody({ body: `${head}${filler}` });
    const match = /echo one more line of the script(\n[`~]+)?\n\n… cut here: \d+ more characters\.$/.exec(stored.body);
    assert.ok(match, head);
    return (match[1] || '').trim();
  };
  // Four backticks around a three-backtick block that is closed: the outer one is open.
  assert.equal(await closedWith('````md\n```js\nlet a;\n```\n'), '````');
  // Four backticks with a three-backtick line inside: still the outer one, nothing nested.
  assert.equal(await closedWith('````md\n```js\n'), '````');
  // A tilde line does not close a backtick block, and a tilde block closes with tildes.
  assert.equal(await closedWith('```\n~~~\n'), '```');
  assert.equal(await closedWith('~~~~ sh\n```\n'), '~~~~');
  // A fence line with a label cannot close: the block opened by ```md is still open.
  assert.equal(await closedWith('```md\n```js\n'), '```');
  // Closed blocks, a too-short closer, and a backtick line that is no fence.
  assert.equal(await closedWith('```md\ntext\n```\n~~~\ntext\n~~~\n'), '');
  assert.equal(await closedWith('````\ntext\n```\n'), '````');
  assert.equal(await closedWith('``` a `b` c\n'), '');
  assert.equal(await closedWith('Steps:\n\n    ```\n'), '', 'four blanks: an indented code line, no fence');
});

test('fences are found in a plan with Windows line ends', async () => {
  const cut = await storedBoardBody({ body: `\`\`\`js\r\n${'echo x\r\n'.repeat(30_000)}` });
  assert.match(cut.body, /echo x\n```\n\n… cut here: \d+ more characters\.$/);
  // A closed backtick block, then an open tilde block: the tilde one is closed.
  const tilde = await storedBoardBody({ body: `\`\`\`\r\na\r\n\`\`\`\r\n~~~~\r\n${'b\r\n'.repeat(70_000)}` });
  assert.match(tilde.body, /b\n~~~~\n\n… cut here: \d+ more characters\.$/);
  // Closed blocks need nothing.
  const closed = await storedBoardBody({ body: `\`\`\`js\r\nlet a;\r\n\`\`\`\r\n${'A step of the plan.\r\n'.repeat(13_000)}` });
  assert.match(closed.body, /A step of the plan\.\n\n… cut here: \d+ more characters\.$/);
});

test('a cut never leaves half a character', async () => {
  const stored = await storedBoardBody({ body: `${'x'.repeat(199_999)}${'🙂'.repeat(30_000)}` });
  assert.ok(stored.body.startsWith(`${'x'.repeat(199_999)}\n\n… cut here: `));
});
