import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  MODEL_REFRESH_INTERVAL_CHOICES,
  applyUnsavedModelTicks,
  buildNewModelsToastText,
  buildOpenAIModelRows,
  collectUnsavedModelTicks,
  formatModelRefreshIntervalLabel,
  formatModelRefreshLastChecked,
  isUnseenModelRow,
  mergeUnseenByTab,
  modelCheckboxSelection,
  modelRefreshBlockFields,
  modelRowSdkModelId,
  modelSelectionSignature,
  modelTabAutoEnableNew,
  modelTabFallbackModel,
  newModelsToastFor,
  newModelsToastTab,
  nextModelRefreshExcluded,
  normalizeCopilotModelState,
  normalizeModelRefreshSettings,
  renderModelAutoEnableRowHtml,
  renderModelFallbackWarningHtml,
  renderModelVariantCheckboxHtml,
  renderNewModelChipHtml,
} from './model-refresh-ui.mjs';

// New models in the browser: the Select Models switch row, "New" tags and
// fallback line, the toast of a refresh that found models, and the texts of
// Settings › General › Models. The model ids are invented.

const fragment = (html) => JSDOM.fragment(html);

// A slice of GET /api/model-variants after applyModelVariantCatalogState.
const CATALOG = {
  copilotModelState: normalizeCopilotModelState({ autoEnableNew: false, unseen: ['GPT-9-Nova'] }),
  cursorModels: {
    defaultModel: 'composer-3',
    availableModels: ['composer-3', 'cursor-fable-2'],
    enabledModels: ['composer-3'],
    ...modelRefreshBlockFields({ autoEnableNew: true, unseen: ['Cursor-Fable-2'], fallback: true }),
  },
  openaiModels: {
    defaultModel: 'gpt-9-mini',
    availableModels: ['gpt-9-mini', 'gpt-9-pro'],
    enabledModels: ['gpt-9-mini'],
    ...modelRefreshBlockFields({ autoEnableNew: true, unseen: ['gpt-9-pro'], fallback: false }),
  },
  // From a relay before the switch: no fields.
  grokModels: { defaultModel: 'grok-9', availableModels: ['grok-9'], enabledModels: [], ...modelRefreshBlockFields({}) },
};

test('a provider block\'s new-model fields are read defensively', () => {
  assert.deepEqual(modelRefreshBlockFields({ autoEnableNew: false, unseen: [' a ', '', null, 'b'], fallback: 'yes' }), {
    autoEnableNew: false,
    unseen: ['a', 'b'],
    fallback: false,
  });
  assert.deepEqual(modelRefreshBlockFields(null), { autoEnableNew: null, unseen: [], fallback: false });
  assert.equal(normalizeCopilotModelState(null), null);
  assert.deepEqual(normalizeCopilotModelState({ unseen: 'x' }), { autoEnableNew: null, unseen: [] });
});

test('each tab reads its own switch and fallback; a block without them has none', () => {
  assert.equal(modelTabAutoEnableNew(CATALOG, 'copilot'), false);
  assert.equal(modelTabAutoEnableNew(CATALOG, 'cursor'), true);
  assert.equal(modelTabAutoEnableNew(CATALOG, 'openai'), true);
  assert.equal(modelTabAutoEnableNew(CATALOG, 'grok'), null);
  assert.equal(modelTabAutoEnableNew(CATALOG, 'deepseek'), null, 'a provider that is off has no block');
  assert.equal(modelTabFallbackModel(CATALOG, 'cursor'), 'composer-3');
  assert.equal(modelTabFallbackModel(CATALOG, 'openai'), '');
  assert.equal(modelTabFallbackModel(CATALOG, 'copilot'), '');
});

