import test from 'node:test';
import assert from 'node:assert/strict';

import { describeShare, describeShareOpen } from './share-format.mjs';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

test('a share row says when it was shared, renewed and opened, and how often', () => {
  assert.equal(describeShare({
    sharedSince: '2026-10-13T12:00:00.000Z',
    renewedAt: '2026-10-16T10:00:00.000Z',
    lastOpenedAt: '2026-10-16T11:55:00.000Z',
    openCount: 4,
    viewerCount: 1,
  }, NOW), 'shared 3 d ago · new link 2 h ago · last opened 5 min ago · 4 opens · 1 viewer');
  assert.equal(describeShare({ sharedSince: '2026-10-16T11:59:30.000Z', openCount: 1, viewerCount: 0, archived: true }, NOW),
    'shared just now · never opened · 1 open · 0 viewers · archived');
});

test('an access log entry names time, country, address and viewer', () => {
  const text = describeShareOpen({ openedAt: '2026-10-16T11:55:00.000Z', country: 'DE', ip: '203.0.113.10', viewer: '1a2b3c4d' }, { locale: 'en-GB' });
  assert.match(text, /2026/);
  assert.match(text, / · DE · 203\.0\.113\.10 · viewer 1a2b3c4d$/);
  assert.match(describeShareOpen({ openedAt: '2026-10-16T11:55:00.000Z', ip: null }), / · IP not stored$/);
});
