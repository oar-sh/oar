import test from 'node:test';
import assert from 'node:assert/strict';

import { latestModelCatalogRefresh } from './model-catalog-freshness.mjs';

test('uses the newest valid model catalog timestamp', () => {
  assert.equal(
    latestModelCatalogRefresh(
      '2026-07-12T07:32:22.351Z',
      '2026-07-12T09:03:53.203Z',
    ),
    '2026-07-12T09:03:53.203Z',
  );
});

test('ignores invalid timestamps and returns null when none parse', () => {
  assert.equal(latestModelCatalogRefresh(null, '', 'not-a-date'), null);
  assert.equal(
    latestModelCatalogRefresh(null, '2026-07-12T09:03:53.203Z', 'not-a-date'),
    '2026-07-12T09:03:53.203Z',
  );
});
