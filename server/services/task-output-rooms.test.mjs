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

// ─── A second instance: the worker log ───────────────────────────────────────

const WORKER_LOG_EVENTS = { watch: 'worker_log_watch', unwatch: 'worker_log_unwatch', chunk: 'worker_log_chunk' };

function workerLogRooms(io, resolveSource) {
  const timers = [];
  const rooms = createTaskOutputRooms({
    io,
    resolveSource,
    roomPrefix: 'worker-log:',
    events: WORKER_LOG_EVENTS,
    dataKey: 'workerLogRoom',
    itemKey: null,
    roomSize: (room) => io.rooms.get(room)?.size || 0,
    setIntervalImpl: (fn) => { const timer = { fn, cleared: false }; timers.push(timer); return timer; },
    clearIntervalImpl: (timer) => { timer.cleared = true; },
    logger: null,
  });
  return { rooms, timers };
}

test('a worker-log instance: one room per conversation, its own events, no item id', async (t) => {
  const file = tempFile(t, 'boot\n');
  const io = fakeIo();
  const { rooms } = workerLogRooms(io, (conversationId) => (conversationId === 'conv-1' ? { path: file, ended: false } : null));
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  assert.deepEqual(await socket.call('worker_log_watch', { conversationId: 'conv-1', offset: 5 }), { ok: true, offset: 5, size: 5 });
  assert.equal(socket.data.workerLogRoom, 'worker-log:conv-1');
  assert.equal(socket.data.taskOutputRoom, undefined);
  fs.appendFileSync(file, 'turn started\n');
  await rooms.poll('worker-log:conv-1');
  assert.equal(io.emitted.length, 1);
  const { room, event, payload } = io.emitted[0];
  assert.deepEqual([room, event], ['worker-log:conv-1', 'worker_log_chunk']);
  assert.deepEqual({ ...payload, mtime: typeof payload.mtime }, { conversationId: 'conv-1', offset: 5, endOffset: 18, text: 'turn started\n', size: 18, mtime: 'number', ended: false });
  assert.equal('taskId' in payload, false);
  assert.deepEqual(await socket.call('worker_log_watch', { conversationId: 'conv-2' }), { ok: false, code: 'not-found' });
  assert.deepEqual(rooms.watchedRooms(), []);
});

test('a socket in a task room and a worker-log room at once gets both, and leaving one keeps the other', async (t) => {
  const { file: taskFile, io, rooms: taskRooms } = setup(t);
  const logFile = tempFile(t, '');
  const { rooms: logRooms } = workerLogRooms(io, () => ({ path: logFile, ended: false }));
  const socket = io.socket('s1');
  taskRooms.registerSocket(socket);
  logRooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1', offset: 6 });
  await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  assert.deepEqual([...socket.rooms].sort(), ['task-output:conv-1:t1', 'worker-log:conv-1']);
  fs.appendFileSync(taskFile, 'task line\n');
  fs.appendFileSync(logFile, 'log line\n');
  await taskRooms.poll('task-output:conv-1:t1');
  await logRooms.poll('worker-log:conv-1');
  assert.deepEqual(io.emitted.map((entry) => [entry.room, entry.event, entry.payload.text]), [
    ['task-output:conv-1:t1', 'task_output_chunk', 'task line\n'],
    ['worker-log:conv-1', 'worker_log_chunk', 'log line\n'],
  ]);
  await socket.call('worker_log_unwatch', {});
  assert.deepEqual([...socket.rooms], ['task-output:conv-1:t1']);
  assert.deepEqual(taskRooms.watchedRooms(), ['task-output:conv-1:t1']);
  assert.deepEqual(logRooms.watchedRooms(), []);
});

test('a worker log rotated at a relaunch (renamed, a new smaller file) is sent as a reset', async (t) => {
  const file = tempFile(t, 'old run line one\nold run line two\n');
  const io = fakeIo();
  const { rooms } = workerLogRooms(io, () => ({ path: file, ended: false }));
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  fs.renameSync(file, `${file}.1`);
  fs.writeFileSync(file, 'new run\n');
  await rooms.poll('worker-log:conv-1');
  assert.deepEqual([io.emitted[0].event, io.emitted[0].payload.reset, io.emitted[0].payload.offset], ['worker_log_chunk', true, 8]);
});

test('a worker-log source with no path is refused with its code', async () => {
  const io = fakeIo();
  const { rooms } = workerLogRooms(io, () => ({ path: '', code: 'no-session' }));
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  assert.deepEqual(await socket.call('worker_log_watch', { conversationId: 'conv-1' }), { ok: false, code: 'no-session' });
  assert.deepEqual(await socket.call('worker_log_watch', {}), { ok: false, code: 'missing-id' });
});

// ─── Line-safe sends (the worker log's options) ──────────────────────────────

function lineSafeRooms(io, file, { clock, resolveSource } = {}) {
  return createTaskOutputRooms({
    io,
    resolveSource: resolveSource || (() => ({ path: file, ended: false })),
    roomPrefix: 'worker-log:',
    events: WORKER_LOG_EVENTS,
    dataKey: 'workerLogRoom',
    itemKey: null,
    idleFlushMs: 5000,
    followPath: true,
    now: () => clock.now,
    roomSize: (room) => io.rooms.get(room)?.size || 0,
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
    logger: null,
  });
}

const framesOf = (io) => io.emitted.map((entry) => entry.payload);

