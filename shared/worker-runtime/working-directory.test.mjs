import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WORKING_DIRECTORY_GUIDANCE,
  WORKING_DIRECTORY_MISSING_CODE,
  explainLaunchFailure,
  isWorkingDirectoryMissingError,
  missingWorkingDirectoryError,
} from './working-directory.mjs';

function scratchFolder(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-working-directory-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// What the Claude Agent SDK (0.3.292) makes of a spawn that failed with ENOENT
// although the binary is there.
const CLAUDE_SDK_LAUNCH_ERROR = 'Claude Code native binary at /opt/claude/claude exists but failed to launch. '
  + "This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a "
  + 'glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary '
  + 'with options.pathToClaudeCodeExecutable.';

test('a folder that is there passes, and so does no folder at all', (t) => {
  const folder = scratchFolder(t);
  assert.equal(missingWorkingDirectoryError(folder), null);
  assert.equal(missingWorkingDirectoryError(''), null);
  assert.equal(missingWorkingDirectoryError(undefined), null);
});

test('a folder that is gone names itself and what to do', (t) => {
  const gone = path.join(scratchFolder(t), 'deleted');
  const error = missingWorkingDirectoryError(gone);
  assert.ok(isWorkingDirectoryMissingError(error));
  assert.equal(error.code, WORKING_DIRECTORY_MISSING_CODE);
  assert.equal(error.workingDirectory, gone);
  assert.equal(error.message, `The working directory of this conversation no longer exists: ${gone}.`);
  assert.equal(error.guidance, WORKING_DIRECTORY_GUIDANCE);
});

test('a file where the folder was is not a folder', (t) => {
  const file = path.join(scratchFolder(t), 'file.txt');
  fs.writeFileSync(file, 'x');
  assert.match(missingWorkingDirectoryError(file).message, /is not a folder: .*file\.txt\.$/);
  // Below a file: ENOTDIR, which is as gone as ENOENT.
  assert.match(missingWorkingDirectoryError(path.join(file, 'below')).message, /no longer exists/);
});

test('a folder that cannot be read is left to the launch', () => {
  const statSync = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
  assert.equal(missingWorkingDirectoryError('/srv/locked', { statSync }), null);
});

test('a spawn in a missing folder fails with ENOENT, and is put down to the folder', async (t) => {
  // The mechanism behind the misleading message: Node reports a missing cwd
  // with the same code as a missing executable. The spawn fails before
  // anything is started.
  const gone = path.join(scratchFolder(t), 'deleted');
  const spawnError = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--version'], { cwd: gone, stdio: 'ignore' });
    child.on('error', resolve);
    child.on('exit', () => resolve(null));
  });
  assert.equal(spawnError?.code, 'ENOENT');
  const explained = explainLaunchFailure(spawnError, gone);
  assert.ok(isWorkingDirectoryMissingError(explained));
  assert.equal(explained.workingDirectory, gone);
});

test('the Claude SDK\'s libc message for a missing folder is put down to the folder', (t) => {
  const gone = path.join(scratchFolder(t), 'deleted');
  const explained = explainLaunchFailure(new ReferenceError(CLAUDE_SDK_LAUNCH_ERROR), gone);
  assert.ok(isWorkingDirectoryMissingError(explained));
  assert.match(explained.message, /no longer exists/);
});

test('a launch failure in a folder that is there keeps its own message', (t) => {
  const folder = scratchFolder(t);
  const original = new ReferenceError(CLAUDE_SDK_LAUNCH_ERROR);
  assert.equal(explainLaunchFailure(original, folder), original);
});

test('an error that is no launch failure is not blamed on the folder', (t) => {
  const gone = path.join(scratchFolder(t), 'deleted');
  const original = new Error('Invalid API key · Please run /login');
  assert.equal(explainLaunchFailure(original, gone), original);
});

test('the folder\'s own error passes through unchanged', () => {
  const error = missingWorkingDirectoryError('/x', { statSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
  assert.equal(explainLaunchFailure(error, '/x', { check: () => null }), error);
});
