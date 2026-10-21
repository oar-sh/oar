import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  MIGRATION_MARKER,
  mergeStrayMigratedUploads,
  migrateStateToOarRoot,
  resolveOarRoot,
} from './oar-state-migration-service.mjs';

// Every folder made here is removed at the end: a run used to leave several in the temp dir.
const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

/** A database in the target data dir, as a relay's first start leaves it
 * (tables, no rows) or with `conversations` rows in it. */
function seedTargetDb(dataDir, { conversations = 0 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'copilot.db'));
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, text TEXT)');
  for (let i = 0; i < conversations; i += 1) db.prepare('INSERT INTO conversations VALUES (?, ?)').run(`t${i}`, 'kept');
  db.close();
}

/** A WAL-mode database left as a killed relay leaves it: copilot.db plus a
 * -wal (and -shm) holding writes never checkpointed into the main file. */
function seedTargetWalDb(dataDir, { conversations = 0 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const scratch = tempDir('oar-mig-wal-');
  const db = new Database(path.join(scratch, 'copilot.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, text TEXT)');
  for (let i = 0; i < conversations; i += 1) db.prepare('INSERT INTO conversations VALUES (?, ?)').run(`w${i}`, 'in the wal');
  for (const name of ['copilot.db', 'copilot.db-wal', 'copilot.db-shm']) {
    fs.copyFileSync(path.join(scratch, name), path.join(dataDir, name));
  }
  db.close();
  assert.ok(fs.statSync(path.join(dataDir, 'copilot.db-wal')).size > 0, 'fixture must have a non-empty WAL');
}

const countRows = (dbPath, table) => {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); }
};

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
    // Uploads land where a global install's relay reads them: inside its data dir.
    assert.ok(fs.existsSync(path.join(target, 'data', 'uploads', 'note.txt')));
    assert.ok(!fs.existsSync(path.join(target, 'uploads')));
    assert.ok(fs.existsSync(path.join(target, 'data', 'cursor-agents', 'agent-1', 'state.json')));
    assert.ok(fs.existsSync(path.join(target, MIGRATION_MARKER)));
    const receipt = fs.readFileSync(path.join(target, 'backups', 'MIGRATION.md'), 'utf8');
    assert.match(receipt, /5 conversations, 20 messages/);

    // Source untouched (copy, never move).
    assert.ok(fs.existsSync(path.join(serverDir, 'data', 'copilot.db')));
    assert.ok(fs.existsSync(path.join(serverDir, 'config.json')));

    // An automatic run (no explicit source) is a no-op behind the marker.
    const again = await migrateStateToOarRoot({ targetRoot: target, logger: {} });
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

test('nothing to migrate writes no marker and creates nothing', async () => {
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const result = await migrateStateToOarRoot({ targetRoot: target, logger: {} });
  assert.equal(result.status, 'nothing-to-migrate');
  assert.ok(!fs.existsSync(target), 'an automatic run with no source leaves no trace');
});

test('an explicit source migrates after an automatic run, behind its marker, and keeps the existing config', async () => {
  // The installer's automatic run brought the legacy managed config over and
  // wrote the marker; the old checkout is named later.
  const managedDir = tempDir('oar-mig-managed-');
  fs.writeFileSync(path.join(managedDir, 'config.json'), JSON.stringify({ authToken: 'managed-token' }));
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const automatic = await migrateStateToOarRoot({ targetRoot: target, managedConfigDir: managedDir, logger: {} });
  assert.equal(automatic.status, 'migrated');
  assert.ok(fs.existsSync(path.join(target, MIGRATION_MARKER)));

  const { serverDir, db } = seedRepoServerDir();
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      repoServerDir: serverDir,
      managedConfigDir: managedDir,
      logger: {},
    });
    assert.equal(result.status, 'migrated');
    assert.equal(result.counts.messages, 20);
    assert.ok(fs.existsSync(path.join(target, 'data', 'copilot.db')));
    assert.ok(fs.existsSync(path.join(target, 'data', 'uploads', 'note.txt')));
    // The config already there is never overwritten, and the result says so.
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).authToken, 'managed-token');
    assert.deepEqual(result.kept, [path.join(target, 'config.json')]);
  } finally {
    db.close();
  }
});

