import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same approach as composer-provider-modes.test.mjs: bootstrap.js touches
// window/document at module scope, so these ordering and side-effect invariants
// are asserted against its source.
const sourcePath = fileURLToPath(new URL('./bootstrap.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected bootstrap.js to contain ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected bootstrap.js to contain ${endMarker}`);
  return source.slice(start, end);
}

test('model options are rebuilt for the provider before preferences are clamped', () => {
  const applySource = sliceBetween('function applyConversationPreferences({', '\nfunction applyConversationPreferencesForConversation(');
  const rebuildAt = applySource.indexOf('rebuildModelSelectorOptionsForProvider()');
  const clampAt = applySource.indexOf('const supportedModels = modelOptions()');
  assert.ok(rebuildAt !== -1 && clampAt !== -1 && rebuildAt < clampAt,
    'applyConversationPreferences must rebuild model options before reading them');
});

test('the model rebuild uses the providerScope cache idiom and keeps locked options', () => {
  const rebuildSource = sliceBetween('function rebuildModelSelectorOptionsForProvider() {', '\nfunction updateModelCatalogState(');
  assert.match(rebuildSource, /select\.dataset\.providerScope === scope\) return false;/);
  assert.match(rebuildSource, /select\.dataset\.providerScope = scope;/);
  assert.match(rebuildSource, /isSharedReaderMode\(\)\) return false;/);
  assert.match(rebuildSource, /runtimeModelLock === '1'/);
});

test('applying a conversation preference never writes the shared storage', () => {
  // This runs on every open, on the ~1s live poll, on a catalog refresh and on
  // another client's edit. Persisting the clamp there is what let one
  // conversation's resolution become the next New Chat's default.
  const catalogSource = sliceBetween('function updateModelCatalogState(payload) {', '\nfunction selectedModelValue(');
  assert.equal(catalogSource.includes('localStorage.setItem('), false,
    'catalog refresh must not persist a preference of its own');
  const applySource = sliceBetween('function applyConversationPreferences({', '\nfunction applyConversationPreferencesForConversation(');
  assert.equal(applySource.includes('localStorage.setItem('), false,
    'applying a stored preference must not write the shared storage');
  // persist defaults to false, so only an explicit opt-in writes storage, and
  // the one opt-in is the user-driven model change.
  const selectorSource = sliceBetween('function updateReasoningSelectorForModel(', '\n// Rebuilds the option list');
  assert.match(selectorSource, /\{ persist = false \} = \{\}/);
  const optIns = source.match(/\{ persist: true \}/g) || [];
  assert.equal(optIns.length, 1, 'only the user-initiated model change may persist an effort');
  const initSource = sliceBetween('function initModelSelector() {', '\nfunction initContextTierSelector(');
  assert.match(initSource, /\{ persist: true \}/);
});

test('changing the model carries the raw current effort across the rebuild', () => {
  const initSource = sliceBetween('function initModelSelector() {', '\nfunction initContextTierSelector(');
  assert.match(initSource, /updateReasoningSelectorForModel\(\s*select\.value,/);
  // selectedReasoningEffortValue() substitutes 'none' for an empty selector,
  // which would overwrite a remembered effort on the way through.
  assert.equal(initSource.includes('updateReasoningSelectorForModel(select.value, selectedReasoningEffortValue())'), false);
});

test('the runtime binding only fills in for a conversation with no stored preference', () => {
  // Preferring it over a stored preference let every catalog refresh revert a
  // model the user changed before sending the first message.
  const applySource = sliceBetween('function applyConversationPreferencesForConversation(conversationId', '\nfunction initModelSelector(');
  const preferredAt = applySource.indexOf('const effectivePreferredModel');
  const runtimeAt = applySource.indexOf('runtimeModel', preferredAt);
  assert.ok(preferredAt !== -1 && runtimeAt !== -1);
  assert.match(applySource.slice(preferredAt, runtimeAt), /preferredModel\s*\|\|/,
    'the stored preference has to be consulted before the runtime binding');
  assert.match(applySource.slice(preferredAt), /messageCount/,
    'the runtime binding only stands in for an unstarted conversation');
});

test('the shared effort storage is not promoted above the conversation preference', () => {
  const applySource = sliceBetween('const preferredReasoningEffort = firstDefinedPreference(', '  const runtimeModel = firstDefinedPreference(');
  assert.equal(applySource.includes('REASONING_STORAGE_KEY'), false,
    'updateReasoningSelectorForModel already consults storage, below the conversation value');
});

test('a preference write updates the local conversation before the round-trip', () => {
  const persistSource = sliceBetween('async function persistCurrentConversationPreferences() {', '\nfunction applyConversationPreferences({');
  const optimisticAt = persistSource.indexOf('preferredModel: preferredModelWithTier');
  const requestAt = persistSource.indexOf('await updateConversationPreferences(');
  assert.ok(optimisticAt !== -1 && requestAt !== -1 && optimisticAt < requestAt,
    'a refresh landing during the PATCH must reapply the new selection, not the replaced one');
});

test('the provider rebuild restores the selection it emptied', () => {
  const rebuildSource = sliceBetween('function rebuildModelSelectorOptionsForProvider() {', '\nfunction updateModelCatalogState(');
  assert.match(rebuildSource, /select\.value = selectedBefore;/);
});

test('conversation preferences fall through blank sources instead of stopping at them', () => {
  const applySource = sliceBetween('function applyConversationPreferencesForConversation(conversationId', '\nfunction initModelSelector(');
  assert.match(applySource, /firstDefinedPreference\(/);
  assert.equal(applySource.includes('?? conversation?.preferredModel'), false,
    'nullish coalescing treats an unset "" preference as a real value');
});
