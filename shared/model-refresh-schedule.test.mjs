import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODEL_REFRESH_INTERVAL_HOURS,
  MODEL_REFRESH_INTERVAL_HOURS_CHOICES,
  modelRefreshProvider,
  parseModelRefreshAutoUpdate,
  parseModelRefreshExcludedUpdate,
  parseModelRefreshIntervalHoursUpdate,
  readModelRefreshAutoSetting,
  readModelRefreshExcludedSetting,
  readModelRefreshIntervalHoursSetting,
  readModelRefreshLastSetting,
} from './model-refresh-schedule.mjs';

test('the check is on unless switched off', () => {
  assert.equal(readModelRefreshAutoSetting(''), true);
  assert.equal(readModelRefreshAutoSetting('false'), false);
  assert.equal(readModelRefreshAutoSetting('true'), true);
  assert.equal(readModelRefreshAutoSetting('garbage'), true);
  assert.deepEqual(parseModelRefreshAutoUpdate(false), { ok: true, auto: false });
  assert.equal(parseModelRefreshAutoUpdate('false').ok, false);
});

test('the interval is one of the choices, 24 h by default', () => {
  assert.deepEqual([...MODEL_REFRESH_INTERVAL_HOURS_CHOICES], [6, 12, 24, 72, 168]);
  assert.equal(DEFAULT_MODEL_REFRESH_INTERVAL_HOURS, 24);
  assert.equal(readModelRefreshIntervalHoursSetting(''), 24);
  assert.equal(readModelRefreshIntervalHoursSetting('72'), 72);
  assert.equal(readModelRefreshIntervalHoursSetting('5'), 24);
  assert.deepEqual(parseModelRefreshIntervalHoursUpdate('168'), { ok: true, intervalHours: 168 });
  assert.equal(parseModelRefreshIntervalHoursUpdate(48).ok, false);
  assert.equal(parseModelRefreshIntervalHoursUpdate(null).ok, false);
});

test('the opt-out list holds known provider ids only', () => {
  assert.deepEqual(readModelRefreshExcludedSetting(''), []);
  assert.deepEqual(readModelRefreshExcludedSetting('["cursor","nope","Cursor","github"]'), ['cursor', 'github']);
  assert.deepEqual(readModelRefreshExcludedSetting('not json'), []);
  assert.deepEqual(parseModelRefreshExcludedUpdate(['claude-api']), { ok: true, excluded: ['claude-api'] });
  assert.equal(parseModelRefreshExcludedUpdate(['nope']).ok, false);
  assert.equal(parseModelRefreshExcludedUpdate('cursor').ok, false);
});

test('the last refresh of each provider drops what it cannot read', () => {
  const last = readModelRefreshLastSetting(JSON.stringify({
    cursor: { at: '2026-11-01T00:00:00Z', ok: true, error: 'stale', lastOkAt: '2026-11-01T00:00:00Z' },
    grok: { at: '2026-11-01T00:00:00Z', ok: false, error: 'refused', lastFailureAt: '2026-11-01T00:00:00Z' },
    nope: { at: '2026-11-01T00:00:00Z', ok: true },
    claude: { ok: true },
  }));
  assert.deepEqual(Object.keys(last), ['cursor', 'grok']);
  assert.equal(last.cursor.error, null);
  assert.equal(last.grok.error, 'refused');
  assert.equal(last.grok.lastOkAt, null);
  assert.deepEqual(readModelRefreshLastSetting('[]'), {});
});

test('providers carry their Select Models tab', () => {
  assert.equal(modelRefreshProvider('claude').tab, 'anthropic');
  assert.equal(modelRefreshProvider('github').label, 'Copilot');
  assert.equal(modelRefreshProvider('nope'), null);
});
