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
  assert.deepEqual(Object.keys(modes).sort(), ['claude', 'cursor', 'github', 'grok', 'openai']);
  for (const [provider, list] of Object.entries(modes)) {
    assert.ok(list.includes('agent'), `${provider} must offer agent`);
    for (const mode of list) {
      assert.ok(['agent', 'ask', 'plan', 'autopilot'].includes(mode), `${provider} mode ${mode} must be relay vocabulary`);
    }
  }
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
