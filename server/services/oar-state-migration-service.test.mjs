import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  MIGRATION_MARKER,
  migrateStateToOarRoot,
  resolveOarRoot,
} from './oar-state-migration-service.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A repo-shaped server dir with a real WAL-mode database. Returns the open
 * source connection so the -wal file persists while the migration runs. */
function seedRepoServerDir({ withLockPid = null } = {}) {
  const serverDir = tempDir('oar-mig-repo-');
  const dataDir = path.join(serverDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'copilot.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, text TEXT)');
  const insertConv = db.prepare('INSERT INTO conversations VALUES (?, ?)');
  const insertMsg = db.prepare('INSERT INTO messages VALUES (?, ?, ?)');
  for (let i = 0; i < 5; i += 1) insertConv.run(`c${i}`, `Conversation ${i}`);
  for (let i = 0; i < 20; i += 1) insertMsg.run(`m${i}`, `c${i % 5}`, `message body ${i}`);
  assert.ok(fs.existsSync(path.join(dataDir, 'copilot.db-wal')), 'fixture must have a live WAL');

  fs.writeFileSync(path.join(serverDir, 'config.json'), JSON.stringify({ authToken: 'repo-token', port: 3333 }));
  fs.mkdirSync(path.join(serverDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'uploads', 'note.txt'), 'attachment');
  fs.mkdirSync(path.join(dataDir, 'cursor-agents', 'agent-1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'cursor-agents', 'agent-1', 'state.json'), '{}');

  if (withLockPid !== null) {
    fs.writeFileSync(
      path.join(dataDir, 'relay-server.lock'),
      JSON.stringify({ pid: withLockPid, startedAt: '2026-01-01T00:00:00Z', token: 'x' }),
    );
  }
  return { serverDir, dataDir, db };
}

test('resolveOarRoot honors override, APPDATA on win32, and ~/.oar otherwise', () => {
  assert.equal(
    resolveOarRoot({ OAR_STATE_ROOT: '/home/dev/custom-root' }, 'linux'),
    path.resolve('/home/dev/custom-root'),
  );
  // Platform note: exercises the win32 branch; the joined shape is asserted
  // with path.join so the test passes on POSIX runners too.
  assert.equal(
    resolveOarRoot({ APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'win32'),
    path.join('C:\\Users\\dev\\AppData\\Roaming', 'oar'),
  );
  assert.equal(resolveOarRoot({}, 'linux'), path.join(os.homedir(), '.oar'));
});

test('migrates db (with WAL), config, uploads, cursor-agents; verifies and writes receipts', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  try {
    const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} });
    assert.equal(result.status, 'migrated');
    assert.equal(result.counts.conversations, 5);
    assert.equal(result.counts.messages, 20);

    const copied = new Database(path.join(target, 'data', 'copilot.db'), { readonly: true });
    assert.equal(copied.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 20);
    copied.close();

    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).authToken, 'repo-token');
    assert.ok(fs.existsSync(path.join(target, 'uploads', 'note.txt')));
    assert.ok(fs.existsSync(path.join(target, 'data', 'cursor-agents', 'agent-1', 'state.json')));
    assert.ok(fs.existsSync(path.join(target, MIGRATION_MARKER)));
    const receipt = fs.readFileSync(path.join(target, 'backups', 'MIGRATION.md'), 'utf8');
    assert.match(receipt, /5 conversations, 20 messages/);

    // Source untouched (copy, never move).
    assert.ok(fs.existsSync(path.join(serverDir, 'data', 'copilot.db')));
    assert.ok(fs.existsSync(path.join(serverDir, 'config.json')));

    // Second run is a no-op behind the marker.
    const again = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} });
    assert.equal(again.status, 'already-migrated');
  } finally {
    db.close();
  }
});

test('refuses to run while the source relay lock names a live pid', async () => {
  const { serverDir, db } = seedRepoServerDir({ withLockPid: 4242 });
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      repoServerDir: serverDir,
      isProcessAliveImpl: (pid) => pid === 4242,
      logger: {},
    });
    assert.equal(result.status, 'blocked-live-relay');
    assert.equal(result.pid, 4242);
    assert.ok(!fs.existsSync(path.join(target, MIGRATION_MARKER)), 'no marker while blocked');
    assert.ok(!fs.existsSync(path.join(target, 'data')), 'nothing copied while blocked');
  } finally {
    db.close();
  }
});

test('a stale lock (dead pid) does not block the migration', async () => {
  const { serverDir, db } = seedRepoServerDir({ withLockPid: 4242 });
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      repoServerDir: serverDir,
      isProcessAliveImpl: () => false,
      logger: {},
    });
    assert.equal(result.status, 'migrated');
  } finally {
    db.close();
  }
});

test('managed config dir migrates alone; repo config wins when both exist', async () => {
  const managedDir = tempDir('oar-mig-managed-');
  fs.writeFileSync(path.join(managedDir, 'config.json'), JSON.stringify({ authToken: 'managed-token' }));

  const targetManagedOnly = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const managedOnly = await migrateStateToOarRoot({
    targetRoot: targetManagedOnly,
    managedConfigDir: managedDir,
    logger: {},
  });
  assert.equal(managedOnly.status, 'migrated');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(targetManagedOnly, 'config.json'), 'utf8')).authToken,
    'managed-token',
  );

  const { serverDir, db } = seedRepoServerDir();
  const targetBoth = path.join(tempDir('oar-mig-target-'), 'oar-root');
  try {
    await migrateStateToOarRoot({
      targetRoot: targetBoth,
      repoServerDir: serverDir,
      managedConfigDir: managedDir,
      logger: {},
    });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(targetBoth, 'config.json'), 'utf8')).authToken,
      'repo-token',
    );
  } finally {
    db.close();
  }
});

test('nothing to migrate writes the marker and reports it', async () => {
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const result = await migrateStateToOarRoot({ targetRoot: target, logger: {} });
  assert.equal(result.status, 'nothing-to-migrate');
  assert.ok(fs.existsSync(path.join(target, MIGRATION_MARKER)));
});

test('verification failure removes the partial target and leaves no marker', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  // A Database stub whose copies report fewer rows than the source: the
  // readonly (verification) open sees a broken message count.
  class LyingDatabase extends Database {
    prepare(sql) {
      const stmt = super.prepare(sql);
      if (this.readonly && /COUNT\(\*\)/.test(sql) && /messages/.test(sql)) {
        return { get: () => ({ n: 0 }) };
      }
      return stmt;
    }
  }
  try {
    await assert.rejects(
      () => migrateStateToOarRoot({
        targetRoot: target,
        repoServerDir: serverDir,
        DatabaseImpl: LyingDatabase,
        logger: {},
      }),
      /failed verification/,
    );
    assert.ok(!fs.existsSync(target), 'partial target removed');
  } finally {
    db.close();
  }
});
