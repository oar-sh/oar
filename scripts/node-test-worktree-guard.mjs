// Preloaded by `npm test` into each test file's process: the file fails
// when it left a database in server/data or a backup in server/backups of
// this checkout (worktree-data-guard.mjs).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { snapshotWorktreeData, worktreeDataChanges } from './worktree-data-guard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = snapshotWorktreeData(repoRoot);
process.on('exit', () => {
  const changes = worktreeDataChanges(before, snapshotWorktreeData(repoRoot));
  if (!changes.length) return;
  process.stderr.write(`\nA test left files in this checkout (use a temp folder; or a relay running from this checkout made them): ${changes.join(', ')}\n`);
  process.exitCode = 1;
});
