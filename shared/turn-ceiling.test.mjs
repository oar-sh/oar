import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TURN_CEILING_MINUTES,
  TURN_CEILING_MAX_MINUTES,
  formatTurnCeilingLabel,
  normalizeTurnCeilingMinutes,
  parseTurnCeilingUpdate,
  readTurnCeilingSetting,
  turnCeilingMinutesToMs,
} from './turn-ceiling.mjs';

test('zero and anything below it disables the ceiling', () => {
  assert.equal(normalizeTurnCeilingMinutes(0), 0);
  assert.equal(normalizeTurnCeilingMinutes('0'), 0);
  assert.equal(normalizeTurnCeilingMinutes(-30), 0);
  assert.equal(turnCeilingMinutesToMs(0), 0);
});

test('the ceiling is clamped to the slider maximum', () => {
  assert.equal(normalizeTurnCeilingMinutes(600), 600);
  assert.equal(normalizeTurnCeilingMinutes(5000), TURN_CEILING_MAX_MINUTES);
  assert.equal(turnCeilingMinutesToMs(60), 3_600_000);
});

test('non-numeric input falls back rather than silently disabling the ceiling', () => {
  assert.equal(normalizeTurnCeilingMinutes('abc'), DEFAULT_TURN_CEILING_MINUTES);
  assert.equal(normalizeTurnCeilingMinutes(undefined), DEFAULT_TURN_CEILING_MINUTES);
  assert.equal(normalizeTurnCeilingMinutes(NaN), DEFAULT_TURN_CEILING_MINUTES);
  // An explicit null fallback lets callers detect invalid input instead.
  assert.equal(normalizeTurnCeilingMinutes('abc', null), null);
});

test('labels read the way the slider should display them', () => {
  assert.equal(formatTurnCeilingLabel(0), 'No limit');
  assert.equal(formatTurnCeilingLabel(45), '45 min');
  assert.equal(formatTurnCeilingLabel(60), '1 h');
  assert.equal(formatTurnCeilingLabel(90), '1 h 30 min');
  assert.equal(formatTurnCeilingLabel(600), '10 h');
});

test('an unconfigured setting reads as the default, not as "no limit"', () => {
  assert.equal(readTurnCeilingSetting(''), DEFAULT_TURN_CEILING_MINUTES);
  assert.equal(readTurnCeilingSetting(null), DEFAULT_TURN_CEILING_MINUTES);
  assert.equal(readTurnCeilingSetting(undefined), DEFAULT_TURN_CEILING_MINUTES);
  // An explicit 0 is a real choice and must survive a round trip.
  assert.equal(readTurnCeilingSetting('0'), 0);
  assert.equal(readTurnCeilingSetting('120'), 120);
});

test('update parsing accepts the slider range and rejects junk', () => {
  assert.deepEqual(parseTurnCeilingUpdate(0), { ok: true, minutes: 0 });
  assert.deepEqual(parseTurnCeilingUpdate('90'), { ok: true, minutes: 90 });
  assert.deepEqual(parseTurnCeilingUpdate(99999), { ok: true, minutes: TURN_CEILING_MAX_MINUTES });
  assert.equal(parseTurnCeilingUpdate('abc').ok, false);
  assert.equal(parseTurnCeilingUpdate(undefined).ok, false);
  assert.equal(parseTurnCeilingUpdate(null).ok, false);
  assert.match(parseTurnCeilingUpdate('').error, /must be a number/);
});
