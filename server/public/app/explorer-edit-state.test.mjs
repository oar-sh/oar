import assert from 'node:assert/strict';
import test from 'node:test';

import {
  childPathOf,
  descendantsOf,
  dropPathsBelow,
  entryNameOf,
  isSameOrBelow,
  parentPathOf,
  rewritePathPrefix,
  rewritePathSet,
} from './explorer-edit-state.mjs';

// platform-agnostic: these are the explorer's own web paths, never host paths.

test('names and parents on workspace, Linux and Windows web paths', () => {
  assert.equal(entryNameOf('alpha/beta'), 'beta');
  assert.equal(entryNameOf('alpha'), 'alpha');
  assert.equal(entryNameOf('/srv/data'), 'data');
  assert.equal(entryNameOf('C:/work'), 'work');

  assert.equal(parentPathOf('alpha/beta'), 'alpha');
  assert.equal(parentPathOf('alpha'), '');
  assert.equal(parentPathOf('/srv/data'), '/srv');
  assert.equal(parentPathOf('/srv'), '/');
  assert.equal(parentPathOf('C:/work'), 'C:');
  assert.equal(parentPathOf('C:'), '');
});

test('childPathOf joins without doubling the slash of a root', () => {
  assert.equal(childPathOf('', 'new'), 'new');
  assert.equal(childPathOf('alpha', 'new'), 'alpha/new');
  assert.equal(childPathOf('/', 'new'), '/new');
  assert.equal(childPathOf('/srv', 'new'), '/srv/new');
  assert.equal(childPathOf('C:', 'new'), 'C:/new');
});

test('isSameOrBelow matches whole segments only', () => {
  assert.equal(isSameOrBelow('alpha/beta', 'alpha'), true);
  assert.equal(isSameOrBelow('alpha', 'alpha'), true);
  assert.equal(isSameOrBelow('alphabet', 'alpha'), false);
  assert.equal(isSameOrBelow('/srv/x', '/'), true);
  assert.equal(isSameOrBelow('anything', ''), true);
  assert.equal(isSameOrBelow('', ''), true);
});

test('a rename rewrites the entry and everything below it in the expansion sets', () => {
  assert.equal(rewritePathPrefix('alpha/beta/deep', 'alpha/beta', 'alpha/gamma'), 'alpha/gamma/deep');
  assert.equal(rewritePathPrefix('alpha/betamax', 'alpha/beta', 'alpha/gamma'), 'alpha/betamax');
  assert.equal(rewritePathPrefix('alpha/beta', '', 'x'), 'alpha/beta', 'the root is never rewritten');

  const expanded = new Set(['', 'alpha', 'alpha/beta', 'alpha/beta/deep', 'docs']);
  assert.deepEqual([...rewritePathSet(expanded, 'alpha/beta', 'alpha/gamma')], ['', 'alpha', 'alpha/gamma', 'alpha/gamma/deep', 'docs']);
});

test('a delete drops the entry and everything below it', () => {
  const expanded = new Set(['', 'alpha', 'alpha/beta', 'alpha/beta/deep', 'docs']);
  assert.deepEqual([...dropPathsBelow(expanded, 'alpha/beta')], ['', 'alpha', 'docs']);
  assert.deepEqual([...dropPathsBelow(expanded, '')], [...expanded], 'the root is never dropped');
});

test('descendantsOf lists what to re-expand below a folder, shallowest first', () => {
  const expanded = new Set(['alpha/beta/deep', 'docs', 'alpha', 'alpha/beta', '']);
  assert.deepEqual(descendantsOf(expanded, 'alpha'), ['alpha/beta', 'alpha/beta/deep']);
  assert.deepEqual(descendantsOf(expanded, ''), ['docs', 'alpha', 'alpha/beta', 'alpha/beta/deep']);
  assert.deepEqual(descendantsOf(expanded, 'docs'), []);
});
