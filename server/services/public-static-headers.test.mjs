// What the static handler of the public folder tells a browser's cache: the
// versioned browser libraries are kept, everything else is never kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { APP_SHELL_CSP } from './app-shell-csp.mjs';
import { publicStaticHeaders, publicStaticMiddleware } from './file-serving.mjs';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMMUTABLE = 'public, max-age=31536000, immutable';

async function serve(t) {
  const app = express();
  app.use(publicStaticMiddleware(publicDir));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (route) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    await response.arrayBuffer();
    return { status: response.status, cache: response.headers.get('cache-control') };
  };
}

test('every versioned vendor file is cached for a year, immutable', async (t) => {
  const get = await serve(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'vendor', 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.length > 0);
  for (const entry of manifest.files) {
    const route = `/vendor/${entry.package}@${entry.version}/${entry.path}`;
    const answer = await get(route);
    assert.equal(answer.status, 200, route);
    assert.equal(answer.cache, IMMUTABLE, route);
  }
});

test('the service worker, the app modules and the vendor manifest are never kept', async (t) => {
  const get = await serve(t);
  for (const route of ['/sw.js', '/manifest.webmanifest', '/app-icon.svg', '/favicon.ico', '/app/bootstrap.js', '/vendor/manifest.json']) {
    const answer = await get(route);
    assert.equal(answer.status, 200, route);
    assert.equal(answer.cache, 'no-store', route);
  }
});

test('the decision follows the file on disk, not a path prefix in the request', () => {
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; } };
  const setHeaders = publicStaticHeaders(publicDir);
  setHeaders(res, path.join(publicDir, 'vendor', 'marked@15.0.12', 'marked.min.js'));
  assert.equal(headers['Cache-Control'], IMMUTABLE);
  setHeaders(res, path.join(publicDir, 'vendor', '@highlightjs', 'cdn-assets@11.9.0', 'highlight.min.js'));
  assert.equal(headers['Cache-Control'], IMMUTABLE);
  setHeaders(res, path.join(publicDir, 'app', 'vendor', 'marked@15.0.12', 'x.js'));
  assert.equal(headers['Cache-Control'], 'no-store');
  setHeaders(res, path.join(publicDir, 'vendor', 'notes.txt'));
  assert.equal(headers['Cache-Control'], 'no-store');
  setHeaders(res, path.join(path.dirname(publicDir), 'vendor', 'marked@15.0.12', 'marked.min.js'));
  assert.equal(headers['Cache-Control'], 'no-store');
});

test('an HTML file that leaves through the static handler gets the app shell policy', () => {
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; } };
  const setHeaders = publicStaticHeaders(publicDir);
  setHeaders(res, path.join(publicDir, 'app', 'notes.js'));
  assert.equal(headers['Content-Security-Policy'], undefined);
  setHeaders(res, path.join(publicDir, 'index.html'));
  assert.equal(headers['Content-Security-Policy'], APP_SHELL_CSP);
  setHeaders(res, path.join(publicDir, 'other.HTM'));
  assert.equal(headers['Content-Security-Policy'], APP_SHELL_CSP);
});
