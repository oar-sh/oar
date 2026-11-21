import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './session-worker-supervisor-service.mjs';
import { createProcessIdentityReader } from './session-worker-process-service.mjs';

test('supervisor waits for startup heartbeat when launched pid is unknown', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 1_000;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 1_000,
    spawnWorker: async () => ({ workerId: 'worker-abc123', pid: null }),
  });

  const ensureResult = await supervisor.ensureWorker('abc-123');
  assert.equal(ensureResult.ok, true);
  assert.equal(ensureResult.lifecycle?.awaitingHeartbeat, true);
  assert.equal(ensureResult.lifecycle?.degradedReason, null);

  nowMs += 500;
  const beforeTimeout = supervisor.getLifecycleState('abc-123');
  assert.equal(beforeTimeout?.degradedReason, null);

  nowMs += 600;
  const afterTimeout = supervisor.getLifecycleState('abc-123');
  assert.equal(afterTimeout?.degradedReason, 'startup-heartbeat-timeout');
  assert.equal(afterTimeout?.uiState, 'yellow');
});

test('ensureWorker can force a fresh process launch', async () => {
  const spawnOptions = [];
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'fresh-session',
    pid: process.pid,
    status: 'ready',
  });
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => true,
    spawnWorker: async (_sessionId, options) => {
      spawnOptions.push(options);
      return { workerId: 'worker-fresh', pid: 12345 };
    },
  });

  const result = await supervisor.ensureWorker('fresh-session', {
    allowProcessReuse: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.deepEqual(spawnOptions, [{ allowProcessReuse: false }]);
});

test('two concurrent ensureWorker calls spawn only once', async () => {
  // The CWD relaunch route relies on this dedupe: a duplicated request must not
  // produce a second process for the same session.
  const registry = createSessionWorkerRegistry();
  let spawnCalls = 0;
  let releaseSpawn;
  const spawnGate = new Promise((resolve) => { releaseSpawn = resolve; });
  const supervisor = createSessionWorkerSupervisor({
    registry,
    spawnWorker: async () => {
      spawnCalls += 1;
      await spawnGate;
      return { workerId: 'worker-dedupe', pid: 5150 };
    },
  });

  const first = supervisor.ensureWorker('dedupe-session');
  const second = supervisor.ensureWorker('dedupe-session');
  releaseSpawn();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(spawnCalls, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('a steering snapshot the new worker sends while it spawns survives the ready update', async () => {
  // The worker heartbeats as soon as it boots — before spawnWorker resolves —
  // and the ready update used to be built from the 'starting' copy of the
  // entry, whose empty snapshot overwrote the one just stored. The composer
  // then read "Queue" until the next change-bearing heartbeat.
  const registry = createSessionWorkerRegistry();
  const steering = { turnActive: false, canSteer: false, holdReason: null, messageId: null, supported: true, cancellableIds: [] };
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => true,
    spawnWorker: async (sessionId) => {
      // What the heartbeat route does for the new process: adopt its pid,
      // then store its snapshot.
      registry.upsertWorker({ ...registry.getWorker(sessionId), pid: 6060 });
      registry.upsertWorker({ ...registry.getWorker(sessionId), steering });
      return { workerId: 'worker-spawn-beat', pid: 6060 };
    },
  });

  const result = await supervisor.ensureWorker('spawn-beat');
  assert.equal(result.ok, true);
  assert.deepEqual(registry.getWorker('spawn-beat').steering, steering);
  assert.deepEqual(result.worker.steering, steering);

  // Later supervisor updates keep it too; only the registry's own rule (the
  // process gone or replaced) clears it.
  supervisor.markProcessing('spawn-beat', 1);
  supervisor.markIdle('spawn-beat', 0);
  assert.deepEqual(registry.getWorker('spawn-beat').steering, steering);
  supervisor.markError('spawn-beat', 'queue-failed:test');
  assert.equal(registry.getWorker('spawn-beat').steering, null);
});

test('the build id, kind and start time the new worker states while it spawns survive the ready update', async () => {
  // The worker's hello can land while the launcher still looks for its pid;
  // the ready update is built from the 'starting' copy, whose empty fields
  // used to overwrite what the hello had just stored until the next heartbeat.
  const registry = createSessionWorkerRegistry();
  let stated = null;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => true,
    spawnWorker: async (sessionId) => {
      // What the hello does for the new process: adopt its pid, then store
      // its kind and build id.
      registry.upsertWorker({ ...registry.getWorker(sessionId), pid: 6161 });
      stated = registry.upsertWorker({ ...registry.getWorker(sessionId), kind: 'copilot-sdk', buildId: '1.2.3+aaaaaaaaaaaa' });
      return { workerId: 'worker-spawn-hello', pid: 6161 };
    },
  });

  const result = await supervisor.ensureWorker('spawn-hello');
  assert.equal(result.ok, true);
  const worker = registry.getWorker('spawn-hello');
  assert.equal(worker.status, 'ready');
  assert.equal(worker.buildId, '1.2.3+aaaaaaaaaaaa');
  assert.equal(worker.kind, 'copilot-sdk');
  assert.ok(stated.startedAt);
  assert.equal(worker.startedAt, stated.startedAt);
});

