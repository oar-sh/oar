import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrokSteeringState } from './grok-worker-steering.mjs';
import { createGrokTurnRunner } from './grok-turn-runner.mjs';
import { createGrokTaskPublisher } from './grok-background-tasks.mjs';

// A turn runner as the heartbeat sees it: the reads the snapshot takes.
function fakeRunner({ attempt = null, turnActive = false, openTerminals = 0, liveIds = [] } = {}) {
  return {
    getActiveQueueAttempt: () => attempt,
    isTurnActive: () => turnActive,
    openTerminalCount: () => openTerminals,
    backgroundTaskIds: () => liveIds,
  };
}

test('an idle Grok worker is releasable and offers no steering', () => {
  assert.deepEqual(buildGrokSteeringState(fakeRunner()), {
    turnActive: false,
    canSteer: false,
    holdReason: null,
    messageId: null,
    supported: false,
    cancellableIds: [],
    releasable: true,
    releaseHold: null,
    backgroundTaskCount: 0,
  });
});

test('an active attempt holds the release as a turn, ahead of open terminals', () => {
  const state = buildGrokSteeringState(fakeRunner({ attempt: { id: 'q-3', attemptId: 'a-1' }, turnActive: true, openTerminals: 1 }));
  assert.equal(state.messageId, 'q-3');
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'turn');
  assert.equal(state.backgroundTaskCount, 1);
});

test('an open terminal holds the release between turns, before it is a panel row', () => {
  const state = buildGrokSteeringState(fakeRunner({ openTerminals: 2, liveIds: [] }));
  assert.equal(state.turnActive, false);
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'background');
  assert.equal(state.backgroundTaskCount, 2);
});

test('a runner without the open count still holds the release on its live ids', () => {
  const runner = fakeRunner({ liveIds: ['t-1'] });
  delete runner.openTerminalCount;
  const state = buildGrokSteeringState(runner);
  assert.equal(state.releaseHold, 'background');
  assert.equal(state.backgroundTaskCount, 1);
});

test('through the real runner and publisher: a terminal inside its publish grace holds the release', async (t) => {
  const publisher = createGrokTaskPublisher({
    api: async () => ({ ok: true }),
    sdkSessionId: 'conv-grok',
    // No spool: the count needs none, and no file is written.
    spool: { sweep() {}, pathFor: () => '', append: () => ({ ok: true }), end() {} },
    publishAfterMs: 60_000,
  });
  t.after(() => publisher.close());
  const runner = createGrokTurnRunner({ api: async () => ({ ok: true }), sdkSessionId: 'conv-grok', taskPublisher: publisher, oarMcpServer: null });
  assert.equal(buildGrokSteeringState(runner).releasable, true);

  await publisher.started({ terminalId: 'term-1', command: 'sleep 600' });
  assert.deepEqual(runner.backgroundTaskIds(), [], 'not a panel row yet');
  const held = buildGrokSteeringState(runner);
  assert.equal(held.releasable, false);
  assert.equal(held.releaseHold, 'background');
  assert.equal(held.backgroundTaskCount, 1);

  await publisher.released('term-1');
  assert.equal(buildGrokSteeringState(runner).releasable, true);
});
