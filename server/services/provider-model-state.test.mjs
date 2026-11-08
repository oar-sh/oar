import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySelection,
  createProviderModelStateStore,
  decideNewCopilotVariant,
  markSeen,
  migrateCopilotModelState,
  migrateFromAllowlist,
  normalizeProviderModelState,
  providerModelStateKey,
  reconcileDiscovered,
  resolveEnabled,
} from './provider-model-state.mjs';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const LATER = new Date('2026-11-02T10:00:00.000Z');

function createSettings(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, String(value)); },
  };
}

// What a picker showed before 0.9.24: the default, then the allowlist when
// one of its ids was still offered, else everything.
function legacyVisible({ allowlist, available, defaultModel }) {
  const offered = allowlist.filter((id) => available.includes(id));
  return [...new Set([defaultModel, ...(offered.length ? offered : available)])];
}

test('providerModelStateKey names Copilot and Claude API after their settings', () => {
  assert.equal(providerModelStateKey('cursor'), 'cursor_model_state');
  assert.equal(providerModelStateKey('claude-api'), 'claude_api_model_state');
  assert.equal(providerModelStateKey('github'), 'copilot_model_state');
});

test('migration keeps exactly what the pickers showed', async (t) => {
  const available = ['model-a', 'model-b', 'model-c'];
  const cases = [
    { name: 'no allowlist', allowlist: [] },
    { name: 'partial allowlist', allowlist: ['model-b', 'gone-model'] },
    { name: 'fully stale allowlist', allowlist: ['gone-model', 'other-gone'] },
  ];
  for (const { name, allowlist } of cases) {
    await t.test(name, () => {
      const state = migrateFromAllowlist({ allowlist, available, now: NOW });
      const before = legacyVisible({ allowlist, available, defaultModel: 'model-a' });
      const after = resolveEnabled(state, available, 'model-a');
      assert.deepEqual(after.models, before);
      assert.equal(after.fallback, false);
      assert.deepEqual(after.unseen, []);
      assert.equal(state.autoEnableNew, true);
    });
  }
});

test('migration keeps stale allowlist ids on and the rest of the list off', () => {
  const state = migrateFromAllowlist({ allowlist: ['model-b', 'gone-model'], available: ['model-a', 'model-b', 'model-c'], now: NOW });
  assert.equal(state.models['model-a'].on, false);
  assert.equal(state.models['model-b'].on, true);
  assert.equal(state.models['model-c'].on, false);
  assert.equal(state.models['gone-model'].on, true);
  assert.equal(state.models['gone-model'].lastSeen, null);
});

test('a fully stale allowlist is dropped: no warning after the upgrade', () => {
  const state = migrateFromAllowlist({ allowlist: ['gone-model'], available: ['model-a'], now: NOW });
  assert.deepEqual(Object.keys(state.models), ['model-a']);
  assert.deepEqual(resolveEnabled(state, ['model-a'], 'model-a'), { models: ['model-a'], fallback: false, unseen: [], autoEnableNew: true });
});

test('a new id follows the switch and is flagged unseen', async (t) => {
  await t.test('switch on', () => {
    const state = migrateFromAllowlist({ allowlist: ['model-a'], available: ['model-a', 'model-b'], now: NOW });
    const { state: next, added, changed } = reconcileDiscovered(state, ['model-a', 'model-b', 'model-new'], { now: LATER });
    assert.deepEqual(added, [{ id: 'model-new', on: true }]);
    assert.equal(changed, true);
    assert.equal(next.models['model-new'].unseen, true);
    assert.equal(next.models['model-new'].firstSeen, LATER.toISOString());
    const resolved = resolveEnabled(next, ['model-a', 'model-b', 'model-new'], 'model-a');
    assert.deepEqual(resolved.models, ['model-a', 'model-new']);
    assert.deepEqual(resolved.unseen, ['model-new']);
  });
  await t.test('switch off', () => {
    const state = { ...migrateFromAllowlist({ available: ['model-a'], now: NOW }), autoEnableNew: false };
    const { state: next, added } = reconcileDiscovered(state, ['model-a', 'model-new'], { now: LATER });
    assert.deepEqual(added, [{ id: 'model-new', on: false }]);
    const resolved = resolveEnabled(next, ['model-a', 'model-new'], 'model-a');
    assert.deepEqual(resolved.models, ['model-a']);
    assert.deepEqual(resolved.unseen, ['model-new']);
  });
});