test('the switch row carries its tab and state, and says what it does', () => {
  const on = fragment(renderModelAutoEnableRowHtml('cursor', true));
  const input = on.querySelector('input.model-auto-enable-toggle');
  assert.equal(input.type, 'checkbox');
  assert.equal(input.getAttribute('data-auto-enable-tab'), 'cursor');
  assert.equal(input.checked, true);
  assert.equal(input.classList.contains('model-variant-checkbox'), false, 'never counted as a model row by Save');
  assert.match(on.textContent, /Turn new models on automatically/);
  assert.match(on.textContent, /a Cursor model found from now on starts on/);
  const off = fragment(renderModelAutoEnableRowHtml('anthropic', false));
  assert.equal(off.querySelector('input').checked, false);
  assert.match(off.textContent, /a Claude model/);
});

test('the fallback line names the default model, escaped; none without one', () => {
  const html = renderModelFallbackWarningHtml('composer-<3>');
  assert.match(html, /composer-&lt;3&gt;/);
  assert.match(fragment(html).textContent, /None of the models you turned on are offered any more; composer-<3> is used until you pick others\./);
  assert.equal(renderModelFallbackWarningHtml(''), '');
});

test('"New" tags the unseen rows, by base model and case-insensitively', () => {
  const held = mergeUnseenByTab(new Map(), CATALOG);
  const copilot = held.get('copilot');
  assert.equal(isUnseenModelRow({ variantId: 'gpt-9-nova', baseModelId: 'gpt-9-nova' }, copilot), true);
  assert.equal(isUnseenModelRow({ variantId: 'gpt-9-nova--effort-high', baseModelId: 'gpt-9-nova' }, copilot), true, 'every reasoning row of a new model');
  assert.equal(isUnseenModelRow({ variantId: 'gpt-8', baseModelId: 'gpt-8' }, copilot), false);
  assert.equal(isUnseenModelRow({ baseModelId: 'cursor-fable-2' }, held.get('cursor')), true);
  assert.equal(isUnseenModelRow({ baseModelId: 'gpt-9-pro' }, held.get('openai')), true);
  assert.equal(held.has('grok'), false);
  assert.equal(isUnseenModelRow({ baseModelId: 'grok-9' }, undefined), false);
  assert.match(fragment(renderNewModelChipHtml()).textContent, /^\s*New$/);
});

test('tags already shown stay while the modal is open, after the relay marked them seen', () => {
  const held = mergeUnseenByTab(new Map(), CATALOG);
  const seen = { ...CATALOG, copilotModelState: { autoEnableNew: false, unseen: [] }, cursorModels: { ...CATALOG.cursorModels, unseen: [] } };
  const after = mergeUnseenByTab(held, seen);
  assert.deepEqual([...after.get('copilot')], ['gpt-9-nova']);
  assert.deepEqual([...after.get('cursor')], ['cursor-fable-2']);
  // And a model found meanwhile joins them, without touching the input.
  const found = mergeUnseenByTab(after, { ...seen, cursorModels: { ...seen.cursorModels, unseen: ['composer-4'] } });
  assert.deepEqual([...found.get('cursor')].sort(), ['composer-4', 'cursor-fable-2']);
  assert.deepEqual([...after.get('cursor')], ['cursor-fable-2']);
});

test('the toast counts each provider\'s new models and says whether they start on', () => {
  assert.equal(buildNewModelsToastText([{ provider: 'cursor', tab: 'cursor', label: 'Cursor', ids: ['a', 'b'], on: true }]), '2 new Cursor models (on)');
  assert.equal(buildNewModelsToastText([{ provider: 'github', tab: 'copilot', label: 'Copilot', ids: ['a'], on: false }]), '1 new Copilot model (off)');
  const several = [
    { provider: 'claude', ids: ['a'], on: true },
    { provider: 'grok', tab: 'grok', label: 'Grok', ids: [], on: true },
    { provider: 'openai', tab: 'openai', label: 'OpenAI', ids: ['x', 'y', 'z'], on: false },
  ];
  assert.equal(buildNewModelsToastText(several), '1 new Claude model (on), 3 new OpenAI models (off)');
  assert.equal(newModelsToastTab(several), 'anthropic', 'Show opens the first provider\'s tab');
  assert.equal(newModelsToastTab([{ provider: 'github', ids: ['a'] }]), 'copilot');
  for (const none of [undefined, null, [], [{ provider: 'cursor', ids: [] }], 'cursor']) {
    assert.equal(buildNewModelsToastText(none), '', JSON.stringify(none));
  }
});

