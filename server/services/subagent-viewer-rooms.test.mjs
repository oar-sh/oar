import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Server } from 'socket.io';

import { createSubagentTimelinePublisher, createSubagentViewerRooms, subagentViewerRoom } from './subagent-viewer-rooms.mjs';

// The viewer rooms on a real socket.io server with real clients: who joins,
// what is refused, and that a record batch sent the way the relay sends it
// (the publisher: one tick later, `io.to(room).volatile.emit`) reaches only
// the page watching that run.

const require = createRequire(import.meta.url);
const connectClient = require(path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist/socket.io.js'));

const CONV = 'conv-viewer-1';
const OTHER_CONV = 'conv-viewer-2';
const RUN = 'toolu_fixture_watch_alpha';
const OTHER_RUN = 'toolu_fixture_watch_beta';
const RUNS = new Map([
  [RUN, { id: RUN, conversation_id: CONV }],
  [OTHER_RUN, { id: OTHER_RUN, conversation_id: CONV }],
]);

async function boot(t) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { connectionStateRecovery: { maxDisconnectionDuration: 60_000, skipMiddlewares: true } });
  const rooms = createSubagentViewerRooms({ getRun: (id) => RUNS.get(id) || null });
  io.on('connection', (socket) => rooms.registerSocket(socket));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => io.close(resolve));
  });
  async function client() {
    const socket = connectClient(url, { transports: ['websocket'], reconnectionDelay: 50, reconnectionDelayMax: 100 });
    clients.push(socket);
    const received = [];
    socket.on('subagent_timeline', (payload) => received.push(payload));
    await new Promise((resolve) => socket.once('connect', resolve));
    return { socket, received };
  }
  const publish = createSubagentTimelinePublisher(io);
  const emitBatch = (runId, seq, extra = {}) => publish({ subagentRunId: runId, entries: [{ seq, ...extra }] });
  const roomSize = (runId) => io.of('/').adapter.rooms.get(subagentViewerRoom(runId))?.size || 0;
  return { io, client, emitBatch, roomSize };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a watch is refused without ids, for an unknown run, or for a run of another conversation', async (t) => {
  const { client, roomSize } = await boot(t);
  const { socket } = await client();
  assert.deepEqual(await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV }), { ok: false, code: 'missing-id' });
  assert.deepEqual(await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: 'toolu_fixture_unknown' }), { ok: false, code: 'not-found' });
  assert.deepEqual(await socket.emitWithAck('subagent_viewer_watch', { conversationId: OTHER_CONV, subagentRunId: RUN }), { ok: false, code: 'conversation-mismatch' });
  assert.equal(roomSize(RUN), 0);
});

test('a socket watches one run at a time; unwatch and a refused watch leave the room', async (t) => {
  const { client, roomSize } = await boot(t);
  const { socket } = await client();
  assert.deepEqual(await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: RUN }), { ok: true, subagentRunId: RUN });
  assert.equal(roomSize(RUN), 1);
  // Switching to another run (a child, its parent) moves the socket.
  await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: OTHER_RUN });
  assert.equal(roomSize(RUN), 0);
  assert.equal(roomSize(OTHER_RUN), 1);
  await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: OTHER_RUN });
  assert.equal(roomSize(OTHER_RUN), 1, 'watching the same run twice is one membership');
  await socket.emitWithAck('subagent_viewer_unwatch', {});
  assert.equal(roomSize(OTHER_RUN), 0);
  await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: RUN });
  await socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: 'toolu_fixture_unknown' });
  assert.equal(roomSize(RUN), 0, 'the page shows another run now; the old one is left');
});

test('a batch reaches only the socket watching its run', async (t) => {
  const { client, emitBatch } = await boot(t);
  const viewer = await client();
  const otherViewer = await client();
  const bystander = await client();
  await viewer.socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: RUN });
  await otherViewer.socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: OTHER_RUN });
  emitBatch(RUN, 1);
  await settle();
  emitBatch(RUN, 2);
  await waitFor(() => viewer.received.length === 2);
  await settle();
  assert.deepEqual(viewer.received.map((payload) => payload.entries[0].seq), [1, 2]);
  assert.equal(otherViewer.received.length, 0);
  assert.equal(bystander.received.length, 0);

  await viewer.socket.emitWithAck('subagent_viewer_unwatch', {});
  emitBatch(RUN, 3);
  await settle();
  assert.equal(viewer.received.length, 2, 'nothing after unwatch');
});

test('after a reconnect the re-sent watch puts the socket back in the room', async (t) => {
  const { io, client, emitBatch, roomSize } = await boot(t);
  const viewer = await client();
  await viewer.socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: RUN });
  // The relay drops the connection (a restart, a network change).
  for (const socket of await io.fetchSockets()) socket.disconnect(true);
  await waitFor(() => !viewer.socket.connected);
  assert.equal(roomSize(RUN), 0);
  viewer.socket.connect();
  await new Promise((resolve) => viewer.socket.once('connect', resolve));
  // Batches sent while away are gone (volatile, never replayed)…
  emitBatch(RUN, 4);
  await settle();
  assert.equal(viewer.received.length, 0);
  // …and the client's re-watch on connect brings the live feed back.
  assert.equal((await viewer.socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: RUN })).ok, true);
  assert.equal(roomSize(RUN), 1);
  emitBatch(RUN, 5);
  await waitFor(() => viewer.received.length === 1);
  assert.equal(viewer.received[0].entries[0].seq, 5);
});

test('a recovered socket that kept its room data rejoins on its re-watch', async () => {
  const joined = [];
  const handlers = new Map();
  const socket = {
    data: { subagentViewerRoom: subagentViewerRoom(RUN) },
    rooms: new Set(['socket-id']),
    on: (event, handler) => handlers.set(event, handler),
    join: (room) => { joined.push(room); socket.rooms.add(room); },
    leave: (room) => socket.rooms.delete(room),
  };
  createSubagentViewerRooms({ getRun: (id) => RUNS.get(id) || null }).registerSocket(socket);
  let ack = null;
  handlers.get('subagent_viewer_watch')({ conversationId: CONV, subagentRunId: RUN }, (payload) => { ack = payload; });
  assert.equal(ack.ok, true);
  assert.deepEqual(joined, [subagentViewerRoom(RUN)]);
});

test('a batch sent right after another packet still arrives, merged per run', async (t) => {
  const { io, client, emitBatch } = await boot(t);
  const viewer = await client();
  await viewer.socket.emitWithAck('subagent_viewer_watch', { conversationId: CONV, subagentRunId: RUN });
  // What the relay does for a worker post that changes the run's header: the
  // status to everyone, then the batch, in the same tick. A plain volatile
  // emit here would be dropped.
  io.emit('subagent_status', { subagentRunId: RUN });
  emitBatch(RUN, 1, { text: 'Writing' });
  emitBatch(RUN, 1, { text: 'Writing the summary' });
  emitBatch(RUN, 2, { text: 'Done' });
  await waitFor(() => viewer.received.length === 1);
  await settle();
  assert.equal(viewer.received.length, 1, 'one tick, one packet');
  assert.deepEqual(viewer.received[0].entries, [{ seq: 1, text: 'Writing the summary' }, { seq: 2, text: 'Done' }]);
});
