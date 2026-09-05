import test from 'node:test';
import assert from 'node:assert/strict';

import { channelForVersion, compareSemverIsh, parseSemverIsh } from './update-semver.mjs';

test('release versions order by triple', () => {
  assert.equal(compareSemverIsh('0.9.1', '0.9.0'), 1);
  assert.equal(compareSemverIsh('0.9.1', '0.10.0'), -1);
  assert.equal(compareSemverIsh('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemverIsh('0.9.1', '0.9.1'), 0);
  assert.equal(compareSemverIsh('v0.9.2', '0.9.1'), 1, 'a leading v is tolerated');
});

test('prereleases sort below the release with the same triple', () => {
  assert.equal(compareSemverIsh('0.9.1-beta.2', '0.9.1'), -1);
  assert.equal(compareSemverIsh('0.9.1', '0.9.1-beta.2'), 1);
  assert.equal(compareSemverIsh('0.9.1-beta.2', '0.9.1-beta.1'), 1);
  assert.equal(compareSemverIsh('0.9.1-beta.2', '0.9.0'), 1);
  assert.equal(compareSemverIsh('0.9.1-beta.1', '0.9.1-beta.1'), 0);
});

test('garbage parses to null and compares as equal (no update)', () => {
  assert.equal(parseSemverIsh('not-a-version'), null);
  assert.equal(parseSemverIsh(''), null);
  assert.equal(parseSemverIsh(null), null);
  assert.equal(compareSemverIsh('garbage', '0.9.1'), 0);
  assert.equal(compareSemverIsh('0.9.1', undefined), 0);
});

test('channel follows the installed version', () => {
  assert.equal(channelForVersion('0.9.1'), 'stable');
  assert.equal(channelForVersion('0.9.1-beta.1'), 'beta');
  assert.equal(channelForVersion('0.9.1-beta'), 'beta');
  assert.equal(channelForVersion('junk'), 'stable');
});