test('interval labels and the last-check line', () => {
  assert.deepEqual(MODEL_REFRESH_INTERVAL_CHOICES.map(formatModelRefreshIntervalLabel), [
    'Every 6 h', 'Every 12 h', 'Every 24 h', 'Every 3 days', 'Every 7 days',
  ]);
  const now = Date.parse('2026-03-01T12:00:00Z');
  assert.equal(formatModelRefreshLastChecked(null, now), 'Not checked yet');
  assert.equal(formatModelRefreshLastChecked({ at: null, ok: false }, now), 'Not checked yet');
  assert.equal(formatModelRefreshLastChecked({ at: '2026-03-01T09:00:00Z', ok: true }, now), 'Last checked 3 h ago');
  assert.equal(formatModelRefreshLastChecked({ at: '2026-03-01T11:59:40Z', ok: true }, now), 'Last checked just now');
  assert.equal(
    formatModelRefreshLastChecked({ at: '2026-02-26T12:00:00Z', ok: false, error: 'HTTP 401\n  key refused' }, now),
    'Last check failed 3 d ago: HTTP 401 key refused',
  );
  const long = formatModelRefreshLastChecked({ at: '2026-03-01T11:30:00Z', ok: false, error: 'x'.repeat(400) }, now);
  assert.ok(long.length < 200 && long.endsWith('…'), long);
});

test('the settings answer is read with the relay\'s defaults for a missing field', () => {
  assert.deepEqual(normalizeModelRefreshSettings(null), {
    auto: true,
    intervalHours: 24,
    intervalChoices: [6, 12, 24, 72, 168],
    excluded: [],
    providers: [],
  });
  const read = normalizeModelRefreshSettings({
    auto: false,
    intervalHours: 72,
    intervalChoices: [12, 72],
    excluded: ['grok'],
    providers: [{ id: 'cursor', label: 'Cursor', last: { at: '2026-03-01T09:00:00Z', ok: true } }, { id: '' }, { id: 'grok' }],
  });
  assert.equal(read.auto, false);
  assert.equal(read.intervalHours, 72);
  assert.deepEqual(read.intervalChoices, [12, 72]);
  assert.deepEqual(read.providers.map((provider) => [provider.id, provider.label, !!provider.last]), [['cursor', 'Cursor', true], ['grok', 'grok', false]]);
});

test('a provider\'s checkbox adds it to or takes it out of the excluded list', () => {
  assert.deepEqual(nextModelRefreshExcluded(['grok'], 'cursor', false), ['grok', 'cursor']);
  assert.deepEqual(nextModelRefreshExcluded(['grok', 'cursor'], 'cursor', true), ['grok']);
  assert.deepEqual(nextModelRefreshExcluded(['cursor'], 'cursor', false), ['cursor'], 'never twice');
});

test('the settings answer marks a provider not set up only when it says so', () => {
  const read = normalizeModelRefreshSettings({ providers: [{ id: 'cursor', setUp: false }, { id: 'grok', setUp: true }, { id: 'deepseek' }] });
  assert.deepEqual(read.providers.map((provider) => [provider.id, provider.setUp]), [['cursor', false], ['grok', true], ['deepseek', true]]);
});

// A checkbox as Select Models renders it, for the helpers that read the DOM.
function box(attributes = {}, { checked = false, defaultChecked = checked, disabled = false } = {}) {
  return { checked, defaultChecked, disabled, getAttribute: (name) => attributes[name] ?? null };
}

