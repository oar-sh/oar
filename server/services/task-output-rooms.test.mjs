import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTaskOutputRooms, taskOutputRoom } from './task-output-rooms.mjs';

function tempFile(t, content = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-rooms-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'out.log');
  fs.writeFileSync(file, content);
  return file;
}

// A minimal socket.io stand-in: rooms with members, emits recorded per room.
function fakeIo() {
  const rooms = new Map();
  const emitted = [];
  return {
    rooms,
    emitted,
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
    socket(id) {
      const handlers = new Map();
      const own = [];
      const socket = {
        id,
        data: {},
        rooms: new Set(),
        own,
        on: (event, handler) => handlers.set(event, handler),
        join(room) {
          socket.rooms.add(room);
          if (!rooms.has(room)) rooms.set(room, new Set());
          rooms.get(room).add(id);
        },
        leave(room) {
          socket.rooms.delete(room);
          rooms.get(room)?.delete(id);
          if (rooms.get(room)?.size === 0) rooms.delete(room);
        },
        emit: (event, payload) => own.push({ event, payload }),
        call: (event, payload) => new Promise((resolve) => handlers.get(event)(payload, resolve)),
      };
      return socket;
    },
  };
}

function setup(t, { content = 'first\n', task, resolve } = {}) {
  const file = tempFile(t, content);
  const io = fakeIo();
  const timers = [];
  const rooms = createTaskOutputRooms({
    io,
    resolveTask: resolve || ((conversationId, taskId) => (conversationId === 'conv-1' && taskId === 't1'
      ? { key: 'sess-1', task: task || { taskId: 't1', outputPath: file }, ended: false }
      : null)),
    roomSize: (room) => io.rooms.get(room)?.size || 0,
    setIntervalImpl: (fn) => { const timer = { fn, cleared: false }; timers.push(timer); return timer; },
    clearIntervalImpl: (timer) => { timer.cleared = true; },
    logger: null,
  });
  return { file, io, rooms, timers };
}

test('watch joins the task room and appended bytes go out as chunks with offsets', async (t) => {
  const { file, io, rooms, timers } = setup(t);
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  const ack = await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1', offset: 6 });
  assert.deepEqual(ack, { ok: true, taskId: 't1', offset: 6, size: 6 });
  assert.ok(socket.rooms.has(taskOutputRoom('conv-1', 't1')));
  assert.equal(timers.length, 1);

  fs.appendFileSync(file, 'second \x1b[31mred\x1b[0m\x1b[2K\n');
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  assert.equal(io.emitted.length, 1);
  const { room, event, payload } = io.emitted[0];
  assert.equal(room, 'task-output:conv-1:t1');
  assert.equal(event, 'task_output_chunk');
  assert.deepEqual(
    { ...payload, mtime: typeof payload.mtime },
    { conversationId: 'conv-1', taskId: 't1', offset: 6, endOffset: fs.statSync(file).size, text: 'second \x1b[31mred\x1b[0m\n', size: fs.statSync(file).size, mtime: 'number', ended: false },
  );
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  assert.equal(io.emitted.length, 1, 'no new bytes, no chunk');
});

test('a big append goes out in 64 KB chunks', async (t) => {
  const { file, io, rooms } = setup(t, { content: '' });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  fs.appendFileSync(file, `${'x'.repeat(100)}\n`.repeat(1500));
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  assert.equal(io.emitted.length, 3);
  // Each chunk ends on the last line break within its 64 KB.
  assert.equal(io.emitted[0].payload.endOffset, Math.floor((64 * 1024) / 101) * 101);
  assert.equal(io.emitted[1].payload.offset, io.emitted[0].payload.endOffset);
  assert.equal(io.emitted.at(-1).payload.endOffset, 1500 * 101);
});

test('an open line waits while the writer is busy, so a credential is never scrubbed in two halves', async (t) => {
  const { file, io, rooms } = setup(t, { content: 'start\n' });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  const room = taskOutputRoom('conv-1', 't1');
  fs.appendFileSync(file, 'line one\nAPI_TOKEN=Zq8v');
  await rooms.poll(room);
  assert.deepEqual(io.emitted.map((entry) => entry.payload.text), ['line one\n']);
  fs.appendFileSync(file, 'Lr2Nf0Kp\n');
  await rooms.poll(room);
  assert.equal(io.emitted.at(-1).payload.text, 'API_TOKEN=[redacted]\n');
  // A prompt with no line break goes out once the writer is idle for a tick.
  fs.appendFileSync(file, 'Continue? [y/n] ');
  await rooms.poll(room);
  assert.equal(io.emitted.length, 2);
  await rooms.poll(room);
  assert.equal(io.emitted.at(-1).payload.text, 'Continue? [y/n] ');
});