test('line-safe: an open line waits for 5 s of quiet, and once complete goes out again whole, scrubbed; no frame shows the value', async (t) => {
  const file = tempFile(t, 'boot\n');
  const io = fakeIo();
  const clock = { now: 1_000_000 };
  const rooms = lineSafeRooms(io, file, { clock });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  const room = 'worker-log:conv-1';
  const secret = 'hunter2plainsecret';
  fs.appendFileSync(file, 'Authorization: Bearer ');
  await rooms.poll(room);
  // Two quiet ticks: the task console would flush here; the worker log waits.
  clock.now += 1000;
  await rooms.poll(room);
  clock.now += 1000;
  await rooms.poll(room);
  assert.equal(io.emitted.length, 0, 'an open line within 5 s of its last write is held');
  clock.now += 4000;
  await rooms.poll(room);
  assert.deepEqual(framesOf(io).map((frame) => [frame.offset, frame.text, frame.partial, frame.rewrite]), [[5, 'Authorization: Bearer ', true, undefined]]);
  fs.appendFileSync(file, `${secret}\nnext line\n`);
  clock.now += 1000;
  await rooms.poll(room);
  const last = framesOf(io).at(-1);
  assert.deepEqual([last.offset, last.rewrite, last.text], [5, true, 'Authorization: Bearer [redacted]\nnext line\n']);
  assert.equal(last.endOffset, fs.statSync(file).size);
  assert.ok(!JSON.stringify(io.emitted).includes(secret), 'no frame carries the value');
  // The next line continues after it, without a rewrite.
  fs.appendFileSync(file, 'after\n');
  clock.now += 1000;
  await rooms.poll(room);
  assert.deepEqual([framesOf(io).at(-1).text, framesOf(io).at(-1).rewrite], ['after\n', undefined]);
});

test('line-safe: a value written slowly is held while its writer keeps going', async (t) => {
  const file = tempFile(t, '');
  const io = fakeIo();
  const clock = { now: 1_000_000 };
  const rooms = lineSafeRooms(io, file, { clock });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  for (const piece of ['Authorization: ', 'Bearer ', 'hunter2', 'plain', 'secret']) {
    fs.appendFileSync(file, piece);
    clock.now += 2000;
    await rooms.poll('worker-log:conv-1');
  }
  assert.equal(io.emitted.length, 0);
  fs.appendFileSync(file, '\n');
  clock.now += 1000;
  await rooms.poll('worker-log:conv-1');
  assert.deepEqual(framesOf(io).map((frame) => frame.text), ['Authorization: Bearer [redacted]\n']);
});

test('line-safe: a line longer than 64 KB is cut between words, so a Bearer value is not split', async (t) => {
  const file = tempFile(t, '');
  const io = fakeIo();
  const clock = { now: 1_000_000 };
  const rooms = lineSafeRooms(io, file, { clock });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  const secret = 'hunter2plainsecretvalue';
  const prefix = 'curl -H "x-trace: ok" -H "Authorization: Bearer ';
  // The value straddles the 64 KB mark.
  const filler = 'w '.repeat(Math.floor((64 * 1024 - prefix.length - 10) / 2));
  fs.appendFileSync(file, `${filler}${prefix}${secret}" https://api.example.test/v1 ${'z '.repeat(500)}\n`);
  assert.ok(filler.length + prefix.length < 64 * 1024 && filler.length + prefix.length + secret.length > 64 * 1024);
  clock.now += 1000;
  await rooms.poll('worker-log:conv-1');
  const frames = framesOf(io);
  assert.ok(frames.length >= 2, 'the line goes out in more than one piece');
  assert.ok(frames[0].endOffset < 64 * 1024);
  assert.ok(!JSON.stringify(io.emitted).includes(secret.slice(0, 8)), 'no frame carries any part of the value');
  assert.ok(!JSON.stringify(io.emitted).includes(secret.slice(-8)));
  assert.ok(frames.some((frame) => frame.text.includes('Authorization: Bearer [redacted]')));
  // Piece by piece, the whole line arrived.
  assert.equal(frames.at(-1).endOffset, fs.statSync(file).size);
  for (let index = 1; index < frames.length; index += 1) assert.equal(frames[index].offset, frames[index - 1].endOffset);
});

test('line-safe: a source whose path changes (a new SDK session) moves the room there with a reset, on a tick and on a watch', async (t) => {
  const first = tempFile(t, 'old session\n');
  const second = tempFile(t, 'new session line\n');
  const io = fakeIo();
  const clock = { now: 1_000_000 };
  let current = first;
  const rooms = lineSafeRooms(io, null, { clock, resolveSource: () => ({ path: current, ended: false }) });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  current = second;
  await rooms.poll('worker-log:conv-1');
  assert.deepEqual([framesOf(io)[0].reset, framesOf(io)[0].offset], [true, 17]);
  fs.appendFileSync(second, 'more\n');
  clock.now += 1000;
  await rooms.poll('worker-log:conv-1');
  assert.equal(framesOf(io).at(-1).text, 'more\n');
  // A page that watches after the next change finds the room on the new file.
  current = first;
  const ack = await socket.call('worker_log_watch', { conversationId: 'conv-1' });
  assert.deepEqual([ack.ok, ack.offset, framesOf(io).at(-1).reset], [true, 12, true]);
});

test('the task console\'s defaults are unchanged: no rewrite or partial marks, an open line flushed after one quiet tick', async (t) => {
  const { file, io, rooms } = setup(t, { content: 'start\n' });
  const socket = io.socket('s1');
  rooms.registerSocket(socket);
  await socket.call('task_output_watch', { conversationId: 'conv-1', taskId: 't1' });
  fs.appendFileSync(file, 'prompt? ');
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  await rooms.poll(taskOutputRoom('conv-1', 't1'));
  assert.deepEqual(io.emitted.map((entry) => Object.keys(entry.payload).sort()), [['conversationId', 'endOffset', 'ended', 'mtime', 'offset', 'size', 'taskId', 'text']]);
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
