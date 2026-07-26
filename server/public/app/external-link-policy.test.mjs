import assert from 'node:assert/strict';
import test from 'node:test';

import { isExternalNavigationHref } from './external-link-policy.mjs';

const BASE_URL = 'https://relay.example.test/shared/session';

test('recognizes HTTP(S) links, including relative application links', () => {
  assert.equal(isExternalNavigationHref('https://github.com', BASE_URL), true);
  assert.equal(isExternalNavigationHref('/api/files/README.md', BASE_URL), true);
  assert.equal(isExternalNavigationHref('../docs/guide.html', BASE_URL), true);
});

test('does not treat fragments or non-web schemes as external navigation', () => {
  assert.equal(isExternalNavigationHref('', BASE_URL), false);
  assert.equal(isExternalNavigationHref('#section', BASE_URL), false);
  assert.equal(isExternalNavigationHref('javascript:alert(1)', BASE_URL), false);
  assert.equal(isExternalNavigationHref('data:text/html,unsafe', BASE_URL), false);
  assert.equal(isExternalNavigationHref('mailto:hello@example.test', BASE_URL), false);
});
