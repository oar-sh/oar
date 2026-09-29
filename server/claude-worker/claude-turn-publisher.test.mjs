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
  assert.deepEqual(bodies[0].consumedSteerIds, [{ id: 'q-2', attemptId: null }, { id: 'q-3', attemptId: null }]);
});

test('a failed turn names its failure and brings the advice that fits', async () => {
  const bodies = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { if (routePath === '/api/response') bodies.push(body); return { ok: true }; },
  });
  const refusal = 'Your organization has disabled Claude subscription access for Claude Code';
  await publisher.publishErrorResult({
    message,
    state: {
      result: { text: refusal, isError: true, subtype: 'success', assistantError: 'oauth_org_not_allowed', apiErrorStatus: 403, terminalReason: 'api_error' },
      lastStreamedText: '',
    },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishErrorResult({
    message,
    state: { result: { text: '', isError: true, subtype: 'success' }, lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishErrorResult({
    message,
    state: { result: { text: '', isError: true, subtype: 'error_during_execution' }, lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishTurnException({ message, errorText: 'Not logged in' });
  await publisher.publishTurnException({ message, errorText: 'spawn failed' });

  const failures = bodies.map((body) => body.terminalError);
  assert.deepEqual(failures.map((failure) => failure.stableCode), [
    'claude.oauth_org_not_allowed',
    'claude.turn-error',
    'claude.error_during_execution',
    'claude.authentication_failed',
    'claude.turn-error',
  ]);
  assert.equal(failures[0].message, refusal);
  assert.match(failures[0].guidance, /Check the Claude account/);
  assert.doesNotMatch(failures[0].guidance, /retry/i);
  assert.match(failures[3].guidance, /Settings → Providers → Claude → Relogin/);
  // The rest leave the advice to the relay's default.
  for (const index of [1, 2, 4]) assert.ok(!failures[index].guidance, String(index));
  for (const body of bodies) assert.doesNotMatch(JSON.stringify(body), /restart the relay/i);
});

test('a turn refused at the usage limit goes out as a pause, ahead of the general failure', async () => {
  const bodies = [];
  const publisher = createClaudeTurnPublisher({
    api: async (method, routePath, body) => { if (routePath === '/api/response') bodies.push(body); return { ok: true }; },
  });
  const refusal = 'You have hit your session limit';
  const refused = { text: refusal, isError: true, subtype: 'success', assistantError: 'rate_limit', apiErrorStatus: 429, terminalReason: 'api_error' };
  const usageLimit = { rateLimitType: 'five_hour', resetsAt: '2030-01-01T22:00:00.000Z', text: refusal };

  // Taken by the usage-limit classifier: the relay pauses on this kind.
  await publisher.publishErrorResult({
    message,
    state: { result: { ...refused, usageLimit }, lastStreamedText: `Renaming the module now.\n\n${refusal}` },
    responseModel: 'claude-sonnet-5',
  });
  // Not taken (no report from the CLI, as with an API key): a failure like
  // any other, named after the rate limit.
  await publisher.publishErrorResult({
    message,
    state: { result: { ...refused, usageLimit: null }, lastStreamedText: '' },
    responseModel: 'claude-sonnet-5',
  });
  await publisher.publishTurnException({ message, errorText: `Claude Code returned an error result: ${refusal}`, usageLimit });

  assert.equal(bodies[0].terminalError.kind, 'claude-usage-limit');
  assert.equal(bodies[0].terminalError.stableCode, 'claude.usage-limit');
  assert.equal(bodies[0].terminalError.resetsAt, usageLimit.resetsAt);
  assert.equal(bodies[0].terminalError.rateLimitType, 'five_hour');
  // What the turn wrote, without the CLI's own line about the limit.
  assert.equal(bodies[0].partialText, 'Renaming the module now.');

  assert.equal(bodies[1].terminalError.kind, 'claude-turn-failed');
  assert.equal(bodies[1].terminalError.stableCode, 'claude.rate_limit');
  assert.equal('partialText' in bodies[1], false);

  assert.equal(bodies[2].terminalError.kind, 'claude-usage-limit');
  assert.equal(bodies[2].terminalError.resetsAt, usageLimit.resetsAt);
});
