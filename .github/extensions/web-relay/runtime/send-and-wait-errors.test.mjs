import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTerminalSendAndWaitError,
  normalizeTerminalSendAndWaitError,
} from './send-and-wait-errors.mjs';

test('classifies provider HTTP 400 text as terminal', () => {
  const error = new Error(
    "400 Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions.",
  );
  const normalized = normalizeTerminalSendAndWaitError(error);
  assert.equal(isTerminalSendAndWaitError(error), true);
  assert.equal(normalized?.stableCode, 'relay.request-invalid');
});
