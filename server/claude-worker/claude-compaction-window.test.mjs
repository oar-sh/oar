import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tick,
  waitFor,
  makeApiStub,
  scriptedTurn,
  initMessage,
  resultMessage,
  backgroundTasksMessage,
  compactBoundaryMessage,
  compactingStatusMessage,
  compactSummaryReplay,
  userReplay,
  assistantText,
  baseMessage,
  makeRunner,
  settled,
} from './claude-session-test-harness.mjs';

// The compaction line's own entries (pending while the CLI compacts,
// cancelled when it ends without a boundary) and the compaction window, which
// a running CLI never takes live: a changed window respawns an idle process.

function compactionEntries(stub, messageId = null) {
  return stub.calls
    .filter((call) => call.routePath === '/api/activity' && call.body?.metadata?.kind === 'compact_boundary')
    .filter((call) => !messageId || call.body.messageId === messageId)
    .map((call) => ({ messageId: call.body.messageId, state: call.body.metadata.state || 'boundary', text: call.body.text }));
}

function respawnNotes(stub) {
  return stub.calls
    .filter((call) => call.routePath === '/api/activity' && call.body?.metadata?.kind === 'compact_window_respawn')
    .map((call) => ({ messageId: call.body.messageId, text: call.body.text, metadata: call.body.metadata }));
}

function responseFor(stub, messageId) {
  return stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === messageId) || null;
}

/**
 * Delivers q-1 and resolves once its turn is the active one, with `done`
 * wrapped (an async function returning a promise would wait on it).
 */
async function startLiveTurn(runner, turn) {
  const done = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('working'));
  await waitFor(() => runner._getProcess()?.activeCtx, { label: 'q-1 turn is live' });
  return { done };
}

const compactSuccess = { type: 'system', subtype: 'status', status: null, compact_result: 'success' };
const compactFailed = { type: 'system', subtype: 'status', status: null, compact_result: 'failed' };

// ---------------------------------------------------------------------------
// Pending / cancelled compaction entries

test('a compaction on the running turn shows pending, then the boundary', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const { done: first } = await startLiveTurn(runner, turn);

  turn.emit(compactingStatusMessage());
  await waitFor(() => compactionEntries(stub).length === 1, { label: 'pending entry' });
  assert.deepEqual(compactionEntries(stub), [{ messageId: 'q-1', state: 'pending', text: 'Compacting context…' }]);

  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSuccess);
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);
  assert.deepEqual(compactionEntries(stub).map((entry) => entry.state), ['pending', 'boundary']);
  turn.endInput();
  await settled(runner);
});

test('a compaction that ends without a boundary is cancelled on the same row', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const { done: first } = await startLiveTurn(runner, turn);

  turn.emit(compactingStatusMessage());
  // The status is emitted once per compaction; a repeat must not add a line.
  turn.emit(compactingStatusMessage());
  turn.emit(compactFailed);
  await waitFor(() => compactionEntries(stub).length === 2, { label: 'cancelled entry' });
  assert.deepEqual(compactionEntries(stub), [
    { messageId: 'q-1', state: 'pending', text: 'Compacting context…' },
    { messageId: 'q-1', state: 'cancelled', text: 'Compaction ended without a result' },
  ]);

  // A later terminator has nothing left to cancel.
  turn.emit({ type: 'system', subtype: 'status', status: 'requesting' });
  turn.emit(resultMessage('answered uncompacted', 'native-1'));
  assert.equal(await first, true);
  assert.equal(compactionEntries(stub).length, 2);
  turn.endInput();
  await settled(runner);
});

test('a compaction before the delivered message\'s turn shows on the waiting row', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  // Resumed against a smaller window: the CLI compacts before it answers.
  turn.emit(compactingStatusMessage());
  await waitFor(() => compactionEntries(stub).length === 1, { label: 'pending on the waiting row' });
  assert.deepEqual(compactionEntries(stub), [{ messageId: 'q-1', state: 'pending', text: 'Compacting context…' }]);

  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(compactSuccess);
  turn.emit(assistantText('the answer'));
  turn.emit(resultMessage('the answer', 'native-1'));
  assert.equal(await first, true);
  assert.deepEqual(compactionEntries(stub, 'q-1').map((entry) => entry.state), ['pending', 'boundary']);
  assert.equal(responseFor(stub, 'q-1').body.text, 'the answer');
  turn.endInput();
  await settled(runner);
});

