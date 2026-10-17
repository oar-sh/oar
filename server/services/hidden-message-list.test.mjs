import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHiddenMessageList } from './hidden-message-list.mjs';

test('each hidden message becomes a row with a one-line preview', () => {
  const list = buildHiddenMessageList([
    {
      id: ' msg-1 ',
      role: 'user',
      text: '## Deploy notes\n\n- token for **relay-b.example.test**',
      mode: 'agent',
      attachments: JSON.stringify([{ name: 'a.png' }, { name: 'b.png' }]),
      timestamp: '2026-10-16T10:00:00.000Z',
      share_hidden_at: '2026-10-16T11:00:00.000Z',
    },
    { id: 'msg-2', role: 'assistant', text: '', timestamp: '2026-10-16T10:00:05.000Z', share_hidden_at: null },
  ]);
  assert.deepEqual(list, [
    {
      messageId: 'msg-1',
      role: 'user',
      preview: 'Deploy notes token for relay-b.example.test',
      timestamp: '2026-10-16T10:00:00.000Z',
      hiddenAt: '2026-10-16T11:00:00.000Z',
      attachmentCount: 2,
    },
    {
      messageId: 'msg-2',
      role: 'assistant',
      preview: '',
      timestamp: '2026-10-16T10:00:05.000Z',
      hiddenAt: null,
      attachmentCount: 0,
    },
  ]);
});

test('rows without an id are dropped, and no rows is an empty list', () => {
  assert.deepEqual(buildHiddenMessageList([{ id: '  ', role: 'user', text: 'x' }]), []);
  assert.deepEqual(buildHiddenMessageList(null), []);
});
