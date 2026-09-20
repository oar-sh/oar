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
  assert.deepEqual(registry.getWorker('sdk-1').steering, {
    turnActive: true,
    canSteer: false,
    holdReason: 'question',
    messageId: 'q-7',
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
  });

  // Unknown hold reasons are dropped to null; junk shapes normalize to null.
  registry.upsertWorker({
    ...registry.getWorker('sdk-1'),
    steering: { turnActive: true, canSteer: false, holdReason: 'weird-new-reason' },
  });
  assert.equal(registry.getWorker('sdk-1').steering.holdReason, null);
  registry.upsertWorker({ ...registry.getWorker('sdk-1'), steering: 'garbage' });
  assert.equal(registry.getWorker('sdk-1').steering, null);
});
