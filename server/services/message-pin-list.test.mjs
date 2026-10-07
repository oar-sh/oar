import test from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_PIN_LIMIT, PIN_PREVIEW_MAX_LENGTH, buildPinList, buildPinPreview } from './message-pin-list.mjs';

test('a preview is one line of plain text', () => {
  assert.equal(buildPinPreview('  first line\n\n  second   line\t\n'), 'first line second line');
});

test('a preview drops the markdown that would only be noise in a list', () => {
  assert.equal(buildPinPreview('## Release steps\n\n- tag the **build**\n- see [the notes](https://example.com/notes)'), 'Release steps tag the build see the notes');
  assert.equal(buildPinPreview('> quoted\n1. first\n2) second'), 'quoted first second');
  assert.equal(buildPinPreview('Run `npm test` now:\n```sh\nnpm test\n```'), 'Run npm test now: npm test');
  assert.equal(buildPinPreview('![chart](https://example.com/chart.png) and ![](x.png)'), '🖼 chart and 🖼');
});

test('names with single underscores and stars are left alone', () => {
  assert.equal(buildPinPreview('set draft_updated_at and glob *.mjs'), 'set draft_updated_at and glob *.mjs');
});

test('a long preview is cut with an ellipsis, never through an emoji', () => {
  const long = 'word '.repeat(80);
  const preview = buildPinPreview(long);
  assert.equal(Array.from(preview).length <= PIN_PREVIEW_MAX_LENGTH, true);
  assert.equal(preview.endsWith('…'), true);

  const emojiAtCut = `${'e'.repeat(PIN_PREVIEW_MAX_LENGTH - 2)}😀😀😀`;
  const cut = buildPinPreview(emojiAtCut);
  assert.equal(cut, `${'e'.repeat(PIN_PREVIEW_MAX_LENGTH - 2)}😀…`);
  assert.equal(/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), false, 'no lone surrogate before the ellipsis');
});

test('an exact-length text is not cut', () => {
  const exact = 'x'.repeat(PIN_PREVIEW_MAX_LENGTH);
  assert.equal(buildPinPreview(exact), exact);
});

test('empty and missing text give an empty preview', () => {
  assert.equal(buildPinPreview(''), '');
  assert.equal(buildPinPreview(null), '');
  assert.equal(buildPinPreview(undefined, 'agent'), '');
});

test('the list maps rows to what the browser shows and keeps their order', () => {
  const pins = buildPinList([
    {
      id: 'msg-1', role: 'user', text: 'please keep this', mode: 'agent',
      attachments: JSON.stringify([{ name: 'notes.txt' }, { name: 'chart.png' }]),
      timestamp: '2026-10-05T10:00:00.000Z', pinned_at: '2026-10-05T11:00:00.000Z', hidden_from_shares: 1,
    },
    {
      id: 'msg-2', role: 'assistant', text: '# Result\nAll done.', mode: null, attachments: null,
      timestamp: '2026-10-05T10:01:00.000Z', pinned_at: '2026-10-05T10:30:00.000Z', hidden_from_shares: 0,
    },
  ]);
  assert.deepEqual(pins, [
    {
      messageId: 'msg-1', role: 'user', preview: 'please keep this',
      timestamp: '2026-10-05T10:00:00.000Z', pinnedAt: '2026-10-05T11:00:00.000Z',
      attachmentCount: 2, hiddenFromShares: true,
    },
    {
      messageId: 'msg-2', role: 'assistant', preview: 'Result All done.',
      timestamp: '2026-10-05T10:01:00.000Z', pinnedAt: '2026-10-05T10:30:00.000Z',
      attachmentCount: 0, hiddenFromShares: false,
    },
  ]);
});

test('the list skips rows that are not pins and survives broken attachment JSON', () => {
  assert.deepEqual(buildPinList(null), []);
  const pins = buildPinList([
    { id: 'msg-unpinned', role: 'user', text: 'no', timestamp: 't', pinned_at: null },
    { id: '', role: 'user', text: 'no id', timestamp: 't', pinned_at: '2026-10-05T10:00:00.000Z' },
    { id: 'msg-3', role: 'user', text: '', attachments: '{not json', timestamp: 't', pinned_at: '2026-10-05T10:00:00.000Z' },
  ]);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].messageId, 'msg-3');
  assert.equal(pins[0].preview, '');
  assert.equal(pins[0].attachmentCount, 0);
});

test('the limit is a round number the route and the notice can name', () => {
  assert.equal(MESSAGE_PIN_LIMIT, 100);
});
