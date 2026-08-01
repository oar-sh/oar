import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deepestExistingAncestor,
  planRepoRehydration,
  repoAncestorPaths,
} from './repo-browser-tree-state.mjs';

test('ancestor chains cover the three path shapes the browser produces', () => {
  // Workspace root: relative, '' is the root node.
  assert.deepEqual(repoAncestorPaths('a/b/c'), ['', 'a', 'a/b', 'a/b/c']);
  // Drives/session root on posix: absolute, '/' is a real node.
  assert.deepEqual(repoAncestorPaths('/home/s/x'), ['', '/', '/home', '/home/s', '/home/s/x']);
  assert.deepEqual(repoAncestorPaths('/'), ['', '/']);
  // Windows drive paths ride the relative branch — no special case.
  assert.deepEqual(repoAncestorPaths('C:/Users/x'), ['', 'C:', 'C:/Users', 'C:/Users/x']);
});

test('empty and nullish paths collapse to the root', () => {
  assert.deepEqual(repoAncestorPaths(''), ['']);
  assert.deepEqual(repoAncestorPaths(null), ['']);
  assert.deepEqual(repoAncestorPaths(undefined), ['']);
});

test('the current path chain is planned parents-first', () => {
  assert.deepEqual(planRepoRehydration({ currentPath: 'a/b/c' }), ['', 'a', 'a/b', 'a/b/c']);
  assert.deepEqual(planRepoRehydration({}), ['']);
});

test('expanded branches reachable from the plan are included', () => {
  const plan = planRepoRehydration({
    currentPath: 'a/b/c',
    expandedPaths: ['x', 'a/b/z'],
  });
  assert.deepEqual(plan, ['', 'a', 'a/b', 'a/b/c', 'x', 'a/b/z']);
});

test('an expanded path whose parent is unreachable is dropped with its descendants', () => {
  // 'q' is neither in the current chain nor expanded, so 'q/r' would render the
  // lazy placeholder however hard we tried to load it.
  const plan = planRepoRehydration({
    currentPath: 'a/b',
    expandedPaths: ['q/r', 'q/r/s'],
  });
  assert.deepEqual(plan, ['', 'a', 'a/b']);
});

test('a path already in the current chain is not planned twice', () => {
  const plan = planRepoRehydration({
    currentPath: 'a/b/c',
    expandedPaths: ['a/b', 'a'],
  });
  assert.deepEqual(plan, ['', 'a', 'a/b', 'a/b/c']);
});

test('tier two is capped', () => {
  const expandedPaths = Array.from({ length: 40 }, (_, index) => `dir-${String(index).padStart(2, '0')}`);
  const plan = planRepoRehydration({ currentPath: '', expandedPaths, maxPaths: 24 });
  assert.equal(plan.length, 24);
  assert.equal(plan[0], '');
});

test('the current path chain is exempt from the cap', () => {
  const deep = Array.from({ length: 30 }, (_, index) => `seg${index}`).join('/');
  const plan = planRepoRehydration({ currentPath: deep, expandedPaths: ['other'], maxPaths: 24 });
  // 30 segments + the root, and the over-cap tier-two candidate is dropped.
  assert.equal(plan.length, 31);
  assert.equal(plan.at(-1), deep);
  assert.equal(plan.includes('other'), false);
});

test('a Set of expanded paths is accepted, session-root shape included', () => {
  const plan = planRepoRehydration({
    currentPath: '/home/s/repo/sub',
    expandedPaths: new Set(['/home/s/repo/other']),
  });
  assert.deepEqual(plan, [
    '', '/', '/home', '/home/s', '/home/s/repo', '/home/s/repo/sub', '/home/s/repo/other',
  ]);
});

test('the deepest surviving ancestor is used when a branch disappears', () => {
  const dirs = new Set(['a', 'a/b', 'a/b/c']);
  const hasDir = (p) => dirs.has(p);

  assert.equal(deepestExistingAncestor('a/b/c', hasDir), 'a/b/c');
  // The hidden-dir case: '.git' vanishes when Hidden is switched off.
  assert.equal(deepestExistingAncestor('a/b/.git', hasDir), 'a/b');
  assert.equal(deepestExistingAncestor('q/r/s', hasDir), '');
  assert.equal(deepestExistingAncestor('', hasDir), '');
});

test('a path that resolves to a file falls back to its parent directory', () => {
  const nodes = new Map([['a', 'dir'], ['a/b', 'file']]);
  const hasDir = (p) => nodes.get(p) === 'dir';
  assert.equal(deepestExistingAncestor('a/b', hasDir), 'a');
});
