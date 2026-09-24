import test from 'node:test';
import assert from 'node:assert/strict';

import { isLiveResend, liveResendsByOriginal } from './steer-resend.mjs';

test('a queued or running Resend stands; a failed or cancelled one does not', () => {
  assert.equal(isLiveResend({ hasQueueRow: true, queueStatus: 'pending' }), true);
  assert.equal(isLiveResend({ hasQueueRow: true, queueStatus: 'processing' }), true);
  assert.equal(isLiveResend({ hasQueueRow: true, queueStatus: 'failed' }), false);
  // Cancel deletes the queue row, and nothing ever answered it.
  assert.equal(isLiveResend({ hasQueueRow: false, answered: false }), false);
  // A finished Resend whose queue row was pruned is proven by its answer.
  assert.equal(isLiveResend({ hasQueueRow: false, answered: true }), true);
});

test('each original maps to the Resend of it that still stands', () => {
  const messages = [
    { id: 'orig-1', role: 'user' },
    { id: 'resend-cancelled', role: 'user', resend_of_message_id: 'orig-1' },
    { id: 'resend-live', role: 'user', resend_of_message_id: 'orig-1' },
    { id: 'orig-2', role: 'user' },
    { id: 'resend-answered', role: 'user', resend_of_message_id: 'orig-2' },
    { id: 'answer', role: 'assistant', source_message_id: 'resend-answered' },
    { id: 'orig-3', role: 'user' },
    { id: 'resend-failed', role: 'user', resend_of_message_id: 'orig-3' },
  ];
  const queue = [
    { id: 'resend-live', status: 'pending' },
    { id: 'resend-failed', status: 'failed', response_message_id: 'failure-bubble' },
  ];
  const live = liveResendsByOriginal(messages, queue);
  assert.equal(live.get('orig-1'), 'resend-live');
  assert.equal(live.get('orig-2'), 'resend-answered');
  assert.equal(live.has('orig-3'), false);
});
