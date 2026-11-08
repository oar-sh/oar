import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import WebSocket from 'ws';

import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { applySchema } from '../db-schema.mjs';
import { MAX_THOUGHT_CHARS } from '../../shared/thought-cap.mjs';
import { makeRouteDeps, postHandler } from './messages-routes-test-harness.mjs';

// POST /api/thought on a real socket.io server with connection state recovery,
// as server-runtime.mjs runs it. Every thought update carries the whole
// thought so far (up to MAX_THOUGHT_CHARS); a worker streaming long reasoning
// a token at a time sends thousands of them. The relay must not keep them in
// the recovery buffer, nor queue them for a client that does not read.

const require = createRequire(import.meta.url);
const connectClient = require(path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist/socket.io.js'));

const NOW = '2026-01-01T00:00:00.000Z';
// A full-size thought in a two-byte script, as the long reasoning seen live.
const FULL_THOUGHT = '考'.repeat(MAX_THOUGHT_CHARS);

async function boot(t) {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Test', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, timestamp) VALUES ('q-1', 'conv-1', 'prompt', ?)`).run(NOW);

  const httpServer = http.createServer();
  const io = new Server(httpServer, { connectionStateRecovery: { maxDisconnectionDuration: 10 * 60 * 1000, skipMiddlewares: true } });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => io.close(resolve));
    db.close();
  });
  async function client() {
    const socket = connectClient(url, { transports: ['websocket'], reconnection: false });
    clients.push(socket);
    const thoughts = [];
    socket.on('relay_thought', (payload) => thoughts.push(payload));
    await new Promise((resolve) => socket.once('connect', resolve));
    return { socket, thoughts };
  }
  // A socket.io client on a raw `ws` socket, so its TCP reads can be paused.
  async function rawClient() {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`);
    clients.push({ close: () => ws.terminate() });
    const thoughts = [];
    let sid = null;
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (data) => {
        const frame = String(data);
        if (frame.startsWith('0{')) ws.send('40');
        else if (frame.startsWith('40{')) { sid = JSON.parse(frame.slice(2)).sid; resolve(); }
        else if (frame.startsWith('42[')) {
          const [event, payload] = JSON.parse(frame.slice(2));
          if (event === 'relay_thought') thoughts.push(payload);
        }
      });
    });
    return { sid, thoughts, pause: () => ws._socket.pause(), resume: () => ws._socket.resume() };
  }
  const post = postHandler('/api/thought', makeRouteDeps({
    db: {
      prepare: () => ({ run() {}, get: () => null, all: () => [] }),
      transaction: (fn) => db.transaction(fn),
    },
    stmts: { ...createQuestionRepository(db), findQById: db.prepare(`SELECT * FROM queue WHERE id = ?`) },
    io,
    DEFAULT_RELAY_MODE: 'agent',
  }));
  const thought = (text, done = false) => post({
    messageId: 'q-1', conversationId: 'conv-1', mode: 'agent', reasoningId: 'thought-main-1-0', text, done,
  });
  const recoveryPackets = () => io.of('/').adapter.packets.filter((packet) => packet.data?.[0] === 'relay_thought');
  return { db, io, client, rawClient, thought, recoveryPackets };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(check, timeoutMs = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('thought updates in flight stay out of the recovery buffer; the final thought is kept', async (t) => {
  const { db, thought, recoveryPackets, client } = await boot(t);
  const { thoughts } = await client();
  for (let i = 0; i < 300; i += 1) {
    const { status } = await thought(FULL_THOUGHT.slice(0, MAX_THOUGHT_CHARS - 300 + i));
    assert.equal(status, 200);
  }
  assert.equal(recoveryPackets().length, 0, 'no update in flight is kept for a replay');

  const { status } = await thought(FULL_THOUGHT, true);
  assert.equal(status, 200);
  const kept = recoveryPackets();
  assert.equal(kept.length, 1, 'the final thought is kept for a client that comes back');
  assert.equal(kept[0].data[1].done, true);
  assert.equal(kept[0].data[1].text, FULL_THOUGHT);

  // A connected client still gets updates live, and the final one.
  await waitFor(() => thoughts.some((payload) => payload.done));
  assert.ok(thoughts.length > 1);
  assert.equal(thoughts.at(-1).text, FULL_THOUGHT);
  // The stored snapshot, which a reconnect resync reads, is the latest text.
  const row = db.prepare(`SELECT text, done FROM relay_thought WHERE queue_message_id = 'q-1'`).get();
  assert.deepEqual({ ...row }, { text: FULL_THOUGHT, done: 1 });
});

test('a client that stops reading does not queue thought updates without bound', async (t) => {
  const { io, client, rawClient, thought } = await boot(t);
  const reader = await client();
  const stalled = await rawClient();
  // Stop reading on the client's TCP socket: the relay's writes back up.
  stalled.pause();
  const serverSocket = io.of('/').sockets.get(stalled.sid);
  assert.ok(serverSocket);
  const queuedBytes = () => {
    const conn = serverSocket.conn;
    const tcp = conn.transport.socket?._socket;
    const engineQueued = conn.writeBuffer.reduce((sum, packet) => sum + String(packet.data || '').length * 3, 0);
    return (tcp?.writableLength || 0) + engineQueued;
  };

  const updates = 1000;
  let maxQueued = 0;
  for (let i = 0; i < updates; i += 1) {
    await thought(FULL_THOUGHT.slice(0, MAX_THOUGHT_CHARS - updates + i));
    await tick();
    maxQueued = Math.max(maxQueued, queuedBytes());
  }
  // 1000 updates of ~48 KB on the wire are ~48 MB; what a paused reader can
  // hold up is the socket's buffers, not the turn's worth of copies.
  assert.ok(maxQueued < 8 * 1024 * 1024, `${(maxQueued / 1048576).toFixed(1)} MB queued for a client that does not read`);

  // The final thought is not dropped: once the client reads again it arrives.
  await thought(FULL_THOUGHT, true);
  stalled.resume();
  await waitFor(() => stalled.thoughts.some((payload) => payload.done));
  assert.equal(stalled.thoughts.at(-1).text, FULL_THOUGHT);
  await waitFor(() => reader.thoughts.some((payload) => payload.done));
});
