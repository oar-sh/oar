import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PWA_APP_NAME_DEFAULT,
  PWA_APP_NAME_MAX_LENGTH,
  derivePwaShortName,
  normalizePwaAppName,
  readPwaAppNameSetting,
  resolvePwaManifestNames,
} from './pwa-app-name.mjs';

test('normalization collapses whitespace and treats empty as "use the default"', () => {
  assert.deepEqual(normalizePwaAppName('  My   Dev\tRelay  '), { ok: true, value: 'My Dev Relay' });
  assert.deepEqual(normalizePwaAppName(''), { ok: true, value: '' });
  assert.deepEqual(normalizePwaAppName('   '), { ok: true, value: '' });
  assert.deepEqual(normalizePwaAppName(null), { ok: true, value: '' });
  assert.deepEqual(normalizePwaAppName(undefined), { ok: true, value: '' });
});

test('names over the cap are rejected, not truncated', () => {
  const long = 'x'.repeat(PWA_APP_NAME_MAX_LENGTH + 1);
  const result = normalizePwaAppName(long);
  assert.equal(result.ok, false);
  assert.match(result.error, /60 characters or fewer/);
  assert.equal(normalizePwaAppName('x'.repeat(PWA_APP_NAME_MAX_LENGTH)).ok, true);
});

test('non-string input degrades to a string instead of throwing', () => {
  assert.deepEqual(normalizePwaAppName(42), { ok: true, value: '42' });
});

test('a stored setting reads back normalized, and junk reads as default', () => {
  assert.equal(readPwaAppNameSetting(' My Relay '), 'My Relay');
  assert.equal(readPwaAppNameSetting(''), '');
  assert.equal(readPwaAppNameSetting(null), '');
  assert.equal(readPwaAppNameSetting('x'.repeat(PWA_APP_NAME_MAX_LENGTH + 5)), '', 'over-long stored junk means default');
});

test('short names take the first word when it fits, else a 12-char slice', () => {
  assert.equal(derivePwaShortName('My Dev Relay'), 'My');
  assert.equal(derivePwaShortName('Relay'), 'Relay');
  assert.equal(derivePwaShortName('Supercalifragilistic Relay'), 'Supercalifra');
  assert.equal(derivePwaShortName(''), PWA_APP_NAME_DEFAULT);
  assert.equal(derivePwaShortName(null), PWA_APP_NAME_DEFAULT);
});

test('manifest names use the custom name, falling back to the template then the default', () => {
  assert.deepEqual(resolvePwaManifestNames('My Dev Relay', 'OAR'), { name: 'My Dev Relay', short_name: 'My' });
  assert.deepEqual(resolvePwaManifestNames('', 'OAR'), { name: 'OAR', short_name: 'OAR' });
  assert.deepEqual(resolvePwaManifestNames('', ''), {
    name: PWA_APP_NAME_DEFAULT,
    short_name: PWA_APP_NAME_DEFAULT,
  });
});
