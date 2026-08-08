import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelectionGuard, selectionIntersectsNode } from './selection-guard.mjs';

test('pointer drag holds the container until pointer up', () => {
  const guard = createSelectionGuard();
  assert.equal(guard.isHeld('messages'), false);
  guard.pointerDown('messages');
  assert.equal(guard.isHeld('messages'), true);
  assert.equal(guard.isHeld(), true);
  assert.equal(guard.isHeld('sidebar'), false);
  guard.pointerUp();
  assert.equal(guard.isHeld('messages'), false);
});

test('selection holds replace previous holds wholesale', () => {
  const guard = createSelectionGuard();
  guard.setSelectionHolds(['messages']);
  assert.equal(guard.isHeld('messages'), true);
  guard.setSelectionHolds(['sidebar']);
  assert.equal(guard.isHeld('messages'), false);
  assert.equal(guard.isHeld('sidebar'), true);
  guard.setSelectionHolds([]);
  assert.equal(guard.isHeld(), false);
});

test('release callbacks fire once when the last hold clears', () => {
  const guard = createSelectionGuard();
  let released = 0;
  guard.onRelease(() => { released += 1; });
  guard.pointerDown('messages');
  guard.setSelectionHolds(['messages']);
  guard.pointerUp();
  assert.equal(released, 0, 'selection still holds');
  guard.setSelectionHolds([]);
  assert.equal(released, 1);
  guard.setSelectionHolds([]);
  assert.equal(released, 1, 'no release event without a prior hold');
});

test('unsubscribing a release callback stops notifications', () => {
  const guard = createSelectionGuard();
  let released = 0;
  const unsubscribe = guard.onRelease(() => { released += 1; });
  guard.pointerDown('messages');
  unsubscribe();
  guard.pointerUp();
  assert.equal(released, 0);
});

test('a throwing release callback does not block the others', () => {
  const guard = createSelectionGuard();
  let released = 0;
  guard.onRelease(() => { throw new Error('boom'); });
  guard.onRelease(() => { released += 1; });
  guard.pointerDown('messages');
  guard.pointerUp();
  assert.equal(released, 1);
});

test('selectionIntersectsNode is false without DOM selection support', () => {
  assert.equal(selectionIntersectsNode(null, undefined), false);
  assert.equal(selectionIntersectsNode({}, {}), false);
  assert.equal(selectionIntersectsNode({}, { getSelection: () => null }), false);
  assert.equal(selectionIntersectsNode({}, { getSelection: () => ({ isCollapsed: true, rangeCount: 1 }) }), false);
});

test('selectionIntersectsNode checks each range against the node', () => {
  const node = {};
  const doc = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (index) => ({
        intersectsNode: (target) => index === 1 && target === node,
      }),
    }),
  };
  assert.equal(selectionIntersectsNode(node, doc), true);
  const missDoc = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: () => false }),
    }),
  };
  assert.equal(selectionIntersectsNode(node, missDoc), false);
});
