import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { countEntries, createDirectory, removeEntry, renameEntry } from './explorer-mutations.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-explorer-mutations-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function canSymlink(dir) {
  try {
    fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'probe-link'));
    fs.unlinkSync(path.join(dir, 'probe-link'));
    return true;
  } catch {
    return false; // host-platform: symlink creation needs a privilege on some Windows setups
  }
}

test('createDirectory makes the folder, with missing parents, and refuses an existing name', () => {
  const dir = fixture('create');
  assert.deepEqual(createDirectory(path.join(dir, 'new')), { ok: true });
  assert.ok(fs.statSync(path.join(dir, 'new')).isDirectory());

  assert.deepEqual(createDirectory(path.join(dir, 'lazy-root', 'child')), { ok: true });
  assert.ok(fs.statSync(path.join(dir, 'lazy-root', 'child')).isDirectory());

  fs.writeFileSync(path.join(dir, 'taken.txt'), 'x');
  assert.equal(createDirectory(path.join(dir, 'taken.txt')).statusCode, 409);
  assert.equal(createDirectory(path.join(dir, 'new')).statusCode, 409);
});

test('renameEntry renames files and folders inside the parent and refuses a taken name', () => {
  const dir = fixture('rename');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(path.join(dir, 'folder'));
  fs.writeFileSync(path.join(dir, 'folder', 'inner.txt'), 'i');

  const renamedFile = renameEntry(path.join(dir, 'a.txt'), 'b.txt');
  assert.deepEqual(renamedFile, { ok: true, path: path.join(dir, 'b.txt') });
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'a');

  const renamedDir = renameEntry(path.join(dir, 'folder'), 'moved');
  assert.equal(renamedDir.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'moved', 'inner.txt'), 'utf8'), 'i');

  fs.writeFileSync(path.join(dir, 'c.txt'), 'c');
  assert.equal(renameEntry(path.join(dir, 'b.txt'), 'c.txt').statusCode, 409);
  assert.equal(renameEntry(path.join(dir, 'ghost'), 'x').statusCode, 404);
  // Same name: nothing to do, no error.
  assert.equal(renameEntry(path.join(dir, 'b.txt'), 'b.txt').ok, true);
});

test('removeEntry deletes a file and a non-empty folder', () => {
  const dir = fixture('remove');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'f');
  fs.mkdirSync(path.join(dir, 'tree', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree', 'deep', 'leaf.txt'), 'l');

  assert.deepEqual(removeEntry(path.join(dir, 'f.txt')), { ok: true });
  assert.deepEqual(removeEntry(path.join(dir, 'tree')), { ok: true });
  assert.equal(fs.existsSync(path.join(dir, 'tree')), false);
  assert.equal(removeEntry(path.join(dir, 'tree')).statusCode, 404);
});

test('countEntries reports files and folders below a directory, and the cap', () => {
  const dir = fixture('count');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'one.txt'), '1');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'two.txt'), '2');
  fs.writeFileSync(path.join(dir, 'three.txt'), '3');

  assert.deepEqual(countEntries(dir), { ok: true, kind: 'dir', files: 3, dirs: 2, capped: false });
  assert.deepEqual(countEntries(path.join(dir, 'three.txt')), { ok: true, kind: 'file', files: 0, dirs: 0, capped: false });
  assert.equal(countEntries(path.join(dir, 'nope')).statusCode, 404);

  const capped = countEntries(dir, { cap: 2 });
  assert.equal(capped.capped, true);
  assert.equal(capped.files + capped.dirs, 2);
});

test('symbolic links are refused by rename, delete and count', { skip: !canSymlink(fixture('links')) }, () => {
  const dir = path.join(root, 'links');
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'keep.txt'), 'k');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'link'));

  assert.equal(renameEntry(path.join(dir, 'link'), 'other').statusCode, 409);
  assert.equal(removeEntry(path.join(dir, 'link')).statusCode, 409);
  assert.equal(countEntries(path.join(dir, 'link')).statusCode, 409);
  assert.ok(fs.existsSync(path.join(dir, 'outside', 'keep.txt')));

  // A link inside a counted folder is one entry and is not followed.
  assert.deepEqual(countEntries(dir), { ok: true, kind: 'dir', files: 2, dirs: 1, capped: false });
});