test('supervisor marks stale pid when known launched pid is dead and work is pending', async () => {
  const registry = createSessionWorkerRegistry();
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => 2_000,
    heartbeatTimeoutMs: 5_000,
    isPidAlive: () => false,
    spawnWorker: async () => ({ workerId: 'worker-xyz789', pid: 98765 }),
  });

  const ensureResult = await supervisor.ensureWorker('xyz-789');
  assert.equal(ensureResult.ok, true);
  const status = supervisor.snapshot({
    pendingQuestionSessionIds: ['xyz-789'],
  });
  const lifecycle = status.lifecycle.find((entry) => entry.sdkSessionId === 'xyz-789');
  assert.equal(lifecycle?.degradedReason, 'stale-pid');
  assert.equal(lifecycle?.uiState, 'yellow');
  assert.equal(lifecycle?.stalePidDetected, true);
});

test('an idle worker whose process is gone is no longer listed, and the next message starts a new one', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 10_000;
  let alive = true;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 5_000,
    isPidAlive: () => alive,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-idle-${spawnCount}`, pid: 4100 + spawnCount };
    },
  });
  await supervisor.ensureWorker('idle-123');
  supervisor.noteSessionHeartbeat('idle-123', nowMs);
  assert.deepEqual(supervisor.snapshot().workers.map((worker) => [worker.status, worker.pid]), [['ready', 4101]]);

  // Killed from outside, right after a heartbeat: the heartbeat still counts.
  alive = false;
  nowMs += 1_000;
  assert.equal(supervisor.snapshot().workers.length, 1, 'a recent heartbeat outranks the pid');

  nowMs += 5_000;
  const status = supervisor.snapshot();
  assert.deepEqual(status.workers, [], 'not listed as ready with a pid that is gone');
  assert.equal(status.workerCount, 0);
  assert.equal(registry.getWorker('idle-123'), null);

  alive = true;
  const again = await supervisor.ensureWorker('idle-123');
  assert.equal(again.ok, true);
  assert.equal(spawnCount, 2);
  assert.equal(registry.getWorker('idle-123').pid, 4102);
});

test('a dead worker with open work stays listed for the stale-pid handling', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 10_000;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 5_000,
    isPidAlive: () => false,
    spawnWorker: async () => ({ workerId: 'worker-busy-1', pid: 4200 }),
  });
  await supervisor.ensureWorker('busy-123');
  supervisor.noteSessionHeartbeat('busy-123', nowMs);
  supervisor.markProcessing('busy-123', 1);
  nowMs += 60_000;
  assert.deepEqual(supervisor.snapshot().workers.map((worker) => worker.status), ['processing']);

  // Idle again, with a question card waiting on it.
  supervisor.markIdle('busy-123', 0);
  nowMs += 60_000;
  const waiting = supervisor.snapshot({ pendingQuestionSessionIds: ['busy-123'] });
  assert.equal(waiting.workers.length, 1);
  assert.equal(waiting.lifecycle.find((entry) => entry.sdkSessionId === 'busy-123')?.degradedReason, 'stale-pid');
});

test('supervisor does not reuse worker after startup heartbeat timeout', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 10_000;
  let spawnCount = 0;
  const spawnOptions = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    heartbeatTimeoutMs: 1_000,
    spawnWorker: async (_sessionId, options = {}) => {
      spawnCount += 1;
      spawnOptions.push(options);
      return { workerId: `worker-timeout-${spawnCount}`, pid: null };
    },
  });

  const first = await supervisor.ensureWorker('retry-timeout');
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(spawnCount, 1);

  nowMs += 1_500;
  const lifecycleAfterTimeout = supervisor.getLifecycleState('retry-timeout');
  assert.equal(lifecycleAfterTimeout?.degradedReason, 'startup-heartbeat-timeout');

  const second = await supervisor.ensureWorker('retry-timeout');
  assert.equal(second.ok, true);
  assert.equal(second.reused, false);
  assert.equal(spawnCount, 2);
  assert.equal(spawnOptions[0]?.allowProcessReuse, true);
  assert.equal(spawnOptions[1]?.allowProcessReuse, false);
});

test('markKilled blocks ensureWorker within grace period', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 5_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 10_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-killed-${spawnCount}`, pid: null };
    },
  });

  // Spawn the worker first
  const first = await supervisor.ensureWorker('killed-session');
  assert.equal(first.ok, true);
  assert.equal(spawnCount, 1);

  // Simulate kill: remove from registry, clear schedule, then mark killed
  registry.removeWorker('killed-session');
  supervisor.clearRestartSchedule('killed-session');
  supervisor.markKilled('killed-session');

  // ensureWorker should now be blocked
  const blocked = await supervisor.ensureWorker('killed-session');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.equal(spawnCount, 1, 'no new spawn should occur while kill-blocked');

  // Lifecycle should report killedAt
  const lifecycle = supervisor.getLifecycleState('killed-session');
  assert.ok(lifecycle?.killedAt, 'killedAt should be set');
});

