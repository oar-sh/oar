import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createWorkerLogRooms,
  previousWorkerLogs,
  readWorkerLogBefore,
  readWorkerLogTail,
  resolveWorkerLog,
} from './worker-log-service.mjs';

// Credential-shaped values are put together at run time: the hygiene scan
// refuses token shapes in the source.
const fake = (...parts) => parts.join('');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A file that exists only in memory: `bytes(start, end)` gives its content;
// every byte read is counted.
function memoryFs(size, bytes) {
  const counter = { read: 0 };
  const stats = { size, mtimeMs: 1_700_000_000_000, ino: 7, isSymbolicLink: () => false, isFile: () => true };
  return {
    counter,
    constants: fs.constants,
    promises: {
      lstat: async () => stats,
      open: async () => ({
        stat: async () => stats,
        read: async (buffer, offset, length, position) => {
          const end = Math.min(size, position + length);
          const chunk = bytes(position, end);
          chunk.copy(buffer, offset);
          counter.read += chunk.length;
          return { bytesRead: chunk.length };
        },
        close: async () => {},
      }),
    },
  };
}

test('resolveWorkerLog: the path the launch writes, under the conversation\'s own id before a session is reported', () => {
  const env = { COPILOT_WEB_RELAY_LOG_DIR: '/srv/oar/logs' };
  assert.deepEqual(resolveWorkerLog({ id: 'conv-1', sdk_session_id: 'sess-1' }, env, { pathImpl: path.posix }), {
    dir: '/srv/oar/logs',
    path: '/srv/oar/logs/worker-sess-1.log',
    sdkSessionId: 'sess-1',
  });
  // A new conversation is launched under its own id until its worker reports one.
  assert.deepEqual(resolveWorkerLog({ id: 'conv-2', sdk_session_id: null }, env, { pathImpl: path.posix }), {
    dir: '/srv/oar/logs',
    path: '/srv/oar/logs/worker-conv-2.log',
    sdkSessionId: 'conv-2',
  });
  // An id that cleans to nothing would name the shared worker-worker.log.
  assert.equal(resolveWorkerLog({ id: 'conv-3', sdk_session_id: '../..' }, env, { pathImpl: path.posix }).path, '');
  assert.deepEqual(resolveWorkerLog({ id: '', sdk_session_id: '' }, env, { pathImpl: path.posix }), { dir: '/srv/oar/logs', path: '', sdkSessionId: '' });
});

test('a missing log reads as missing; the rolled-over .1 is listed by name and size', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'worker-sess-1.log');
  assert.deepEqual(await readWorkerLogTail(file), { ok: false, code: 'missing' });
  assert.deepEqual(await previousWorkerLogs(file), []);
  fs.writeFileSync(`${file}.1`, 'older run\n');
  fs.writeFileSync(file, 'this run\n');
  assert.deepEqual(await previousWorkerLogs(file), [{ name: 'worker-sess-1.log.1', size: 10 }]);
  const tail = await readWorkerLogTail(file);
  assert.equal(tail.text, 'this run\n');
  assert.equal(tail.hasMoreBefore, false);
});

test('the tail holds a last line still being written (under 5 s old), as the live room does', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'worker-sess-1.log');
  fs.writeFileSync(file, '[claude] request sent\nAuthorization: Bearer hunter2');
  const mtime = fs.statSync(file).mtimeMs;
  const fresh = await readWorkerLogTail(file, { now: () => mtime + 1000 });
  assert.equal(fresh.text, '[claude] request sent\n');
  assert.ok(!JSON.stringify(fresh).includes('hunter2'));
  const quiet = await readWorkerLogTail(file, { now: () => mtime + 6000 });
  assert.equal(quiet.text, '[claude] request sent\nAuthorization: Bearer [redacted]');
});

test('a symlinked log is refused, never followed', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'elsewhere.txt');
  fs.writeFileSync(target, 'not a worker log\n');
  const link = path.join(dir, 'worker-sess-1.log');
  try {
    fs.symlinkSync(target, link);
  } catch (error) {
    t.skip(`symlinks need a privilege here (${error.code})`);
    return;
  }
  assert.deepEqual(await readWorkerLogTail(link), { ok: false, code: 'symlink' });
  assert.deepEqual(await readWorkerLogBefore(link, { before: 5 }), { ok: false, code: 'symlink' });
});

