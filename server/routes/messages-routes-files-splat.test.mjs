// GET /api/files/* and /api/files-preview/* on a real express app: the
// workspace path the handler resolves is the decoded rest of the URL, as it
// was with express 4's req.params[0].
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { splatPath } from './messages-routes.mjs';
import { captureRoutes, makeRouteDeps } from './messages-routes-test-harness.mjs';

const ROUTES = ['/api/files/{*splat}', '/api/files-preview/{*splat}'];

// The captured handlers mounted on express under the paths they were
// registered with; resolveWorkspaceFilePath records what it was asked for
// and refuses it, so no file is read.
async function startApp(t) {
  const asked = [];
  const routes = captureRoutes(makeRouteDeps({
    normalizeWorkspaceRelativePath: (requestedPath) => requestedPath,
    resolveWorkspaceFilePath: (requestedPath) => {
      asked.push(requestedPath);
      return null;
    },
  }));
  const app = express();
  for (const route of ROUTES) {
    const handler = routes.get(`GET ${route}`);
    assert.equal(typeof handler, 'function', `registered: GET ${route}`);
    app.get(route, handler);
  }
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    asked,
    get: async (urlPath) => {
      const response = await fetch(`${base}${urlPath}`);
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

test('both file routes hand the handler the decoded path after their prefix', async (t) => {
  const app = await startApp(t);
  for (const prefix of ['/api/files/', '/api/files-preview/']) {
    app.asked.length = 0;
    const answer = await app.get(`${prefix}docs/read%20me.md`);
    assert.equal(answer.status, 400, prefix);
    assert.deepEqual(answer.body, { error: 'Invalid file path' }, prefix);
    assert.deepEqual(app.asked, ['docs/read me.md'], prefix);
  }
});

test('an encoded slash and a nested folder come through as one path', async (t) => {
  const app = await startApp(t);
  await app.get('/api/files/src%2Flib/deep/file.txt');
  await app.get('/api/files/%C3%BCber/n%C3%A4he.md');
  assert.deepEqual(app.asked, ['src/lib/deep/file.txt', 'über/nähe.md']);
});

test('the prefix alone reaches the handler with an empty path, as before', async (t) => {
  const app = await startApp(t);
  const answer = await app.get('/api/files/');
  assert.equal(answer.status, 400);
  assert.deepEqual(app.asked, ['']);
});

test('splatPath joins express 5 segments and reads a missing splat as empty', () => {
  assert.equal(splatPath({ params: { splat: ['a', 'b c', 'd.txt'] } }), 'a/b c/d.txt');
  assert.equal(splatPath({ params: {} }), '');
  assert.equal(splatPath({}), '');
});
