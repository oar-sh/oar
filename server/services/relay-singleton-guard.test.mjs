import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { createRelaySingletonGuard } from './relay-singleton-guard.mjs';

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-'));
  return path.join(dir, 'relay-server.lock');
}

test('the lock file stores a hash, never the plaintext auth token', () => {
  const lockPath = tmpLock();
  const token = 'super-secret-token-value';
  const guard = createRelaySingletonGuard({ lockPath, pid: 1234, token, isProcessAlive: () => false });
  guard.acquire();

  const raw = fs.readFileSync(lockPath, 'utf8');
  assert.doesNotMatch(raw, /super-secret-token-value/, 'plaintext token must not appear on disk');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.token, undefined, 'no plaintext token field');
  assert.equal(parsed.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('the lock file is created owner-only (0600) on POSIX', { skip: process.platform === 'win32' }, () => {
  const lockPath = tmpLock();
  const guard = createRelaySingletonGuard({ lockPath, pid: 1234, token: 't', isProcessAlive: () => false });
  guard.acquire();
  const mode = fs.statSync(lockPath).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a live process holding the lock with the same token is detected as already running', () => {
  const lockPath = tmpLock();
  const opts = { lockPath, pid: 4242, token: 'tok', isProcessAlive: () => true };
  createRelaySingletonGuard(opts).acquire();
  assert.throws(() => createRelaySingletonGuard(opts).acquire(), /already running/);
});

test('a stale lock from a dead process is recovered', () => {
  const lockPath = tmpLock();
  createRelaySingletonGuard({ lockPath, pid: 1, token: 'tok', isProcessAlive: () => false }).acquire();
  // A second acquire with the pid reported dead should recover and succeed.
  const payload = createRelaySingletonGuard({ lockPath, pid: 2, token: 'tok', isProcessAlive: () => false }).acquire();
  assert.equal(payload.pid, 2);
});

test('a legacy plaintext-token lock still matches for ownership', () => {
  const lockPath = tmpLock();
  const token = 'legacy-token';
  // Simulate an old build's lock file with a plaintext token field.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, token, startedAt: 'x' }));
  const guard = createRelaySingletonGuard({ lockPath, pid: 1000, token, isProcessAlive: () => true });
  assert.throws(() => guard.acquire(), /already running/, 'legacy token must hash-match');
});

test('release only removes the lock the current process owns', () => {
  const lockPath = tmpLock();
  createRelaySingletonGuard({ lockPath, pid: 5, token: 'a', isProcessAlive: () => false }).acquire();
  // A different token/pid must not release someone else's lock.
  const other = createRelaySingletonGuard({ lockPath, pid: 6, token: 'b', isProcessAlive: () => false });
  assert.equal(other.release(), false);
  assert.ok(fs.existsSync(lockPath));
});