test('a save reads the ticked and the shown ids of the rendered rows only', () => {
  const inputs = [
    box({ 'data-cursor-model': 'composer-3' }, { checked: true, disabled: true }), // the locked default model
    box({ 'data-cursor-model': 'cursor-fable-2' }, { checked: false }),
    box({ 'data-cursor-model': ' cursor-nova ' }, { checked: true }),
    box({ 'data-cursor-model': '' }, { checked: true }),
  ];
  // A models_updated already put a newer model in the state; it is not rendered.
  const state = { ...CATALOG.cursorModels, availableModels: [...CATALOG.cursorModels.availableModels, 'cursor-nova', 'composer-4'] };
  const selection = modelCheckboxSelection(inputs, 'data-cursor-model');
  assert.deepEqual(selection, { enabled: ['composer-3', 'cursor-nova'], shown: ['composer-3', 'cursor-fable-2', 'cursor-nova'] });
  assert.ok(state.availableModels.includes('composer-4'));
  assert.equal(selection.shown.includes('composer-4'), false, 'a model not rendered is never sent as shown');
  // Plain { checked, value } objects work without an attribute.
  assert.deepEqual(modelCheckboxSelection([{ checked: false, value: 'gpt-9' }, { checked: true, value: 'gpt-9-pro' }, { checked: true, value: 'gpt-9' }]), {
    enabled: ['gpt-9-pro'],
    shown: ['gpt-9', 'gpt-9-pro'],
  });
  assert.deepEqual(modelCheckboxSelection(null), { enabled: [], shown: [] });
});

test('the selection signature changes with what the modal shows, and only with that', () => {
  const state = {
    variants: [{ variantId: 'gpt-9', label: 'GPT 9' }, { variantId: 'gpt-9--effort-high', label: 'GPT 9' }],
    enabledVariantIds: ['gpt-9'],
    refreshedAt: '2026-03-01T09:00:00Z',
    ...CATALOG,
  };
  const signature = modelSelectionSignature(state);
  assert.equal(modelSelectionSignature({ ...state, refreshedAt: '2026-03-01T10:00:00Z', warning: 'slow' }), signature, 'a later refresh time alone');
  assert.equal(modelSelectionSignature(structuredClone(state)), signature);
  const changed = [
    { ...state, enabledVariantIds: ['gpt-9', 'gpt-9--effort-high'] },
    { ...state, variants: [...state.variants, { variantId: 'gpt-10' }] },
    { ...state, copilotModelState: { autoEnableNew: true, unseen: ['gpt-9-nova'] } },
    { ...state, copilotModelState: { autoEnableNew: false, unseen: [] } },
    { ...state, cursorModels: { ...state.cursorModels, availableModels: [...state.cursorModels.availableModels, 'composer-4'] } },
    { ...state, cursorModels: { ...state.cursorModels, enabledModels: ['composer-3', 'cursor-fable-2'] } },
    { ...state, cursorModels: { ...state.cursorModels, autoEnableNew: false } },
    { ...state, cursorModels: { ...state.cursorModels, unseen: [] } },
    { ...state, cursorModels: { ...state.cursorModels, fallback: false } },
    { ...state, openaiModels: null },
    { ...state, deepseekModels: { defaultModel: 'deepseek-9', availableModels: ['deepseek-9'], enabledModels: [] } },
  ];
  for (const next of changed) assert.notEqual(modelSelectionSignature(next), signature, JSON.stringify(next).slice(0, 80));
  assert.equal(typeof modelSelectionSignature(null), 'string');
});

