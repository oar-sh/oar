import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELAUNCH_COALESCE_WINDOW_MS,
  buildRelaunchRequestKey,
  createRelaunchCoalescer,
  evaluateReuseCwdMismatch,
  evaluateWorkspaceRootRelaunch,
} from './workspace-root-relaunch-service.mjs';

const SID = 'sess-1';

test('evaluateWorkspaceRootRelaunch keeps its historical shape', () => {
  assert.deepEqual(evaluateWorkspaceRootRelaunch({ workerStatus: 'ready' }), { ok: true, stopWorker: true });
  assert.deepEqual(evaluateWorkspaceRootRelaunch({ workerStatus: 'stopped' }), { ok: true, stopWorker: false });
  assert.equal(evaluateWorkspaceRootRelaunch({ workerStatus: 'processing' }).ok, false);
  assert.equal(evaluateWorkspaceRootRelaunch({ workerStatus: 'starting' }).ok, false);
  assert.equal(evaluateWorkspaceRootRelaunch({ workerStatus: 'ready', activeQueueCount: 1 }).ok, false);
});

test('a live process forces a stop even when the status says otherwise', () => {
  // Without this, the launch reuses the old process — in the old directory.
  assert.deepEqual(
    evaluateWorkspaceRootRelaunch({ workerStatus: 'error', workerPidAlive: true }),
    { ok: true, stopWorker: true },
  );
  assert.deepEqual(
    evaluateWorkspaceRootRelaunch({ workerStatus: '', liveProcessDetected: true }),
    { ok: true, stopWorker: true },
  );
  // ...but an active turn still wins.
  assert.equal(
    evaluateWorkspaceRootRelaunch({ workerStatus: 'processing', workerPidAlive: true }).ok,
    false,
  );
});

test('buildRelaunchRequestKey is stable, case-folded on win32, and overridable', () => {
  const a = buildRelaunchRequestKey({ conversationId: 'c1', rootPath: 'C:\\Git\\Repo', platform: 'win32' });
  const b = buildRelaunchRequestKey({ conversationId: 'c1', rootPath: 'c:\\git\\repo\\', platform: 'win32' });
  assert.equal(a, b);

  const other = buildRelaunchRequestKey({ conversationId: 'c1', rootPath: 'C:\\other', platform: 'win32' });
  assert.notEqual(a, other);

  const posixA = buildRelaunchRequestKey({ conversationId: 'c1', rootPath: '/srv/A', platform: 'linux' });
  const posixB = buildRelaunchRequestKey({ conversationId: 'c1', rootPath: '/srv/a', platform: 'linux' });
  assert.notEqual(posixA, posixB);

  const explicit = buildRelaunchRequestKey({ conversationId: 'c1', rootPath: '/x', idempotencyKey: 'k1' });
  assert.equal(explicit, buildRelaunchRequestKey({ conversationId: 'c2', rootPath: '/y', idempotencyKey: 'k1' }));
});

test('coalescer shares an in-flight result and then caches it', async () => {
  let now = 0;
  const coalescer = createRelaunchCoalescer({ nowMs: () => now });
  const key = 'c1|/srv/app';

  assert.deepEqual(coalescer.peek(SID, key), { state: 'idle' });

  const { settle } = coalescer.begin(SID, key);
  const inFlight = coalescer.peek(SID, key);
  assert.equal(inFlight.state, 'in-flight');

  settle({ statusCode: 200, body: { ok: true } });
  assert.deepEqual(await inFlight.promise, { statusCode: 200, body: { ok: true } });

  coalescer.settle(SID, key, { statusCode: 200, body: { ok: true } });
  const cached = coalescer.peek(SID, key);
  assert.equal(cached.state, 'cached');
  assert.deepEqual(cached.result.body, { ok: true });

  now += RELAUNCH_COALESCE_WINDOW_MS + 1;
  assert.deepEqual(coalescer.peek(SID, key), { state: 'idle' });
  assert.equal(coalescer.size(), 0, 'expired entries are pruned');
});

test('a different key while one is in flight reports busy, not idle', () => {
  const coalescer = createRelaunchCoalescer();
  coalescer.begin(SID, 'c1|/srv/app');
  assert.deepEqual(coalescer.peek(SID, 'c1|/srv/other'), { state: 'busy' });
});

test('a different key after settle is free to run', () => {
  let now = 0;
  const coalescer = createRelaunchCoalescer({ nowMs: () => now });
  coalescer.begin(SID, 'c1|/srv/app');
  coalescer.settle(SID, 'c1|/srv/app', { statusCode: 200, body: {} });
  assert.deepEqual(coalescer.peek(SID, 'c1|/srv/other'), { state: 'idle' });
});

test('separate sessions never coalesce with each other', () => {
  const coalescer = createRelaunchCoalescer();
  coalescer.begin('sess-a', 'c1|/srv/app');
  assert.deepEqual(coalescer.peek('sess-b', 'c2|/srv/app'), { state: 'idle' });
});

test('evaluateReuseCwdMismatch is case-aware per platform and honest about unknowns', () => {
  assert.deepEqual(
    evaluateReuseCwdMismatch({ requestedRootPath: 'C:\\Git\\Repo', observedRootPath: 'c:\\git\\repo', platform: 'win32' }),
    { comparable: true, mismatch: false },
  );
  assert.deepEqual(
    evaluateReuseCwdMismatch({ requestedRootPath: '/srv/A', observedRootPath: '/srv/a', platform: 'linux' }),
    { comparable: true, mismatch: true },
  );
  assert.deepEqual(
    evaluateReuseCwdMismatch({ requestedRootPath: '/srv/app', observedRootPath: '', platform: 'linux' }),
    { comparable: false, mismatch: false },
  );
});
