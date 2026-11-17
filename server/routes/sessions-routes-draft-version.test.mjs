import assert from 'node:assert/strict';
import test from 'node:test';

import { hasConversationDraftVersionConflict, normalizeOptionalIsoTimestamp } from './conversation-settings-routes.mjs';

test('normalizeOptionalIsoTimestamp normalizes valid ISO values', () => {
  const normalized = normalizeOptionalIsoTimestamp('2026-06-20T10:11:12.123Z');
  assert.equal(normalized, '2026-06-20T10:11:12.123Z');
});

test('normalizeOptionalIsoTimestamp returns null for invalid values', () => {
  assert.equal(normalizeOptionalIsoTimestamp('not-a-time'), null);
  assert.equal(normalizeOptionalIsoTimestamp(''), null);
  assert.equal(normalizeOptionalIsoTimestamp(null), null);
});

test('hasConversationDraftVersionConflict detects stale base timestamp', () => {
  const conflict = hasConversationDraftVersionConflict({
    existingDraftUpdatedAt: '2026-06-20T10:11:13.000Z',
    baseDraftUpdatedAt: '2026-06-20T10:11:12.000Z',
    compareEnabled: true,
  });
  assert.equal(conflict, true);
});

test('hasConversationDraftVersionConflict allows matching timestamp', () => {
  const conflict = hasConversationDraftVersionConflict({
    existingDraftUpdatedAt: '2026-06-20T10:11:13.000Z',
    baseDraftUpdatedAt: '2026-06-20T10:11:13.000Z',
    compareEnabled: true,
  });
  assert.equal(conflict, false);
});

test('hasConversationDraftVersionConflict allows null baseline when server draft is empty', () => {
  const conflict = hasConversationDraftVersionConflict({
    existingDraftUpdatedAt: null,
    baseDraftUpdatedAt: null,
    compareEnabled: true,
  });
  assert.equal(conflict, false);
});

test('hasConversationDraftVersionConflict is disabled when compare flag is false', () => {
  const conflict = hasConversationDraftVersionConflict({
    existingDraftUpdatedAt: '2026-06-20T10:11:13.000Z',
    baseDraftUpdatedAt: '2026-06-20T10:11:12.000Z',
    compareEnabled: false,
  });
  assert.equal(conflict, false);
});
