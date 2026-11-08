import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isSafeCursorModelId } from '../shared/model-id.mjs';
import { createProviderModelStateStore } from './services/provider-model-state.mjs';

// The Cursor provider's getter and setter as server-runtime.mjs has them,
// run against an in-memory settings table: server-runtime.mjs boots a
// server on import, so its functions are taken from the source text and
// given the few names they use.
const source = fs.readFileSync(fileURLToPath(new URL('./server-runtime.mjs', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const CONSTANTS = [
  'CURSOR_API_KEY_SETTING_KEY',
  'CURSOR_ENABLED_SETTING_KEY',
  'CURSOR_MODEL_SETTING_KEY',
  'CURSOR_MODELS_SETTING_KEY',
  'CURSOR_ENABLED_MODELS_SETTING_KEY',
  'CURSOR_MODEL_EFFORTS_SETTING_KEY',
  'CURSOR_MODEL_REASONING_OFF_SETTING_KEY',
  'CURSOR_EFFORT_LEVELS',
  'DEFAULT_CURSOR_MODEL',
  'DEFAULT_CURSOR_MODELS',
];

function constantSource(name) {
  const match = source.match(new RegExp(`\\nconst ${name} = [^\\n]+;`));
  assert.ok(match, `expected server-runtime.mjs to define ${name}`);
  return match[0];
}

function createCursorProvider(initial = {}) {
  const values = new Map(Object.entries(initial));
  const readAppSettingValue = (key) => String(values.get(String(key || '').trim()) ?? '').trim();
  const stmts = {
    upsertAppSetting: { run: (key, value) => { values.set(key, String(value)); } },
    deleteAppSetting: { run: (key) => { values.delete(key); } },
    listRuntimeSessionProviderCandidates: { all: () => [] },
  };
  const providerModelState = createProviderModelStateStore({
    readSetting: readAppSettingValue,
    writeSetting: (key, value, stamp) => stmts.upsertAppSetting.run(key, value, stamp),
    now: () => new Date('2026-11-01T10:00:00Z'),
  });
  const body = [
    ...CONSTANTS.map(constantSource),
    sliceBetween('function readCursorModelReasoningOffSetting() {', '\nfunction getCursorProviderSettings() {'),
    sliceBetween('function getCursorProviderSettings() {', '\n/**\n * Manual Cursor plan allowances.'),
    sliceBetween('function setCursorProviderSettings(update = {}) {', '\nconst CURSOR_MODEL_DISCOVERY_TIMEOUT_MS'),
    'return { getCursorProviderSettings, setCursorProviderSettings };',
  ].join('\n');
  const factory = new Function('readAppSettingValue', 'stmts', 'providerModelState', 'isSafeCursorModelId', body);
  return { values, ...factory(readAppSettingValue, stmts, providerModelState, isSafeCursorModelId) };
}

const DISCOVERED = JSON.stringify(['composer-2.5', 'gpt-test-a', 'gpt-test-b', 'gpt-test-c']);

test('runtime Cursor: the upgrade through the getter shows what the old allowlist showed', () => {
  const cursor = createCursorProvider({
    cursor_api_key: 'crsr_test_1111111111',
    cursor_models: DISCOVERED,
    cursor_enabled_models: JSON.stringify(['gpt-test-b', 'gpt-test-retired']),
  });
  const settings = cursor.getCursorProviderSettings();
  assert.deepEqual(settings.models, ['composer-2.5', 'gpt-test-b']);
  assert.equal(settings.autoEnableNew, true);
  assert.equal(settings.fallback, false);
  assert.deepEqual(settings.unseenModels, []);
  const stored = JSON.parse(cursor.values.get('cursor_model_state'));
  assert.equal(stored.models['gpt-test-a'].on, false);
  assert.equal(stored.models['gpt-test-retired'].on, true);
  // The old key is left for a downgrade.
  assert.equal(cursor.values.get('cursor_enabled_models'), JSON.stringify(['gpt-test-b', 'gpt-test-retired']));
});

test('runtime Cursor: an empty save leaves the default; a save changes only what it showed', () => {
  const cursor = createCursorProvider({ cursor_api_key: 'crsr_test_1111111111', cursor_models: DISCOVERED });
  assert.deepEqual(cursor.getCursorProviderSettings().models, ['composer-2.5', 'gpt-test-a', 'gpt-test-b', 'gpt-test-c']);
  assert.equal(cursor.setCursorProviderSettings({ enabledModels: [] }).ok, true);
  assert.deepEqual(cursor.getCursorProviderSettings().models, ['composer-2.5']);
  // A model found after the modal was drawn (it showed a and b only) stays as it is.
  cursor.values.set('cursor_models', JSON.stringify([...JSON.parse(DISCOVERED), 'gpt-test-new']));
  cursor.setCursorProviderSettings({ enabledModels: ['gpt-test-a'], shownModels: ['composer-2.5', 'gpt-test-a', 'gpt-test-b'] });
  assert.deepEqual(cursor.getCursorProviderSettings().models, ['composer-2.5', 'gpt-test-a', 'gpt-test-new']);
});

test('runtime Cursor: removing the key keeps the map, a key added again finds it', () => {
  const cursor = createCursorProvider({ cursor_api_key: 'crsr_test_1111111111', cursor_models: DISCOVERED });
  cursor.setCursorProviderSettings({ enabledModels: ['gpt-test-c'] });
  assert.equal(cursor.setCursorProviderSettings({ remove: true }).ok, true);
  assert.equal(cursor.values.has('cursor_api_key'), false);
  assert.ok(cursor.values.has('cursor_model_state'));
  cursor.setCursorProviderSettings({ apiKey: 'crsr_test_2222222222' });
  // Discovery lists the models again.
  cursor.values.set('cursor_models', DISCOVERED);
  assert.deepEqual(cursor.getCursorProviderSettings().models, ['composer-2.5', 'gpt-test-c']);
});
