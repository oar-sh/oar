'use strict';

// server-runtime.mjs boots a live server on import, so this is pinned by
// source inspection like the other runtime suites. The behaviour itself was
// measured end to end: with Node's default, a pooled connection reused after
// 6 s of idle time had its next POST reset every time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');

test('the relay keeps idle connections longer than pooling clients and proxies do', () => {
  const keepAlive = Number(runtimeSource.match(/httpServer\.keepAliveTimeout = ([\d_]+);/)?.[1].replaceAll('_', ''));
  const headers = Number(runtimeSource.match(/httpServer\.headersTimeout = ([\d_]+);/)?.[1].replaceAll('_', ''));
  assert.ok(keepAlive >= 60_000, `keepAliveTimeout is ${keepAlive}`);
  assert.ok(headers > keepAlive, 'headersTimeout must exceed keepAliveTimeout, or Node closes the socket on the header timer instead');
});