test('a known id only has its lastSeen moved and changes nothing visible', () => {
  const state = migrateFromAllowlist({ available: ['model-a'], now: NOW });
  const { state: next, added, changed } = reconcileDiscovered(state, ['model-a'], { now: LATER });
  assert.deepEqual(added, []);
  assert.equal(changed, false);
  assert.equal(next.models['model-a'].lastSeen, LATER.toISOString());
  assert.equal(next.models['model-a'].firstSeen, NOW.toISOString());
});

test('a model turned off stays off when it vanishes and comes back', () => {
  let state = migrateFromAllowlist({ available: ['model-a', 'model-b', 'model-c'], now: NOW });
  state = applySelection(state, ['model-a', 'model-c'], ['model-a', 'model-b', 'model-c'], { defaultModel: 'model-a', now: NOW });
  assert.equal(state.models['model-b'].on, false);
  // model-b leaves the list; a save from the modal (which no longer shows it)
  // must not touch it.
  state = applySelection(state, ['model-a', 'model-c'], ['model-a', 'model-c'], { defaultModel: 'model-a', now: NOW });
  assert.equal(state.models['model-b'].on, false);
  const back = reconcileDiscovered(state, ['model-a', 'model-b', 'model-c'], { now: LATER });
  assert.deepEqual(back.added, []);
  assert.deepEqual(resolveEnabled(back.state, ['model-a', 'model-b', 'model-c'], 'model-a').models, ['model-a', 'model-c']);
});

test('unticking everything leaves only the default model, never all', () => {
  let state = migrateFromAllowlist({ available: ['model-a', 'model-b', 'model-c'], now: NOW });
  state = applySelection(state, [], ['model-a', 'model-b', 'model-c'], { defaultModel: 'model-b', now: NOW });
  assert.equal(state.models['model-b'].on, true);
  const resolved = resolveEnabled(state, ['model-a', 'model-b', 'model-c'], 'model-b');
  assert.deepEqual(resolved.models, ['model-b']);
  // Unticked on purpose, nothing vanished: no warning.
  assert.equal(resolved.fallback, false);
});

test('when every enabled model vanishes the default stands in with a warning', () => {
  let state = migrateFromAllowlist({ available: ['model-a', 'model-b', 'model-c'], now: NOW });
  state = applySelection(state, ['model-b', 'model-c'], ['model-a', 'model-b', 'model-c'], { defaultModel: 'model-a', now: NOW });
  const resolved = resolveEnabled(state, ['model-a', 'model-d'], 'model-a');
  assert.deepEqual(resolved.models, ['model-a', 'model-d']);
  assert.equal(resolved.fallback, false, 'model-d is new and follows the switch');
  const switchedOff = resolveEnabled({ ...state, autoEnableNew: false }, ['model-a', 'model-d'], 'model-a');
  assert.deepEqual(switchedOff.models, ['model-a']);
  assert.equal(switchedOff.fallback, true);
});

test('ids match case-insensitively and keep the casing first seen', () => {
  let state = migrateFromAllowlist({ allowlist: ['Model-B'], available: ['model-a', 'model-b'], now: NOW });
  assert.deepEqual(Object.keys(state.models), ['model-a', 'model-b']);
  const { added } = reconcileDiscovered(state, ['MODEL-A', 'Model-B'], { now: LATER });
  assert.deepEqual(added, []);
  state = applySelection(state, ['MODEL-A'], ['MODEL-A', 'MODEL-B'], { defaultModel: 'model-a', now: NOW });
  assert.deepEqual(Object.keys(state.models), ['model-a', 'model-b']);
  assert.equal(state.models['model-b'].on, false);
  assert.deepEqual(resolveEnabled(state, ['Model-A', 'Model-B'], 'Model-A').models, ['Model-A']);
});

test('markSeen clears every New flag once', () => {
  const { state } = reconcileDiscovered(migrateFromAllowlist({ available: ['model-a'], now: NOW }), ['model-a', 'model-new'], { now: LATER });
  const first = markSeen(state);
  assert.equal(first.changed, true);
  assert.equal(first.state.models['model-new'].unseen, false);
  assert.equal(markSeen(first.state).changed, false);
});

