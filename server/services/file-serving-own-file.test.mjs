// sw.js and the socket.io client from an install under a dot folder (the
// installer's ~/.oar/npm, nvm, ~/.npm-global), on a real express app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { sendOwnFile } from './file-serving.mjs';

async function serve(t, routes) {
  const app = express();
  for (const [route, handler] of Object.entries(routes)) app.get(route, handler);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (route) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
  };
}

function packageUnderDotFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-own-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, '.oar', 'npm', 'lib', 'node_modules', '@oar-sh', 'oar');
  const sw = path.join(pkg, 'server', 'public', 'sw.js');
  const client = path.join(pkg, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
  for (const [file, text] of [[sw, 'self.addEventListener("fetch", () => {});\n'], [client, 'window.io = {};\n']]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { sw, client };
}

test('the relay\'s own files are served from an install under a dot folder', async (t) => {
  const { sw, client } = packageUnderDotFolder(t);
  const get = await serve(t, {
    '/sw.js': (req, res, next) => sendOwnFile(res, sw, next),
    '/socket.io/socket.io.js': (req, res, next) => sendOwnFile(res, client, next),
  });
  const worker = await get('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.type, /javascript/);
  assert.equal(worker.text, 'self.addEventListener("fetch", () => {});\n');
  const socket = await get('/socket.io/socket.io.js');
  assert.equal(socket.status, 200);
  assert.equal(socket.text, 'window.io = {};\n');
});

test('a bare absolute path under a dot folder is what express 5 refuses', async (t) => {
  const { sw } = packageUnderDotFolder(t);
  const get = await serve(t, {
    '/sw.js': (req, res, next) => res.sendFile(sw, (error) => { if (error) res.status(error.status || 500).end(); }),
  });
  assert.equal((await get('/sw.js')).status, 404);
});