test('an explicit source never overwrites a database with conversations, nor one it cannot read', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetDb(path.join(target, 'data'), { conversations: 1 });
  const unreadable = path.join(tempDir('oar-mig-target-'), 'oar-root');
  fs.mkdirSync(path.join(unreadable, 'data'), { recursive: true });
  fs.writeFileSync(path.join(unreadable, 'data', 'copilot.db'), 'not a database');
  try {
    const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} });
    assert.equal(result.status, 'refused-existing-database');
    assert.match(result.error, /already has a database/);
    assert.match(result.error, /copilot\.db/);
    assert.equal(countRows(path.join(target, 'data', 'copilot.db'), 'conversations'), 1);
    assert.ok(!fs.existsSync(path.join(target, 'config.json')), 'nothing copied when refused');
    assert.ok(!fs.existsSync(path.join(target, 'data', 'uploads')), 'nothing copied when refused');
    assert.ok(!fs.existsSync(path.join(target, 'backups')), 'nothing moved aside when refused');
    assert.ok(!fs.existsSync(path.join(target, MIGRATION_MARKER)));

    const other = await migrateStateToOarRoot({ targetRoot: unreadable, repoServerDir: serverDir, logger: {} });
    assert.equal(other.status, 'refused-existing-database');
    assert.equal(fs.readFileSync(path.join(unreadable, 'data', 'copilot.db'), 'utf8'), 'not a database');
  } finally {
    db.close();
  }
});

test('a fresh, empty database with no relay on it is moved into backups/ and the migration runs', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetDb(path.join(target, 'data'));
  // The installer's relay ran once and is gone: its lock names a dead pid.
  fs.writeFileSync(path.join(target, 'data', 'relay-server.lock'), JSON.stringify({ pid: 5151 }));
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      repoServerDir: serverDir,
      isProcessAliveImpl: () => false,
      now: () => '2026-10-20T06:30:00.000Z',
      logger: {},
    });
    assert.equal(result.status, 'migrated');
    const aside = path.join(target, 'backups', '2026-10-20T06-30-00-000Z');
    assert.equal(result.movedAsideTo, aside);
    assert.equal(countRows(path.join(aside, 'copilot.db'), 'conversations'), 0);
    assert.equal(countRows(path.join(target, 'data', 'copilot.db'), 'messages'), 20);
    assert.match(fs.readFileSync(path.join(target, 'backups', 'MIGRATION.md'), 'utf8'), /Moved aside/);
  } finally {
    db.close();
  }
});

test('a fresh database a relay is running on refuses: stop the relay first', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetDb(path.join(target, 'data'));
  fs.writeFileSync(path.join(target, 'data', 'relay-server.lock'), JSON.stringify({ pid: 6161 }));
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      repoServerDir: serverDir,
      isProcessAliveImpl: (pid) => pid === 6161,
      logger: {},
    });
    assert.equal(result.status, 'refused-relay-running');
    assert.equal(result.pid, 6161);
    assert.match(result.error, /stop the relay first \(oar stop\)/);
    assert.equal(countRows(path.join(target, 'data', 'copilot.db'), 'conversations'), 0);
    assert.ok(!fs.existsSync(path.join(target, 'backups')));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'uploads')));
  } finally {
    db.close();
  }
});

test('an explicit source with nothing in it says why nothing was done', async () => {
  const emptyServerDir = tempDir('oar-mig-empty-');
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: emptyServerDir, logger: {} });
  assert.equal(result.status, 'nothing-to-migrate');
  assert.match(result.reason, /no database and no config\.json/);
  assert.ok(!fs.existsSync(target));
});

test('database and uploads go to the data and upload dirs the caller resolved', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const base = tempDir('oar-mig-target-');
  const target = path.join(base, 'oar-root');
  const dataDir = path.join(base, 'elsewhere', 'data');
  const uploadDir = path.join(base, 'elsewhere', 'blobs');
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      targetDataDir: dataDir,
      targetUploadDir: uploadDir,
      repoServerDir: serverDir,
      logger: {},
    });
    assert.equal(result.status, 'migrated');
    assert.ok(fs.existsSync(path.join(dataDir, 'copilot.db')));
    assert.ok(fs.existsSync(path.join(dataDir, 'cursor-agents', 'agent-1', 'state.json')));
    assert.ok(fs.existsSync(path.join(uploadDir, 'note.txt')));
    assert.ok(!fs.existsSync(path.join(target, 'data')));
  } finally {
    db.close();
  }
});

