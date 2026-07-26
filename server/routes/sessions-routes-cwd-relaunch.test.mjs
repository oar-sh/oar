import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateWorkspaceRootRelaunch } from './sessions-routes.mjs';

test('evaluateWorkspaceRootRelaunch restarts an idle worker', () => {
  assert.deepEqual(evaluateWorkspaceRootRelaunch({ workerStatus: 'ready' }), {
    ok: true,
    stopWorker: true,
  });
});

test('evaluateWorkspaceRootRelaunch starts a stopped worker without stopping it', () => {
  assert.deepEqual(evaluateWorkspaceRootRelaunch({ workerStatus: 'stopped' }), {
    ok: true,
    stopWorker: false,
  });
});

test('evaluateWorkspaceRootRelaunch protects active and queued work', () => {
  assert.equal(evaluateWorkspaceRootRelaunch({ workerStatus: 'processing' }).ok, false);
  assert.equal(evaluateWorkspaceRootRelaunch({ workerStatus: 'ready', activeQueueCount: 1 }).ok, false);
});
