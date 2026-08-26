import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_COMPACT_WINDOW_MIN_TOKENS,
  AUTO_COMPACT_WINDOW_STOPS,
  autoCompactWindowFromIndex,
  autoCompactWindowToIndex,
  formatAutoCompactWindowLabel,
  parseAutoCompactWindow,
  resolveDeliveredAutoCompactWindow,
} from './auto-compact-window.mjs';
import * as browserMirror from '../server/public/app/auto-compact-window-options.mjs';

test('every stop round-trips through index and back', () => {
  for (const stop of AUTO_COMPACT_WINDOW_STOPS) {
    const index = autoCompactWindowToIndex(stop);
    assert.equal(autoCompactWindowFromIndex(index), stop);
    assert.equal(parseAutoCompactWindow(stop), stop);
  }
  assert.equal(AUTO_COMPACT_WINDOW_STOPS[0], null, 'Auto must be index 0');
});

test('off-stop values snap to the nearest stop', () => {
  // Below the CLI's 100k floor: snapped up to the smallest window it honors
  // rather than pinned to a value it would silently ignore.
  assert.equal(parseAutoCompactWindow(48_000), 100_000);
  assert.equal(parseAutoCompactWindow(50_000), 100_000);
  assert.equal(parseAutoCompactWindow(120_000), 100_000);
  assert.equal(parseAutoCompactWindow(130_000), 150_000);
  assert.equal(parseAutoCompactWindow(9_999_999), 1_000_000);
  assert.equal(parseAutoCompactWindow('150000'), 150_000);
});

test('absent, blank and junk all mean Auto rather than a pinned window', () => {
  for (const value of [null, undefined, '', '   ', 'auto', 'AUTO', 'nonsense', NaN, 0, -5, {}]) {
    assert.equal(parseAutoCompactWindow(value), null, `expected Auto for ${String(value)}`);
  }
});

test('labels are short enough for the slider', () => {
  assert.equal(formatAutoCompactWindowLabel(null), 'Auto');
  assert.equal(formatAutoCompactWindowLabel(100_000), '100k');
  assert.equal(formatAutoCompactWindowLabel(150_000), '150k');
  assert.equal(formatAutoCompactWindowLabel(1_000_000), '1M');
  assert.equal(formatAutoCompactWindowLabel('junk'), 'Auto');
});

test('the browser mirror agrees with the shared module', () => {
  // server/public is the only served directory, so the client cannot import
  // shared/ — the copy is only safe while these stay identical.
  assert.deepEqual(
    [...browserMirror.AUTO_COMPACT_WINDOW_STOPS],
    [...AUTO_COMPACT_WINDOW_STOPS],
  );
  for (const value of [null, 'auto', 'junk', 0, 48_000, 130_000, 1_000_000, 9_999_999]) {
    assert.equal(browserMirror.parseAutoCompactWindow(value), parseAutoCompactWindow(value), String(value));
    assert.equal(
      browserMirror.formatAutoCompactWindowLabel(value),
      formatAutoCompactWindowLabel(value),
      String(value),
    );
    assert.equal(browserMirror.autoCompactWindowToIndex(value), autoCompactWindowToIndex(value), String(value));
  }
});

// The claude worker's delivery contract (claude-session-worker.mjs onDeliver).
// Both halves are load-bearing: presence, not truthiness, decides.

test('a delivery that omits the window keeps the worker\'s last known value', () => {
  // An older relay sends settings without the key at all.
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { backgroundTaskTimeoutMs: 0 }), 150_000);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, {}), 150_000);
  // No settings bag at all is the same "say nothing" case.
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, null), 150_000);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, undefined), 150_000);
  assert.equal(resolveDeliveredAutoCompactWindow(null, {}), null);
});

test('an explicit null clears the pin — "return to Auto" must survive', () => {
  // A truthiness check would leave 150k pinned forever for all of these.
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { autoCompactWindow: null }), null);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { autoCompactWindow: 0 }), null);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { autoCompactWindow: '' }), null);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { autoCompactWindow: 'junk' }), null);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { autoCompactWindow: -1 }), null);
});

test('an explicit window replaces the worker value', () => {
  assert.equal(resolveDeliveredAutoCompactWindow(null, { autoCompactWindow: 200_000 }), 200_000);
  assert.equal(resolveDeliveredAutoCompactWindow(150_000, { autoCompactWindow: '300000' }), 300_000);
});

test('an out-of-range slider index reads as Auto', () => {
  assert.equal(autoCompactWindowFromIndex(-1), null);
  assert.equal(autoCompactWindowFromIndex(AUTO_COMPACT_WINDOW_STOPS.length), null);
  assert.equal(autoCompactWindowFromIndex('2'), AUTO_COMPACT_WINDOW_STOPS[2]);
});

test('no stop sits below the window the CLI actually honors', () => {
  // Probed 2026-08-20 against the bundled CLI: 50k and 60k are dropped (the
  // resolved source stays 'auto'), 100k applies as source 'settings'. A stop
  // the CLI ignores would be a slider position that silently does nothing.
  for (const stop of AUTO_COMPACT_WINDOW_STOPS) {
    if (stop === null) continue;
    assert.ok(stop >= AUTO_COMPACT_WINDOW_MIN_TOKENS, `stop ${stop} is below the CLI floor`);
  }
});
