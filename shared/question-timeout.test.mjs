import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_QUESTION_TIMEOUT_MS, questionExpiresAt } from './question-timeout.mjs';

const CREATED_AT = '2026-09-01T20:42:29.371Z';
const createdMs = new Date(CREATED_AT).getTime();

function expiresMs(timeoutMs) {
  return new Date(questionExpiresAt(CREATED_AT, timeoutMs)).getTime();
}

test('a missing timeout falls back to the 8h default', () => {
  assert.equal(expiresMs(undefined), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
  assert.equal(new Date(questionExpiresAt(CREATED_AT)).getTime(), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
});

test('null falls back to the default instead of collapsing to zero', () => {
  // Regression: the route feeds normalizeTimeoutMs(req.body.timeout_ms) in,
  // which is null when the caller omits timeout_ms. null skips a default
  // parameter and Number(null) === 0, so questions expired at creation and the
  // 10s sweeper killed them before anyone could answer (relay-question-ui:82).
  assert.equal(expiresMs(null), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
});

test('non-number junk falls back to the default', () => {
  assert.equal(expiresMs(NaN), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
  assert.equal(expiresMs('soon'), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
  assert.equal(expiresMs(Infinity), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
  // Strings are junk even when numeric-looking: a timeout must fail toward
  // "lives the default", never toward an accidental early expiry.
  assert.equal(expiresMs('5000'), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
  assert.equal(expiresMs(''), createdMs + DEFAULT_QUESTION_TIMEOUT_MS);
});

test('explicit finite timeouts are honored, including zero', () => {
  assert.equal(expiresMs(120000), createdMs + 120000);
  assert.equal(expiresMs(0), createdMs);
  assert.equal(expiresMs(-5000), createdMs, 'negative clamps to zero');
  assert.equal(expiresMs(1500.9), createdMs + 1500, 'fractional truncates');
});
