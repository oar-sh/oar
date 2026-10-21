import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  existingUploadPaths,
  resolveDataDir,
  resolveUploadDir,
  resolveUploadReadDirs,
  uploadPathInDirs,
} from './data-dir-resolution.mjs';
import { mergeStrayMigratedUploads } from './oar-state-migration-service.mjs';

const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');

function writeBlob(dir, content, name = sha(content)) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return name;
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, sha(fs.readFileSync(path.join(dir, name)))]));
}

const quiet = { log() {}, warn() {} };

test('read dirs: the upload dir first, then <server>/uploads and the state root uploads, each once', () => {
  const win = path.win32;
  assert.deepEqual(
    resolveUploadReadDirs({
      uploadDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data\\uploads',
      dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data',
      serverDir: 'C:\\Users\\dev\\oar\\server',
      pathImpl: win,
      platform: 'win32',
    }),
    [
      'C:\\Users\\dev\\AppData\\Roaming\\oar\\data\\uploads',
      'C:\\Users\\dev\\oar\\server\\uploads',
      'C:\\Users\\dev\\AppData\\Roaming\\oar\\uploads',
    ],
  );
  // A checkout on its defaults: the upload dir is <server>/uploads, the folder
  // holding the data dir is the server folder; one dir, named once.
  assert.deepEqual(
    resolveUploadReadDirs({
      uploadDir: 'c:\\users\\dev\\oar\\SERVER\\uploads',
      dataDir: 'C:\\Users\\dev\\oar\\server\\data',
      serverDir: 'C:\\Users\\dev\\oar\\server',
      pathImpl: win,
      platform: 'win32',
    }),
    ['c:\\users\\dev\\oar\\SERVER\\uploads'],
  );
});

