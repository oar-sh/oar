import assert from 'node:assert/strict';
import test from 'node:test';

import { validateEntryName } from './explorer-entry-name.mjs';

const linux = { platform: 'linux' };
const windows = { platform: 'win32' };

test('accepts an ordinary name and trims it', () => {
  assert.deepEqual(validateEntryName('  notes ', linux), { ok: true, name: 'notes' });
  assert.deepEqual(validateEntryName('Ünïcödé 日本', windows), { ok: true, name: 'Ünïcödé 日本' });
});

test('rejects empty names and the dot names', () => {
  assert.equal(validateEntryName('', linux).ok, false);
  assert.equal(validateEntryName('   ', linux).ok, false);
  assert.equal(validateEntryName('.', linux).ok, false);
  assert.equal(validateEntryName('..', linux).ok, false);
  assert.equal(validateEntryName(null, linux).ok, false);
});

test('rejects separators and NUL on every platform', () => {
  for (const name of ['a/b', 'a\\b', '/abs', 'nul\0byte']) {
    assert.equal(validateEntryName(name, linux).ok, false, name);
    assert.equal(validateEntryName(name, windows).ok, false, name);
  }
});

test('rejects names over 255 bytes', () => {
  assert.equal(validateEntryName('x'.repeat(255), linux).ok, true);
  assert.equal(validateEntryName('x'.repeat(256), linux).ok, false);
  // 4 bytes per character: 64 of them are 256 bytes.
  assert.equal(validateEntryName('😀'.repeat(64), linux).ok, false);
});

test('Windows rules apply only on Windows', () => {
  // A trailing space is trimmed away before the rules run, so only the dot is left to refuse.
  for (const name of ['a:b', 'what?', 'trailing.', 'CON', 'com1.txt', 'Lpt9']) {
    assert.equal(validateEntryName(name, windows).ok, false, name);
    assert.equal(validateEntryName(name, linux).ok, true, name);
  }
  assert.equal(validateEntryName('console', windows).ok, true);
  assert.equal(validateEntryName('com10', windows).ok, true);
});
