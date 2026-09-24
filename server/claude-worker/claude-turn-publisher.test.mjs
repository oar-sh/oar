import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeTurnPublisher } from './claude-turn-publisher.mjs';

const message = { id: 'q-1', conversationId: 'conv-1', relayMode: 'agent', attemptId: 'a-1' };

test('a retried publish reuses the workflow digests drained once, instead of losing them', async () => {
  let drains = 0;
  const bodies = [];
  let failNext = true;
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => {
      if (routePath !== '/api/response') return { ok: true };
      bodies.push(body);
      if (failNext) {
        failNext = false;
        throw new Error('relay 503');
      }
      return { ok: true };
    },
    takeWorkflowRuns: () => {
      drains += 1;
      return drains === 1 ? [{ runId: 'wf-1', status: 'completed' }] : null;
    },
  });

  const workflowRuns = publisher.drainWorkflowRuns();
  assert.equal(await publisher.publishResponse(message, { text: 'merged', kind: 'absorbed', workflowRuns }), 'failed');
  assert.equal(await publisher.publishResponse(message, { text: 'merged', kind: 'absorbed', workflowRuns }), 'published');
  assert.equal(drains, 1, 'drained once');
  assert.deepEqual(bodies[1].workflowRuns, [{ runId: 'wf-1', status: 'completed' }], 'the retry still carries them');
});

test('publishResponse reports outcomes and only requeues an ordinary failed publish', async () => {
  const calls = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => {
      calls.push({ routePath, body });
      if (routePath === '/api/response') throw new Error('relay 503');
      return { ok: true };
    },
  });
  assert.equal(await publisher.publishResponse(message, { text: 'x', kind: 'stopped' }), 'failed');
  assert.equal(await publisher.publishResponse(message, { text: 'x', requeueOnFailure: false }), 'failed');
  assert.equal(calls.filter((call) => call.routePath === '/api/requeue').length, 0);
  assert.equal(await publisher.publishResponse(message, { text: 'x' }), 'requeued');
  assert.equal(calls.filter((call) => call.routePath === '/api/requeue').length, 1);
});

test('consumed steer ids ride the response that finishes their turn', async () => {
  const bodies = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { if (routePath === '/api/response') bodies.push(body); return { ok: true }; },
  });
  await publisher.publishCompletedTurn({
    message,
    state: { result: { text: 'done' }, resultTexts: ['done'], lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
    consumedSteerIds: ['q-2', '', 'q-3'],
  });
  assert.deepEqual(bodies[0].consumedSteerIds, ['q-2', 'q-3']);
});
