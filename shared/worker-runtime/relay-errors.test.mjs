import test from 'node:test';
import assert from 'node:assert/strict';

import { isRelayUnreachableError, isTransientRelayError } from './relay-errors.mjs';

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const fetchFailed = (code) => Object.assign(new TypeError('fetch failed'), code ? { cause: { code } } : {});

test('a request that did not get through is transient', () => {
  assert.equal(isTransientRelayError(fetchFailed()), true);
  assert.equal(isTransientRelayError(fetchFailed('ECONNRESET')), true);
  assert.equal(isTransientRelayError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), true);
});

test('an answer from something in front of the relay is transient', () => {
  for (const status of [500, 502, 503, 504, 408, 429]) assert.equal(isTransientRelayError(httpError(status)), true, String(status));
});

test('the relay\'s own refusal is not, and neither is the caller\'s abort', () => {
  for (const status of [400, 401, 404, 409]) assert.equal(isTransientRelayError(httpError(status)), false, String(status));
  assert.equal(isTransientRelayError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
});

test('only a refused or unroutable connection proves the request never arrived', () => {
  assert.equal(isRelayUnreachableError(fetchFailed('ECONNREFUSED')), true);
  assert.equal(isRelayUnreachableError(fetchFailed('EHOSTUNREACH')), true);
  assert.equal(isRelayUnreachableError(fetchFailed('ECONNRESET')), false);
  assert.equal(isRelayUnreachableError(fetchFailed()), false);
  assert.equal(isRelayUnreachableError(httpError(503)), false);
});
