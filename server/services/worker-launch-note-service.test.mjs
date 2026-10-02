import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkerLaunchNoteText, createWorkerLaunchNoteService, WORKER_LAUNCH_NOTE_KINDS } from './worker-launch-note-service.mjs';

function fakeStore() {
  const messages = new Map();
  const kinds = new Map();
  const updates = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /UPDATE messages SET text = \?, kind = \? WHERE id = \?/);
      return {
        run(text, kind, id) {
          updates.push({ text, kind, id });
          messages.set(id, { ...messages.get(id), text });
          kinds.set(id, kind);
          return { changes: 1 };
        },
      };
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
  const stmts = {
    insertMsg: { run(id, conversationId, role, text, model, mode, attachments, timestamp) { messages.set(id, { id, conversationId, role, text, model, mode, attachments, timestamp }); } },
    setMessageKind: { run(kind, id) { kinds.set(id, kind); } },
    updateConvTime: { run() {} },
  };
  return { db, stmts, messages, kinds, updates };
}

const lifecycle = (patch = {}) => ({
  retryCount: 6,
  lastError: 'windows-process-snapshot-unreadable: Bad control character in string literal in JSON at position 144233',
  exhaustedSince: '2026-10-01T14:44:51.000Z',
  lastFailureAt: '2026-10-01T14:44:51.000Z',
  launchAt: null,
  ...patch,
});

test('one note per episode: opened when exhausted, updated in place, closed when the worker starts', () => {
  const store = fakeStore();
  const emitted = [];
  const service = createWorkerLaunchNoteService({
    db: store.db,
    stmts: store.stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    resolveConversationId: (sid) => (sid === 'sess-1' ? 'conv-1' : null),
    now: () => Date.parse('2026-10-01T14:44:52.000Z'),
    logger: { log() {} },
  });

  assert.equal(service.handle({ type: 'exhausted', sdkSessionId: 'sess-1', lifecycle: lifecycle() }), true);
  assert.equal(store.messages.size, 1, 'one message inserted');
  const [noteId, note] = [...store.messages.entries()][0];
  assert.equal(note.role, 'assistant');
  assert.equal(note.conversationId, 'conv-1');
  assert.equal(store.kinds.get(noteId), WORKER_LAUNCH_NOTE_KINDS.failed);
  assert.match(note.text, /could not be started \(6 tries\)/);
  assert.match(note.text, /Cause: windows-process-snapshot-unreadable: Bad control character/);
  assert.match(note.text, /tries again every 1 minute until 14:54 UTC/);
  assert.equal(emitted[0].event, 'assistant_message');
  assert.equal(emitted[0].payload.messageId, noteId);
  assert.equal(emitted[0].payload.message.kind, WORKER_LAUNCH_NOTE_KINDS.failed);

  // A failed retry rewrites the same note; nothing new is inserted.
  service.handle({ type: 'retry-failed', sdkSessionId: 'sess-1', lifecycle: lifecycle({ retryCount: 7, lastFailureAt: '2026-10-01T14:45:52.000Z' }) });
  assert.equal(store.messages.size, 1);
  assert.equal(store.updates.length, 1);
  assert.equal(store.updates[0].id, noteId);
  assert.match(store.updates[0].text, /\(7 tries, last at 14:45 UTC\)/);
  assert.equal(emitted[1].event, 'message_updated');
  assert.equal(emitted[1].payload.messageId, noteId);
  assert.equal(emitted[1].payload.conversationId, 'conv-1');

  // Stopped: the kind changes so the client shows Retry.
  service.handle({ type: 'stopped', sdkSessionId: 'sess-1', lifecycle: lifecycle({ retryCount: 16 }) });
  assert.equal(store.kinds.get(noteId), WORKER_LAUNCH_NOTE_KINDS.stopped);
  assert.match(store.updates[1].text, /stopped trying after 10 minutes \(16 tries\)/);
  assert.match(store.updates[1].text, /press Retry once the cause is fixed/);

  // Started (the Retry worked): the note says so and the episode is over.
  service.handle({ type: 'launched', sdkSessionId: 'sess-1', lifecycle: lifecycle({ launchAt: '2026-10-01T15:40:10.000Z' }) });
  assert.equal(store.kinds.get(noteId), WORKER_LAUNCH_NOTE_KINDS.started);
  assert.match(store.updates[2].text, /started at 15:40 UTC/);
  assert.equal(service.openEpisode('sess-1'), null);

  // An ordinary launch with no episode writes nothing.
  assert.equal(service.handle({ type: 'launched', sdkSessionId: 'sess-1', lifecycle: lifecycle() }), false);
  assert.equal(store.messages.size, 1);
  assert.equal(emitted.length, 4);
});

test('a session without a conversation gets no note, and unknown events are ignored', () => {
  const store = fakeStore();
  const service = createWorkerLaunchNoteService({
    db: store.db,
    stmts: store.stmts,
    emit() {},
    resolveConversationId: () => null,
    logger: { log() {} },
  });
  assert.equal(service.handle({ type: 'exhausted', sdkSessionId: 'orphan', lifecycle: lifecycle() }), false);
  assert.equal(service.handle({ type: 'something-else', sdkSessionId: 'orphan', lifecycle: lifecycle() }), false);
  assert.equal(store.messages.size, 0);
});

test('the note text clips a long cause and names the window', () => {
  const text = buildWorkerLaunchNoteText({
    type: 'exhausted',
    lifecycle: lifecycle({ lastError: 'x'.repeat(400) }),
    retryEveryMs: 60_000,
    retryWindowMs: 10 * 60_000,
  });
  assert.match(text, /Cause: x{159}…\. Your message stays queued/);
  assert.match(text, /every 1 minute until 14:54 UTC\.$/);
  const stopped = buildWorkerLaunchNoteText({ type: 'stopped', lifecycle: lifecycle({ retryCount: 1 }), retryWindowMs: 5 * 60_000 });
  assert.match(stopped, /after 5 minutes \(1 try\)/);
});
