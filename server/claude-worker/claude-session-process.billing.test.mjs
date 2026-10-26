import test from 'node:test';
import assert from 'node:assert/strict';

import {
  waitFor,
  makeApiStub,
  scriptedTurn,
  resultMessage,
  assistantText,
  baseMessage,
  makeRunner,
  settled,
} from './claude-session-test-harness.mjs';
import { createClaudeApiClaudeBackend } from '../claude-api-worker/claude-api-backend.mjs';

// The worker's side of the Claude billing switch: it states its kind, runs
// only rows of its billing (a row of the other one goes back to the queue),
// tells the relay when it may be replaced, and says once that it is the
// worker a swap brought up.

const backend = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: 'test-claude-api-key' } });

function spawningStart() {
  const spawns = [];
  const startImpl = (params) => {
    const turn = scriptedTurn();
    turn.applyFlagSettings = async () => {};
    turn.setModel = async () => {};
    spawns.push({ params, turn });
    return turn;
  };
  return { spawns, startImpl };
}

const pushedReplay = (content) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } });
const routeCalls = (stub, routePath) => stub.calls.filter((call) => call.routePath === routePath);

test('the worker states its kind: claude on the login, the backend\'s provider otherwise', () => {
  const stub = makeApiStub();
  assert.equal(makeRunner({ stub, startImpl: () => scriptedTurn() }).workerKind, 'claude');
  assert.equal(makeRunner({ stub, startImpl: () => scriptedTurn(), backend }).workerKind, 'claude-api');
});

test('a row of the other billing goes back to the queue, unrun, in both directions', async () => {
  for (const [withBackend, billing] of [[false, 'claude-api'], [true, 'claude']]) {
    const stub = makeApiStub();
    const { spawns, startImpl } = spawningStart();
    const runner = makeRunner({ stub, startImpl, ...(withBackend ? { backend } : {}) });
    const ran = await runner.handlePendingPayload({ message: { ...baseMessage, attemptId: 'attempt-1', billing } });
    assert.equal(ran, false);
    assert.equal(spawns.length, 0, 'no CLI for a row of the other billing');
    const requeues = routeCalls(stub, '/api/requeue');
    assert.equal(requeues.length, 1);
    assert.equal(requeues[0].body.class, 'kind-mismatch');
    assert.equal(requeues[0].body.messageId, 'q-1');
    assert.equal(requeues[0].body.attemptId, 'attempt-1');
  }
});

test('a row of its own billing, or of no Claude billing named, runs', async () => {
  for (const message of [{ ...baseMessage, billing: 'claude' }, { ...baseMessage, providerType: 'claude' }, { ...baseMessage }]) {
    const stub = makeApiStub();
    const { spawns, startImpl } = spawningStart();
    const runner = makeRunner({ stub, startImpl });
    const done = runner.handlePendingPayload({ message });
    await waitFor(() => spawns.length > 0 && spawns[0].turn.pushed.length > 0, { label: 'pushed' });
    const { turn } = spawns[0];
    turn.emit(pushedReplay(turn.pushed[0]));
    turn.emit(assistantText('ok'));
    turn.emit(resultMessage('ok', 'native-1'));
    assert.equal(await done, true);
    assert.deepEqual(routeCalls(stub, '/api/requeue'), []);
    turn.endInput();
    await settled(runner);
  }
});

test('releasable: yes with no CLI, no while a turn runs, yes again once it ended', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl });
  const idle = runner.steeringState();
  assert.equal(idle.releasable, true);
  assert.equal(idle.releaseHold, null);
  const done = runner.handlePendingPayload({ message: { ...baseMessage } });
  await waitFor(() => spawns.length > 0 && spawns[0].turn.pushed.length > 0, { label: 'pushed' });
  const busy = runner.steeringState();
  assert.equal(busy.releasable, false);
  assert.equal(busy.releaseHold, 'turn');
  const { turn } = spawns[0];
  turn.emit(pushedReplay(turn.pushed[0]));
  turn.emit(assistantText('ok'));
  turn.emit(resultMessage('ok', 'native-1'));
  assert.equal(await done, true);
  await waitFor(() => runner.steeringState().releasable === true, { label: 'releasable after the turn' });
  assert.equal(runner.steeringState().backgroundTaskCount, 0);
  turn.endInput();
  await settled(runner);
});