test('verification failure removes only what the migration created and leaves no marker', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  // State that was there before the migration: a config, a log, an upload.
  fs.mkdirSync(path.join(target, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(target, 'data', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ authToken: 'kept-token' }));
  fs.writeFileSync(path.join(target, 'logs', 'server.log'), 'earlier log');
  fs.writeFileSync(path.join(target, 'data', 'uploads', 'earlier-blob'), 'earlier upload');
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
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), JSON.stringify({ authToken: 'kept-token' }));
    assert.equal(fs.readFileSync(path.join(target, 'logs', 'server.log'), 'utf8'), 'earlier log');
    assert.equal(fs.readFileSync(path.join(target, 'data', 'uploads', 'earlier-blob'), 'utf8'), 'earlier upload');
    // What the migration copied is gone again.
    assert.ok(!fs.existsSync(path.join(target, 'data', 'copilot.db')));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'copilot.db-wal')));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'cursor-agents')));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'uploads', 'note.txt')));
    assert.ok(!fs.existsSync(path.join(target, MIGRATION_MARKER)));
  } finally {
    db.close();
  }
});

test('a failed migration puts a fresh database it moved aside back', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetDb(path.join(target, 'data'));
  const before = fs.readFileSync(path.join(target, 'data', 'copilot.db'));
  class LyingDatabase extends Database {
    prepare(sql) {
      const stmt = super.prepare(sql);
      // Only the verification of the copy lies (it runs once the fresh
      // database is in backups/); the fresh check before it sees the truth.
      if (this.readonly && /COUNT\(\*\)/.test(sql) && /messages/.test(sql)
        && fs.existsSync(path.join(target, 'backups'))) {
        return { get: () => ({ n: 0 }) };
      }
      return stmt;
    }
  }
  try {
    await assert.rejects(
      () => migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, DatabaseImpl: LyingDatabase, logger: {} }),
      /failed verification/,
    );
    assert.deepEqual(fs.readFileSync(path.join(target, 'data', 'copilot.db')), before);
    assert.ok(!fs.existsSync(path.join(target, 'data', 'copilot.db-wal')));
    assert.ok(!fs.existsSync(path.join(target, 'backups')), 'the backup folder made for it is gone again');
    assert.ok(!fs.existsSync(path.join(target, MIGRATION_MARKER)));
  } finally {
    db.close();
  }
});

// ─── review round: data safety, repeat runs, the lock, symlinks ─────────────

test('a target uploads link to a missing disk is never deleted by a failed copy', { skip: process.platform === 'win32' }, async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  const unmounted = path.join(tempDir('oar-mig-disk-'), 'not-mounted', 'uploads');
  fs.symlinkSync(unmounted, path.join(target, 'data', 'uploads'));
  try {
    await assert.rejects(() => migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} }));
    assert.ok(fs.lstatSync(path.join(target, 'data', 'uploads')).isSymbolicLink(), 'the user\'s link is still there');
    assert.ok(!fs.existsSync(path.join(target, 'data', 'copilot.db')), 'the copied database was taken back');
  } finally {
    db.close();
  }
});

test('a database moved aside stays in backups/ when it cannot be moved back, and the error says where', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const dataDir = path.join(target, 'data');
  seedTargetDb(dataDir);
  // The verification fails, and the data dir is read-only by then (as a
  // locked file on Windows would be): nothing can be moved back into it.
  class LockingDatabase extends Database {
    prepare(sql) {
      const stmt = super.prepare(sql);
      if (this.readonly && /COUNT\(\*\)/.test(sql) && /messages/.test(sql) && fs.existsSync(path.join(target, 'backups'))) {
        fs.chmodSync(dataDir, 0o500);
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
        DatabaseImpl: LockingDatabase,
        now: () => '2026-10-20T07:00:00.000Z',
        logger: {},
      }),
      (error) => /failed verification/.test(error.message) && error.message.includes(path.join(target, 'backups', '2026-10-20T07-00-00-000Z')),
    );
    assert.equal(countRows(path.join(target, 'backups', '2026-10-20T07-00-00-000Z', 'copilot.db'), 'conversations'), 0);
  } finally {
    fs.chmodSync(dataDir, 0o700);
    db.close();
  }
});

