import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseSetupArgs, setupGit } from './setup-git.mjs';
import { createSandbox, hasGit } from './git-test-helpers.mjs';

const quiet = () => {};

test('parseSetupArgs reads --work-url in both forms', () => {
  assert.equal(parseSetupArgs(['--work-url', 'https://example.com/w.git']).workUrl, 'https://example.com/w.git');
  assert.equal(parseSetupArgs(['--work-url=https://example.com/w.git']).workUrl, 'https://example.com/w.git');
  assert.equal(parseSetupArgs([]).workUrl, '');
});

test('setup points hooks at the repository, aims pushes at the private remote, seeds the denylist', { skip: !hasGit() }, () => {
  const box = createSandbox({ withWorkRemote: false });
  try {
    const report = setupGit({ cwd: box.repo, workUrl: box.workDir, env: {}, log: quiet });
    assert.equal(box.git('config', 'core.hooksPath'), 'scripts/git-hooks');
    assert.equal(box.git('remote', 'get-url', 'work'), box.workDir);
    assert.equal(box.git('config', 'remote.pushDefault'), 'work');
    assert.equal(box.git('config', 'push.default'), 'current');
    assert.equal(box.git('remote', 'get-url', 'origin'), box.publicDir, 'origin is left alone');
    assert.ok(fs.existsSync(report.denylist));
    assert.equal(path.basename(report.denylist), 'hygiene-denylist');
    assert.match(report.warnings.join('\n'), /EMPTY hygiene denylist/);

    // A second run changes nothing and keeps what the user wrote.
    fs.appendFileSync(report.denylist, 'acme-internal\n');
    const again = setupGit({ cwd: box.repo, env: {}, log: quiet });
    assert.deepEqual(again.warnings, []);
    assert.match(fs.readFileSync(report.denylist, 'utf8'), /acme-internal/);
  } finally {
    box.cleanup();
  }
});

test('without a private remote the setup says what is missing and does not redirect pushes', { skip: !hasGit() }, () => {
  const box = createSandbox({ withWorkRemote: false });
  try {
    const report = setupGit({ cwd: box.repo, env: {}, log: quiet });
    assert.equal(report.workRemote, null);
    assert.match(report.warnings.join('\n'), /no private remote named "work"/);
    assert.throws(() => box.git('config', 'remote.pushDefault'));
  } finally {
    box.cleanup();
  }
});