test('unsaved ticks are carried across a re-render onto the same rows and switch', () => {
  const before = [
    box({ 'data-variant-id': 'gpt-9' }, { checked: false, defaultChecked: true }), // unticked, not saved
    box({ 'data-variant-id': 'gpt-9--effort-high' }, { checked: true, defaultChecked: false }), // ticked, not saved
    box({ 'data-variant-id': 'gpt-8' }, { checked: true }), // as rendered
    box({ 'data-variant-id': 'composer-3--provider-cursor' }, { checked: true, disabled: true }),
    box({ 'data-auto-enable-tab': 'copilot' }, { checked: false, defaultChecked: true }),
    box({ 'data-variant-id': 'gpt-7' }, { checked: true, defaultChecked: false }), // gone after the re-render
  ];
  const ticks = collectUnsavedModelTicks(before);
  assert.deepEqual([...ticks], [['variant:gpt-9', false], ['variant:gpt-9--effort-high', true], ['auto:copilot', false], ['variant:gpt-7', true]]);

  // The re-render: rows from the relay's state, plus a model found meanwhile.
  const after = [
    box({ 'data-variant-id': 'gpt-9' }, { checked: true }),
    box({ 'data-variant-id': 'gpt-9--effort-high' }, { checked: false }),
    box({ 'data-variant-id': 'gpt-8' }, { checked: false }), // turned off on the other device
    box({ 'data-variant-id': 'gpt-10' }, { checked: true }),
    box({ 'data-auto-enable-tab': 'copilot' }, { checked: true }),
  ];
  assert.equal(applyUnsavedModelTicks(after, ticks), 3);
  assert.deepEqual(after.map((input) => input.checked), [false, true, false, true, false]);
  // Still unsaved after the carry-over: a second update carries them again.
  assert.equal(collectUnsavedModelTicks(after).size, 3);
  assert.equal(applyUnsavedModelTicks(after, new Map()), 0);
  // A row locked by the re-render takes none.
  const locked = [box({ 'data-variant-id': 'gpt-9' }, { checked: true, disabled: true })];
  assert.equal(applyUnsavedModelTicks(locked, ticks), 0);
  assert.equal(locked[0].checked, true);
});

test('the OpenAI tab lists its models as checkboxes, the default model locked on', () => {
  const rows = buildOpenAIModelRows(
    { defaultModel: 'gpt-9-mini', availableModels: ['gpt-9-mini', 'gpt-9-pro', 'gpt-9-nano'], enabledModels: ['gpt-9-pro'] },
    (id) => id.toUpperCase(),
  );
  assert.deepEqual(rows.map((row) => [row.openaiModelId, row.label, row.selectable, row.enabled, row.provider]), [
    ['gpt-9-mini', 'GPT-9-MINI', false, true, 'openai-byok'],
    ['gpt-9-pro', 'GPT-9-PRO', true, true, 'openai-byok'],
    ['gpt-9-nano', 'GPT-9-NANO', true, false, 'openai-byok'],
  ]);
  const inputs = [...fragment(rows.map((row) => renderModelVariantCheckboxHtml(row, new Set())).join('')).querySelectorAll('input')];
  assert.deepEqual(inputs.map((input) => [input.getAttribute('data-openai-model'), input.checked, input.disabled]), [
    ['gpt-9-mini', true, true],
    ['gpt-9-pro', true, false],
    ['gpt-9-nano', false, false],
  ]);
  assert.ok(inputs.every((input) => input.classList.contains('model-variant-checkbox') && input.type === 'checkbox'));
  assert.deepEqual(inputs.map((input) => input.getAttribute('data-selectable')), ['0', '1', '1']);
  // And Save reads them back with the default model among the shown.
  assert.deepEqual(modelCheckboxSelection(inputs, 'data-openai-model'), {
    enabled: ['gpt-9-mini', 'gpt-9-pro'],
    shown: ['gpt-9-mini', 'gpt-9-pro', 'gpt-9-nano'],
  });
  assert.deepEqual(buildOpenAIModelRows(null), []);
});