test('applySelection sets the switch only when told', () => {
  const state = migrateFromAllowlist({ available: ['model-a'], now: NOW });
  assert.equal(applySelection(state, ['model-a'], ['model-a'], { autoEnableNew: false }).autoEnableNew, false);
  assert.equal(applySelection({ ...state, autoEnableNew: false }, ['model-a'], ['model-a']).autoEnableNew, false);
});

test('normalizeProviderModelState refuses what it cannot read', () => {
  assert.equal(normalizeProviderModelState('not json'), null);
  assert.equal(normalizeProviderModelState('[]'), null);
  assert.equal(normalizeProviderModelState('{}').autoEnableNew, true);
});

test('the store migrates once from the old allowlist and leaves that key alone', () => {
  const settings = createSettings({ cursor_enabled_models: JSON.stringify(['model-b']) });
  const store = createProviderModelStateStore({ ...settings, now: () => NOW });
  const legacy = () => JSON.parse(settings.readSetting('cursor_enabled_models'));
  const first = store.resolve('cursor', { availableModels: ['model-a', 'model-b', 'model-c'], defaultModel: 'model-a', legacyAllowlist: legacy });
  assert.deepEqual(first.models, ['model-a', 'model-b']);
  assert.ok(settings.values.has('cursor_model_state'));
  assert.equal(settings.values.get('cursor_enabled_models'), JSON.stringify(['model-b']));
  // Later the old key is not read.
  settings.values.set('cursor_enabled_models', JSON.stringify(['model-c']));
  const second = store.resolve('cursor', { availableModels: ['model-a', 'model-b', 'model-c'], defaultModel: 'model-a', legacyAllowlist: legacy });
  assert.deepEqual(second.models, ['model-a', 'model-b']);
});

test('the store selects, reconciles and marks seen', () => {
  const settings = createSettings();
  const store = createProviderModelStateStore({ ...settings, now: () => NOW });
  store.select('grok', { enabledModels: [], shownModels: ['model-a', 'model-b'], defaultModel: 'model-a', autoEnableNew: false });
  assert.deepEqual(store.resolve('grok', { availableModels: ['model-a', 'model-b'], defaultModel: 'model-a' }).models, ['model-a']);
  const { added, changed } = store.reconcile('grok', { availableModels: ['model-a', 'model-b', 'model-new'] });
  assert.deepEqual(added, [{ id: 'model-new', on: false }]);
  assert.equal(changed, true);
  assert.equal(store.markSeen('grok'), true);
  assert.equal(store.markSeen('grok'), false);
  // A save that only flips the switch leaves the models as they are, even
  // when it names the selection as undefined.
  store.select('grok', { enabledModels: ['model-new'], shownModels: ['model-a', 'model-b', 'model-new'], defaultModel: 'model-a' });
  store.select('grok', { enabledModels: undefined, shownModels: ['model-a', 'model-b', 'model-new'], defaultModel: 'model-a', autoEnableNew: true });
  const state = store.read('grok');
  assert.equal(state.autoEnableNew, true);
  assert.equal(state.models['model-b'].on, false);
  assert.equal(state.models['model-new'].on, true);
});

test('Copilot: the upgrade knows every model and keeps disabled rows off', () => {
  const state = migrateCopilotModelState([
    { variantId: 'gpt-x-low', baseModelId: 'gpt-x', enabled: true },
    { variantId: 'gpt-x-high', baseModelId: 'gpt-x', enabled: false },
    { variantId: 'gpt-y', baseModelId: 'gpt-y', enabled: false },
  ]);
  assert.deepEqual(state.knownModels, ['gpt-x', 'gpt-y']);
  assert.deepEqual(state.disabledVariants, ['gpt-x-high', 'gpt-y']);
  assert.equal(state.autoEnableNew, true);
});

test('Copilot: new effort rows follow the model, new models follow the switch', () => {
  const state = { autoEnableNew: true, knownModels: ['gpt-x', 'gpt-y'], disabledVariants: ['gpt-x-high'], unseen: [] };
  assert.deepEqual(decideNewCopilotVariant(state, { variantId: 'gpt-x-high', baseModelId: 'gpt-x' }, { siblingEnabled: true }), { enabled: false, newModel: false });
  assert.deepEqual(decideNewCopilotVariant(state, { variantId: 'gpt-x-max', baseModelId: 'gpt-x' }, { siblingEnabled: true }), { enabled: true, newModel: false });
  assert.deepEqual(decideNewCopilotVariant(state, { variantId: 'gpt-y-max', baseModelId: 'gpt-y' }, { siblingEnabled: false }), { enabled: false, newModel: false });
  assert.deepEqual(decideNewCopilotVariant(state, { variantId: 'gpt-z-low', baseModelId: 'gpt-z' }), { enabled: true, newModel: true });
  assert.deepEqual(decideNewCopilotVariant({ ...state, autoEnableNew: false }, { variantId: 'gpt-z-low', baseModelId: 'gpt-z' }), { enabled: false, newModel: true });
});

