import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotWorktreeData, worktreeDataChanges } from './worktree-data-guard.mjs';

test('the guard sees a new database in server/data and a new backup, not files already there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-worktree-guard-'));
  try {
    fs.mkdirSync(path.join(root, 'server', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'data', 'copilot.db'), 'live');
    fs.writeFileSync(path.join(root, 'server', 'data', 'config-note.txt'), '');
    const before = snapshotWorktreeData(root);
    fs.appendFileSync(path.join(root, 'server', 'data', 'copilot.db'), ' and written to');
    fs.writeFileSync(path.join(root, 'server', 'data', 'other.txt'), '');
    assert.deepEqual(worktreeDataChanges(before, snapshotWorktreeData(root)), []);
    fs.writeFileSync(path.join(root, 'server', 'data', 'oar.db'), '');
    fs.mkdirSync(path.join(root, 'server', 'backups'));
    fs.writeFileSync(path.join(root, 'server', 'backups', 'oar-0.9.20-20261103-091500-manual.db'), '');
    assert.deepEqual(worktreeDataChanges(before, snapshotWorktreeData(root)), [
      'server/data/oar.db',
      'server/backups/oar-0.9.20-20261103-091500-manual.db',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('what a live relay on the checkout makes is not counted: side files of its database, the backups its manifest lists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-worktree-guard-'));
  try {
    fs.mkdirSync(path.join(root, 'server', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'data', 'copilot.db'), 'live');
    const before = snapshotWorktreeData(root);
    fs.writeFileSync(path.join(root, 'server', 'data', 'copilot.db-wal'), '');
    fs.writeFileSync(path.join(root, 'server', 'data', 'copilot.db-shm'), '');
    fs.mkdirSync(path.join(root, 'server', 'backups'));
    fs.writeFileSync(path.join(root, 'server', 'backups', 'oar-0.9.20-20261103-091500-pre-update-1512900.db'), '');
    fs.writeFileSync(path.join(root, 'server', 'data', 'db-backups.json'), JSON.stringify({ backups: [{ file: 'oar-0.9.20-20261103-091500-pre-update-1512900.db' }] }));
    assert.deepEqual(worktreeDataChanges(before, snapshotWorktreeData(root)), []);
    fs.writeFileSync(path.join(root, 'server', 'backups', 'stray.db'), '');
    fs.writeFileSync(path.join(root, 'server', 'data', 'oar.db-wal'), '');
    assert.deepEqual(worktreeDataChanges(before, snapshotWorktreeData(root)), ['server/data/oar.db-wal', 'server/backups/stray.db']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