test('the first row after a swap notes it in the turn, once', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  const runner = makeRunner({ stub, startImpl, backend });
  const settings = { billingSwap: { from: 'claude', to: 'claude-api' } };
  for (const id of ['q-1', 'q-2']) {
    const before = spawns.reduce((sum, spawn) => sum + spawn.turn.pushed.length, 0);
    const done = runner.handlePendingPayload({ message: { ...baseMessage, id, billing: 'claude-api' }, settings });
    await waitFor(() => spawns.reduce((sum, spawn) => sum + spawn.turn.pushed.length, 0) > before, { label: `${id} pushed` });
    const { turn } = spawns[spawns.length - 1];
    if (id === 'q-1') turn.emit({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-sonnet-5', apiKeySource: 'ANTHROPIC_API_KEY' });
    turn.emit(pushedReplay(turn.pushed[turn.pushed.length - 1]));
    turn.emit(assistantText('ok'));
    turn.emit(resultMessage('ok', 'native-1'));
    assert.equal(await done, true);
  }
  const notes = routeCalls(stub, '/api/activity').filter((call) => call.body?.metadata?.kind === 'billing_switch_respawn');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body.messageId, 'q-1');
  assert.match(notes[0].body.text || notes[0].body.activity || JSON.stringify(notes[0].body), /Restarted the session on the Claude API key \(billing switch\)/);
  assert.deepEqual({ from: notes[0].body.metadata.from, to: notes[0].body.metadata.to }, { from: 'claude', to: 'claude-api' });
  spawns[spawns.length - 1].turn.endInput();
  await settled(runner);
});

test('a subscription turn that comes up on an API key is stopped, with its own note', async () => {
  for (const apiKeySource of ['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key']) {
    const stub = makeApiStub();
    const { spawns, startImpl } = spawningStart();
    const runner = makeRunner({ stub, startImpl });
    const done = runner.handlePendingPayload({ message: { ...baseMessage, billing: 'claude' } });
    await waitFor(() => spawns.length > 0 && spawns[0].turn.pushed.length > 0, { label: 'pushed' });
    spawns[0].turn.emit({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-sonnet-5', apiKeySource });
    await done;
    await waitFor(() => routeCalls(stub, '/api/response').length > 0, { label: 'the turn ended' });
    const [response] = routeCalls(stub, '/api/response');
    const failure = response.body.terminalError;
    assert.equal(failure.code, 'subscription-key-source', apiKeySource);
    assert.equal(failure.stableCode, 'claude.subscription-key-source');
    assert.match(failure.message, new RegExp(`source "${apiKeySource.replace(/[/]/g, '\\/')}"`));
    assert.match(failure.guidance, /apiKeyHelper/);
    // Never the sign-in advice.
    assert.doesNotMatch(response.body.text, /Relogin/);
    await settled(runner);
  }
});

test('a subscription turn on the login (or a source the relay does not know) goes on', async () => {
  for (const apiKeySource of ['none', 'oauth', 'something-new', undefined]) {
    const stub = makeApiStub();
    const { spawns, startImpl } = spawningStart();
    const runner = makeRunner({ stub, startImpl });
    const done = runner.handlePendingPayload({ message: { ...baseMessage } });
    await waitFor(() => spawns.length > 0 && spawns[0].turn.pushed.length > 0, { label: 'pushed' });
    const { turn } = spawns[0];
    turn.emit({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-sonnet-5', ...(apiKeySource ? { apiKeySource } : {}) });
    turn.emit(pushedReplay(turn.pushed[0]));
    turn.emit(assistantText('ok'));
    turn.emit(resultMessage('ok', 'native-1'));
    assert.equal(await done, true, String(apiKeySource));
    assert.equal(routeCalls(stub, '/api/response')[0].body.terminalError, undefined);
    turn.endInput();
    await settled(runner);
  }
});

test('not releasable while a delivered message waits for its cold spawn (no CLI yet)', async () => {
  const stub = makeApiStub();
  const { spawns, startImpl } = spawningStart();
  let openGate = null;
  const gateReady = new Promise((resolve) => { openGate = resolve; });
  // The tool gate holds the cold spawn, as a slow first answer does.
  const remoteRelayToolGate = {
    refresh: async () => {},
    isSettled: () => false,
    ready: () => gateReady,
    isEnabled: () => false,
  };
  const runner = makeRunner({ stub, startImpl, remoteRelayToolGate });
  assert.equal(runner.steeringState().releasable, true);
  const done = runner.handlePendingPayload({ message: { ...baseMessage } });
  await waitFor(() => runner.steeringState().releasable === false, { label: 'held during the spawn' });
  assert.equal(spawns.length, 0, 'no CLI yet');
  assert.equal(runner.steeringState().releaseHold, 'turn');
  openGate();
  await waitFor(() => spawns.length > 0 && spawns[0].turn.pushed.length > 0, { label: 'pushed' });
  const { turn } = spawns[0];
  turn.emit(pushedReplay(turn.pushed[0]));
  turn.emit(assistantText('ok'));
  turn.emit(resultMessage('ok', 'native-1'));
  assert.equal(await done, true);
  turn.endInput();
  await settled(runner);
});
