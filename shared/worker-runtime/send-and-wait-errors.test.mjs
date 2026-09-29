import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTerminalFailureText,
  isStructuredQuotaError,
  isTerminalSendAndWaitError,
  normalizeTerminalSendAndWaitError,
  toKebabToken,
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

test('a structured quota hint outranks milder prose', () => {
  // The failure mode this guards: GitHub rewords the prose ("reached your
  // monthly quota" has no "exceeded"/"exhausted"), the prose branch misses,
  // and a non-retryable billing failure is retried until the row dies with a
  // misleading timeout.
  const error = new Error('You have reached your monthly quota for this model');
  assert.equal(normalizeTerminalSendAndWaitError(error), null);
  const hinted = normalizeTerminalSendAndWaitError(error, { quota: true });
  assert.equal(hinted?.stableCode, 'relay.quota-exhausted');
  assert.match(hinted?.message || '', /no AI credits left/);
});

test('every structured quota field classifies on its own, whatever the prose says', () => {
  const prose = new Error('Payment required for this model');
  for (const options of [
    { errorCode: 'quota_exceeded' },
    { errorCode: 'session_quota_exceeded' },
    { errorType: 'quota' },
    { statusCode: 402 },
  ]) {
    assert.equal(
      normalizeTerminalSendAndWaitError(prose, options)?.stableCode,
      'relay.quota-exhausted',
      JSON.stringify(options),
    );
  }
});

test('structured fields carried on the error object itself are read too', () => {
  const error = Object.assign(new Error('request rejected'), { statusCode: 402 });
  assert.equal(normalizeTerminalSendAndWaitError(error)?.stableCode, 'relay.quota-exhausted');
  const coded = Object.assign(new Error('request rejected'), { code: 'quota_exceeded' });
  assert.equal(isTerminalSendAndWaitError(coded), true);
});

test('a non-quota structured hint changes nothing', () => {
  // Only quota is modelled; anything else must fall through to the prose
  // branches exactly as before.
  assert.equal(normalizeTerminalSendAndWaitError(new Error('socket hang up'), { errorType: 'network' }), null);
  assert.equal(
    normalizeTerminalSendAndWaitError(new Error('rate limit exceeded'), { errorCode: 'rate_limited' }),
    null,
  );
  assert.equal(isStructuredQuotaError({ statusCode: 500 }), false);
  assert.equal(isStructuredQuotaError(null), false);
});

test('buildTerminalFailureText honours the structured hint as well', () => {
  const text = buildTerminalFailureText(new Error('You have reached your monthly quota'), { quota: true });
  assert.match(text, /Error code: relay\.quota-exhausted\./);
  assert.match(text, /Open Check Usage/);
});

test('toKebabToken is exported for callers building provider-scoped codes', () => {
  assert.equal(toKebabToken('Session Error'), 'session-error');
  assert.equal(toKebabToken('quota_exceeded'), 'quota-exceeded');
  assert.equal(toKebabToken('  '), null);
  assert.equal(toKebabToken(null), null);
});

test('no terminal failure advises a relay restart', () => {
  // The session workers replace their own runtime: a relay restart repairs
  // nothing and interrupts every other running session.
  const cases = [
    ['No tool output found for function call call_abc123', 'relay.missing-tool-output',
      'Send the message again to retry. If this keeps happening, include the error code when you report it.'],
    ['tool call call_abc123 not found', 'relay.tool-call-missing',
      'Send the message again to retry. If it repeats, include the error code when you report it.'],
    ['tool output was invalid', 'relay.invalid-tool-output',
      'Send the message again to retry. If it repeats, include the error code when you report it.'],
    ['400 the request body is malformed', 'relay.request-invalid',
      'Retry after adjusting the request. If it persists, include the error code when you report it.'],
    ['You have exceeded your monthly quota', 'relay.quota-exhausted', null],
  ];
  for (const [detail, stableCode, guidance] of cases) {
    const normalized = normalizeTerminalSendAndWaitError(new Error(detail));
    assert.equal(normalized?.stableCode, stableCode, detail);
    if (guidance) assert.equal(normalized.guidance, guidance);
    assert.doesNotMatch(normalized.guidance, /restart/i, detail);
    assert.doesNotMatch(buildTerminalFailureText(new Error(detail)), /restart/i, detail);
  }
  assert.doesNotMatch(buildTerminalFailureText(new Error('something unheard of')), /restart/i);
});
