import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createStatusEventService } from './status-event-service.mjs';

function createService(options = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE status_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  return { db, service: createStatusEventService(db, options) };
}

test('persists minimized shared-access telemetry and replays it to later clients', () => {
  const { db, service } = createService();
  const result = service.recordSharedAccess({
    shareToken: 'a'.repeat(64),
    viewerIp: '203.0.113.24',
    conversationId: 'conversation-1',
    conversationTitle: 'Release notes',
    sdkSessionId: 'sdk-1',
    timestamp: 1_700_000_000_000,
  });

  assert.equal(result.deduped, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM status_events').get().count, 1);
  assert.deepEqual(service.getEventsPage().items, [{
    id: result.event.id,
    timestamp: 1_700_000_000_000,
    type: 'shared-access-opened',
    source: 'server',
    details: {
      shareId: 'ffe054fe7ae0',
      viewerIp: '203.0.113.24',
      conversationId: 'conversation-1',
    },
  }]);
});

test('deduplicates repeated shared reads by token and full IP within the TTL', () => {
  const { db, service } = createService({ sharedAccessDedupeTtlMs: 60_000 });
  const event = {
    shareToken: 'b'.repeat(64),
    viewerIp: '2001:db8::10',
    conversationId: 'conversation-1',
    conversationTitle: 'Release notes',
  };

  assert.equal(service.recordSharedAccess({ ...event, timestamp: 1_000 }).deduped, false);
  assert.equal(service.recordSharedAccess({ ...event, timestamp: 30_000 }).deduped, true);
  assert.equal(service.recordSharedAccess({ ...event, timestamp: 89_999 }).deduped, true);
  assert.equal(service.recordSharedAccess({ ...event, timestamp: 150_000 }).deduped, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM status_events').get().count, 2);
});

test('returns stable, cursor-based pages in timeline order', () => {
  const { service } = createService();
  const common = {
    shareToken: 'c'.repeat(64),
    viewerIp: '198.51.100.9',
    conversationId: 'conversation-1',
    conversationTitle: 'Release notes',
  };
  const first = service.recordSharedAccess({ ...common, timestamp: 1_000 }).event;
  const second = service.recordSharedAccess({ ...common, viewerIp: '198.51.100.10', timestamp: 2_000 }).event;
  const third = service.recordSharedAccess({ ...common, viewerIp: '198.51.100.11', timestamp: 3_000 }).event;

  const newest = service.getEventsPage({ limit: 2 });
  assert.deepEqual(newest.items.map((event) => event.id), [second.id, third.id]);
  assert.equal(newest.hasMore, true);
  const older = service.getEventsPage({
    beforeTimestamp: newest.nextCursor.timestamp,
    beforeId: newest.nextCursor.id,
    limit: 2,
  });
  assert.deepEqual(older.items.map((event) => event.id), [first.id]);
  assert.equal(older.hasMore, false);
});
