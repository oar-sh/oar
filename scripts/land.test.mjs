import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildCommitMessage, findMessageLeaks, land, LandError, parseLandArgs } from './land.mjs';
import { buildDenylistPatterns } from './hygiene-patterns.mjs';
import { createSandbox, hasGit } from './git-test-helpers.mjs';

const NO_PATTERNS = [];
const quiet = () => {};

test('parseLandArgs reads message, body file and switches; unknown flags are errors', () => {
  assert.deepEqual(parseLandArgs(['-m', 'Subject', '--body-file', 'b.txt', '--dry-run']), {
    message: 'Subject', bodyFile: 'b.txt', dryRun: true, skipE2e: false, help: false,
  });
  assert.equal(parseLandArgs(['--message=Other']).message, 'Other');
  assert.equal(parseLandArgs(['--skip-e2e']).skipE2e, true);
  assert.throws(() => parseLandArgs(['--no-verify']), LandError);
});

test('buildCommitMessage wants a subject and joins the body after a blank line', () => {
  assert.equal(buildCommitMessage({ message: 'Subject' }), 'Subject\n');
  assert.equal(buildCommitMessage({ message: 'Subject\nmore', body: 'and the body\r\n' }), 'Subject\n\nmore\n\nand the body\n');
  assert.throws(() => buildCommitMessage({ message: '  ' }), /subject is required/);
});

test('findMessageLeaks names each pattern once', () => {
  const patterns = buildDenylistPatterns(['acme-internal']);
  assert.deepEqual(findMessageLeaks('Fix acme-internal\n\nacme-internal again', patterns).length, 1);
  assert.deepEqual(findMessageLeaks('Fix the report builder', patterns), []);
});

function topicBranch(box, name = 'dev/topic') {
  box.git('switch', '-q', '-c', name);
  box.commit('feature.md', 'first draft\n', 'wip');
  box.commit('feature.md', 'second draft\n', 'fixup');
  box.commit('extra.md', 'extra\n', 'more');
  box.git('push', '-q', 'work', name);
}

test('land squashes the branch onto main, publishes it and retires the branch', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    const base = box.git('rev-parse', 'HEAD');
    topicBranch(box);
    const gatesRun = [];
    const result = land({
      cwd: box.repo,
      message: 'Add the feature',
      body: 'Why it exists.',
      gates: [{ name: 'a' }, { name: 'b' }],
      runGate: (gate) => { gatesRun.push(gate.name); return true; },
      patterns: NO_PATTERNS,
      log: quiet,
    });
    assert.deepEqual(gatesRun, ['a', 'b']);
    assert.equal(result.pushed, true);

    const pub = box.remoteGit(box.publicDir);
    assert.equal(pub('rev-parse', 'main'), result.squashed);
    assert.equal(pub('rev-list', '--count', `${base}..main`), '1', 'one commit on the public main');
    assert.equal(pub('log', '-1', '--format=%B', 'main').trim(), 'Add the feature\n\nWhy it exists.');
    assert.equal(pub('log', '--format=%s', 'main').includes('fixup'), false, 'no intermediate commit is published');
    assert.equal(pub('show', 'main:feature.md'), 'second draft');

    const work = box.remoteGit(box.workDir);
    assert.equal(work('rev-parse', 'main'), result.squashed, 'private main mirrors the public one');
    assert.equal(work('branch', '--list', 'dev/topic'), '', 'the branch is gone from the private remote');

    assert.equal(box.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(box.git('rev-parse', 'HEAD'), result.squashed);
    assert.equal(box.git('branch', '--list', 'dev/topic'), '');
    assert.equal(box.git('status', '--porcelain'), '', 'the checkout is clean on main');
    assert.equal(fs.readFileSync(path.join(box.repo, 'feature.md'), 'utf8'), 'second draft\n');
  } finally {
    box.cleanup();
  }
});

test('a failing gate lands nothing', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    const base = box.git('rev-parse', 'HEAD');
    topicBranch(box);
    assert.throws(() => land({
      cwd: box.repo,
      message: 'Add the feature',
      gates: [{ name: 'unit suite' }, { name: 'never reached' }],
      runGate: (gate) => gate.name !== 'unit suite',
      patterns: NO_PATTERNS,
      log: quiet,
    }), /gate failed: unit suite/);
    assert.equal(box.remoteGit(box.publicDir)('rev-parse', 'main'), base);
    assert.equal(box.git('rev-parse', '--abbrev-ref', 'HEAD'), 'dev/topic');
  } finally {
    box.cleanup();
  }
});

test('--skip-e2e skips only the gate marked for it', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    topicBranch(box);
    const gatesRun = [];
    land({
      cwd: box.repo,
      message: 'Reword the notes',
      skipE2e: true,
      dryRun: true,
      gates: [{ name: 'unit' }, { name: 'e2e', skippableBy: 'skipE2e' }],
      runGate: (gate) => { gatesRun.push(gate.name); return true; },
      patterns: NO_PATTERNS,
      log: quiet,
    });
    assert.deepEqual(gatesRun, ['unit']);
  } finally {
    box.cleanup();
  }
});

test('a dry run builds the commit but publishes and moves nothing', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    const base = box.git('rev-parse', 'HEAD');
    topicBranch(box);
    const result = land({ cwd: box.repo, message: 'Add the feature', dryRun: true, gates: [], patterns: NO_PATTERNS, log: quiet });
    assert.equal(result.pushed, false);
    assert.equal(box.git('rev-parse', `${result.squashed}^`), base);
    assert.equal(box.remoteGit(box.publicDir)('rev-parse', 'main'), base);
    assert.equal(box.git('rev-parse', '--abbrev-ref', 'HEAD'), 'dev/topic');
  } finally {
    box.cleanup();
  }
});

test('refuses: on main, dirty tree, stale base, empty branch, leaking message', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    const run = (extra = {}) => land({ cwd: box.repo, message: 'Add the feature', gates: [], patterns: NO_PATTERNS, log: quiet, ...extra });
    assert.throws(() => run(), /you are on main/);

    box.git('switch', '-q', '-c', 'dev/empty');
    assert.throws(() => run(), /no commits on top of main/);

    topicBranch(box, 'dev/topic');
    box.write('scratch.txt', 'not committed\n');
    assert.throws(() => run(), /uncommitted changes/);
    fs.rmSync(path.join(box.repo, 'scratch.txt'));

    assert.throws(() => run({ patterns: buildDenylistPatterns(['feature']) }), /commit message contains private/);

    // main moves on the public remote while the branch is open
    const other = createSandbox({ withWorkRemote: false });
    try {
      other.git('remote', 'set-url', 'origin', box.publicDir);
      other.git('fetch', '-q', 'origin');
      other.git('reset', '-q', '--hard', 'origin/main');
      other.commit('elsewhere.md', 'landed meanwhile\n', 'Land something else');
      other.git('push', '-q', 'origin', 'main');
    } finally {
      other.cleanup();
    }
    assert.throws(() => run(), /does not sit on the current origin\/main/);
  } finally {
    box.cleanup();
  }
});