test('a checkout whose config dataDir points outside it, uploads in both old places, every recorded upload resolves and nothing old changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-upload-dirs-'));
  try {
    // A checkout whose config.json pins dataDir into a release install's state
    // root; that state root was once the target of a state migration.
    const serverDir = path.join(root, 'checkout', 'server');
    const stateRoot = path.join(root, 'state');
    const configPath = path.join(serverDir, 'config.json');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.mkdirSync(path.join(stateRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, '.migrated'), 'migrated\n');
    fs.writeFileSync(configPath, JSON.stringify({ dataDir: path.join(stateRoot, 'data') }));

    const serverUploads = path.join(serverDir, 'uploads');
    const strayUploads = path.join(stateRoot, 'uploads');
    // Only in the checkout (the recent ones), in both places, only in the
    // state root, and one name in both whose copies differ (a damaged copy in
    // the state root, the real one in the checkout).
    const onlyServer = writeBlob(serverUploads, 'recent upload, checkout only');
    const both = writeBlob(serverUploads, 'older upload, in both places');
    writeBlob(strayUploads, 'older upload, in both places');
    const onlyStray = writeBlob(strayUploads, 'an upload only the migration copy kept');
    const realContent = 'the real bytes of a picture';
    const differing = writeBlob(serverUploads, realContent);
    writeBlob(strayUploads, 'damaged', differing);
    const unreferenced = writeBlob(serverUploads, 'an upload no message refers to');
    // The uploaded_files rows: sha and recorded size.
    const rows = new Map([
      [onlyServer, Buffer.byteLength('recent upload, checkout only')],
      [both, Buffer.byteLength('older upload, in both places')],
      [onlyStray, Buffer.byteLength('an upload only the migration copy kept')],
      [differing, Buffer.byteLength(realContent)],
    ]);
    const before = { server: snapshot(serverUploads), stray: snapshot(strayUploads) };

    // What the runtime does at start, in its order.
    const dataDir = resolveDataDir({ env: {}, configPath, serverDir });
    assert.equal(dataDir, path.join(stateRoot, 'data'));
    const uploadDir = resolveUploadDir({ dataDir, env: {}, serverDir });
    assert.equal(uploadDir, path.join(stateRoot, 'data', 'uploads'));
    fs.mkdirSync(uploadDir, { recursive: true });
    mergeStrayMigratedUploads({ dataDir, uploadDir, logger: quiet });
    const readDirs = resolveUploadReadDirs({ uploadDir, dataDir, serverDir });
    assert.deepEqual(readDirs, [uploadDir, serverUploads, strayUploads]);

    for (const [name, size] of rows) {
      const resolved = uploadPathInDirs(readDirs, name, { expectedSize: size });
      assert.ok(fs.existsSync(resolved), `${name} resolves to a file`);
      const bytes = fs.readFileSync(resolved);
      assert.equal(bytes.length, size, `${name} resolves to the recorded size`);
      assert.equal(sha(bytes), name, `${name} resolves to its own content`);
    }
    // The differing name: both copies kept, the one of the recorded size read.
    assert.equal(existingUploadPaths(readDirs, differing).length, 3, 'the merged, checkout and state root copies are all there');
    assert.equal(uploadPathInDirs(readDirs, differing, { expectedSize: Buffer.byteLength(realContent) }), path.join(serverUploads, differing));
    // An upload not on disk anywhere goes to the upload dir.
    assert.equal(uploadPathInDirs(readDirs, sha('new')), path.join(uploadDir, sha('new')));

    // Nothing in the old places was deleted, moved or changed.
    assert.deepEqual(snapshot(serverUploads), before.server);
    assert.deepEqual(snapshot(strayUploads), before.stray);
    assert.ok(fs.existsSync(path.join(serverUploads, unreferenced)), 'an unreferenced old file stays too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pinned data dir (oar start, systemd, the launchers) also reads <server>/uploads and the state root uploads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-upload-dirs-'));
  try {
    const serverDir = path.join(root, 'package', 'server');
    const dataDir = path.join(root, 'state', 'data');
    const env = { COPILOT_WEB_RELAY_DATA_DIR: dataDir };
    const uploadDir = resolveUploadDir({ dataDir: resolveDataDir({ env, serverDir }), env, serverDir });
    const inPackage = writeBlob(path.join(serverDir, 'uploads'), 'written by a relay started without the pin');
    const readDirs = resolveUploadReadDirs({ uploadDir, dataDir, serverDir });
    assert.equal(readDirs[0], path.join(dataDir, 'uploads'));
    assert.equal(uploadPathInDirs(readDirs, inPackage), path.join(serverDir, 'uploads', inPackage));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two copies of the same size but different content: the one whose content hashes to its name is read, both stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-upload-dirs-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const real = 'real bytes 1234';
    const name = writeBlob(second, real);
    writeBlob(first, 'fake bytes 9876', name);
    const before = { first: snapshot(first), second: snapshot(second) };
    assert.equal(uploadPathInDirs([first, second], name, { expectedSize: Buffer.byteLength(real) }), path.join(second, name));
    assert.deepEqual({ first: snapshot(first), second: snapshot(second) }, before);
    // Only sha256 names are blobs.
    assert.deepEqual(existingUploadPaths([first, second], 'README.md'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('identical copies of the recorded size are read without hashing them, and a decision is not made twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-upload-dirs-'));
  try {
    const dirs = [path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'c')];
    const content = 'x'.repeat(300 * 1024);
    const name = sha(content);
    for (const dir of dirs) writeBlob(dir, content);
    let wholeReads = 0;
    let opens = 0;
    const counting = {
      ...fs,
      readFileSync: (...args) => { wholeReads += 1; return fs.readFileSync(...args); },
      openSync: (...args) => { opens += 1; return fs.openSync(...args); },
    };
    const size = Buffer.byteLength(content);
    assert.equal(uploadPathInDirs(dirs, name, { expectedSize: size, fsImpl: counting }), path.join(dirs[0], name));
    assert.equal(wholeReads, 0, 'alike copies are never read whole');
    const opensAfterFirst = opens;
    assert.equal(uploadPathInDirs(dirs, name, { expectedSize: size, fsImpl: counting }), path.join(dirs[0], name));
    assert.equal(opens, opensAfterFirst, 'the second lookup only stats');

    // A damaged same-size copy in front: hashed once, then remembered.
    const damaged = Buffer.from(content);
    damaged[10] = 0x79;
    fs.writeFileSync(path.join(dirs[0], name), damaged);
    // A new mtime for certain, also where timestamps are coarse.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dirs[0], name), later, later);
    assert.equal(uploadPathInDirs(dirs, name, { expectedSize: size, fsImpl: counting }), path.join(dirs[1], name));
    const readsAfterDecision = wholeReads;
    assert.ok(readsAfterDecision >= 1);
    assert.equal(uploadPathInDirs(dirs, name, { expectedSize: size, fsImpl: counting }), path.join(dirs[1], name));
    assert.equal(wholeReads, readsAfterDecision, 'not hashed again while no copy changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
