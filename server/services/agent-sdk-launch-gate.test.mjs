// The launch gate of the agent SDKs: a missing SDK never holds up a launch.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_SDK_INSTALLING, createAgentSdkLaunchGate, staleWorkerLosesAgentSdk } from './agent-sdk-launch-gate.mjs';
import { createPendingWorkerPrimer } from './queue-waker.mjs';
import { agentSdkForWorkerKind } from './session-worker-launch-service.mjs';
import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A store whose install the test ends by hand.
function fakeStore() {
  const statuses = { claude: { state: 'missing', label: 'Claude Agent SDK' }, cursor: { state: 'missing', label: 'Cursor SDK' } };
  const installs = [];
  const dirs = {};
  return {
    statuses,
    installs,
    dirs,
    status: (sdk) => statuses[sdk] || null,
    getDescriptor: (sdk) => ({ label: statuses[sdk]?.label || sdk }),
    ensure(sdk) {
      statuses[sdk] = { ...statuses[sdk], state: 'installing', active: true };
      return new Promise((resolve) => {
        installs.push({
          sdk,
          finish: (state, extra = {}) => {
            statuses[sdk] = { ...statuses[sdk], state, active: false, ...extra };
            if (state === 'ready') dirs[sdk] = `/sdks/${sdk}/1.0.0-0a1b2c3d`;
            resolve(statuses[sdk]);
          },
        });
      });
    },
  };
}

function harness(overrides = {}) {
  const store = fakeStore();
  const notes = [];
  const released = [];
  const gate = createAgentSdkLaunchGate({
    store,
    sdkForWorkerKind: agentSdkForWorkerKind,
    resolveSource: (sdk) => (overrides.checkout ? { source: 'checkout', dir: null } : (store.dirs[sdk] ? { source: 'store', dir: store.dirs[sdk] } : null)),
    noteInstalling: (sid, info) => notes.push({ sid, ...info }),
    onSessionsReleased: (event) => released.push(event),
    logger: { log() {} },
  });
  return { store, notes, released, gate };
}

test('a missing SDK: the launch is deferred at once, the install started once and joined, a note per session', async () => {
  const { store, notes, released, gate } = harness();
  assert.deepEqual(gate.check('sess-a', 'claude'), { sdk: 'claude', deferred: AGENT_SDK_INSTALLING });
  assert.deepEqual(gate.check('sess-b', 'deepseek'), { sdk: 'claude', deferred: AGENT_SDK_INSTALLING });
  assert.equal(store.installs.length, 1, 'one install for both');
  assert.deepEqual(notes.map((n) => [n.sid, n.label]), [['sess-a', 'Claude Agent SDK'], ['sess-b', 'Claude Agent SDK']]);
  assert.deepEqual(gate.waitingSessions('claude').sort(), ['sess-a', 'sess-b']);

  store.installs[0].finish('ready');
  await flush();
  assert.equal(released.length, 1);
  assert.deepEqual(released[0].sessions.sort(), ['sess-a', 'sess-b']);
  assert.deepEqual(gate.waitingSessions('claude'), []);
  assert.deepEqual(gate.check('sess-a', 'claude'), { sdk: 'claude', dir: '/sdks/claude/1.0.0-0a1b2c3d' });
});

test('no SDK for the kind, or a checkout, launches without a folder', () => {
  const { gate, store } = harness();
  assert.deepEqual(gate.check('sess-a', 'copilot'), { sdk: null });
  assert.deepEqual(gate.check('sess-a', 'grok'), { sdk: null });
  assert.equal(store.installs.length, 0);
  assert.deepEqual(harness({ checkout: true }).gate.check('sess-a', 'cursor'), { sdk: null });
});

test('a failed install stops the launch with the Settings tab, and a Retry that works launches it', async () => {
  const { store, released, gate } = harness();
  gate.check('sess-a', 'cursor');
  store.installs[0].finish('error', { error: 'No connection to the npm registry.' });
  await flush();
  assert.equal(released.length, 1, 'the end of the install wakes the session: its launch now says why');
  assert.throws(() => gate.check('sess-a', 'cursor'), /Cursor SDK could not be installed: No connection to the npm registry\. \(Settings → Providers → Cursor\)/);
  store.statuses.cursor = { state: 'unsupported', label: 'Cursor SDK' };
  assert.throws(() => gate.check('sess-b', 'cursor'), /Cursor SDK is not available on this platform \(Settings → Providers → Cursor\)/);
  // The Retry button, or the store's own retry, brings it back.
  store.dirs.cursor = '/sdks/cursor/1.3.1-0a1b2c3d';
  assert.deepEqual(gate.onReady('cursor').sort(), ['sess-a', 'sess-b']);
  assert.equal(released.at(-1).reason, 'ready');
});

