import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// bootstrap.js touches window/document at module scope, so the mode-selector
// wiring is exercised through its source rather than imported.
const sourcePath = fileURLToPath(new URL('./bootstrap.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected bootstrap.js to contain ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected bootstrap.js to contain ${endMarker}`);
  return source.slice(start, end);
}

test('every provider scope has a relay-mode list covering the shared vocabulary', () => {
  const tableSource = sliceBetween('const RELAY_MODES_BY_PROVIDER = {', '\nfunction relayModesForProvider(');
  const modes = new Function(`${tableSource}\nreturn RELAY_MODES_BY_PROVIDER;`)();
  assert.deepEqual(Object.keys(modes).sort(), ['claude', 'claude-cloud', 'cursor', 'github', 'grok', 'openai']);
  // A cloud session ignores relay modes: one entry, and the selector is hidden.
  assert.deepEqual(modes['claude-cloud'], ['agent']);
  for (const [provider, list] of Object.entries(modes)) {
    assert.ok(list.includes('agent'), `${provider} must offer agent`);
    for (const mode of list) {
      assert.ok(['agent', 'ask', 'plan', 'autopilot'].includes(mode), `${provider} mode ${mode} must be relay vocabulary`);
    }
  }
});

test('a cloud conversation resolves to its own provider scope, not to Copilot', () => {
  const normalizeSource = sliceBetween('function normalizeModelSelectorProviderType(', '\nfunction modelProvidersForId(');
  const normalize = new Function(
    'CLAUDE_CLOUD_PROVIDER',
    `${normalizeSource}\nreturn normalizeModelSelectorProviderType;`,
  )('claude-cloud');
  assert.equal(normalize('claude-cloud'), 'claude-cloud');
  assert.equal(normalize(' Claude-Cloud '), 'claude-cloud');
  // Every existing scope is untouched: `claude` stays Claude-only.
  assert.equal(normalize('claude'), 'claude');
  assert.equal(normalize('grok'), 'grok');
  assert.equal(normalize('something-new'), 'github');
});

test('a cloud conversation gets the one effort "none", a switchable model and no catalog prices', () => {
  const reasoningSource = sliceBetween('function reasoningOptionsForModel(', '\nfunction reasoningProviderKey(');
  // Not an empty list: the send path refuses a message without an effort, so
  // an empty (hidden) select made every cloud message unsendable.
  assert.match(reasoningSource, /if \(provider === CLAUDE_CLOUD_PROVIDER\) return \['none'\];/);
  // The model of a cloud chat is switched between turns (set_model): no lock.
  const lockSource = sliceBetween('function currentRuntimeModelLock() {', '\n// The runtime model decides');
  assert.doesNotMatch(lockSource, /ClaudeCloud/);
  const optionsSource = sliceBetween('function buildModelSelectorOptions(', '\nfunction reasoningOptionsForModel(');
  assert.match(optionsSource, /=== CLAUDE_CLOUD_PROVIDER\) \{\s+return buildClaudeCloudModelSelectorOptions\(/);
  const pricingSource = sliceBetween('function updateModelPricingDetails(', '\n// Relay modes each provider');
  assert.match(pricingSource, /activeComposerProviderType\(\) === CLAUDE_CLOUD_PROVIDER\s+\? null/);
});

test('the fixed mode of a cloud chat never becomes the remembered mode', () => {
  const persistSource = sliceBetween('async function persistCurrentConversationPreferences() {', '\nfunction applyConversationPreferences({');
  assert.match(
    persistSource,
    /if \(activeComposerProviderType\(\) !== CLAUDE_CLOUD_PROVIDER\) localStorage\.setItem\(MODE_STORAGE_KEY, mode\);/,
  );
});

test('mode options are rebuilt for the provider before preferences are clamped', () => {
  const applySource = sliceBetween('function applyConversationPreferences({', '\nfunction applyConversationPreferencesForConversation(');
  const rebuildAt = applySource.indexOf('updateModeSelectorForProvider()');
  const clampAt = applySource.indexOf('const supportedModes = modeOptions()');
  assert.ok(rebuildAt !== -1 && clampAt !== -1 && rebuildAt < clampAt,
    'applyConversationPreferences must rebuild mode options before reading them');
  // The send path re-scopes on every provider change via syncAutoModelAvailability.
  const syncSource = sliceBetween('function syncAutoModelAvailability() {', '\nfunction syncSessionLockNote(');
  assert.match(syncSource, /updateModeSelectorForProvider\(\);/);
});

test('mode selector rebuild uses the providerScope cache idiom and keeps a valid selection', () => {
  const rebuildSource = sliceBetween('function updateModeSelectorForProvider() {', '\nfunction modeOptions(');
  assert.match(rebuildSource, /select\.dataset\.providerScope === scope\) return;/);
  assert.match(rebuildSource, /select\.dataset\.providerScope = scope;/);
  assert.match(rebuildSource, /isSharedReaderMode\(\)\) return;/);
  assert.match(rebuildSource, /modes\.includes\(selectedBefore\)/);
});

test('saving Select Models preserves enabled variants that are not rendered on the active tab', () => {
  const saveSource = sliceBetween('async function saveSelectedModelsFromModal() {', '\nasync function loadUsageSummaryAndRender(');
  // The PATCH replaces the whole enabled set, so the payload must start from
  // the stored enablement and only apply changes for rows present in the DOM.
  assert.match(saveSource, /modelVariantCatalogState\.enabledVariantIds \|\| \[\]/);
  assert.match(saveSource, /!renderedVariantIds\.has\(variantId\) \|\| checkedVariantSet\.has\(variantId\)/);
});