test('a room that names no offset starts after the last complete line', async (t) => {
  const { file, io, rooms } = setup(t, { content: 'done\nhalf a li' });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  const ack = await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  assert.equal(ack.offset, 5);
  fs.appendFileSync(file, 'ne\n');
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  assert.deepEqual([io.emitted[0].payload.offset, io.emitted[0].payload.text], [5, 'half a line\n']);
});

test('a file that shrank is sent as a reset', async (t) => {
  const { file, io, rooms } = setup(t, { content: 'a long first line\n' });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  fs.writeFileSync(file, 'new\n');
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  assert.equal(io.emitted[0].payload.reset, true);
  assert.equal(io.emitted[0].payload.offset, 4);
});

test('a second page behind the room gets the gap on its own', async (t) => {
  const { file, io, rooms } = setup(t);
  const first = io.socket('s1');
  rooms.registerSocket(first);
  await first.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1', offset: 6 });
  fs.appendFileSync(file, 'more\n');
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  const second = io.socket('s2');
  rooms.registerSocket(second);
  const ack = await second.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1', offset: 6 });
  assert.equal(ack.offset, 11);
  assert.deepEqual(second.own.map((entry) => [entry.payload.offset, entry.payload.text]), [[6, 'more\n']]);
});

test('refusals: unknown task, missing ids, no output, snapshot; a refusal leaves the old room', async (t) => {
  const file = tempFile(t, 'x\n');
  const tasks = {
    t1: { taskId: 't1', outputPath: file },
    none: { taskId: 'none' },
    snap: { taskId: 'snap', outputKind: 'snapshot' },
  };
  const { io, rooms } = setup(t, { resolve: (conversationId, taskId) => (conversationId === 'conv-1' && tasks[taskId] ? { key: 'sess-1', task: tasks[taskId], ended: false } : null) });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  assert.equal((await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' })).ok, true);
  assert.deepEqual(await socket.call('task_output_watch', { conversationId: 'conv-2', taskId: 't1' }), { ok: false, code: 'not-found' });
  assert.equal(socket.rooms.size, 0);
  assert.deepEqual(rooms.watchedRooms(), []);
  assert.deepEqual(await socket.call('task_output_watch', { conversationId: 'conv-1' }), { ok: false, code: 'missing-id' });
  assert.deepEqual(await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 'none' }), { ok: false, code: 'no-output' });
  assert.deepEqual(await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 'snap' }), { ok: false, code: 'snapshot' });
});

test('one room per socket, and the poller stops when its room empties', async (t) => {
  const { io, rooms, timers } = setup(t);
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  assert.deepEqual(rooms.watchedRooms(), ['task-output:conv-1:t1']);
  assert.deepEqual(await socket.call('task_output_unwatch', {}), { ok: true });
  assert.deepEqual(rooms.watchedRooms(), []);
  assert.equal(timers[0].cleared, true);
  // A socket that went away without unwatching: the next tick stops it.
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  socket.leave('task-output:conv-1:t1');
  await rooms.poll('task-output:conv-1:t1');
  assert.deepEqual(rooms.watchedRooms(), []);
});

test('chunks say when the task has ended, and a task gone from both sets stops the poller', async (t) => {
  let state = 'ended';
  const file = tempFile(t, '');
  const { io, rooms } = setup(t, {
    resolve: () => (state === 'gone' ? null : { key: 'sess-1', task: { taskId: 't1', outputPath: file }, ended: true }),
  });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  fs.appendFileSync(file, 'last words\n');
  await rooms.poll('task-output:conv-1:t1');
  assert.equal(io.emitted[0].payload.ended, true);
  state = 'gone';
  await rooms.poll('task-output:conv-1:t1');
  assert.deepEqual(rooms.watchedRooms(), []);
});

test('a file that is not there yet is waited for, and its first bytes come from offset 0', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-rooms-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spool.log');
  const { io, rooms } = setup(t, { resolve: () => ({ key: 'sess-1', task: { taskId: 't1', outputPath: file, outputKind: 'spool' }, ended: false }) });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  assert.deepEqual(await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' }), { ok: true, taskId: 't1', offset: 0, size: 0 });
  await rooms.poll('task-output:conv-1:t1');
  assert.equal(io.emitted.length, 0);
  fs.writeFileSync(file, 'hello\n');
  await rooms.poll('task-output:conv-1:t1');
  assert.deepEqual([io.emitted[0].payload.offset, io.emitted[0].payload.text], [0, 'hello\n']);
});
