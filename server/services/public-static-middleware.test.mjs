// The static handler of the public folder never sends the page template:
// only the app shell routes render it (base path, configuration, page
// policy). Requests go over a real socket with the path exactly as written,
// since fetch() would tidy dot segments and double slashes first.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { isPublicHtmlRequest, publicStaticMiddleware } from './file-serving.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

async function serve(t) {
  const app = express();
  app.use(publicStaticMiddleware(publicDir));
  app.use((req, res) => res.status(404).type('text/plain').send('fell through'));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (rawPath, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const TEMPLATE_MARKER = '__COPILOT_APP_CONFIG';

test('no spelling of the page path gets the raw template', async (t) => {
  const get = await serve(t);
  const spellings = [
    '/index.html',
    '//index.html',
    '/%69ndex.html',
    '/./index.html',
    '/%2e/index.html',
    '/app/../index.html',
    '/app/..%2Findex.html',
    '/app/..%5Cindex.html',
    '//elsewhere.test/..%2Findex.html',
    '/INDEX.HTML',
    '/index.html/',
    '/',
    '//',
  ];
  for (const spelling of spellings) {
    for (const method of ['GET', 'HEAD']) {
      const answer = await get(spelling, method);
      assert.notEqual(answer.status, 200, `${method} ${spelling} answered 200`);
      assert.ok(!answer.body.includes(TEMPLATE_MARKER), `${method} ${spelling} sent the template`);
    }
  }
});

// On Windows `index.html::$DATA` is index.html itself (its data stream), and
// its name does not end in .html: a path with a colon is never served from
// the public folder, on any system, and goes on to the routes after it.
test('a path with a colon (a Windows file stream) is not served from the public folder', async (t) => {
  const get = await serve(t);
  for (const spelling of [
    '/index.html::$DATA',
    '/index.html%3A%3A$DATA',
    '/index.html%3a%3a%24DATA',
    '/index.html:x',
    '/INDEX.HTML::$DATA',
    '/app/..%2Findex.html::$DATA',
    '/sw.js::$DATA',
    '/app/store.js%3A%3A$DATA',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const answer = await get(spelling, method);
      assert.equal(answer.status, 404, `${method} ${spelling}`);
      if (method === 'GET') assert.equal(answer.body, 'fell through', `${method} ${spelling} was not left to the routes after it`);
      assert.ok(!answer.body.includes(TEMPLATE_MARKER), `${method} ${spelling} sent the template`);
    }
  }
});

test('the other public files are still served', async (t) => {
  const get = await serve(t);
  for (const route of ['/sw.js', '/app/store.js', '/app/app-base.mjs', '/vendor/manifest.json', '/manifest.webmanifest']) {
    const answer = await get(route);
    assert.equal(answer.status, 200, route);
  }
});

test('an HTML path that is not a public file is left to the routes after it', () => {
  assert.equal(isPublicHtmlRequest(publicDir, '/api/files/docs/readme.html'), false);
  assert.equal(isPublicHtmlRequest(publicDir, '/api/drives/file'), false);
  assert.equal(isPublicHtmlRequest(publicDir, '/no-such-page.html'), false);
  assert.equal(isPublicHtmlRequest(publicDir, '/../../etc/index.html'), false);
  assert.equal(isPublicHtmlRequest(publicDir, '/%E0%A4%A'), false);
  assert.equal(isPublicHtmlRequest(publicDir, '/index.html%00.js'), false);
  assert.equal(isPublicHtmlRequest(publicDir, '/index.html'), true);
  assert.equal(isPublicHtmlRequest(publicDir, '//x.test/..%2Findex.html'), true);
});

test('a non-GET request is left to the routes after it', async (t) => {
  const get = await serve(t);
  const answer = await get('/index.html', 'POST');
  assert.equal(answer.body, 'fell through');
});