test('uploads an earlier migration left in <root>/uploads are merged into the data dir, never deleted', () => {
  const root = path.join(tempDir('oar-mig-stray-'), 'oar-root');
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uploads', 'aaa'), 'stray blob');
  fs.writeFileSync(path.join(root, 'uploads', 'bbb'), 'stray copy');
  fs.writeFileSync(path.join(root, 'data', 'uploads', 'bbb'), 'the relay\'s own');
  const lines = [];
  const logger = { log: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const args = { dataDir: path.join(root, 'data'), uploadDir: path.join(root, 'data', 'uploads'), logger };

  // Without the marker of an earlier migration nothing is touched.
  assert.equal(mergeStrayMigratedUploads(args), 0);
  assert.ok(!fs.existsSync(path.join(root, 'data', 'uploads', 'aaa')));

  fs.writeFileSync(path.join(root, MIGRATION_MARKER), '2026-01-01T00:00:00.000Z migrated\n');
  assert.equal(mergeStrayMigratedUploads(args), 1);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'uploads', 'aaa'), 'utf8'), 'stray blob');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'uploads', 'bbb'), 'utf8'), 'the relay\'s own');
  assert.equal(fs.readFileSync(path.join(root, 'uploads', 'aaa'), 'utf8'), 'stray blob', 'the source stays');
  assert.match(lines.join('\n'), /1 upload/);
  assert.equal(mergeStrayMigratedUploads(args), 0, 'a second start merges nothing');

  // An upload dir that is not <root>/data/uploads (a checkout) is left alone.
  assert.equal(mergeStrayMigratedUploads({ ...args, uploadDir: path.join(root, 'elsewhere') }), 0);
});

test('the same source again is already migrated, whatever the state root holds now', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  try {
    assert.equal((await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} })).status, 'migrated');
    const again = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} });
    assert.equal(again.status, 'already-migrated');
    assert.equal(again.source, serverDir);

    // Another source is refused: the state root has conversations now.
    const other = seedRepoServerDir();
    try {
      const refused = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: other.serverDir, logger: {} });
      assert.equal(refused.status, 'refused-existing-database');
    } finally {
      other.db.close();
    }

    // With the database moved away by hand, the same source runs again.
    fs.renameSync(path.join(target, 'data'), path.join(target, 'data-old'));
    assert.equal((await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} })).status, 'migrated');
  } finally {
    db.close();
  }
});

test('a database with conversations is refused as such even while a relay runs on it: no "stop the relay"', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetDb(path.join(target, 'data'), { conversations: 2 });
  fs.writeFileSync(path.join(target, 'data', 'relay-server.lock'), JSON.stringify({ pid: 8181 }));
  try {
    const result = await migrateStateToOarRoot({
      targetRoot: target,
      repoServerDir: serverDir,
      isProcessAliveImpl: (pid) => pid === 8181,
      logger: {},
    });
    assert.equal(result.status, 'refused-existing-database');
    assert.doesNotMatch(result.error, /stop the relay first/);
  } finally {
    db.close();
  }
});

test('the run holds the relay lock while it copies the database, and a relay holding it refuses the run', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const lockPath = path.join(target, 'data', 'relay-server.lock');
  let lockDuringRun = null;
  class WatchingDatabase extends Database {
    prepare(sql) {
      if (this.readonly && /COUNT\(\*\)/.test(sql) && fs.existsSync(path.join(target, 'data', 'copilot.db'))) {
        lockDuringRun ??= JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      }
      return super.prepare(sql);
    }
  }
  try {
    const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, DatabaseImpl: WatchingDatabase, logger: {} });
    assert.equal(result.status, 'migrated');
    assert.equal(lockDuringRun?.pid, process.pid, 'the lock names this process while it runs');
    assert.ok(!fs.existsSync(lockPath), 'and is gone afterwards');

    // A relay that started on an empty data dir holds the lock: refused.
    const busy = path.join(tempDir('oar-mig-target-'), 'oar-root');
    fs.mkdirSync(path.join(busy, 'data'), { recursive: true });
    fs.writeFileSync(path.join(busy, 'data', 'relay-server.lock'), JSON.stringify({ pid: 9191, tokenHash: 'x', startedAt: 'then' }));
    const refused = await migrateStateToOarRoot({
      targetRoot: busy,
      repoServerDir: serverDir,
      isProcessAliveImpl: (pid) => pid === 9191,
      logger: {},
    });
    assert.equal(refused.status, 'refused-relay-running');
    assert.match(refused.error, /stop the relay first \(oar stop\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(busy, 'data', 'relay-server.lock'), 'utf8')).pid, 9191, 'its lock is left alone');
    assert.ok(!fs.existsSync(path.join(busy, 'data', 'copilot.db')));
  } finally {
    db.close();
  }
});

