import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STRANDED_SESSION_HEARTBEAT_FRESH_MS,
  shouldTakeOverStrandedPendingMessage,
} from './messages-routes.mjs';

const NOW = Date.parse('2026-05-04T12:00:00.000Z');
const strandedRow = { id: 'q-1', owner_sdk_session_id: 'sdk-owner', retry_count: 0 };

function decide(heartbeatAgeMs, lifecycle = {}) {
  return shouldTakeOverStrandedPendingMessage({
    strandedRow,
    requesterSessionId: 'sdk-requester',
    strandedLifecycle: {
      lastHeartbeatAt: new Date(NOW - heartbeatAgeMs).toISOString(),
      awaitingHeartbeat: true,
      ...lifecycle,
    },
    nowMs: NOW,
  });
}

test('an idle worker beats every 30 s, so a beat up to 45 s old is fresh', () => {
  assert.equal(STRANDED_SESSION_HEARTBEAT_FRESH_MS, 45_000);
  assert.equal(decide(30_000), false, 'one idle beat old: the worker is alive');
  assert.equal(decide(44_999), false);
});

test('a beat older than the window lets a stranded row be taken over', () => {
  assert.equal(decide(45_001), true);
  assert.equal(decide(60_000, { awaitingHeartbeat: false, degradedReason: 'stale-pid' }), true);
  assert.equal(decide(60_000, { awaitingHeartbeat: false, degradedReason: '' }), false, 'no degradation, no takeover');
});