test('a 300 MB log costs one 256 KB read, and Load earlier pages back from where the tail began', async () => {
  const size = 300 * 1024 * 1024;
  // Lines of equal length that differ (identical neighbours would fold).
  const width = '[claude] heartbeat 000000000\n'.length;
  const lineAt = (index) => `[claude] heartbeat ${String(index).padStart(9, '0')}\n`;
  const memory = memoryFs(size, (start, end) => {
    const out = Buffer.alloc(end - start);
    for (let at = start; at < end; at += 1) out[at - start] = lineAt(Math.floor(at / width)).charCodeAt(at % width);
    return out;
  });
  const tail = await readWorkerLogTail('/srv/oar/logs/worker-sess-1.log', { fsImpl: memory });
  assert.ok(memory.counter.read <= 256 * 1024, `read ${memory.counter.read} bytes`);
  assert.equal(tail.endOffset, size);
  assert.equal(tail.hasMoreBefore, true);
  assert.equal(tail.lines.length, 2000);
  memory.counter.read = 0;
  const earlier = await readWorkerLogBefore('/srv/oar/logs/worker-sess-1.log', { before: tail.startOffset, fsImpl: memory });
  assert.ok(memory.counter.read <= 256 * 1024);
  assert.equal(earlier.endOffset, tail.startOffset);
});

test('a secret cut by the window\'s start is not shown half: the window starts on the next line', async () => {
  const secret = fake('Zq8vLr2Nf0Kp', 'Wm4tYb6cXd1e', 'Hg3jSa5u');
  const head = Buffer.from('start\ntoken ');
  const windowStart = head.length + 10;
  const size = windowStart + 256 * 1024;
  const fillerLength = size - head.length - secret.length - 1;
  // Lines of 100 bytes, so the window holds fewer than 5,000 of them.
  const unit = `${'y'.repeat(99)}\n`;
  const filler = Buffer.from(`${unit.repeat(Math.ceil(fillerLength / 100)).slice(0, fillerLength - 1)}\n`);
  const content = Buffer.concat([head, Buffer.from(`${secret}\n`), filler]);
  assert.equal(content.length, size);
  const memory = memoryFs(size, (start, end) => content.subarray(start, end));
  const tail = await readWorkerLogTail('/srv/oar/logs/worker-sess-1.log', { lines: 5000, fsImpl: memory });
  assert.equal(tail.startOffset, head.length + secret.length + 1);
  assert.ok(!tail.text.includes(secret.slice(10)), 'no tail of the secret');
  assert.ok(!JSON.stringify(tail.lines).includes(secret.slice(10)));
});

test('what a window carries is scrubbed: an OAuth token, an agent token and a cookie', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'worker-sess-1.log');
  const oauth = fake('sk-ant-', 'oat01-', 'AbCdEfGhIjKlMnOpQrStUv');
  const agent = fake('oar', 'a1_', 's.Y29udi0x.', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi');
  fs.writeFileSync(file, `[claude] env CLAUDE_CODE_OAUTH_TOKEN=${oauth}\n[relay] 401 for ${agent}\nCookie: sid=Qm9iQm9i\n`);
  const tail = await readWorkerLogTail(file);
  for (const raw of [oauth, agent, 'Qm9iQm9i']) assert.ok(!tail.text.includes(raw), raw.slice(0, 6));
  assert.match(tail.text, /CLAUDE_CODE_OAUTH_TOKEN=\[redacted\]/);
  assert.match(tail.text, /oara1_\[redacted\]/);
  assert.match(tail.text, /Cookie: \[redacted\]/);
});

test('the rooms resolve the conversation\'s log, and refuse one without an SDK session or a conversation', async (t) => {
  const dir = tempDir(t);
  // conv-2's ids clean to nothing: its file would be the shared one.
  const conversations = { 'conv-1': { id: 'conv-1', sdk_session_id: 'sess-1' }, 'conv-2': { id: '..', sdk_session_id: '' } };
  const handlers = new Map();
  const socket = { data: {}, rooms: new Set(), on: (event, handler) => handlers.set(event, handler), join: (room) => socket.rooms.add(room), leave: (room) => socket.rooms.delete(room) };
  const rooms = createWorkerLogRooms({
    io: { to: () => ({ emit() {} }) },
    getConversation: (id) => conversations[id] || null,
    getLaunchEnv: () => ({ COPILOT_WEB_RELAY_LOG_DIR: dir }),
    roomSize: () => 1,
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
    logger: null,
  });
  rooms.registerSocket(socket);
  const call = (payload) => new Promise((resolve) => handlers.get('worker_log_watch')(payload, resolve));
  // The file is not there yet: waited for from offset 0.
  assert.deepEqual(await call({ conversationId: 'conv-1' }), { ok: true, offset: 0, size: 0 });
  assert.deepEqual([...socket.rooms], ['worker-log:conv-1']);
  assert.deepEqual(await call({ conversationId: 'conv-2' }), { ok: false, code: 'no-session' });
  assert.deepEqual(await call({ conversationId: 'conv-9' }), { ok: false, code: 'not-found' });
  rooms.stop();
});
