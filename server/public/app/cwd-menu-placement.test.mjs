import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveActiveOptionIndex,
  resolveCwdMenuPlacement,
  resolveTypeaheadIndex,
} from './cwd-menu-placement.mjs';

const TRIGGER = { top: 200, left: 40, width: 260, height: 44 };

test('places the panel below the trigger when there is room', () => {
  const placement = resolveCwdMenuPlacement({
    triggerRect: TRIGGER,
    viewportWidth: 1200,
    viewportHeight: 900,
    panelHeight: 220,
  });
  assert.equal(placement.placement, 'below');
  assert.equal(placement.top, 250);
  assert.equal(placement.left, 40);
  assert.equal(placement.width, 260);
  assert.equal(placement.maxHeight, 220);
});

test('flips above the trigger when the space below is too small', () => {
  const placement = resolveCwdMenuPlacement({
    triggerRect: { ...TRIGGER, top: 700 },
    viewportWidth: 1200,
    viewportHeight: 800,
    panelHeight: 300,
  });
  assert.equal(placement.placement, 'above');
  assert.ok(placement.top < 700);
  assert.ok(placement.maxHeight <= 700 - 6 - 8);
});

test('keeps the panel below when the space above is even smaller', () => {
  const placement = resolveCwdMenuPlacement({
    triggerRect: { ...TRIGGER, top: 20 },
    viewportWidth: 1200,
    viewportHeight: 220,
    panelHeight: 300,
  });
  assert.equal(placement.placement, 'below');
});

test('clamps maxHeight to the available space and never below minHeight', () => {
  const tight = resolveCwdMenuPlacement({
    triggerRect: { ...TRIGGER, top: 100 },
    viewportWidth: 1200,
    viewportHeight: 260,
    panelHeight: 300,
    minHeight: 140,
    maxHeight: 300,
  });
  assert.ok(tight.maxHeight <= 300);
  assert.ok(tight.maxHeight > 0);

  const roomy = resolveCwdMenuPlacement({
    triggerRect: TRIGGER,
    viewportWidth: 1200,
    viewportHeight: 2000,
    panelHeight: 5000,
    maxHeight: 300,
  });
  assert.equal(roomy.maxHeight, 300);
});

test('clamps left against both viewport edges', () => {
  const offLeft = resolveCwdMenuPlacement({
    triggerRect: { ...TRIGGER, left: -50 },
    viewportWidth: 1200,
    viewportHeight: 900,
  });
  assert.equal(offLeft.left, 8);

  const offRight = resolveCwdMenuPlacement({
    triggerRect: { ...TRIGGER, left: 1150 },
    viewportWidth: 1200,
    viewportHeight: 900,
  });
  assert.equal(offRight.left, 1200 - 260 - 8);
});

test('resolveActiveOptionIndex clamps at both ends and handles an empty list', () => {
  assert.equal(resolveActiveOptionIndex(-1, 1, 5), 0);
  assert.equal(resolveActiveOptionIndex(-1, -1, 5), 4);
  assert.equal(resolveActiveOptionIndex(0, -1, 5), 0);
  assert.equal(resolveActiveOptionIndex(4, 1, 5), 4);
  assert.equal(resolveActiveOptionIndex(2, 1, 5), 3);
  assert.equal(resolveActiveOptionIndex(0, 1, 0), -1);
  assert.equal(resolveActiveOptionIndex(3, 0, 5), 3);
});

// platform-agnostic: typeahead matches these paths as plain lowercased strings;
// no path semantics are involved, so the win32 fixtures behave the same anywhere.
test('resolveTypeaheadIndex matches label or path prefixes and wraps', () => {
  const entries = [
    { label: 'Current session CWD', path: 'C:\\git\\copilot-remote' },
    { label: 'Relay workspace', path: 'C:\\git\\other' },
    { label: 'Recent CWD 1', path: 'D:\\work\\alpha' },
  ];
  assert.equal(resolveTypeaheadIndex(entries, 'relay'), 1);
  assert.equal(resolveTypeaheadIndex(entries, 'd:\\work'), 2);
  // Wraps back to the start when searching forward from the last entry.
  assert.equal(resolveTypeaheadIndex(entries, 'current', 2), 0);
  assert.equal(resolveTypeaheadIndex(entries, 'zzz'), -1);
  assert.equal(resolveTypeaheadIndex(entries, ''), -1);
  assert.equal(resolveTypeaheadIndex([], 'a'), -1);
});
