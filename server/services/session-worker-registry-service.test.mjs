import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerRegistry } from './session-worker-registry-service.mjs';

test('upsert, lookup and remove round-trip through all secondary indexes', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'sdk-1',
    workerId: 'worker-1',
    conversationId: 'conv-1',
    runtimeSessionId: 'rt-1',
    status: 'ready',
    pid: 4242,
  });

  assert.equal(registry.getWorker('sdk-1')?.pid, 4242);
  assert.equal(registry.getWorkerByWorkerId('worker-1')?.sdkSessionId, 'sdk-1');
  assert.equal(registry.getWorkerByConversationId('conv-1')?.sdkSessionId, 'sdk-1');
  assert.equal(registry.getWorkerByRuntimeSessionId('rt-1')?.sdkSessionId, 'sdk-1');

  assert.equal(registry.removeWorker('sdk-1'), true);
  assert.equal(registry.getWorker('sdk-1'), null);
  assert.equal(registry.getWorkerByWorkerId('worker-1'), null);
  assert.equal(registry.getWorkerByConversationId('conv-1'), null);
  assert.equal(registry.getWorkerByRuntimeSessionId('rt-1'), null);
});

test('removing a stale entry does not steal an index a newer entry now owns', () => {
  // Regression for audit #22: index removal used to be unconditional, so
  // deleting an old entry whose conversationId had since been claimed by a
  // newer session severed the newer session's lookup path.
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sdk-old', conversationId: 'conv-1', workerId: 'worker-old' });
  // The conversation moved on to a new session; its index now points there.
  registry.upsertWorker({ sdkSessionId: 'sdk-new', conversationId: 'conv-1', workerId: 'worker-new' });

  assert.equal(registry.removeWorker('sdk-old'), true);

  assert.equal(registry.getWorkerByConversationId('conv-1')?.sdkSessionId, 'sdk-new');
  assert.equal(registry.getWorkerByWorkerId('worker-new')?.sdkSessionId, 'sdk-new');
  // The stale entry's own index went with it.
  assert.equal(registry.getWorkerByWorkerId('worker-old'), null);
});

test('rekeyWorker moves the placeholder entry and all its indexes to the real id', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'conv-1',
    conversationId: 'conv-1',
    workerId: 'worker-1',
    runtimeSessionId: 'rt-1',
    status: 'processing',
    pid: 7,
  });

  const rekeyed = registry.rekeyWorker('conv-1', 'sdk-real');

  assert.equal(rekeyed?.sdkSessionId, 'sdk-real');
  assert.equal(rekeyed?.pid, 7);
  assert.equal(rekeyed?.status, 'processing');
  // Exactly one entry, registered under the real key.
  assert.equal(registry.listWorkers().length, 1);
  assert.equal(registry.getWorker('conv-1'), null);
  assert.equal(registry.getWorker('sdk-real')?.pid, 7);
  // No stale secondary indexes pointing at the placeholder.
  assert.equal(registry.getWorkerByWorkerId('worker-1')?.sdkSessionId, 'sdk-real');
  assert.equal(registry.getWorkerByConversationId('conv-1')?.sdkSessionId, 'sdk-real');
  assert.equal(registry.getWorkerByRuntimeSessionId('rt-1')?.sdkSessionId, 'sdk-real');
});

test('rekeyWorker merges into an existing real-id entry, newer fields winning', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({
    sdkSessionId: 'conv-1',
    conversationId: 'conv-1',
    workerId: 'worker-1',
    status: 'starting',
    pid: 7,
    retryCount: 3,
  });
  // A sync already registered the session under its real id.
  registry.upsertWorker({
    sdkSessionId: 'sdk-real',
    conversationId: 'conv-1',
    workerId: 'worker-1',
    status: 'ready',
    pid: 9,
  });

  const merged = registry.rekeyWorker('conv-1', 'sdk-real');

  assert.equal(registry.listWorkers().length, 1);
  assert.equal(merged?.status, 'ready');
  assert.equal(merged?.pid, 9);
  assert.equal(registry.getWorker('conv-1'), null);
  assert.equal(registry.getWorkerByConversationId('conv-1')?.sdkSessionId, 'sdk-real');
  assert.equal(registry.getWorkerByWorkerId('worker-1')?.sdkSessionId, 'sdk-real');
});

