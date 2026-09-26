import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKGROUND_TASK_TIMEOUT_MAX_MINUTES,
  DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES,
  backgroundTaskTimeoutMinutesToMs,
  formatBackgroundTaskTimeoutLabel,
  normalizeBackgroundTaskTimeoutMinutes,
  parseBackgroundTaskTimeoutUpdate,
  readBackgroundTaskTimeoutSetting,
} from './background-task-timeout.mjs';

test('the default is 4 hours — long work survives, forgotten tasks do not live forever', () => {
  assert.equal(DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES, 240);
  assert.equal(readBackgroundTaskTimeoutSetting(''), 240);
  assert.equal(readBackgroundTaskTimeoutSetting(null), 240);
  assert.equal(backgroundTaskTimeoutMinutesToMs(DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES), 4 * 3_600_000);
  assert.equal(formatBackgroundTaskTimeoutLabel(DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES), '4 h');
});

test('zero and anything below it disables the timeout', () => {
  assert.equal(normalizeBackgroundTaskTimeoutMinutes(0), 0);
  assert.equal(normalizeBackgroundTaskTimeoutMinutes('0'), 0);
  assert.equal(normalizeBackgroundTaskTimeoutMinutes(-30), 0);
  assert.equal(backgroundTaskTimeoutMinutesToMs(0), 0);
});

test('the timeout is clamped to the slider maximum', () => {
  assert.equal(normalizeBackgroundTaskTimeoutMinutes(600), 600);
  assert.equal(normalizeBackgroundTaskTimeoutMinutes(5000), BACKGROUND_TASK_TIMEOUT_MAX_MINUTES);
  assert.equal(backgroundTaskTimeoutMinutesToMs(60), 3_600_000);
});

test('non-numeric input falls back rather than silently disabling the timeout', () => {
  assert.equal(normalizeBackgroundTaskTimeoutMinutes('abc'), DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES);
  assert.equal(normalizeBackgroundTaskTimeoutMinutes(undefined), DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES);
  assert.equal(normalizeBackgroundTaskTimeoutMinutes(NaN), DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES);
  // An explicit null fallback lets callers detect invalid input instead.
  assert.equal(normalizeBackgroundTaskTimeoutMinutes('abc', null), null);
});

test('labels read the way the slider should display them', () => {
  assert.equal(formatBackgroundTaskTimeoutLabel(0), 'No limit');
  assert.equal(formatBackgroundTaskTimeoutLabel(45), '45 min');
  assert.equal(formatBackgroundTaskTimeoutLabel(60), '1 h');
  assert.equal(formatBackgroundTaskTimeoutLabel(90), '1 h 30 min');
  assert.equal(formatBackgroundTaskTimeoutLabel(600), '10 h');
});

test('a stored explicit value survives a round trip', () => {
  // An explicit 0 is still "no limit", not "unset".
  assert.equal(readBackgroundTaskTimeoutSetting('0'), 0);
  assert.equal(readBackgroundTaskTimeoutSetting('120'), 120);
});

test('update parsing accepts the slider range and rejects junk', () => {
  assert.deepEqual(parseBackgroundTaskTimeoutUpdate(0), { ok: true, minutes: 0 });
  assert.deepEqual(parseBackgroundTaskTimeoutUpdate('90'), { ok: true, minutes: 90 });
  assert.deepEqual(parseBackgroundTaskTimeoutUpdate(99999), { ok: true, minutes: BACKGROUND_TASK_TIMEOUT_MAX_MINUTES });
  assert.equal(parseBackgroundTaskTimeoutUpdate('abc').ok, false);
  assert.equal(parseBackgroundTaskTimeoutUpdate(undefined).ok, false);
  assert.equal(parseBackgroundTaskTimeoutUpdate(null).ok, false);
  assert.match(parseBackgroundTaskTimeoutUpdate('').error, /must be a number/);
});