// The supervisor and the queue's prime with the gate inside the launch, as
// server-runtime wires them.
function wiredRelay() {
  const h = harness();
  const registry = createSessionWorkerRegistry();
  const kinds = { 'sess-claude': 'claude', 'sess-copilot': 'copilot', 'sess-cursor': 'cursor' };
  const spawned = [];
  let supervisor = null;
  supervisor = createSessionWorkerSupervisor({
    registry,
    restartBackoffBaseMs: 1,
    spawnWorker: async (sid) => {
      const gate = h.gate.check(sid, kinds[sid]);
      if (gate.deferred) return { deferred: gate.deferred };
      spawned.push({ sid, dir: gate.dir || null });
      return { workerId: `worker-${sid}`, pid: null };
    },
  });
  return { ...h, registry, supervisor, spawned, kinds };
}

test('the queue prime launches a Copilot session while a Claude session waits for its install', async () => {
  const relay = wiredRelay();
  const prime = createPendingWorkerPrimer({
    listPendingOwnerSessionIds: () => [{ sdk_session_id: 'sess-claude' }, { sdk_session_id: 'sess-copilot' }],
    ensureWorker: (sid) => relay.supervisor.ensureWorker(sid),
  });
  assert.equal(await prime('test'), 2);
  assert.deepEqual(relay.spawned.map((s) => s.sid), ['sess-copilot'], 'the install never resolved, and Copilot launched anyway');
  assert.equal(relay.supervisor.getWorkerState('sess-claude').status, 'new', 'no worker, none starting');
});

test('a deferred launch is no failure: no backoff, no second worker, and the install\'s end launches it', async () => {
  const relay = wiredRelay();
  const first = await relay.supervisor.ensureWorker('sess-claude');
  assert.equal(first.ok, true);
  assert.equal(first.deferred, AGENT_SDK_INSTALLING);
  assert.equal(first.lifecycle.retryCount || 0, 0, 'not counted toward the restart backoff');
  assert.equal(relay.supervisor.canAttemptRestart('sess-claude').allowed, true);
  // Asked again while it installs (a send, the prime): deferred again, never spawned.
  const again = await relay.supervisor.ensureWorker('sess-claude');
  assert.equal(again.deferred, AGENT_SDK_INSTALLING);
  assert.equal(relay.spawned.length, 0);
  assert.equal(relay.store.installs.length, 1);

  // The relay's onSessionsReleased clears the schedule and wakes the queue;
  // the queue's prime asks for the worker again.
  relay.store.installs[0].finish('ready');
  await flush();
  assert.deepEqual(relay.released[0].sessions, ['sess-claude']);
  const launched = await relay.supervisor.ensureWorker('sess-claude');
  assert.equal(launched.ok, true);
  assert.equal(launched.deferred, undefined);
  assert.deepEqual(relay.spawned, [{ sid: 'sess-claude', dir: '/sdks/claude/1.0.0-0a1b2c3d' }]);
});

test('a session whose launch gave up on a failed install launches once the SDK comes back', async () => {
  const relay = wiredRelay();
  await relay.supervisor.ensureWorker('sess-cursor');
  relay.store.installs[0].finish('error', { error: 'npm error code ENOTFOUND' });
  await flush();
  const failed = await relay.supervisor.ensureWorker('sess-cursor');
  assert.equal(failed.ok, false, 'the failure is a launch failure with its cause');
  assert.match(relay.supervisor.getWorkerState('sess-cursor').lastError, /Cursor SDK could not be installed/);
  // The store's automatic retry (or the Retry button) succeeds later.
  relay.store.dirs.cursor = '/sdks/cursor/1.3.1-0a1b2c3d';
  for (const sid of relay.gate.onReady('cursor')) relay.supervisor.clearRestartSchedule(sid);
  const launched = await relay.supervisor.ensureWorker('sess-cursor');
  assert.equal(launched.ok, true);
  assert.deepEqual(relay.spawned, [{ sid: 'sess-cursor', dir: '/sdks/cursor/1.3.1-0a1b2c3d' }]);
});

test('a stale worker loses its SDK files on an update only where the store installs the SDK', () => {
  const store = { sdkForWorkerKind: agentSdkForWorkerKind, fromCheckout: () => false };
  const checkout = { sdkForWorkerKind: agentSdkForWorkerKind, fromCheckout: () => true };
  for (const kind of ['claude', 'claude-api', 'deepseek', 'cursor']) {
    assert.equal(staleWorkerLosesAgentSdk(kind, store), true, `${kind} on the store: the fast recycle`);
    assert.equal(staleWorkerLosesAgentSdk(kind, checkout), false, `${kind} in a checkout: the usual holds`);
  }
  assert.equal(staleWorkerLosesAgentSdk('copilot', store), false);
  // Per SDK: a checkout without Cursor's package takes it from the store.
  const mixed = { sdkForWorkerKind: agentSdkForWorkerKind, fromCheckout: (sdk) => sdk === 'claude' };
  assert.equal(staleWorkerLosesAgentSdk('deepseek', mixed), false);
  assert.equal(staleWorkerLosesAgentSdk('cursor', mixed), true);
});