test('rekeyWorker is a no-op without a placeholder entry or with equal ids', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sdk-1', conversationId: 'conv-1' });

  assert.equal(registry.rekeyWorker('missing', 'sdk-2'), null);
  assert.equal(registry.rekeyWorker('sdk-1', 'sdk-1'), null);
  assert.equal(registry.listWorkers().length, 1);
  assert.equal(registry.getWorker('sdk-1')?.conversationId, 'conv-1');
});

test('the steering snapshot is normalized, stored, and survives spread-convention upserts', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sdk-1', status: 'ready' });
  assert.equal(registry.getWorker('sdk-1').steering, null);

  registry.upsertWorker({
    ...registry.getWorker('sdk-1'),
    steering: { turnActive: true, canSteer: false, holdReason: 'QUESTION', messageId: 'q-7' },
  });
  // The Claude worker's 4-field snapshot: no opt-in flag, nothing un-steerable.
  assert.deepEqual(registry.getWorker('sdk-1').steering, {
    turnActive: true,
    canSteer: false,
    holdReason: 'question',
    messageId: 'q-7',
    supported: false,
    cancellableIds: [],
  });

  // An unrelated update that spreads the existing entry (the registry's
  // caller convention) keeps the last snapshot.
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), pid: 42 });
  assert.equal(registry.getWorker('sdk-1').pid, 42);
  assert.deepEqual(registry.getWorker('sdk-1').steering, {
    turnActive: true,
    canSteer: false,
    holdReason: 'question',
    messageId: 'q-7',
    supported: false,
    cancellableIds: [],
  });

  // A running tool call is a hold the Copilot SDK worker reports.
  registry.upsertWorker({
    ...registry.getWorker('sdk-1'),
    steering: { turnActive: true, canSteer: false, holdReason: 'tool', messageId: 'q-7' },
  });
  assert.equal(registry.getWorker('sdk-1').steering.holdReason, 'tool');

  // Unknown hold reasons are dropped to null; junk shapes normalize to null.
  registry.upsertWorker({
    ...registry.getWorker('sdk-1'),
    steering: { turnActive: true, canSteer: false, holdReason: 'weird-new-reason' },
  });
  assert.equal(registry.getWorker('sdk-1').steering.holdReason, null);
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), steering: 'garbage' });
  assert.equal(registry.getWorker('sdk-1').steering, null);
});

test('the steering snapshot carries the running CLI\'s compaction window only when reported', () => {
  const registry = createSessionWorkerRegistry();
  const base = { turnActive: false, canSteer: false, holdReason: null, messageId: null, supported: true };
  registry.upsertWorker({ sdkSessionId: 'sdk-1', status: 'ready', steering: base });
  assert.equal('autoCompactWindow' in registry.getWorker('sdk-1').steering, false, 'an older worker sends nothing');

  registry.upsertWorker({
    ...registry.getWorker('sdk-1'),
    steering: { ...base, autoCompactWindow: { active: '150000', backgroundWork: 'yes' } },
  });
  assert.deepEqual(registry.getWorker('sdk-1').steering.autoCompactWindow, { active: 150000, backgroundWork: false });

  // Auto (null) and junk windows both read as Auto; a junk shape as nothing.
  registry.upsertWorker({
    ...registry.getWorker('sdk-1'),
    steering: { ...base, autoCompactWindow: { active: 'junk', backgroundWork: true } },
  });
  assert.deepEqual(registry.getWorker('sdk-1').steering.autoCompactWindow, { active: null, backgroundWork: true });
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), steering: { ...base, autoCompactWindow: 'junk' } });
  assert.equal('autoCompactWindow' in registry.getWorker('sdk-1').steering, false);
});

