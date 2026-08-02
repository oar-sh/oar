import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createTmuxInspectorStreamService } from './tmux-inspector-stream-service.mjs';

function createTmuxExecStub({
  snapshotsBySession = new Map(),
  hasSession = () => true,
} = {}) {
  return (command, args) => {
    assert.equal(command, 'tmux');
    const action = String(args?.[0] || '');
    if (action === 'has-session') {
      const sessionId = String(args?.[2] || '');
      if (!hasSession(sessionId)) {
        throw new Error('missing session');
      }
      return Buffer.alloc(0);
    }
    if (action === 'capture-pane') {
      const sessionId = String(args?.[args.length - 1] || '');
      const queue = snapshotsBySession.get(sessionId) || [];
      const text = queue.length ? queue.shift() : '';
      return Buffer.from(String(text || ''));
    }
    if (action === 'resize-window') {
      return Buffer.alloc(0);
    }
    if (action === '-V') {
      return Buffer.from('tmux 3.4');
    }
    throw new Error(`unexpected tmux action: ${action}`);
  };
}

test('tmux stream service attaches and emits delta updates', async () => {
  const chunkEvents = [];
  const statusEvents = [];
  const snapshots = new Map([
    ['abc-123', ['hello\n', 'hello\nworld\n']],
  ]);
  const service = createTmuxInspectorStreamService({
    tmuxAvailable: true,
    preferByteStream: false,
    pollIntervalMs: 30,
    historyLines: 200,
    execFileSyncImpl: createTmuxExecStub({ snapshotsBySession: snapshots }),
    isSessionAllowed: () => ({ ok: true }),
  });

  const attached = service.attach({
    sdkSessionId: 'abc-123',
    watcherId: 'watcher-1',
    onChunk: (event) => chunkEvents.push(event),
    onStatus: (event) => statusEvents.push(event),
  });
  assert.equal(attached.ok, true);
  assert.equal(attached.snapshot, 'hello\n');

  service.pollNow('abc-123');
  service.stopAll();

  assert.equal(statusEvents.length, 0);
  assert.equal(chunkEvents.length >= 1, true);
  assert.equal(chunkEvents[0].chunkKind, 'delta');
  assert.equal(chunkEvents[0].data, 'world\n');
});

test('tmux stream service blocks attach when session is not allowed', () => {
  const service = createTmuxInspectorStreamService({
    tmuxAvailable: true,
    preferByteStream: false,
    execFileSyncImpl: createTmuxExecStub(),
    isSessionAllowed: () => ({ ok: false, code: 'session-worker-inactive', reason: 'inactive' }),
  });

  const attached = service.attach({
    sdkSessionId: 'abc-123',
    watcherId: 'watcher-1',
  });
  assert.equal(attached.ok, false);
  assert.equal(attached.code, 'session-worker-inactive');
});

test('tmux stream service ends watch when session becomes disallowed', async () => {
  const statusEvents = [];
  let allowed = true;
  const service = createTmuxInspectorStreamService({
    tmuxAvailable: true,
    preferByteStream: false,
    pollIntervalMs: 20,
    execFileSyncImpl: createTmuxExecStub({
      snapshotsBySession: new Map([['abc-123', ['hello\n', 'hello\n']]]),
    }),
    isSessionAllowed: () => (allowed
      ? { ok: true }
      : { ok: false, code: 'session-worker-inactive', reason: 'worker inactive' }),
  });

  const attached = service.attach({
    sdkSessionId: 'abc-123',
    watcherId: 'watcher-1',
    onStatus: (event) => statusEvents.push(event),
  });
  assert.equal(attached.ok, true);

  allowed = false;
  service.pollNow('abc-123');
  service.stopAll();

  assert.equal(statusEvents.length >= 1, true);
  assert.equal(statusEvents[0].state, 'ended');
  assert.equal(statusEvents[0].code, 'session-worker-inactive');
});

test('tmux stream service resizes attached watcher session', () => {
  const service = createTmuxInspectorStreamService({
    tmuxAvailable: true,
    preferByteStream: false,
    execFileSyncImpl: createTmuxExecStub({
      snapshotsBySession: new Map([['abc-123', ['boot\n']]]),
    }),
    isSessionAllowed: () => ({ ok: true }),
  });
  const attached = service.attach({
    sdkSessionId: 'abc-123',
    watcherId: 'watcher-1',
  });
  assert.equal(attached.ok, true);
  const resized = service.resizeSession({
    sdkSessionId: 'abc-123',
    watcherId: 'watcher-1',
    cols: 132,
    rows: 40,
  });
  assert.equal(resized.ok, true);
  assert.equal(resized.code, 'resized');
  service.stopAll();
});

test('tmux stream service emits true byte chunks when byte stream is available', async () => {
  const chunkEvents = [];
  const processStub = new EventEmitter();
  processStub.stdout = new EventEmitter();
  processStub.stderr = new EventEmitter();
  processStub.kill = () => true;

  const service = createTmuxInspectorStreamService({
    tmuxAvailable: true,
    platform: 'linux',
    preferByteStream: true,
    spawnImpl(command, args) {
      assert.equal(command, 'script');
      assert.deepEqual(args, ['-q', '-f', '/dev/null', 'tmux', 'attach-session', '-r', '-t', 'abc-123']);
      return processStub;
    },
    execFileSyncImpl: createTmuxExecStub({
      snapshotsBySession: new Map([['abc-123', ['']]]),
    }),
    isSessionAllowed: () => ({ ok: true }),
  });

  const attached = service.attach({
    sdkSessionId: 'abc-123',
    watcherId: 'watcher-1',
    onChunk: (event) => chunkEvents.push(event),
  });
  assert.equal(attached.ok, true);

  processStub.stdout.emit('data', Buffer.from('\u001b[31mhello\u001b[0m'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.stopAll();

  assert.equal(chunkEvents.length >= 1, true);
  assert.equal(chunkEvents[0].chunkKind, 'byte');
  assert.equal(chunkEvents[0].data, '\u001b[31mhello\u001b[0m');
});
