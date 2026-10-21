// A Copilot turn in a conversation whose working directory is gone fails with
// the folder's name and what to do, not with the runtime spawn's ENOENT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { baseMessage, createFakeCopilotClient, loadFixture, makeApiStub, makeRunner } from './copilot-sdk-test-harness.mjs';
import { classifyCopilotTurnException } from './copilot-sdk-adapter.mjs';
import { missingWorkingDirectoryError } from '../../shared/worker-runtime/working-directory.mjs';

function scratchFolder(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-copilot-cwd-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function assertFolderFailure(stub, folder) {
  const failure = stub.bodiesFor('/api/response')[0]?.terminalError;
  assert.ok(failure, 'the turn fails');
  assert.equal(failure.stableCode, 'copilot.working-directory-missing');
  assert.equal(failure.message, `The working directory of this conversation no longer exists: ${folder}.`);
  assert.match(failure.guidance || '', /Change CWD/);
}

test('a missing working directory fails the turn with the folder, before the runtime is started', async (t) => {
  const gone = path.join(scratchFolder(t), 'deleted');
  const stub = makeApiStub();
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  const { runner, started } = makeRunner({ stub, client, cwd: gone, checkWorkingDirectoryImpl: missingWorkingDirectoryError });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assert.equal(started.length, 0, 'nothing is spawned in a folder that is not there');
  assertFolderFailure(stub, gone);
});

test('a runtime spawn that fails because the folder went away meanwhile is put down to the folder', async (t) => {
  const folder = path.join(scratchFolder(t), 'project');
  fs.mkdirSync(folder);
  const stub = makeApiStub();
  const { runner } = makeRunner({
    stub,
    client: createFakeCopilotClient(),
    cwd: folder,
    checkWorkingDirectoryImpl: missingWorkingDirectoryError,
    startClientImpl: async () => {
      fs.rmSync(folder, { recursive: true, force: true });
      throw Object.assign(new Error('spawn /opt/copilot/copilot ENOENT'), { code: 'ENOENT' });
    },
  });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assertFolderFailure(stub, folder);
});

test('the classifier keeps the folder error\'s own words and advice', () => {
  const error = missingWorkingDirectoryError('/srv/gone', {
    statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  const classified = classifyCopilotTurnException(error);
  assert.equal(classified.stableCode, 'copilot.working-directory-missing');
  assert.equal(classified.text, 'The working directory of this conversation no longer exists: /srv/gone.');
  assert.equal(classified.guidance, error.guidance);
});
