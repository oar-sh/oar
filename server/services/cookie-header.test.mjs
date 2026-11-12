import test from 'node:test';
import assert from 'node:assert/strict';

import { cookieValues, parseCookies } from './cookie-header.mjs';

// The Cookie header as browsers send it (made-up values only).

test('parseCookies: the first value of each name; a malformed % skips that cookie, not the request', () => {
  assert.deepEqual(parseCookies('a=1; b=two%20words; a=3'), { a: '1', b: 'two words' });
  assert.deepEqual(parseCookies('bad=%E0%A4%A; good=yes'), { good: 'yes' });
  // A malformed first value does not hide a readable second one of the same name.
  assert.deepEqual(parseCookies('a=%; a=fine'), { a: 'fine' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('novalue; =empty-name; c='), { c: '' });
});

test('cookieValues: every readable value of one name, in header order', () => {
  assert.deepEqual(cookieValues('copilot_auth=one; other=x; copilot_auth=two', 'copilot_auth'), ['one', 'two']);
  assert.deepEqual(cookieValues('copilot_auth=%zz; copilot_auth=two', 'copilot_auth'), ['two']);
  assert.deepEqual(cookieValues('other=x', 'copilot_auth'), []);
  assert.deepEqual(cookieValues('copilot_auth=one', ''), []);
});