test('symlinked source folders are copied as real folders; links inside them are skipped and reported', { skip: process.platform === 'win32' }, async () => {
  const { serverDir, db } = seedRepoServerDir();
  const realUploads = path.join(tempDir('oar-mig-real-'), 'uploads');
  fs.mkdirSync(realUploads, { recursive: true });
  fs.writeFileSync(path.join(realUploads, 'blob'), 'real blob');
  fs.symlinkSync(path.join(serverDir, 'config.json'), path.join(realUploads, 'inner-link'));
  fs.rmSync(path.join(serverDir, 'uploads'), { recursive: true });
  fs.symlinkSync(realUploads, path.join(serverDir, 'uploads'));
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  try {
    const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} });
    assert.equal(result.status, 'migrated');
    const uploads = path.join(target, 'data', 'uploads');
    assert.ok(!fs.lstatSync(uploads).isSymbolicLink(), 'a real folder, not a link to the source');
    assert.equal(fs.readFileSync(path.join(uploads, 'blob'), 'utf8'), 'real blob');
    assert.ok(!fs.existsSync(path.join(uploads, 'inner-link')));
    assert.deepEqual(result.skipped, [path.join(serverDir, 'uploads', 'inner-link')]);
    assert.match(fs.readFileSync(path.join(target, 'backups', 'MIGRATION.md'), 'utf8'), /Skipped \(links, not copied/);
  } finally {
    db.close();
  }
});

test('a WAL-mode fresh database is moved aside with its -wal; conversations only in the WAL are seen', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const fresh = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetWalDb(path.join(fresh, 'data'));
  const used = path.join(tempDir('oar-mig-target-'), 'oar-root');
  seedTargetWalDb(path.join(used, 'data'), { conversations: 1 });
  try {
    const moved = await migrateStateToOarRoot({ targetRoot: fresh, repoServerDir: serverDir, logger: {} });
    assert.equal(moved.status, 'migrated');
    assert.ok(fs.existsSync(path.join(moved.movedAsideTo, 'copilot.db-wal')));
    assert.equal(countRows(path.join(fresh, 'data', 'copilot.db'), 'messages'), 20);

    const refused = await migrateStateToOarRoot({ targetRoot: used, repoServerDir: serverDir, logger: {} });
    assert.equal(refused.status, 'refused-existing-database');
  } finally {
    db.close();
  }
});

test('stray -wal/-shm files without a database are refused in words that say so', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  fs.writeFileSync(path.join(target, 'data', 'copilot.db-wal'), 'stray');
  try {
    const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, logger: {} });
    assert.equal(result.status, 'refused-existing-database');
    assert.doesNotMatch(result.error, /with conversations/);
    assert.match(result.error, /copilot\.db-wal/);
    assert.match(result.error, /without copilot\.db/);
  } finally {
    db.close();
  }
});

test('a database that got a conversation before the lock was taken is refused under the lock', async () => {
  const { serverDir, db } = seedRepoServerDir();
  const target = path.join(tempDir('oar-mig-target-'), 'oar-root');
  const targetDb = path.join(target, 'data', 'copilot.db');
  seedTargetDb(path.join(target, 'data'));
  // A relay writes a conversation right after the first (lock-free) look.
  let wrote = false;
  class RacingDatabase extends Database {
    close() {
      const name = this.name;
      super.close();
      if (!wrote && name === targetDb) {
        wrote = true;
        const writer = new Database(targetDb);
        writer.prepare('INSERT INTO conversations VALUES (?, ?)').run('late', 'written meanwhile');
        writer.close();
      }
    }
  }
  try {
    const result = await migrateStateToOarRoot({ targetRoot: target, repoServerDir: serverDir, DatabaseImpl: RacingDatabase, logger: {} });
    assert.ok(wrote, 'the first look happened');
    assert.equal(result.status, 'refused-existing-database');
    assert.equal(countRows(targetDb, 'conversations'), 1, 'the database is untouched');
    assert.ok(!fs.existsSync(path.join(target, 'backups')));
    assert.ok(!fs.existsSync(path.join(target, 'data', 'relay-server.lock')), 'the lock is released');
  } finally {
    db.close();
  }
});