test('markKilled block expires after grace period', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 5_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 10_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-expired-${spawnCount}`, pid: null };
    },
  });

  // Spawn first worker
  await supervisor.ensureWorker('grace-session');
  assert.equal(spawnCount, 1);

  // Kill the worker
  registry.removeWorker('grace-session');
  supervisor.clearRestartSchedule('grace-session');
  supervisor.markKilled('grace-session');

  // Still blocked inside grace window
  const stillBlocked = await supervisor.ensureWorker('grace-session');
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.error, 'session-killed');
  assert.equal(spawnCount, 1);

  // Advance past grace period
  nowMs += 11_000;

  // Should now allow respawn (grace expired)
  const respawned = await supervisor.ensureWorker('grace-session');
  assert.equal(respawned.ok, true);
  assert.equal(spawnCount, 2);
});

test('clearRestartSchedule preserves killedAtMs by default', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 3_000;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => ({ workerId: 'worker-preserve', pid: null }),
  });

  await supervisor.ensureWorker('preserve-session');
  registry.removeWorker('preserve-session');
  supervisor.markKilled('preserve-session');

  // clearRestartSchedule without resetKilledMarker should keep the kill block
  supervisor.clearRestartSchedule('preserve-session');
  const stillBlocked = await supervisor.ensureWorker('preserve-session');
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.error, 'session-killed');

  // clearRestartSchedule with resetKilledMarker:true should clear it
  supervisor.clearRestartSchedule('preserve-session', { resetKilledMarker: true });
  let spawnCount = 0;
  // Need a fresh supervisor with spawn to verify it can spawn
  const registry2 = createSessionWorkerRegistry();
  const supervisor2 = createSessionWorkerSupervisor({
    registry: registry2,
    now: () => nowMs,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: 'worker-reset', pid: null };
    },
  });
  supervisor2.markKilled('reset-session');
  supervisor2.clearRestartSchedule('reset-session', { resetKilledMarker: true });
  const unblocked = await supervisor2.ensureWorker('reset-session');
  assert.equal(unblocked.ok, true);
  assert.equal(spawnCount, 1);
});

test('markKilled prevents respawn even when registry entry is re-inserted with no identity', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 7_000;
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCount += 1;
      return { workerId: `worker-reinsert-${spawnCount}`, pid: null };
    },
  });

  // Spawn first worker
  await supervisor.ensureWorker('reinsert-session');
  assert.equal(spawnCount, 1);

  // Simulate kill sequence
  registry.removeWorker('reinsert-session');
  supervisor.clearRestartSchedule('reinsert-session');
  supervisor.markKilled('reinsert-session');

  // Simulate the heartbeat route re-inserting the worker WITHOUT workerId
  // (the exact bug that triggered the respawn: no workerId means shouldReuseLiveWorker=false)
  registry.upsertWorker({
    sdkSessionId: 'reinsert-session',
    status: 'ready',
    workerId: null,
    pid: null,
  });

  // ensureWorker must still be blocked despite the re-insertion
  const blocked = await supervisor.ensureWorker('reinsert-session');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.equal(spawnCount, 1, 'kill block must win over identity-less re-insertion');
});

test('cancelPendingStart prevents in-flight spawn from becoming ready', async () => {
  const registry = createSessionWorkerRegistry();
  let resolveSpawn = null;
  const spawnGate = new Promise((resolve) => {
    resolveSpawn = resolve;
  });
  let spawnCount = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCount += 1;
      await spawnGate;
      return { workerId: `worker-cancelled-${spawnCount}`, pid: null };
    },
  });

  const pendingEnsure = supervisor.ensureWorker('cancel-in-flight');
  supervisor.markKilled('cancel-in-flight');
  const cancelResult = await supervisor.cancelPendingStart('cancel-in-flight');
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.hadPending, true);
  resolveSpawn();

  const blocked = await pendingEnsure;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.ok(spawnCount <= 1, 'spawn should not continue past cancellation');
  assert.notEqual(supervisor.getWorkerState('cancel-in-flight')?.status, 'ready');
});

test('ensureWorker re-checks kill block before spawn begins', async () => {
  const registry = createSessionWorkerRegistry();
  let spawnCalled = false;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    killBlockGraceMs: 30_000,
    spawnWorker: async () => {
      spawnCalled = true;
      return { workerId: 'worker-should-not-spawn', pid: null };
    },
  });

  const pendingEnsure = supervisor.ensureWorker('kill-before-start');
  supervisor.markKilled('kill-before-start');
  await supervisor.cancelPendingStart('kill-before-start');
  const blocked = await pendingEnsure;

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'session-killed');
  assert.equal(spawnCalled, false);
});

test('default startup timeout outlasts a slow Copilot CLI boot', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 1_000;
  // No heartbeatTimeoutMs override: this asserts the production default.
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    spawnWorker: async () => ({ workerId: 'worker-slowboot', pid: null }),
  });

  await supervisor.ensureWorker('slow-boot-session');

  // Measured median boot for a copilot-kind worker is ~35s; the old 30s default
  // killed it mid-boot and paid a second cold start.
  nowMs += 60_000;
  assert.equal(supervisor.getLifecycleState('slow-boot-session')?.degradedReason, null);

  nowMs += 35_000;
  assert.equal(
    supervisor.getLifecycleState('slow-boot-session')?.degradedReason,
    'startup-heartbeat-timeout',
  );
});

test('default kill block clears in seconds, not half a minute', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 1_000;
  // No killBlockGraceMs override: this asserts the production default.
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    spawnWorker: async () => ({ workerId: 'worker-killed', pid: 4242 }),
  });

  await supervisor.ensureWorker('killed-session');
  supervisor.markKilled('killed-session');
  assert.equal(supervisor.isKillBlocked('killed-session'), true);

  // Long enough to cover a kill racing an in-flight respawn...
  nowMs += 1_000;
  assert.equal(supervisor.isKillBlocked('killed-session'), true);

  // ...but stopping a turn then sending a new message must not wait 30s.
  nowMs += 2_500;
  assert.equal(supervisor.isKillBlocked('killed-session'), false);
});

test('an exhausted session is launched once more after the retry-after window', async () => {
  // What failed the launches can be gone (an unreadable process list was,
  // 2026-10-01); the pending work must not wait for a relay restart.
  const registry = createSessionWorkerRegistry();
  let nowMs = 100_000;
  let launchesFail = true;
  let spawns = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    maxRestartRetries: 1,
    restartBackoffBaseMs: 1_000,
    restartExhaustedRetryAfterMs: 60_000,
    spawnWorker: async () => {
      spawns += 1;
      if (launchesFail) throw new Error('windows-process-snapshot-unreadable: Bad control character in string literal');
      return { workerId: 'worker-exhausted-1', pid: 777 };
    },
  });

  const first = await supervisor.ensureWorker('exhausted-1');
  assert.equal(first.error, 'spawn-failed');
  nowMs += 1_000;
  const second = await supervisor.ensureWorker('exhausted-1');
  assert.equal(second.error, 'restart-exhausted');
  assert.equal(spawns, 2);

  nowMs += 59_000;
  const tooEarly = await supervisor.ensureWorker('exhausted-1');
  assert.equal(tooEarly.error, 'restart-exhausted');
  assert.equal(spawns, 2, 'no launch inside the window');

  nowMs += 1_000;
  const dueAgain = await supervisor.ensureWorker('exhausted-1');
  assert.equal(spawns, 3, 'one launch once the window has passed');
  assert.equal(dueAgain.error, 'restart-exhausted', 'a failure exhausts the session again at once');

  launchesFail = false;
  nowMs += 60_000;
  const healed = await supervisor.ensureWorker('exhausted-1');
  assert.equal(healed.ok, true);
  assert.equal(spawns, 4);
  assert.equal(supervisor.getLifecycleState('exhausted-1')?.restartExhausted, false);
  assert.equal(supervisor.getLifecycleState('exhausted-1')?.degradedReason, null);
});

test('after the retry window the relay stops trying, and reports the episode as it goes', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 100_000;
  let spawns = 0;
  let launchesFail = true;
  const events = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    maxRestartRetries: 0,
    restartExhaustedRetryAfterMs: 60_000,
    restartExhaustedRetryWindowMs: 150_000,
    onLaunchState: (event) => events.push([event.type, event.lifecycle.retriesStopped, event.lifecycle.retryAgainAt]),
    spawnWorker: async () => {
      spawns += 1;
      if (launchesFail) throw new Error('spawn failed');
      return { workerId: 'worker-window-1', pid: 4242 };
    },
  });

  await supervisor.ensureWorker('window-1');
  for (let step = 0; step < 3; step += 1) {
    nowMs += 60_000;
    await supervisor.ensureWorker('window-1');
  }
  assert.equal(spawns, 4);
  assert.deepEqual(events.map((event) => event[0]), ['exhausted', 'retry-failed', 'retry-failed', 'stopped']);
  assert.deepEqual(events[0].slice(1), [false, new Date(160_000).toISOString()], 'the next try is announced');
  assert.deepEqual(events[3].slice(1), [true, null], 'stopped: no next try');
  assert.equal(supervisor.getLifecycleState('window-1')?.exhaustedSince, new Date(100_000).toISOString());

  nowMs += 60 * 60_000;
  assert.equal((await supervisor.ensureWorker('window-1')).error, 'restart-exhausted');
  assert.equal(spawns, 4, 'stopped means stopped');

  // Retry (the launch route): the episode is cleared and the launch reported.
  supervisor.clearRestartSchedule('window-1', { resetKilledMarker: true });
  launchesFail = false;
  const launched = await supervisor.ensureWorker('window-1');
  assert.equal(launched.ok, true);
  assert.equal(events.at(-1)[0], 'launched');
  assert.equal(supervisor.getLifecycleState('window-1')?.retriesStopped, false);
});

test('restartExhaustedRetryAfterMs 0 keeps an exhausted session exhausted', async () => {
  const registry = createSessionWorkerRegistry();
  let nowMs = 100_000;
  let spawns = 0;
  const supervisor = createSessionWorkerSupervisor({
    registry,
    now: () => nowMs,
    maxRestartRetries: 0,
    restartExhaustedRetryAfterMs: 0,
    spawnWorker: async () => {
      spawns += 1;
      throw new Error('spawn failed');
    },
  });

  assert.equal((await supervisor.ensureWorker('exhausted-2')).error, 'restart-exhausted');
  nowMs += 24 * 60 * 60 * 1000;
  assert.equal((await supervisor.ensureWorker('exhausted-2')).error, 'restart-exhausted');
  assert.equal(spawns, 1);
});

test('the end of a kill block is reported: when its grace runs out, or when the marker is cleared', () => {
  let nowMs = 1_000;
  const timers = new Map();
  let nextId = 1;
  const lifted = [];
  const supervisor = createSessionWorkerSupervisor({
    registry: createSessionWorkerRegistry(),
    now: () => nowMs,
    killBlockGraceMs: 3_000,
    spawnWorker: async () => ({ workerId: 'w', pid: null }),
    onKillBlockLifted: (sid) => lifted.push(sid),
    setTimeoutImpl: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimeoutImpl: (id) => { timers.delete(id); },
  });

  supervisor.markKilled('sess-a');
  assert.equal(supervisor.isKillBlocked('sess-a'), true);
  assert.equal(timers.size, 1);
  const [[id, timer]] = [...timers.entries()];
  assert.ok(timer.ms >= 3_000, 'fires once the grace is over');
  nowMs += timer.ms;
  timers.delete(id);
  timer.fn();
  assert.equal(supervisor.isKillBlocked('sess-a'), false);
  assert.deepEqual(lifted, ['sess-a']);

  supervisor.markKilled('sess-b');
  supervisor.markKilled('sess-b');
  assert.equal(timers.size, 1, 'a second kill re-arms the one timer');
  supervisor.clearRestartSchedule('sess-b', { resetKilledMarker: true });
  assert.equal(timers.size, 0);
  assert.equal(supervisor.isKillBlocked('sess-b'), false);
  assert.deepEqual(lifted, ['sess-a', 'sess-b'], 'a cleared marker lifts the block at once');

  supervisor.clearRestartSchedule('sess-c', { resetKilledMarker: true });
  assert.deepEqual(lifted, ['sess-a', 'sess-b'], 'no block, nothing to report');
});

// A relay that launches its workers itself: every one of them says its kind.
function supervisorOverEntry(entry, {
  workersStateTheirKind = () => true,
  spawned = { workerId: 'worker-new', pid: 9100 },
  readProcessIdentity = null,
} = {}) {
  const registry = createSessionWorkerRegistry();
  if (entry) registry.upsertWorker({ sdkSessionId: 'abc-123', ...entry });
  const spawns = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    isPidAlive: () => true,
    workersStateTheirKind,
    readProcessIdentity,
    spawnWorker: async (sessionId, options) => {
      spawns.push({ sessionId, ...options });
      return spawned;
    },
  });
  return { registry, supervisor, spawns };
}

test('a live process that heartbeats and never said its kind is no worker to reuse: the launch runs', async () => {
  // What the heartbeat of a Copilot CLI an earlier version started leaves.
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' });
  supervisor.noteSessionHeartbeat('abc-123');
  const result = await supervisor.ensureWorker('abc-123');
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.deepEqual(spawns, [{ sessionId: 'abc-123', allowProcessReuse: true }]);
  assert.equal(result.worker.pid, 9100);
});

test('a live worker that said its kind is reused as before', async () => {
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready', kind: 'copilot-sdk' });
  const result = await supervisor.ensureWorker('abc-123');
  assert.equal(result.reused, true);
  assert.equal(result.worker.pid, 4242);
  assert.deepEqual(spawns, []);
});

test('the worker a launch just started is reused before it has said its kind', async () => {
  const { supervisor, spawns } = supervisorOverEntry(null);
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, false);
  const again = await supervisor.ensureWorker('abc-123');
  assert.equal(again.reused, true);
  assert.equal(again.worker.pid, 9100);
  assert.equal(spawns.length, 1);
});

test('a launch that knew no pid: the worker is reused, and so is the one that then names its pid and kind', async () => {
  const { registry, supervisor, spawns } = supervisorOverEntry(null, { spawned: { workerId: 'worker-new', pid: null } });
  await supervisor.ensureWorker('abc-123');
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  registry.upsertWorker({ ...registry.getWorker('abc-123'), pid: 9200, kind: 'claude' });
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.equal(spawns.length, 1);
});

test('a relay that launches no worker takes a process that never said its kind for the session\'s worker', async () => {
  for (const workersStateTheirKind of [() => false, null]) {
    const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { workersStateTheirKind });
    assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
    assert.deepEqual(spawns, []);
  }
});

// What the identity reader (createProcessIdentityReader) says about a pid:
// the command lines are made up, in the shapes the launch starts and an
// earlier version left.
function identityReader(commandLine) {
  const reads = [];
  const readProcessIdentity = async (pid) => {
    reads.push(pid);
    return { pid, startTime: '123456', commandLine };
  };
  return { reads, readProcessIdentity };
}

const WORKERS_OF_AN_EARLIER_VERSION = [
  ['copilot-sdk', 'node /home/dev/oar/server/copilot-worker/copilot-sdk-session-worker.mjs --session-id abc-123'],
  ['cursor', 'node /home/dev/oar/server/cursor-worker/cursor-session-worker.mjs --session-id abc-123'],
  ['grok', 'node /home/dev/oar/server/grok-worker/grok-session-worker.mjs --session-id abc-123'],
  ['claude-cloud', 'node /home/dev/oar/server/claude-cloud-worker/claude-cloud-session-worker.mjs --session-id abc-123'],
];

for (const [kind, commandLine] of WORKERS_OF_AN_EARLIER_VERSION) {
  test(`a ${kind} worker of an earlier version that survived a relay restart is reused mid-turn: no launch, its turn stays`, async () => {
    // It said no kind, and no launch of this relay started it.
    const { reads, readProcessIdentity } = identityReader(commandLine);
    const { registry, supervisor, spawns } = supervisorOverEntry(
      { workerId: 'worker-abc', pid: 4242, status: 'processing' },
      { readProcessIdentity },
    );
    supervisor.noteSessionHeartbeat('abc-123');
    const result = await supervisor.ensureWorker('abc-123');
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.worker.pid, 4242);
    assert.deepEqual(spawns, [], 'no launch, so no process-list read either');
    assert.equal(registry.getWorker('abc-123').status, 'processing');

    // Read once for that process, not at every delivery.
    assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
    assert.deepEqual(reads, [4242]);
    assert.deepEqual(spawns, []);
  });
}

test('a worker of an earlier version that is idle is reused as ready', async () => {
  const { readProcessIdentity } = identityReader(WORKERS_OF_AN_EARLIER_VERSION[0][1]);
  const { registry, supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { readProcessIdentity });
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.equal(registry.getWorker('abc-123').status, 'ready');
  assert.deepEqual(spawns, []);
});

test('a worker that said its kind is reused mid-turn without a read, and its turn stays', async () => {
  const { reads, readProcessIdentity } = identityReader('bash');
  const { registry, supervisor, spawns } = supervisorOverEntry(
    { workerId: 'worker-abc', pid: 4242, status: 'processing', kind: 'grok' },
    { readProcessIdentity },
  );
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.equal(registry.getWorker('abc-123').status, 'processing');
  assert.deepEqual(reads, []);
  assert.deepEqual(spawns, []);
});

for (const [what, commandLine] of [
  ['the Copilot CLI of the removed engine', '/home/dev/.local/bin/copilot --resume abc-123 --allow-all-tools'],
  ['its script parent', 'script -q -c copilot --resume abc-123 /dev/null'],
]) {
  test(`${what}, heartbeating for the session, is not reused: the launch runs`, async () => {
    const { reads, readProcessIdentity } = identityReader(commandLine);
    const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { readProcessIdentity });
    supervisor.noteSessionHeartbeat('abc-123');
    const result = await supervisor.ensureWorker('abc-123');
    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    assert.deepEqual(spawns, [{ sessionId: 'abc-123', allowProcessReuse: true }], 'the launch stops it');
    assert.equal(result.worker.pid, 9100);
    assert.deepEqual(reads, [4242]);
  });
}

test('two calls at once for a process that is no session worker launch once', async () => {
  const { reads, readProcessIdentity } = identityReader('/home/dev/.local/bin/copilot --resume abc-123');
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { readProcessIdentity });
  const [first, second] = await Promise.all([supervisor.ensureWorker('abc-123'), supervisor.ensureWorker('abc-123')]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(spawns.length, 1);
  assert.ok(reads.length >= 1);
});

test('a process whose identity cannot be read is reused, as one that said its kind', async () => {
  const readers = [
    async (pid) => ({ pid, startTime: null, commandLine: null }),
    async () => null,
    async () => { throw new Error('ps timed out'); },
  ];
  for (const readProcessIdentity of readers) {
    const { registry, supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'processing' }, { readProcessIdentity });
    const result = await supervisor.ensureWorker('abc-123');
    assert.equal(result.reused, true);
    assert.equal(registry.getWorker('abc-123').status, 'processing');
    assert.deepEqual(spawns, []);
  }
});

// A reader that answers each read with the next of `commandLines`, the
// last one for good; null is a read that told nothing.
function identityReaderInTurns(commandLines) {
  const reads = [];
  const readProcessIdentity = async (pid) => {
    const commandLine = commandLines[Math.min(reads.length, commandLines.length - 1)];
    reads.push(pid);
    return { pid, startTime: commandLine === null ? null : '123456', commandLine };
  };
  return { reads, readProcessIdentity };
}

test('a process that cannot be read is reused for that call only, read again at each, and never taken for a launch of this relay', async () => {
  const { reads, readProcessIdentity } = identityReaderInTurns([null]);
  const { registry, supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'processing' }, { readProcessIdentity });
  supervisor.noteSessionHeartbeat('abc-123');
  for (let call = 1; call <= 3; call += 1) {
    const result = await supervisor.ensureWorker('abc-123');
    assert.equal(result.reused, true);
    assert.equal(registry.getWorker('abc-123').status, 'processing');
    assert.equal(reads.length, call, 'read at every call');
    assert.notEqual(supervisor.getLifecycleState('abc-123').launchPid, 4242, 'no launch recorded for its pid');
  }
  assert.deepEqual(spawns, []);
});

test('a Windows process whose command line the relay may not read is reused for that call only, and read again at the next', async () => {
  // Win32_Process lists a process the relay may not open (an elevated relay
  // started it) with a null CommandLine; the real reader over such a row.
  const snapshotReads = [];
  const readProcessIdentity = createProcessIdentityReader({
    platform: 'win32',
    readProcessSnapshot: async (options) => {
      snapshotReads.push(options);
      return [{ processId: 4242, parentProcessId: 4100, name: 'node.exe', commandLine: null, createdAt: 1_763_100_000_000 }];
    },
  });
  const { registry, supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'processing' }, { readProcessIdentity });
  supervisor.noteSessionHeartbeat('abc-123');

  const first = await supervisor.ensureWorker('abc-123');
  assert.equal(first.reused, true);
  assert.deepEqual(spawns, []);
  assert.equal(registry.getWorker('abc-123').status, 'processing');
  assert.equal(snapshotReads.length, 1);
  assert.notEqual(supervisor.getLifecycleState('abc-123').launchPid, 4242, 'no verdict kept, no launch recorded');

  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.equal(snapshotReads.length, 2, 'read again');
  assert.deepEqual(spawns, []);
});

test('a command line that is only blanks is no command line either', async () => {
  const { reads, readProcessIdentity } = identityReaderInTurns(['   ']);
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { readProcessIdentity });
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.deepEqual(reads, [4242, 4242]);
  assert.deepEqual(spawns, []);
});

test('a process that could not be read once and then reads as no session worker goes to the launch', async () => {
  // A Copilot CLI of the removed engine, right after an update, while the
  // process list failed once.
  const { reads, readProcessIdentity } = identityReaderInTurns([null, '/home/dev/.local/bin/copilot --resume abc-123']);
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { readProcessIdentity });
  supervisor.noteSessionHeartbeat('abc-123');
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.deepEqual(spawns, []);

  const second = await supervisor.ensureWorker('abc-123');
  assert.equal(second.ok, true);
  assert.equal(second.reused, false);
  assert.deepEqual(spawns, [{ sessionId: 'abc-123', allowProcessReuse: true }], 'the launch stops it');
  assert.equal(second.worker.pid, 9100);
  assert.deepEqual(reads, [4242, 4242]);
});

test('a process that could not be read once and then reads as a session worker is reused, and read no more', async () => {
  const { reads, readProcessIdentity } = identityReaderInTurns([null, WORKERS_OF_AN_EARLIER_VERSION[2][1]]);
  const { registry, supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'processing' }, { readProcessIdentity });
  supervisor.noteSessionHeartbeat('abc-123');
  for (let call = 1; call <= 3; call += 1) {
    assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
    assert.equal(registry.getWorker('abc-123').status, 'processing');
  }
  assert.deepEqual(reads, [4242, 4242], 'the read that told is the last');
  assert.equal(supervisor.getLifecycleState('abc-123').launchPid, 4242);
  assert.deepEqual(spawns, []);
});

test('a kill while the identity is read: nothing is reused or launched', async () => {
  let supervisorRef = null;
  const readProcessIdentity = async (pid) => {
    supervisorRef.markKilled('abc-123');
    return { pid, startTime: '123456', commandLine: WORKERS_OF_AN_EARLIER_VERSION[1][1] };
  };
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { readProcessIdentity });
  supervisorRef = supervisor;
  const result = await supervisor.ensureWorker('abc-123');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'session-killed');
  assert.deepEqual(spawns, []);
});

test('a relay that launches no worker reads no identity', async () => {
  const { reads, readProcessIdentity } = identityReader('/home/dev/.local/bin/copilot --resume abc-123');
  const { supervisor, spawns } = supervisorOverEntry({ workerId: 'worker-abc', pid: 4242, status: 'ready' }, { workersStateTheirKind: () => false, readProcessIdentity });
  assert.equal((await supervisor.ensureWorker('abc-123')).reused, true);
  assert.deepEqual(reads, []);
  assert.deepEqual(spawns, []);
});
