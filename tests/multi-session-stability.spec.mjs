import { expect, test } from '@playwright/test';
import { relayToken } from './e2e-env.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMessage(request, headers, { text, conversationId = null }) {
  const response = await request.post('/api/message', {
    headers,
    data: {
      text,
      conversationId: conversationId || undefined,
      relayMode: 'agent',
      model: 'gpt-5.4-mini',
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function dequeueSpecificMessage(request, headers, messageId, maxAttempts = 40, ownerSessionId = '') {
  // Owned rows (session-worker routing enabled) are invisible to anonymous
  // polls; claim them with the owner identity POST /api/message reported.
  const dequeueHeaders = String(ownerSessionId || '').trim()
    ? { ...headers, 'x-relay-session-id': String(ownerSessionId).trim() }
    : headers;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const dequeued = await request.get('/api/pending', { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const body = await dequeued.json();
    const msg = body?.message || null;
    if (!msg) {
      await sleep(150);
      continue;
    }
    if (String(msg.id || '') === String(messageId || '')) {
      return msg;
    }
    await request.post('/api/requeue', {
      headers,
      data: { messageId: String(msg.id || '') },
    }).catch(() => {});
    await sleep(120);
  }
  throw new Error(`Timed out waiting to dequeue ${String(messageId || '').slice(0, 8)}`);
}

async function openConversation(page, conversationId) {
  await page.waitForFunction(() => typeof window.openConversation === 'function');
  await page.evaluate(async (id) => {
    await window.openConversation(id);
  }, conversationId);
}

test('keeps stream/activity session-bound while switching and avoids duplicate user turn rows', async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedA = `multi-session-a-${stamp}`;
  const seedB = `multi-session-b-${stamp}`;
  const activityA = `tool-activity-a-${stamp}`;
  const activityB = `tool-activity-b-${stamp}`;
  const streamA = `thinking-a-${stamp}`;
  const streamB = `thinking-b-${stamp}`;
  const duplicateText = `duplicate-guard-${stamp}`;
  const sdkSessionA = `pw-sid-a-${stamp}`;
  const sdkSessionB = `pw-sid-b-${stamp}`;
  let convA = '';
  let convB = '';
  let msgA = '';
  let msgB = '';
  let followupA = '';

  try {
    const first = await createMessage(request, headers, { text: seedA });
    convA = String(first?.conversationId || '').trim();
    msgA = String(first?.messageId || '').trim();
    expect(convA).toBeTruthy();
    expect(msgA).toBeTruthy();
    await dequeueSpecificMessage(request, headers, msgA, 40, String(first?.ownerSessionId || ''));

    const second = await createMessage(request, headers, { text: seedB });
    convB = String(second?.conversationId || '').trim();
    msgB = String(second?.messageId || '').trim();
    expect(convB).toBeTruthy();
    expect(msgB).toBeTruthy();
    await dequeueSpecificMessage(request, headers, msgB, 40, String(second?.ownerSessionId || ''));

    const syncA = await request.post('/api/session-sync', {
      headers,
      data: {
        sdk_session_id: sdkSessionA,
        conversation_id: convA,
      },
    });
    expect(syncA.ok()).toBeTruthy();
    const syncB = await request.post('/api/session-sync', {
      headers,
      data: {
        sdk_session_id: sdkSessionB,
        conversation_id: convB,
      },
    });
    expect(syncB.ok()).toBeTruthy();

    const streamRespA = await request.post('/api/stream', {
      headers,
      data: { messageId: msgA, conversationId: convA, text: streamA, mode: 'agent', done: false },
    });
    expect(streamRespA.ok()).toBeTruthy();
    const activityRespA = await request.post('/api/activity', {
      headers,
      data: { messageId: msgA, conversationId: convA, text: activityA, mode: 'agent' },
    });
    expect(activityRespA.ok()).toBeTruthy();

    const streamRespB = await request.post('/api/stream', {
      headers,
      data: { messageId: msgB, conversationId: convB, text: streamB, mode: 'agent', done: false },
    });
    expect(streamRespB.ok()).toBeTruthy();
    const activityRespB = await request.post('/api/activity', {
      headers,
      data: { messageId: msgB, conversationId: convB, text: activityB, mode: 'agent' },
    });
    expect(activityRespB.ok()).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState('networkidle');

    await openConversation(page, convA);
    await expect(page.locator('#thinking-indicator')).toBeVisible();
    await expect(page.locator('#thinking-stream')).toContainText(streamA);
    await expect(page.locator('#thinking-activity .thinking-activity-item', { hasText: activityA })).toHaveCount(1);

    await openConversation(page, convB);
    await expect(page.locator('#thinking-indicator')).toBeVisible();
    await expect(page.locator('#thinking-stream')).toContainText(streamB);
    await expect(page.locator('#thinking-stream')).not.toContainText(streamA);
    await expect(page.locator('#thinking-activity .thinking-activity-item', { hasText: activityB })).toHaveCount(1);
    await expect(page.locator('#thinking-activity .thinking-activity-item', { hasText: activityA })).toHaveCount(0);

    await openConversation(page, convA);
    await expect(page.locator('#thinking-stream')).toContainText(streamA);
    await expect(page.locator('#thinking-stream')).not.toContainText(streamB);

    const firstFollowup = await createMessage(request, headers, { text: duplicateText, conversationId: convA });
    followupA = String(firstFollowup?.messageId || '').trim();
    expect(followupA).toBeTruthy();
    const secondFollowup = await createMessage(request, headers, { text: duplicateText, conversationId: convA });
    expect(secondFollowup?.duplicate).toBe(true);

    await openConversation(page, convA);
    await expect(page.locator('.msg.user .msg-bubble', { hasText: duplicateText })).toHaveCount(1);
  } finally {
    const finalize = async (conversationId, messageId) => {
      if (!conversationId || !messageId) return;
      await request.post('/api/response', {
        headers,
        data: {
          messageId,
          conversationId,
          text: 'playwright cleanup',
          model: 'gpt-5.4-mini',
          mode: 'agent',
        },
      }).catch(() => {});
    };
    await finalize(convA, msgA);
    await finalize(convB, msgB);
    await finalize(convA, followupA);
    if (convA) await request.delete(`/api/conversation/${convA}`, { headers }).catch(() => {});
    if (convB) await request.delete(`/api/conversation/${convB}`, { headers }).catch(() => {});
  }
});