test('the Copilot SDK worker snapshot: supported opt-in and the un-steerable id set', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sdk-1', status: 'processing', pid: 100 });
  const withSteering = (steering) => {
    registry.upsertWorker({ ...registry.getWorker('sdk-1'), steering });
    return registry.getWorker('sdk-1').steering;
  };

  // supported: strictly boolean true; anything else is not an opt-in.
  assert.equal(withSteering({ turnActive: true, canSteer: true, supported: true }).supported, true);
  assert.equal(withSteering({ turnActive: true, canSteer: true, supported: false }).supported, false);
  assert.equal(withSteering({ turnActive: true, canSteer: true }).supported, false);
  assert.equal(withSteering({ turnActive: true, canSteer: true, supported: 'true' }).supported, false);
  assert.equal(withSteering({ turnActive: true, canSteer: true, supported: 1 }).supported, false);

  // cancellableIds: trimmed non-empty strings only, deduped, order kept.
  assert.deepEqual(
    withSteering({ turnActive: true, canSteer: true, supported: true, cancellableIds: [' m-2 ', 'm-1', 'm-2', '', 7, null, { id: 'm-3' }, 'm-3'] }).cancellableIds,
    ['m-2', 'm-1', 'm-3'],
  );
  // Over-long ids are dropped (the relay never stores an unbounded token).
  assert.deepEqual(
    withSteering({ turnActive: true, canSteer: true, supported: true, cancellableIds: ['x'.repeat(65), 'y'.repeat(64)] }).cancellableIds,
    ['y'.repeat(64)],
  );
  // Capped at 50.
  const many = Array.from({ length: 80 }, (_, i) => `m-${i}`);
  const capped = withSteering({ turnActive: true, canSteer: true, supported: true, cancellableIds: many }).cancellableIds;
  assert.equal(capped.length, 50);
  assert.deepEqual(capped, many.slice(0, 50));
  // Missing or junk → [].
  assert.deepEqual(withSteering({ turnActive: true, canSteer: true, supported: true }).cancellableIds, []);
  assert.deepEqual(withSteering({ turnActive: true, canSteer: true, supported: true, cancellableIds: 'm-1' }).cancellableIds, []);

  // Cleared with the rest of the snapshot when the worker process is gone.
  withSteering({ turnActive: true, canSteer: true, supported: true, cancellableIds: ['m-1'] });
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), pid: 200 });
  assert.equal(registry.getWorker('sdk-1').steering, null, 'pid change clears supported + cancellableIds with the snapshot');
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), steering: { turnActive: true, canSteer: true, supported: true, cancellableIds: ['m-1'] } });
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), status: 'stopped' });
  assert.equal(registry.getWorker('sdk-1').steering, null, 'worker gone clears it');
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), status: 'processing', steering: { turnActive: true, canSteer: true, supported: true, cancellableIds: ['m-1'] } });
  assert.equal(registry.clearSteering('sdk-1'), true);
  assert.equal(registry.getWorker('sdk-1').steering, null, 'explicit clear');
});

test('a steering snapshot does not outlive the worker process it describes', () => {
  const registry = createSessionWorkerRegistry();
  const hold = { turnActive: true, canSteer: false, holdReason: 'question', messageId: 'q-7', supported: false, cancellableIds: [] };
  const seed = () => registry.upsertWorker({ sdkSessionId: 'sdk-1', status: 'processing', pid: 100, steering: hold });

  // A replacement process (pid change), even through a spreading upsert.
  seed();
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), pid: 200 });
  assert.equal(registry.getWorker('sdk-1').steering, null, 'pid change');

  // The worker died (dead-worker recovery marks it errored) or is restarting.
  for (const status of ['error', 'starting', 'stopped']) {
    registry.removeWorker('sdk-1');
    seed();
    registry.upsertWorker({ ...registry.getWorker('sdk-1'), status });
    assert.equal(registry.getWorker('sdk-1').steering, null, `status → ${status}`);
  }

  // Staying errored while the live worker keeps heartbeating keeps the fresh
  // snapshot (a requeue retry marks a live worker errored).
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), steering: hold });
  assert.deepEqual(registry.getWorker('sdk-1').steering, hold);

  // An ordinary status change of a live worker keeps it.
  registry.removeWorker('sdk-1');
  seed();
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), status: 'ready' });
  assert.deepEqual(registry.getWorker('sdk-1').steering, hold);

  // Socket-close death detection clears it explicitly.
  assert.equal(registry.clearSteering('sdk-1'), true);
  assert.equal(registry.getWorker('sdk-1').steering, null);
  assert.equal(registry.getWorker('sdk-1').pid, 100, 'nothing else changes');
  assert.equal(registry.clearSteering('sdk-1'), false);
  assert.equal(registry.clearSteering('missing'), false);
});

