import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES,
  CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES,
  CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES,
  DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES,
  DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MS,
  claudeBackgroundCommandLimitMinutesToMs,
  formatClaudeBackgroundCommandLimitLabel,
  normalizeClaudeBackgroundCommandLimitMinutes,
  parseClaudeBackgroundCommandLimitUpdate,
  readClaudeBackgroundCommandLimitSetting,
  resolveDeliveredClaudeBackgroundCommandLimitMs,
} from './claude-background-command-limit.mjs';
import * as browserMirror from '../server/public/app/claude-background-command-limit-options.mjs';

test('the default is 2 hours, the range 30 min to 8 h in 30-minute steps', () => {
  assert.equal(DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES, 120);
  assert.equal(DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MS, 2 * 3_600_000);
  assert.equal(CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES, 30);
  assert.equal(CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES, 480);
  assert.equal(CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES, 30);
  assert.equal(readClaudeBackgroundCommandLimitSetting(''), 120);
  assert.equal(readClaudeBackgroundCommandLimitSetting(null), 120);
  assert.equal(readClaudeBackgroundCommandLimitSetting(undefined), 120);
  assert.equal(readClaudeBackgroundCommandLimitSetting('300'), 300);
  assert.equal(readClaudeBackgroundCommandLimitSetting('junk'), 120);
});

test('values are clamped to the range and snapped to the nearest step', () => {
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(0), 30);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(-60), 30);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(5), 30);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(44), 30);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(45), 60);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(100), 90);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes('210'), 210);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(480), 480);
  assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(1000), 480);
  assert.equal(claudeBackgroundCommandLimitMinutesToMs(240), 4 * 3_600_000);
  assert.equal(claudeBackgroundCommandLimitMinutesToMs(9999), 8 * 3_600_000);
});

test('values that are not numbers fall back, and an update rejects them', () => {
  for (const value of [null, undefined, '', '  ', 'abc', Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
    assert.equal(normalizeClaudeBackgroundCommandLimitMinutes(value), 120, String(value));
    const parsed = parseClaudeBackgroundCommandLimitUpdate(value);
    assert.equal(parsed.ok, false, String(value));
    assert.equal(parsed.error, 'backgroundCommandLimitMinutes must be a number');
  }
  assert.deepEqual(parseClaudeBackgroundCommandLimitUpdate(170), { ok: true, minutes: 180 });
  assert.deepEqual(parseClaudeBackgroundCommandLimitUpdate('15'), { ok: true, minutes: 30 });
});

test('labels read in minutes below an hour and in hours above', () => {
  assert.equal(formatClaudeBackgroundCommandLimitLabel(30), '30 min');
  assert.equal(formatClaudeBackgroundCommandLimitLabel(120), '2 h');
  assert.equal(formatClaudeBackgroundCommandLimitLabel(150), '2 h 30 min');
  assert.equal(formatClaudeBackgroundCommandLimitLabel(480), '8 h');
  for (const minutes of [30, 60, 90, 120, 270, 480]) {
    assert.equal(browserMirror.formatClaudeBackgroundCommandLimitLabel(minutes), formatClaudeBackgroundCommandLimitLabel(minutes));
  }
});

test('the browser mirror stays identical to the shared module', () => {
  assert.equal(browserMirror.DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES, DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES);
  assert.equal(browserMirror.CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES, CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES);
  assert.equal(browserMirror.CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES, CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES);
  assert.equal(browserMirror.CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES, CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES);
});

test('the slider markup starts at the default and the shared bounds', async () => {
  const html = await readFile(fileURLToPath(new URL('../server/public/index.html', import.meta.url)), 'utf8');
  const slider = html.match(/<input\s+id="claude-background-command-limit-slider"[^>]*>/s)?.[0];
  assert.ok(slider, 'the slider is in the page');
  assert.match(slider, new RegExp(`min="${CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES}"`));
  assert.match(slider, new RegExp(`max="${CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES}"`));
  assert.match(slider, new RegExp(`step="${CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES}"`));
  assert.match(slider, new RegExp(`value="${DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES}"`));
  assert.match(html, new RegExp(`<span id="claude-background-command-limit-value">${formatClaudeBackgroundCommandLimitLabel(DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES)}</span>`));
});

test('a delivery sets the worker limit; an absent or junk value keeps the last one', () => {
  const twoHours = 2 * 3_600_000;
  const fourHours = 4 * 3_600_000;
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(twoHours, { claudeBackgroundCommandLimitMs: fourHours }), fourHours);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(fourHours, {}), fourHours);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(fourHours, null), fourHours);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(fourHours, { claudeBackgroundCommandLimitMs: null }), fourHours);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(fourHours, { claudeBackgroundCommandLimitMs: 'abc' }), fourHours);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(fourHours, { claudeBackgroundCommandLimitMs: -1 }), fourHours);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(null, {}), DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MS);
  // Clamped like the setting itself.
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(twoHours, { claudeBackgroundCommandLimitMs: 60_000 }), 30 * 60_000);
  assert.equal(resolveDeliveredClaudeBackgroundCommandLimitMs(twoHours, { claudeBackgroundCommandLimitMs: 24 * 3_600_000 }), 8 * 3_600_000);
});
