// A Claude turn in a conversation whose working directory is gone: the turn
// fails with the folder's name and what to do, not with the Agent SDK's guess
// at a libc mismatch of the native binary.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { baseMessage, makeApiStub, makeRunner, scriptedTurn } from './claude-session-test-harness.mjs';

// What the Agent SDK (0.3.292) throws when the spawn fails with ENOENT and
// the binary is there — which is what a missing cwd looks like to it.
const SDK_LAUNCH_ERROR = 'Claude Code native binary at /opt/claude/claude exists but failed to launch. '
  + "This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a "
  + 'glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary '
  + 'with options.pathToClaudeCodeExecutable.';

function scratchFolder(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-claude-cwd-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function responseOf(stub) {
  return stub.calls.find((call) => call.routePath === '/api/response')?.body || null;
}

function assertFolderFailure(response, folder) {
  assert.ok(response, 'the turn publishes a response');
  assert.equal(response.terminalError?.code, 'working-directory-missing');
  assert.equal(response.terminalError?.stableCode, 'claude.working-directory-missing');
  assert.equal(response.terminalError?.message, `The working directory of this conversation no longer exists: ${folder}.`);
  assert.match(response.terminalError?.guidance || '', /Change CWD/);
  assert.match(response.text, new RegExp(`no longer exists: ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(response.text, /libc|native binary/);
}

test('a missing working directory fails the turn with the folder, before the CLI is started', async (t) => {
  const gone = path.join(scratchFolder(t), 'deleted');
  const stub = makeApiStub();
  let starts = 0;
  const runner = makeRunner({
    stub,
    cwd: gone,
    startImpl: () => {
      starts += 1;
      const turn = scriptedTurn();
      turn.fail(new ReferenceError(SDK_LAUNCH_ERROR));
      return turn;
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  assert.equal(starts, 0, 'nothing is spawned in a folder that is not there');
  assertFolderFailure(responseOf(stub), gone);
});

test('a launch that fails because the folder went away meanwhile is put down to the folder', async (t) => {
  // The folder is there at the check and gone by the spawn.
  const folder = path.join(scratchFolder(t), 'project');
  fs.mkdirSync(folder);
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    cwd: folder,
    startImpl: () => {
      fs.rmSync(folder, { recursive: true, force: true });
      const turn = scriptedTurn();
      turn.fail(new ReferenceError(SDK_LAUNCH_ERROR));
      return turn;
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  assertFolderFailure(responseOf(stub), folder);
});

test('a launch failure in a folder that is there keeps the SDK\'s message', async (t) => {
  const folder = scratchFolder(t);
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    cwd: folder,
    startImpl: () => {
      const turn = scriptedTurn();
      turn.fail(new ReferenceError(SDK_LAUNCH_ERROR));
      return turn;
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  const response = responseOf(stub);
  assert.equal(response.terminalError?.code, 'turn-error');
  assert.match(response.text, /native binary/);
});
