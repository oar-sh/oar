import test from 'node:test';
import assert from 'node:assert/strict';

import { archiveConfirmationFor } from './archive-confirm.mjs';

test('an offline chat archives at once', () => {
  assert.equal(archiveConfirmationFor({ visualState: 'offline' }), null);
  assert.equal(archiveConfirmationFor({}), null);
  assert.equal(archiveConfirmationFor(), null);
});

test('a green chat with an idle process asks first', () => {
  const confirmation = archiveConfirmationFor({ visualState: 'ready' });
  assert.equal(confirmation.reason, 'active');
  assert.equal(confirmation.message, 'Archive this session? Its process is still active.');
  assert.equal(archiveConfirmationFor({ visualState: ' Ready ' })?.reason, 'active');
});

test('a chat with a running turn asks first, whatever its row shows', () => {
  for (const visualState of ['ready', 'offline', 'question', 'error', '']) {
    assert.equal(archiveConfirmationFor({ visualState, running: true })?.reason, 'running');
  }
  assert.match(archiveConfirmationFor({ running: true }).message, /still working on a reply/);
});

test('the other row states are not green and archive at once', () => {
  assert.equal(archiveConfirmationFor({ visualState: 'question' }), null);
  assert.equal(archiveConfirmationFor({ visualState: 'error' }), null);
});

test('an archived chat never asks (unarchive is not guarded)', () => {
  assert.equal(archiveConfirmationFor({ archived: true, visualState: 'ready', running: true }), null);
});

test('only a real true counts as running', () => {
  assert.equal(archiveConfirmationFor({ running: 'yes' }), null);
  assert.equal(archiveConfirmationFor({ running: 1 }), null);
});