test('a Copilot row reads the selection; a provider row its own flag and attribute', () => {
  const copilot = fragment(renderModelVariantCheckboxHtml({ variantId: 'gpt-9', baseModelId: 'gpt-9' }, new Set(['gpt-9']))).querySelector('input');
  assert.equal(copilot.checked, true);
  assert.equal(copilot.getAttribute('data-variant-id'), 'gpt-9');
  assert.equal(modelRowSdkModelId({ variantId: 'gpt-9' }), '');
  const managed = fragment(renderModelVariantCheckboxHtml({ variantId: 'gpt-9', selectable: false }, new Set(['gpt-9']))).querySelector('input');
  assert.equal(managed.checked, false, 'a row managed in settings is never ticked');
  assert.equal(managed.disabled, true);
  const cursor = { variantId: 'composer-3--provider-cursor', cursorModelId: 'composer-"3"', enabled: true };
  const input = fragment(renderModelVariantCheckboxHtml(cursor, new Set())).querySelector('input');
  assert.equal(input.getAttribute('data-cursor-model'), 'composer-"3"', 'escaped in the attribute');
  assert.equal(input.checked, true);
  assert.equal(modelRowSdkModelId(cursor), 'composer-"3"');
});

test('one toast per models_updated that found models; none without, or on a shared view', () => {
  const payload = { unseenNewModelCount: 2, newModels: [{ provider: 'cursor', tab: 'cursor', label: 'Cursor', ids: ['a', 'b'], on: true }] };
  assert.deepEqual(newModelsToastFor(payload), { text: '2 new Cursor models (on)', tab: 'cursor' });
  assert.equal(newModelsToastFor(payload, { sharedView: true }), null);
  for (const none of [undefined, null, {}, { unseenNewModelCount: 3 }, { newModels: [] }, { newModels: [{ provider: 'grok', ids: [] }] }]) {
    assert.equal(newModelsToastFor(none), null, JSON.stringify(none));
  }
  // The socket handler shows what each event answers: two events, two toasts.
  const toasts = [];
  const onModelsUpdated = (event) => {
    const toast = newModelsToastFor(event, { sharedView: false });
    if (toast) toasts.push(toast.text);
  };
  onModelsUpdated(payload);
  onModelsUpdated({ newModels: [] });
  onModelsUpdated({ unseenNewModelCount: 0 });
  onModelsUpdated({ newModels: [{ provider: 'github', ids: ['gpt-9-nova'], on: false }] });
  assert.deepEqual(toasts, ['2 new Cursor models (on)', '1 new Copilot model (off)']);
});

// The modal itself lives in bootstrap.js, which cannot load outside the page:
// its wiring is checked in the source.
const bootstrapSource = await readFile(fileURLToPath(new URL('./bootstrap.js', import.meta.url)), 'utf8');

test('Select Models builds the OpenAI rows and checkboxes with the tested helpers', () => {
  assert.match(bootstrapSource, /grouped\.set\('openai-byok', buildOpenAIModelRows\(openaiCatalog, humanizeModelLabel\)\);/);
  assert.match(bootstrapSource, /\$\{renderModelVariantCheckboxHtml\(row, selected\)\}/);
});