test('a compaction shown on a waiting row is cancelled there when its boundary goes to the CLI\'s own turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const { done: first } = await startLiveTurn(runner, turn);
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  // The CLI opens a turn of its own, and a message is delivered before that
  // turn has produced anything: its row waits.
  turn.emit(initMessage('native-1'));
  await tick(20);
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second' } });
  await waitFor(() => runner._getProcess()?.pendingDelivered.length === 1, { label: 'q-2 waits' });

  // The compaction of the CLI's own turn has no row yet, so it shows on the
  // waiting one.
  turn.emit(compactingStatusMessage());
  await waitFor(() => compactionEntries(stub).length === 1, { label: 'pending on the waiting row' });
  assert.deepEqual(compactionEntries(stub), [{ messageId: 'q-2', state: 'pending', text: 'Compacting context…' }]);

  // The boundary lands on the row of the turn the CLI opened, and the
  // waiting row stops showing a running compaction.
  turn.emit(compactBoundaryMessage({ preTokens: 500000 }));
  turn.emit(compactSuccess);
  turn.emit(assistantText('the follow-up'));
  await waitFor(() => compactionEntries(stub).length === 3, { label: 'cancel and boundary' });
  const ownTurn = runner._getProcess().activeCtx;
  assert.equal(ownTurn.kind, 'continuation');
  const ownRowId = ownTurn.message.id;
  assert.notEqual(ownRowId, 'q-2');
  assert.deepEqual(compactionEntries(stub, 'q-2').map((entry) => entry.state), ['pending', 'cancelled']);
  assert.deepEqual(compactionEntries(stub, ownRowId).map((entry) => entry.state), ['boundary']);
  turn.emit(resultMessage('the follow-up', 'native-1'));
  await waitFor(() => responseFor(stub, ownRowId), { label: 'the own turn settles' });

  // The waiting message's own turn: no compaction entry of its own.
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('second'));
  turn.emit(assistantText('answer two'));
  turn.emit(resultMessage('answer two', 'native-1'));
  assert.equal(await second, true);
  assert.equal(responseFor(stub, 'q-2').body.text, 'answer two');
  assert.deepEqual(compactionEntries(stub, 'q-2').map((entry) => entry.state), ['pending', 'cancelled']);
  assert.deepEqual(compactionEntries(stub).map((entry) => entry.state), ['pending', 'cancelled', 'boundary']);
  turn.endInput();
  await settled(runner);
});

test('a compaction with no row to show it on publishes no pending entry', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const { done: first } = await startLiveTurn(runner, turn);
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  turn.emit(compactingStatusMessage());
  await tick(20);
  turn.emit(compactFailed);
  await tick(20);
  assert.deepEqual(compactionEntries(stub), []);
  turn.endInput();
  await settled(runner);
});

test('a compaction its process dies in is cancelled before the row settles', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const { done: first } = await startLiveTurn(runner, turn);

  turn.emit(compactingStatusMessage());
  await waitFor(() => compactionEntries(stub).length === 1, { label: 'pending entry' });
  turn.endInput();
  assert.equal(await first, true);
  await settled(runner);
  assert.deepEqual(compactionEntries(stub).map((entry) => entry.state), ['pending', 'cancelled']);
  const cancelledAt = stub.calls.findIndex((call) => call.body?.metadata?.state === 'cancelled');
  // A stream that ends without a result hands the row back (requeue).
  const settledAt = stub.calls.findIndex((call) => ['/api/response', '/api/requeue'].includes(call.routePath));
  assert.ok(settledAt > 0 && cancelledAt < settledAt, 'the cancel lands while the row is still open');
});

test('a compaction past the staleness cap is cancelled', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, compactionStaleMs: 40, lifecyclePollMs: 10 });
  const { done: first } = await startLiveTurn(runner, turn);

  turn.emit(compactingStatusMessage());
  await waitFor(() => compactionEntries(stub).some((entry) => entry.state === 'cancelled'), { label: 'stale cancel' });
  assert.deepEqual(compactionEntries(stub).map((entry) => entry.state), ['pending', 'cancelled']);
  // A boundary that still turns up later is the line's final state.
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);
  assert.deepEqual(compactionEntries(stub).map((entry) => entry.state), ['pending', 'cancelled', 'boundary']);
  turn.endInput();
  await settled(runner);
});

// ---------------------------------------------------------------------------
// The compaction window: spawn-only, applied by a respawn when idle

/** Every spawn gets its own scripted CLI; `params` records what it got. */
function spawningStart({ failOn = new Set() } = {}) {
  const spawns = [];
  const startImpl = (params) => {
    if (failOn.has(spawns.length)) {
      spawns.push({ params, turn: null });
      throw new Error('claude CLI failed to start');
    }
    const turn = scriptedTurn();
    turn.flagCalls = [];
    turn.applyFlagSettings = async (settings) => { turn.flagCalls.push(settings); };
    spawns.push({ params, turn });
    return turn;
  };
  return { spawns, startImpl };
}

const totalPushes = (spawns) => spawns.reduce((sum, spawn) => sum + (spawn.turn?.pushed.length || 0), 0);

