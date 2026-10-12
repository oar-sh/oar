import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Server } from 'socket.io';

import { guardUpgradeSocket } from './upgrade-socket-guard.mjs';

function captureUncaught(t) {
  const caught = [];
  const onUncaught = (error) => caught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  return caught;
}

test('a client reset on an upgrade nobody claims does not escape as an uncaught error', async (t) => {
  const caught = captureUncaught(t);
  const httpServer = http.createServer();
  httpServer.prependListener('upgrade', (_req, socket) => guardUpgradeSocket(socket));
  // Socket.IO holds a socket on a foreign path for a second before closing it.
  const io = new Server(httpServer, { path: '/socket.io' });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(async () => {
    await new Promise((resolve) => io.close(() => resolve()));
  });

  const accepted = once(httpServer, 'upgrade');
  const client = net.connect(httpServer.address().port, '127.0.0.1');
  client.on('error', () => {});
  client.write('GET /elsewhere HTTP/1.1\r\nHost: relay.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [, serverSocket] = await accepted;
  client.resetAndDestroy();

  // events.once() would reject on the socket's own 'error'; only the close counts.
  await new Promise((resolve) => serverSocket.once('close', resolve));
  assert.equal(serverSocket.destroyed, true);
  assert.deepEqual(caught, []);
});

test('guardUpgradeSocket adds its listener once per socket', () => {
  const socket = new net.Socket();
  guardUpgradeSocket(socket);
  guardUpgradeSocket(socket);
  assert.equal(socket.listenerCount('error'), 1);
  socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  assert.equal(socket.destroyed, true);
  guardUpgradeSocket(null);
});