test('Save leaves the OpenAI rows out of Copilot\'s and sends what each tab showed', () => {
  assert.match(bootstrapSource, /:not\(\[data-claude-api-model\]\):not\(\[data-openai-model\]\)'\)\)/);
  // Read from the rendered rows, never the catalog state.
  assert.match(bootstrapSource, /const inputs = Array\.from\(body\.querySelectorAll\(`\.model-variant-checkbox\[\$\{attribute\}\]`\)\);\n\s*return \{ inputs, \.\.\.modelCheckboxSelection\(inputs, attribute\) \};/);
  assert.match(bootstrapSource, /modelCheckboxSelection\(renderedVariantCheckboxes, 'data-variant-id'\)/);
  assert.match(bootstrapSource, /shownVariantIds: hasVariantRows \? shownVariantIds : undefined,/);
  // The OpenAI save names no model: the default model stays.
  assert.match(bootstrapSource, /updateOpenAISettings\(\{\s*enabledModels: openaiSelection\.enabled,\s*shownModels: openaiSelection\.shown,\s*autoEnableNew: autoEnableNewFor\('openai'\),\s*\}\)/);
});

test('Save sends the rendered tab\'s switch, and opening the modal or its Refresh marks the models seen', () => {
  for (const [call, selection, tab] of [
    ['updateClaudeSettings', 'claudeSelection', 'anthropic'],
    ['updateCursorSettings', 'cursorSelection', 'cursor'],
    ['updateGrokSettings', 'grokSelection', 'grok'],
    ['updateDeepSeekSettings', 'deepseekSelection', 'deepseek'],
    ['updateClaudeApiSettings', 'claudeApiSelection', 'claude-api'],
  ]) {
    assert.match(
      bootstrapSource,
      new RegExp(`${call}\\(\\{\\s*enabledModels: ${selection}\\.enabled,\\s*shownModels: ${selection}\\.shown,\\s*autoEnableNew: autoEnableNewFor\\('${tab}'\\)`),
      call,
    );
  }
  assert.match(bootstrapSource, /saveEnabledModelVariants\(hasVariantRows \? selectedVariantIds : null, \{\s*autoEnableNew: copilotAutoEnableNew,/);
  const open = bootstrapSource.slice(bootstrapSource.indexOf('async function openSelectModelsModal('));
  const firstRender = open.indexOf('renderModelVariantCatalogBody();');
  assert.ok(firstRender > 0 && open.indexOf('markSelectModelsSeen();') > firstRender, 'seen after the first render');
  // The in-modal Refresh renders first (the render holds its unseen ids with
  // the tags already shown), then marks them seen.
  const render = bootstrapSource.slice(bootstrapSource.indexOf('function renderModelVariantCatalogBody('));
  const refresh = render.slice(render.indexOf('refresh: async () => {'));
  const handler = refresh.slice(0, refresh.indexOf("kind: 'select-models'"));
  const refreshRender = handler.indexOf('renderModelVariantCatalogBody();');
  assert.ok(refreshRender > 0 && handler.indexOf('markSelectModelsSeen();') > refreshRender, 'seen after the refresh render');
  assert.ok(render.indexOf('mergeUnseenByTab(selectModelsHeldUnseen, modelVariantCatalogState)') < render.indexOf('refresh: async () => {'));
});

test('the models_updated handler takes its toast from newModelsToastFor, once per event', async () => {
  const socketSource = await readFile(fileURLToPath(new URL('./socket-handlers.js', import.meta.url)), 'utf8');
  const handler = socketSource.slice(socketSource.indexOf("socket.on('models_updated'"));
  const body = handler.slice(0, handler.indexOf('\n  });\n'));
  assert.match(body, /const toast = newModelsToastFor\(payload, \{ sharedView: IS_SHARED_VIEW \}\);\n\s*if \(toast\) \{/);
  assert.equal(body.match(/showTransientRelayNotice\(/g)?.length, 1);
});

test('a models_updated re-renders an open modal only when what it shows changed, keeping unsaved ticks', () => {
  const reconcile = bootstrapSource.slice(bootstrapSource.indexOf('async function reconcileOpenModelVariantModal('));
  const body = reconcile.slice(0, reconcile.indexOf('\n}\n'));
  assert.match(body, /if \(modelSelectionSignature\(modelVariantCatalogState\) === selectModelsRenderedSignature\) return;/);
  const render = body.indexOf('renderModelVariantCatalogBody();');
  assert.ok(body.indexOf('collectUnsavedModelTicks(') > 0 && body.indexOf('collectUnsavedModelTicks(') < render);
  assert.ok(body.indexOf('applyUnsavedModelTicks(') > render);
  // The signature of each render is what the next update compares with.
  assert.match(bootstrapSource, /selectModelsRenderedSignature = modelSelectionSignature\(modelVariantCatalogState\);\n\s*renderSummaryModalContent\(\{\n\s*title: '🤗 Select Models',\n\s*subtitle: "Choose model variants/);
});
