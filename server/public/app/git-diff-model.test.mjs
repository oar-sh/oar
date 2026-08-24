'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUnifiedDiff,
  collapseContextLines,
  describeGitFileStatus,
  summarizeGitStatusHeader,
} from './git-diff-model.mjs';

const SAMPLE_PATCH = [
  'diff --git a/src/app.mjs b/src/app.mjs',
  'index 1111111..2222222 100644',
  '--- a/src/app.mjs',
  '+++ b/src/app.mjs',
  '@@ -1,5 +1,5 @@',
  ' const one = 1;',
  '-const two = 2;',
  '+const two = 2 + 0;',
  ' const three = 3;',
  ' const four = 4;',
  ' const five = 5;',
  '',
].join('\n');

test('parseUnifiedDiff assigns line numbers to added, removed, and context lines', () => {
  const parsed = parseUnifiedDiff(SAMPLE_PATCH);
  assert.equal(parsed.isBinary, false);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.lines.length, 6);

  const [first, removed, added, third] = parsed.lines;
  assert.deepEqual(first, { type: 'context', text: 'const one = 1;', oldLine: 1, newLine: 1 });
  assert.deepEqual(removed, { type: 'del', text: 'const two = 2;', oldLine: 2, newLine: null });
  assert.deepEqual(added, { type: 'add', text: 'const two = 2 + 0;', oldLine: null, newLine: 2 });
  assert.deepEqual(third, { type: 'context', text: 'const three = 3;', oldLine: 3, newLine: 3 });
});

test('parseUnifiedDiff detects binary patches and empty output', () => {
  assert.equal(parseUnifiedDiff('Binary files a/x.png and b/x.png differ').isBinary, true);
  assert.equal(parseUnifiedDiff('').isEmpty, true);
});

test('parseUnifiedDiff skips the no-newline marker without shifting line numbers', () => {
  const patch = [
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
  ].join('\n');
  const parsed = parseUnifiedDiff(patch);
  assert.deepEqual(parsed.lines.map((line) => line.type), ['context', 'del', 'add']);
  assert.equal(parsed.lines[2].newLine, 2);
});

test('collapseContextLines keeps context around changes and inserts gap markers', () => {
  const lines = [];
  for (let i = 1; i <= 20; i += 1) {
    lines.push({ type: 'context', text: `line ${i}`, oldLine: i, newLine: i });
  }
  lines[9] = { type: 'add', text: 'inserted', oldLine: null, newLine: 10 };
  const collapsed = collapseContextLines(lines, 2);
  assert.equal(collapsed[0].type, 'gap');
  assert.equal(collapsed[0].count, 7);
  assert.deepEqual(collapsed.slice(1, 6).map((line) => line.type), ['context', 'context', 'add', 'context', 'context']);
  assert.equal(collapsed[6].type, 'gap');
  assert.equal(collapsed[6].count, 8);
});

test('collapseContextLines with no changes collapses everything into one gap', () => {
  const lines = [
    { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { type: 'context', text: 'b', oldLine: 2, newLine: 2 },
  ];
  const collapsed = collapseContextLines(lines, 3);
  assert.deepEqual(collapsed, [{ type: 'gap', count: 2 }]);
});

test('describeGitFileStatus maps porcelain codes to labels', () => {
  assert.equal(describeGitFileStatus('M'), 'Modified');
  assert.equal(describeGitFileStatus('D'), 'Deleted');
  assert.equal(describeGitFileStatus('U'), 'Untracked');
  assert.equal(describeGitFileStatus('?'), 'Changed');
});

test('summarizeGitStatusHeader shows branch with ahead/behind markers', () => {
  assert.equal(summarizeGitStatusHeader({ branch: 'dev', ahead: 2, behind: 1 }), 'dev ↑2 ↓1');
  assert.equal(summarizeGitStatusHeader({ branch: 'main' }), 'main');
  assert.equal(summarizeGitStatusHeader({ branch: 'x', detached: true }), 'detached HEAD');
});