test('a worker\'s kind is its own word: kept across upserts that do not state it, dropped with its process', async () => {
  const { normalizeWorkerKind, normalizeWorkerSteeringSnapshot } = await import('./session-worker-registry-service.mjs');
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sid-1', pid: 10, status: 'ready', kind: 'Claude-API' });
  assert.equal(registry.getWorker('sid-1').kind, 'claude-api');
  registry.upsertWorker({ sdkSessionId: 'sid-1', pid: 10, status: 'processing' });
  assert.equal(registry.getWorker('sid-1').kind, 'claude-api');
  // Another process for the session: the old one's word is gone until the new one speaks.
  registry.upsertWorker({ sdkSessionId: 'sid-1', pid: 11, status: 'ready' });
  assert.equal(registry.getWorker('sid-1').kind, null);
  assert.equal(normalizeWorkerKind('claude'), 'claude');
  assert.equal(normalizeWorkerKind('not a kind!'), null);
  // The releasable keys survive normalization only when the worker reports them.
  assert.deepEqual(
    normalizeWorkerSteeringSnapshot({ turnActive: false, releasable: false, releaseHold: 'background', backgroundTaskCount: 2 }),
    { turnActive: false, canSteer: false, holdReason: null, messageId: null, supported: false, cancellableIds: [], releasable: false, releaseHold: 'background', backgroundTaskCount: 2 },
  );
  assert.equal('releasable' in normalizeWorkerSteeringSnapshot({ turnActive: true }), false);
});

test('a worker\'s build id is kept across upserts that do not state it, dropped with its process, and bounded', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sid-b', pid: 20, status: 'ready', buildId: ' 0.9.21+0123456789ab ' });
  assert.equal(registry.getWorker('sid-b').buildId, '0.9.21+0123456789ab');
  registry.upsertWorker({ sdkSessionId: 'sid-b', pid: 20, status: 'processing' });
  assert.equal(registry.getWorker('sid-b').buildId, '0.9.21+0123456789ab');
  // The spread convention restates it, and a later change replaces it.
  registry.upsertWorker({ ...registry.getWorker('sid-b'), status: 'ready' });
  assert.equal(registry.getWorker('sid-b').buildId, '0.9.21+0123456789ab');
  assert.equal(registry.listWorkers()[0].buildId, '0.9.21+0123456789ab');
  // Another process for the session: the old one's build id goes with it.
  registry.upsertWorker({ sdkSessionId: 'sid-b', pid: 21, status: 'ready' });
  assert.equal(registry.getWorker('sid-b').buildId, null);
  // A malformed value is stored as unknown, never as given.
  registry.upsertWorker({ sdkSessionId: 'sid-b', pid: 21, status: 'ready', buildId: 'has spaces in it' });
  assert.equal(registry.getWorker('sid-b').buildId, null);
  registry.upsertWorker({ sdkSessionId: 'sid-b', pid: 21, status: 'ready', buildId: 'x'.repeat(81) });
  assert.equal(registry.getWorker('sid-b').buildId, null);
});

