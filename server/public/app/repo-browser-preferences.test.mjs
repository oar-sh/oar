import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY,
  REPO_BROWSER_WORKSPACE_HEAVY_STORAGE_KEY,
  REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY,
  normalizeStoredBooleanFlag,
  readRepoBrowserPreferences,
  writeRepoBrowserHeavyPreference,
  writeRepoBrowserHiddenPreference,
} from './repo-browser-preferences.mjs';

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

const throwingStorage = {
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('quota exceeded'); },
};

test('a fresh browser profile has every filter off', () => {
  assert.deepEqual(readRepoBrowserPreferences(makeStorage()), {
    workspaceIncludeHidden: false,
    drivesIncludeHidden: false,
    workspaceIncludeHeavy: false,
  });
});

test('stored values are parsed leniently, unknown text falls back', () => {
  assert.equal(normalizeStoredBooleanFlag('1'), true);
  assert.equal(normalizeStoredBooleanFlag('true'), true);
  assert.equal(normalizeStoredBooleanFlag(' ON '), true);
  assert.equal(normalizeStoredBooleanFlag('yes'), true);
  assert.equal(normalizeStoredBooleanFlag('0'), false);
  assert.equal(normalizeStoredBooleanFlag('false'), false);
  assert.equal(normalizeStoredBooleanFlag(''), false);
  assert.equal(normalizeStoredBooleanFlag('maybe'), false);
  assert.equal(normalizeStoredBooleanFlag('maybe', true), true);
  assert.equal(normalizeStoredBooleanFlag(null, true), true);
  assert.equal(normalizeStoredBooleanFlag(undefined), false);
});

test('hidden preference round-trips per root', () => {
  const storage = makeStorage();
  writeRepoBrowserHiddenPreference('workspace', true, storage);
  assert.equal(storage.getItem(REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY), '1');
  assert.equal(storage.getItem(REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY), null);
  assert.equal(readRepoBrowserPreferences(storage).workspaceIncludeHidden, true);

  writeRepoBrowserHiddenPreference('workspace', false, storage);
  assert.equal(storage.getItem(REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY), '0');
  assert.equal(readRepoBrowserPreferences(storage).workspaceIncludeHidden, false);
});

test('drives and session roots share the drives key, workspace never touches it', () => {
  const storage = makeStorage();
  writeRepoBrowserHiddenPreference('drives', true, storage);
  assert.equal(storage.getItem(REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY), '1');

  writeRepoBrowserHiddenPreference('session', false, storage);
  assert.equal(storage.getItem(REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY), '0');

  assert.equal(storage.getItem(REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY), null);
});

test('workspace and drives hidden flags stay independent', () => {
  const storage = makeStorage();
  writeRepoBrowserHiddenPreference('workspace', true, storage);
  const prefs = readRepoBrowserPreferences(storage);
  assert.equal(prefs.workspaceIncludeHidden, true);
  assert.equal(prefs.drivesIncludeHidden, false);
});

test('heavy preference persists under its own key', () => {
  const storage = makeStorage();
  writeRepoBrowserHeavyPreference(true, storage);
  assert.equal(storage.getItem(REPO_BROWSER_WORKSPACE_HEAVY_STORAGE_KEY), '1');
  assert.equal(readRepoBrowserPreferences(storage).workspaceIncludeHeavy, true);
});

test('a storage that throws degrades to defaults instead of breaking boot', () => {
  assert.deepEqual(readRepoBrowserPreferences(throwingStorage), {
    workspaceIncludeHidden: false,
    drivesIncludeHidden: false,
    workspaceIncludeHeavy: false,
  });
  assert.equal(writeRepoBrowserHiddenPreference('workspace', true, throwingStorage), false);
  assert.equal(writeRepoBrowserHeavyPreference(true, throwingStorage), false);
});

test('storage keys are locked so an upgrade cannot silently reset preferences', () => {
  assert.equal(REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY, 'copilot_repo_browser_hidden_workspace');
  assert.equal(REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY, 'copilot_repo_browser_hidden_drives');
  assert.equal(REPO_BROWSER_WORKSPACE_HEAVY_STORAGE_KEY, 'copilot_repo_browser_heavy_workspace');
});
