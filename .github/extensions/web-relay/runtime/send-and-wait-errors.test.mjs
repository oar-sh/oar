import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTerminalSendAndWaitError,
  normalizeTerminalSendAndWaitError,
} from './send-and-wait-errors.mjs';

test('classifies monthly quota exhaustion as terminal with the full request id', () => {
  const error = new Error(
    'You have exceeded your monthly quota (Request ID: AFAC:3C07CD:2E1734D:38B37AF:6A954015)',
  );
  const normalized = normalizeTerminalSendAndWaitError(error);
  assert.equal(isTerminalSendAndWaitError(error), true);
  assert.equal(normalized?.stableCode, 'relay.quota-exhausted');
  assert.equal(normalized?.requestId, 'AFAC:3C07CD:2E1734D:38B37AF:6A954015');
  assert.match(normalized?.guidance || '', /Check Usage/);
});

test('a rate limit stays retryable — only plan quota is terminal', () => {
  assert.equal(isTerminalSendAndWaitError(new Error('rate limit exceeded, retry shortly')), false);
});

test('classifies provider HTTP 400 text as terminal', () => {
  const error = new Error(
    "400 Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions.",
  );
  const normalized = normalizeTerminalSendAndWaitError(error);
  assert.equal(isTerminalSendAndWaitError(error), true);
  assert.equal(normalized?.stableCode, 'relay.request-invalid');
});
