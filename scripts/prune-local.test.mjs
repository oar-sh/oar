import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { findPruneCandidates, parsePruneArgs, pruneLocal } from './prune-local.mjs';
import { createSandbox, hasGit } from './git-test-helpers.mjs';

const quiet = () => {};

test('parsePruneArgs: listing is the default, deleting needs --apply', () => {
  assert.deepEqual(parsePruneArgs([]), { apply: false, list: '', help: false });
  assert.deepEqual(parsePruneArgs(['--apply', '--list', 'out.txt']), { apply: true, list: 'out.txt', help: false });
  assert.equal(parsePruneArgs(['--list=a.txt']).list, 'a.txt');
  assert.throws(() => parsePruneArgs(['--force']), /unknown argument/);
});

// A rewritten commit, a deleted branch, two live stashes and one dropped.
function messyRepository() {
  const box = createSandbox();
  box.commit('a.md', 'first wording\n', 'Add a');
  const rewritten = box.git('rev-parse', 'HEAD');
  box.write('a.md', 'second wording\n');
  box.git('commit', '-q', '-a', '--amend', '-m', 'Add a');

  box.git('switch', '-q', '-c', 'dev/abandoned');
  const abandoned = box.commit('b.md', 'never landed\n', 'Try b');
  box.git('switch', '-q', 'main');
  box.git('branch', '-q', '-D', 'dev/abandoned');

  for (const text of ['older stash\n', 'dropped stash\n', 'newest stash\n']) {
    box.write('a.md', text);
    box.git('stash', 'push', '-q', '-m', text.trim());
  }
  box.git('stash', 'drop', '-q', 'stash@{1}');
  return { box, rewritten, abandoned };
}

test('without --apply the candidates are listed and nothing is deleted', { skip: !hasGit() }, () => {
  const { box, rewritten, abandoned } = messyRepository();
  try {
    const result = pruneLocal({ cwd: box.repo, log: quiet });
    assert.equal(result.applied, false);
    assert.equal(result.stashes, 2);
    const hashes = result.candidates.map((c) => c.hash);
    assert.ok(hashes.includes(rewritten), 'the amended-away commit is a candidate');
    assert.ok(hashes.includes(abandoned), 'the deleted branch is a candidate');
    box.git('cat-file', '-e', `${rewritten}^{commit}`);
    box.git('cat-file', '-e', `${abandoned}^{commit}`);
  } finally {
    box.cleanup();
  }
});

test('the live stashes are never candidates, only the dropped one is', { skip: !hasGit() }, () => {
  const { box } = messyRepository();
  try {
    const live = box.git('reflog', 'show', '--format=%H', 'refs/stash').split(/\r?\n/);
    assert.equal(live.length, 2);
    const candidates = findPruneCandidates({ cwd: box.repo });
    for (const hash of live) assert.equal(candidates.some((c) => c.hash === hash), false);
    assert.ok(candidates.some((c) => /dropped stash/.test(c.subject)), 'the dropped stash is listed');
  } finally {
    box.cleanup();
  }
});

test('--apply deletes the candidates and keeps every listed stash, the older one included', { skip: !hasGit() }, () => {
  const { box, rewritten, abandoned } = messyRepository();
  try {
    const stashesBefore = box.git('stash', 'list');
    const tip = box.git('rev-parse', 'HEAD');
    const result = pruneLocal({ cwd: box.repo, apply: true, log: quiet });
    assert.equal(result.applied, true);
    assert.deepEqual(result.left, []);
    assert.throws(() => box.git('cat-file', '-e', `${rewritten}^{commit}`));
    assert.throws(() => box.git('cat-file', '-e', `${abandoned}^{commit}`));

    assert.equal(box.git('stash', 'list'), stashesBefore, 'the stash list is unchanged');
    assert.equal(box.git('rev-parse', 'HEAD'), tip);
    box.git('stash', 'apply', '-q', 'stash@{1}');
    assert.equal(fs.readFileSync(path.join(box.repo, 'a.md'), 'utf8'), 'older stash\n', 'the OLDER stash still applies');
  } finally {
    box.cleanup();
  }
});

test('a detached worktree keeps its commit, and its reflog is expired too', { skip: !hasGit() }, () => {
  const { box, rewritten } = messyRepository();
  const other = path.join(box.root, 'second-worktree');
  try {
    box.git('worktree', 'add', '-q', '--detach', other, 'HEAD');
    fs.writeFileSync(path.join(other, 'c.md'), 'only here\n');
    const inOther = (...args) => box.remoteGit(other)(...args);
    inOther('add', '-A');
    inOther('commit', '-q', '-m', 'Work in the second worktree');
    const held = inOther('rev-parse', 'HEAD');
    inOther('checkout', '-q', '--detach', rewritten);
    inOther('checkout', '-q', '--detach', held);

    const result = pruneLocal({ cwd: box.repo, apply: true, log: quiet });
    assert.equal(result.candidates.some((c) => c.hash === held), false, 'a worktree HEAD is not a candidate');
    box.git('cat-file', '-e', `${held}^{commit}`);
    assert.throws(() => box.git('cat-file', '-e', `${rewritten}^{commit}`), 'held only by the other worktree\'s reflog, so it goes');
  } finally {
    try { box.git('worktree', 'remove', '--force', other); } catch {}
    box.cleanup();
  }
});