/**
 * One full delivered turn. `index` picks the CLI that answers it (-1: the
 * newest, i.e. the one this delivery may have spawned).
 */
async function answerTurn(runner, spawns, message, { index = -1, init = false } = {}) {
  const before = totalPushes(spawns);
  const done = runner.handlePendingPayload({ message });
  await waitFor(() => totalPushes(spawns) > before, { label: `${message.id} pushed` });
  const { turn } = spawns[index === -1 ? spawns.length - 1 : index];
  if (init) turn.emit(initMessage('native-1'));
  turn.emit(userReplay(message.text));
  turn.emit(resultMessage(`answer to ${message.id}`, 'native-1'));
  assert.equal(await done, true);
}

test('an unchanged window keeps the process, and nothing is sent to it live', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, getAutoCompactWindow: () => 150000 });

  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });
  assert.equal(spawns[0].params.autoCompactWindow, 150000, 'the spawn carries the window');
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-2', text: 'again' }, { index: 0 });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].turn.flagCalls, []);
  assert.deepEqual(respawnNotes(stub), []);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a changed window respawns the idle process on the same session, with a note', async () => {
  // The native id never reached the relay (persist failing): the respawn
  // still resumes the session the released process ran.
  const stub = makeApiStub({ failRoutes: new Set(['/api/claude-native-session']) });
  const { spawns, startImpl } = spawningStart();
  let deliveredWindow = 150000;
  const runner = makeRunner({ stub, startImpl, getAutoCompactWindow: () => deliveredWindow });

  await answerTurn(runner, spawns, { ...baseMessage, claudeNativeSessionId: null }, { init: true });

  deliveredWindow = 500000;
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-2', text: 'second', claudeNativeSessionId: null }, { init: true, index: -1 });
  assert.equal(spawns.length, 2, 'one respawn');
  assert.equal(spawns[0].turn.endInputCalls > 0, true, 'the old CLI was released');
  assert.deepEqual(spawns[0].turn.flagCalls, [], 'never applied live');
  assert.equal(spawns[1].params.autoCompactWindow, 500000);
  assert.equal(spawns[1].params.resume, 'native-1');
  assert.equal(spawns[1].turn.pushed.length, 1, 'the message runs on the new CLI');
  assert.deepEqual(respawnNotes(stub), [{
    messageId: 'q-2',
    text: 'Restarted the session to apply the compaction window (150k → 500k)',
    metadata: { kind: 'compact_window_respawn', from: 150000, to: 500000 },
  }]);
  // The note precedes the cold-start line on the row.
  const rowLines = stub.calls
    .filter((call) => call.routePath === '/api/activity' && call.body.messageId === 'q-2')
    .map((call) => call.body.text);
  assert.match(rowLines[0], /^Restarted the session/);
  assert.match(rowLines[1], /resuming the session transcript/);

  // Back to Auto: a respawn too, and the spawn carries no window.
  deliveredWindow = null;
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-3', text: 'third', claudeNativeSessionId: null }, { init: true, index: -1 });
  assert.equal(spawns.length, 3);
  assert.equal(spawns[2].params.autoCompactWindow, null);
  assert.equal(respawnNotes(stub)[1].text, 'Restarted the session to apply the compaction window (500k → Auto)');
  assert.deepEqual(respawnNotes(stub)[1].metadata, { kind: 'compact_window_respawn', from: 500000, to: null });
  spawns[2].turn.endInput();
  await settled(runner);
});

test('a steered message never respawns the process', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  let deliveredWindow = 150000;
  const runner = makeRunner({ stub, startImpl, getAutoCompactWindow: () => deliveredWindow, steeredFoldGraceMs: 30, lifecyclePollMs: 10 });
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  await waitFor(() => spawns[0]?.turn.pushed.length, { label: 'q-1 pushed' });
  spawns[0].turn.emit(initMessage('native-1'));
  spawns[0].turn.emit(userReplay('hello'));
  spawns[0].turn.emit(assistantText('working'));
  await waitFor(() => runner.canAcceptSteering(), { label: 'q-1 turn is live' });

  deliveredWindow = 500000;
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'steer' } });
  await waitFor(() => spawns[0].turn.pushed.length === 2, { label: 'steered in' });
  spawns[0].turn.emit(resultMessage('both', 'native-1'));
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(spawns.length, 1);
  assert.deepEqual(respawnNotes(stub), []);
  assert.equal(runner._getProcess().autoCompactWindow, 150000, 'still the spawn-time window');
  spawns[0].turn.endInput();
  await settled(runner);
});

