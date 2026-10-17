import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SHARE_PATH_PRIVACY_MODE,
  SHARE_PATH_PRIVACY_LABELS,
  SHARE_PATH_PRIVACY_MODES,
  parseSharePathPrivacyUpdate,
  readSharePathPrivacySetting,
} from './share-path-privacy.mjs';

test('the default hides the path and keeps the file name', () => {
  assert.equal(DEFAULT_SHARE_PATH_PRIVACY_MODE, 'filename');
  for (const stored of [undefined, null, '', 'all', 'SHOW ']) {
    assert.equal(readSharePathPrivacySetting(stored), stored === 'SHOW ' ? 'show' : 'filename');
  }
});

test('an update takes one of the three modes, nothing else', () => {
  for (const mode of SHARE_PATH_PRIVACY_MODES) assert.deepEqual(parseSharePathPrivacyUpdate(mode), { ok: true, mode });
  assert.equal(parseSharePathPrivacyUpdate('everything').ok, false);
  assert.equal(parseSharePathPrivacyUpdate(undefined).ok, false);
});

test('every mode has its label', () => {
  assert.deepEqual(Object.keys(SHARE_PATH_PRIVACY_LABELS).sort(), [...SHARE_PATH_PRIVACY_MODES].sort());
});
