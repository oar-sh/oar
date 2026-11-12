// File capabilities (`k`) on their own, and the serving guard: a request let
// in on a capability is sent a file only once its route checked it for that
// very file. The integration through auth and the routes is in
// routes/file-capability-routes.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FILE_CAPABILITY_REQUEST_KEY,
  FILE_CAPABILITY_TTL_MS,
  createFileCapabilities,
  deriveFileCapabilityKey,
  parseFileCapability,
  withFileCapability,
} from './file-capability.mjs';
import { serveFileWithRangeSupport } from './file-serving.mjs';
import { createProtectedRelayFiles } from './relay-protected-files.mjs';

const SESSION = 'bs_abcDEF123_-x';

function service({ live = new Set([SESSION]), key = crypto.randomBytes(32), clock = { now: 1_800_000_000_000 } } = {}) {
  return {
    clock,
    live,
    caps: createFileCapabilities({ getKey: () => deriveFileCapabilityKey(key), getSession: (id) => (live.has(id) ? { id } : null), nowMs: () => clock.now }),
  };
}

test('a capability names its session and expiry, not its path; it opens that path for that session until it runs out', () => {
  const { caps, clock, live } = service();
  const made = caps.mint({ sessionId: SESSION, filePath: '/home/dev/a.png' });
  const parsed = parseFileCapability(made.k);
  assert.equal(parsed.sessionId, SESSION);
  assert.ok(!made.k.includes('a.png'));
  assert.equal(made.expiresAtMs, Math.floor((clock.now + FILE_CAPABILITY_TTL_MS) / 1000) * 1000);
  assert.deepEqual(caps.verify(made.k, { filePath: '/home/dev/a.png', sessionIds: [SESSION] }), { ok: true, sessionId: SESSION });
  assert.equal(caps.verify(made.k, { filePath: '/home/dev/b.png', sessionIds: [SESSION] }).reason, 'mac');
  assert.equal(caps.verify(made.k, { filePath: '/home/dev/a.png', sessionIds: ['bs_other'] }).reason, 'session');
  assert.equal(caps.verify('fc1.x', { filePath: '/home/dev/a.png', sessionIds: [SESSION] }).reason, 'malformed');
  clock.now += FILE_CAPABILITY_TTL_MS;
  assert.equal(caps.verify(made.k, { filePath: '/home/dev/a.png', sessionIds: [SESSION] }).reason, 'expired');
  clock.now -= FILE_CAPABILITY_TTL_MS;
  live.delete(SESSION);
  assert.equal(caps.verify(made.k, { filePath: '/home/dev/a.png', sessionIds: [SESSION] }).reason, 'revoked');
  assert.equal(caps.mint({ sessionId: SESSION, filePath: '/home/dev/a.png' }), null, 'none for a session that is gone');
});

test('an expiry further out than 10 minutes is refused, and another key\'s capability does not count', () => {
  const key = crypto.randomBytes(32);
  const later = service({ key, clock: { now: 1_800_000_000_000 + 60 * 60_000 } });
  const now = service({ key });
  const fromTheFuture = later.caps.mint({ sessionId: SESSION, filePath: '/x' });
  assert.equal(now.caps.verify(fromTheFuture.k, { filePath: '/x', sessionIds: [SESSION] }).reason, 'expired');
  const other = service();
  const made = other.caps.mint({ sessionId: SESSION, filePath: '/x' });
  assert.equal(now.caps.verify(made.k, { filePath: '/x', sessionIds: [SESSION] }).reason, 'mac');
});

test('withFileCapability keeps the address as written and replaces an earlier k', () => {
  assert.equal(withFileCapability('/api/files/a%20b.png', 'fc1.s.1.m'), '/api/files/a%20b.png?k=fc1.s.1.m');
  assert.equal(withFileCapability('/api/drives/file?path=%2Fa&k=old&v=1#x', 'new'), '/api/drives/file?path=%2Fa&v=1&k=new#x');
  assert.equal(withFileCapability('/api/files/a?k=old', ''), '/api/files/a');
});

test('the serving guard: a capability request is sent a file only after its route checked it for that file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-file-cap-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'a.txt');
  fs.writeFileSync(filePath, 'bytes');
  const answer = () => {
    const captured = { status: 200, body: null };
    const res = {
      headersSent: false,
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(body) { captured.body = body; return res; },
    };
    return { res, captured };
  };
  for (const capability of [{ k: 'x', verified: false }, { k: 'x', verified: true, verifiedPath: path.join(dir, 'b.txt') }]) {
    const { res, captured } = answer();
    serveFileWithRangeSupport({ headers: {}, query: {}, [FILE_CAPABILITY_REQUEST_KEY]: capability }, res, filePath, { contentType: 'text/plain' });
    assert.equal(captured.status, 403);
    assert.equal(captured.body.code, 'AUTH_FILE_CAPABILITY');
  }
});

test('the protected files: secrets, database (by name in the data and backup folders), config; through links and hard links', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-protected-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data');
  const backups = path.join(dir, 'backups');
  const elsewhere = path.join(dir, 'work');
  for (const each of [dataDir, backups, elsewhere]) fs.mkdirSync(each);
  const configPath = path.join(dir, 'config.json');
  const dbPath = path.join(dataDir, 'oar.db');
  for (const file of [configPath, dbPath, path.join(dataDir, 'relay-secrets.json'), path.join(backups, 'oar-0.9.0-20260101-000000-update.db'), path.join(elsewhere, 'notes.db'), path.join(elsewhere, 'a.txt')]) {
    fs.writeFileSync(file, 'x');
  }
  fs.symlinkSync(configPath, path.join(elsewhere, 'cfg'));
  fs.linkSync(path.join(dataDir, 'relay-secrets.json'), path.join(elsewhere, 'copy'));
  const guard = createProtectedRelayFiles({ dataDir, configPath, files: () => [dbPath, `${dbPath}-wal`], backupDir: () => backups });
  for (const target of [configPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.join(dataDir, 'copilot.db'), path.join(dataDir, 'relay-secrets.json'),
    path.join(dataDir, 'sub', '..', 'oar.db'), path.join(backups, 'oar-0.9.0-20260101-000000-update.db'), path.join(elsewhere, 'cfg'), path.join(elsewhere, 'copy')]) {
    assert.equal(guard.isProtected(target), true, target);
  }
  for (const target of [path.join(elsewhere, 'a.txt'), path.join(elsewhere, 'notes.db'), path.join(dataDir, 'uploads', 'p.png'), '']) {
    assert.equal(guard.isProtected(target), false, target);
  }
});