test('a save changes only the models it showed: one a refresh added after the modal was drawn stays on', () => {
  const settings = createSettings();
  const store = createProviderModelStateStore({ ...settings, now: () => NOW });
  // The modal is drawn with model-a and model-b; then a refresh finds model-new (switch on).
  store.ensure('cursor', { availableModels: ['model-a', 'model-b'] });
  store.reconcile('cursor', { availableModels: ['model-a', 'model-b', 'model-new'] });
  // Save from the modal that never showed model-new: model-b unticked.
  store.select('cursor', { enabledModels: ['model-a'], shownModels: ['model-a', 'model-b'], defaultModel: 'model-a' });
  const resolved = store.resolve('cursor', { availableModels: ['model-a', 'model-b', 'model-new'], defaultModel: 'model-a' });
  assert.deepEqual(resolved.models, ['model-a', 'model-new']);
});

test('a save right after models_updated, before the modal re-rendered, leaves the new model alone', () => {
  let state = migrateFromAllowlist({ available: ['model-a', 'model-b'], now: NOW });
  state = { ...state, autoEnableNew: false };
  // models_updated: model-new arrived (off, the switch is off); the page has not re-rendered.
  state = reconcileDiscovered(state, ['model-a', 'model-b', 'model-new'], { now: LATER }).state;
  // The user had ticked model-new on another device meanwhile.
  state = applySelection(state, ['model-a', 'model-new'], ['model-a', 'model-b', 'model-new'], { defaultModel: 'model-a', now: LATER });
  // This page saves what it drew: model-a and model-b, both on.
  state = applySelection(state, ['model-a', 'model-b'], ['model-a', 'model-b'], { defaultModel: 'model-a', now: LATER });
  assert.deepEqual(resolveEnabled(state, ['model-a', 'model-b', 'model-new'], 'model-a').models, ['model-a', 'model-b', 'model-new']);
});

test('no warning after unticking everything when the old allowlist had a stale id', () => {
  let state = migrateFromAllowlist({ allowlist: ['model-a', 'old-model'], available: ['model-default', 'model-a', 'model-b'], now: NOW });
  assert.equal(state.models['old-model'].on, true);
  state = applySelection(state, [], ['model-default', 'model-a', 'model-b'], { defaultModel: 'model-default', now: LATER });
  const resolved = resolveEnabled(state, ['model-default', 'model-a', 'model-b'], 'model-default');
  assert.deepEqual(resolved.models, ['model-default']);
  assert.equal(resolved.fallback, false);
});

test('a model that was on and then leaves the list still warns, before or after a save', () => {
  // Without any save (the map as an upgrade or a 0.9.24 build wrote it).
  const migrated = migrateFromAllowlist({ allowlist: ['model-a'], available: ['model-default', 'model-a', 'model-b'], now: NOW });
  assert.equal(resolveEnabled({ ...migrated, autoEnableNew: false }, ['model-default', 'model-b'], 'model-default').fallback, true);
  // After a save that showed it on.
  const saved = applySelection(migrated, ['model-a'], ['model-default', 'model-a', 'model-b'], { defaultModel: 'model-default', now: LATER });
  assert.equal(saved.selectedAt, LATER.toISOString());
  assert.equal(resolveEnabled({ ...saved, autoEnableNew: false }, ['model-default', 'model-b'], 'model-default').fallback, true);
  // A map from before selectedAt: read as having none.
  const legacy = JSON.parse(JSON.stringify(saved));
  delete legacy.selectedAt;
  assert.equal(normalizeProviderModelState(legacy).selectedAt, null);
  assert.equal(resolveEnabled({ ...legacy, autoEnableNew: false }, ['model-default', 'model-b'], 'model-default').fallback, true);
});

test('a save of the switch alone stamps nothing', () => {
  const state = migrateFromAllowlist({ available: ['model-a'], now: NOW });
  assert.equal(applySelection(state, [], [], { autoEnableNew: false, now: LATER }).selectedAt, null);
});