test('background work keeps the old process; the next turn-opening delivery applies the window', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  let deliveredWindow = 150000;
  const runner = makeRunner({
    stub, startImpl, getAutoCompactWindow: () => deliveredWindow, notificationGraceMs: 30, lifecyclePollMs: 10,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  await waitFor(() => spawns[0]?.turn.pushed.length, { label: 'q-1 pushed' });
  const { turn } = spawns[0];
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'test suite' }]));
  turn.emit(resultMessage('started the suite', 'native-1'));
  assert.equal(await first, true);

  deliveredWindow = 500000;
  assert.deepEqual(runner.steeringState().autoCompactWindow, { active: 150000, backgroundWork: true });
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-2', text: 'meanwhile' }, { index: 0 });
  assert.equal(spawns.length, 1, 'blocked by the background shell');
  assert.deepEqual(respawnNotes(stub), []);

  // The shell finishes; once its continuation window has passed, the next
  // turn-opening delivery takes the respawn.
  turn.emit(backgroundTasksMessage([]));
  await tick(60);
  assert.deepEqual(runner.steeringState().autoCompactWindow, { active: 150000, backgroundWork: false });
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-3', text: 'later' }, { init: true, index: -1 });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].params.autoCompactWindow, 500000);
  assert.deepEqual(respawnNotes(stub).map((note) => note.messageId), ['q-3']);
  assert.deepEqual(runner.steeringState().autoCompactWindow, { active: 500000, backgroundWork: false });
  spawns[1].turn.endInput();
  await settled(runner);
});

test('an open question blocks the respawn', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  let deliveredWindow = 150000;
  // Against a relay without the hand-back, a held delivery is pushed the
  // legacy way, so the window decision itself is what runs here.
  const runner = makeRunner({
    stub, startImpl, getAutoCompactWindow: () => deliveredWindow, canHandBackHeldDelivery: () => false,
  });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });

  deliveredWindow = 500000;
  runner._getProcess().pendingControlRequests += 1;
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-2', text: 'while asked' }, { index: 0 });
  runner._getProcess().pendingControlRequests -= 1;
  assert.equal(spawns.length, 1);
  assert.deepEqual(respawnNotes(stub), []);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a running compaction blocks the respawn', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  let deliveredWindow = 150000;
  const runner = makeRunner({
    stub, startImpl, getAutoCompactWindow: () => deliveredWindow, canHandBackHeldDelivery: () => false,
  });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });

  deliveredWindow = 500000;
  spawns[0].turn.emit(compactingStatusMessage());
  await waitFor(() => runner._getProcess().compactingSince, { label: 'compacting' });
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-2', text: 'while compacting' }, { index: 0 });
  assert.equal(spawns.length, 1);
  assert.deepEqual(respawnNotes(stub), []);
  spawns[0].turn.endInput();
  await settled(runner);
});

test('a delivery joining a respawn in flight does not respawn again', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  let deliveredWindow = 150000;
  const runner = makeRunner({
    stub, startImpl, getAutoCompactWindow: () => deliveredWindow, canHandBackHeldDelivery: () => false,
  });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });

  deliveredWindow = 500000;
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second' } });
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'third' } });
  await waitFor(() => spawns[1]?.turn.pushed.length === 2, { label: 'both pushed into the new CLI' });
  const { turn } = spawns[1];
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('second'));
  turn.emit(resultMessage('answer two', 'native-1'));
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('third'));
  turn.emit(resultMessage('answer three', 'native-1'));
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(spawns.length, 2);
  assert.deepEqual(respawnNotes(stub).map((note) => note.messageId), ['q-2']);
  assert.equal(responseFor(stub, 'q-3').body.text, 'answer three');
  turn.endInput();
  await settled(runner);
});

test('a respawn whose new CLI fails to start fails the message once, without a loop', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart({ failOn: new Set([1]) });
  let deliveredWindow = 150000;
  const runner = makeRunner({ stub, startImpl, getAutoCompactWindow: () => deliveredWindow });
  await answerTurn(runner, spawns, { ...baseMessage }, { init: true });

  deliveredWindow = 500000;
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second' } }), true);
  assert.equal(spawns.length, 2, 'one attempt, no retry loop');
  const failure = responseFor(stub, 'q-2');
  assert.equal(failure.body.terminalError.kind, 'claude-turn-failed');
  assert.match(failure.body.text, /failed to start/);
  assert.deepEqual(respawnNotes(stub), [], 'no note for a process that never started');
  assert.equal(runner._getProcess(), null);

  // The next message cold-starts with the new window; nothing is owed a respawn.
  await answerTurn(runner, spawns, { ...baseMessage, id: 'q-3', text: 'third' }, { init: true, index: -1 });
  assert.equal(spawns.length, 3);
  assert.equal(spawns[2].params.autoCompactWindow, 500000);
  assert.deepEqual(respawnNotes(stub), []);
  spawns[2].turn.endInput();
  await settled(runner);
});