test('a new pid does not inherit the old process\'s build id through the spread convention', () => {
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sid-p', pid: 1, status: 'ready', buildId: '0.9.20+aaaaaaaaaaaa' });
  const entry = registry.getWorker('sid-p');
  // The old entry spread into the upsert that brings pid 2 restates the old
  // build id; it is pid 1's, so pid 2 has none until it speaks.
  registry.upsertWorker({ ...entry, pid: 2 });
  assert.equal(registry.getWorker('sid-p').buildId, null);
  // A build id that differs from the old entry's was stated for the new pid.
  registry.upsertWorker({ ...entry, pid: 3, buildId: '0.9.21+bbbbbbbbbbbb' });
  assert.equal(registry.getWorker('sid-p').buildId, '0.9.21+bbbbbbbbbbbb');
  // Same pid: the spread keeps it, as before.
  registry.upsertWorker({ ...registry.getWorker('sid-p'), status: 'processing' });
  assert.equal(registry.getWorker('sid-p').buildId, '0.9.21+bbbbbbbbbbbb');
  // A pid-less entry that still carries a gone process's build id hands it to
  // no pid that follows.
  registry.upsertWorker({ ...registry.getWorker('sid-p'), pid: null, status: 'stopped' });
  assert.equal(registry.getWorker('sid-p').buildId, '0.9.21+bbbbbbbbbbbb');
  registry.upsertWorker({ ...registry.getWorker('sid-p'), pid: 4, status: 'starting' });
  assert.equal(registry.getWorker('sid-p').buildId, null);
});

test('the steering snapshot carries cliAlive only when the worker reports it as a boolean', async () => {
  const { normalizeWorkerSteeringSnapshot } = await import('./session-worker-registry-service.mjs');
  assert.equal(normalizeWorkerSteeringSnapshot({ turnActive: false, cliAlive: true }).cliAlive, true);
  assert.equal(normalizeWorkerSteeringSnapshot({ turnActive: false, cliAlive: false }).cliAlive, false);
  // Absent or not a boolean: the worker cannot say, and the key stays out.
  assert.equal('cliAlive' in normalizeWorkerSteeringSnapshot({ turnActive: false }), false);
  assert.equal('cliAlive' in normalizeWorkerSteeringSnapshot({ turnActive: false, cliAlive: 'yes' }), false);
  assert.equal('cliAlive' in normalizeWorkerSteeringSnapshot({ turnActive: false, cliAlive: 1 }), false);
  // It survives the registry's own normalization of a stored snapshot.
  const registry = createSessionWorkerRegistry();
  registry.upsertWorker({ sdkSessionId: 'sid-c', pid: 5, status: 'ready', steering: { releasable: true, cliAlive: false } });
  assert.equal(registry.getWorker('sid-c').steering.cliAlive, false);
});

test('a worker\'s startedAt is the first time the relay hears of its pid', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T08:00:00.000Z') });
  const registry = createSessionWorkerRegistry();
  // No pid yet: no start time.
  registry.upsertWorker({ sdkSessionId: 'sid-s', status: 'starting' });
  assert.equal(registry.getWorker('sid-s').startedAt, null);
  t.mock.timers.tick(1_000);
  registry.upsertWorker({ ...registry.getWorker('sid-s'), pid: 30, status: 'ready' });
  assert.equal(registry.getWorker('sid-s').startedAt, '2026-10-30T08:00:01.000Z');
  // Later upserts for the same pid keep it, spread or not.
  t.mock.timers.tick(60_000);
  registry.upsertWorker({ ...registry.getWorker('sid-s'), status: 'processing' });
  registry.upsertWorker({ sdkSessionId: 'sid-s', pid: 30, status: 'ready', buildId: '0.9.21' });
  assert.equal(registry.getWorker('sid-s').startedAt, '2026-10-30T08:00:01.000Z');
  assert.equal(registry.listWorkers()[0].startedAt, '2026-10-30T08:00:01.000Z');
  // A new pid starts the clock again, even when the old entry is spread in.
  t.mock.timers.tick(5_000);
  registry.upsertWorker({ ...registry.getWorker('sid-s'), pid: 31 });
  assert.equal(registry.getWorker('sid-s').startedAt, '2026-10-30T08:01:06.000Z');
  // An entry first heard of with its pid gets the time at once.
  registry.upsertWorker({ sdkSessionId: 'sid-t', pid: 40, status: 'ready' });
  assert.equal(registry.getWorker('sid-t').startedAt, '2026-10-30T08:01:06.000Z');
});
