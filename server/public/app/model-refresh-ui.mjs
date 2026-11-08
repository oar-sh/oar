// New models and the background model check, the browser side: the Select
// Models switch row, "New" tags and fallback line, the toast a refresh that
// found new models shows, and the texts of Settings › General › Models.
// DOM-free so it is unit-testable; the relay side is
// server/services/provider-model-state.mjs and model-refresh-scheduler.mjs.

// Mirrors shared/model-refresh-schedule.mjs, which the browser cannot import —
// only server/public is served. The relay's answer carries the real choices.
export const DEFAULT_MODEL_REFRESH_INTERVAL_HOURS = 24;
export const MODEL_REFRESH_INTERVAL_CHOICES = Object.freeze([6, 12, 24, 72, 168]);

// The Select Models tab of each provider block in GET /api/model-variants.
// Copilot's state rides in `copilotModelState` instead.
const MODEL_TAB_BLOCKS = Object.freeze({
  openai: 'openaiModels',
  anthropic: 'claudeModels',
  'claude-api': 'claudeApiModels',
  cursor: 'cursorModels',
  grok: 'grokModels',
  deepseek: 'deepseekModels',
});

const MODEL_TAB_LABELS = Object.freeze({
  copilot: 'Copilot',
  openai: 'OpenAI',
  anthropic: 'Claude',
  'claude-api': 'Claude API',
  cursor: 'Cursor',
  grok: 'Grok',
  deepseek: 'DeepSeek',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function idList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
}

/**
 * The new-model fields of one provider block (`autoEnableNew`, `unseen`,
 * `fallback`). A relay from before them sends none: `autoEnableNew` stays
 * null and the tab then shows no switch row.
 */
export function modelRefreshBlockFields(block) {
  return {
    autoEnableNew: typeof block?.autoEnableNew === 'boolean' ? block.autoEnableNew : null,
    unseen: idList(block?.unseen),
    fallback: block?.fallback === true,
  };
}

/** `copilotModelState` of GET /api/model-variants; null from an older relay. */
export function normalizeCopilotModelState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    autoEnableNew: typeof value.autoEnableNew === 'boolean' ? value.autoEnableNew : null,
    unseen: idList(value.unseen),
  };
}

function tabState(catalogState, tab) {
  const key = String(tab || '').trim().toLowerCase();
  if (key === 'copilot') return catalogState?.copilotModelState || null;
  const blockKey = MODEL_TAB_BLOCKS[key];
  return blockKey ? (catalogState?.[blockKey] || null) : null;
}

export function modelTabLabel(tab) {
  return MODEL_TAB_LABELS[String(tab || '').trim().toLowerCase()] || String(tab || '');
}

/** The tab's "Turn new models on automatically", or null when it has none. */
export function modelTabAutoEnableNew(catalogState, tab) {
  const value = tabState(catalogState, tab)?.autoEnableNew;
  return typeof value === 'boolean' ? value : null;
}

/** The default model the tab fell back to, or '' while it has not. */
export function modelTabFallbackModel(catalogState, tab) {
  const state = tabState(catalogState, tab);
  if (state?.fallback !== true) return '';
  return String(state.defaultModel || '').trim();
}

/**
 * The unseen ids of every tab, lowercased, added to `held`: the ids a modal
 * already tagged stay tagged while it is open, although opening it marked
 * them seen (POST /api/model-variants/seen re-renders it without them).
 */
export function mergeUnseenByTab(held, catalogState) {
  const next = new Map();
  for (const [tab, ids] of held instanceof Map ? held : []) next.set(tab, new Set(ids));
  for (const tab of Object.keys(MODEL_TAB_LABELS)) {
    const ids = idList(tabState(catalogState, tab)?.unseen).map((id) => id.toLowerCase());
    if (!ids.length) continue;
    if (!next.has(tab)) next.set(tab, new Set());
    for (const id of ids) next.get(tab).add(id);
  }
  return next;
}

/**
 * Whether a Select Models row gets the "New" tag: its model is unseen. A
 * Copilot row is matched by its base model (every reasoning row of a new
 * model is new), any other by its model id, which is its base id too.
 */
export function isUnseenModelRow(row, unseenIds) {
  const id = String(row?.baseModelId || '').trim().toLowerCase();
  return !!id && !!unseenIds?.has?.(id);
}

export function renderNewModelChipHtml() {
  return ' <span class="model-reasoning-chip model-reasoning-chip-new">New</span>';
}

/** The switch row at the top of a provider tab; Save sends its state. */
export function renderModelAutoEnableRowHtml(tab, checked) {
  const key = String(tab || '').trim().toLowerCase();
  const label = modelTabLabel(key);
  return `
    <label class="model-auto-enable-row">
      <input class="model-auto-enable-toggle" type="checkbox" data-auto-enable-tab="${escapeHtml(key)}" ${checked ? 'checked' : ''}>
      <span class="model-auto-enable-copy">
        <span class="model-auto-enable-title">Turn new models on automatically</span>
        <span class="model-auto-enable-help">While this is on, a ${escapeHtml(label)} model found from now on starts on. A model you turned off stays off either way.</span>
      </span>
    </label>
  `;
}

/**
 * The model ids a Select Models save sends for one provider, read from its
 * rendered checkboxes: `enabled` the ticked ones, `shown` all of them (the
 * locked default model too). The relay turns only the shown ids on or off,
 * so a model a refresh added after this render, already in the catalog state
 * but not on screen, keeps its state. Reads `attribute` of each input, or its
 * `value` without one.
 */
export function modelCheckboxSelection(inputs, attribute = '') {
  const enabled = [];
  const shown = [];
  for (const input of Array.isArray(inputs) ? inputs : Array.from(inputs || [])) {
    const raw = attribute && typeof input?.getAttribute === 'function'
      ? input.getAttribute(attribute)
      : input?.value;
    const id = String(raw || '').trim();
    if (!id || shown.includes(id)) continue;
    shown.push(id);
    if (input.checked === true) enabled.push(id);
  }
  return { enabled, shown };
}

// The provider blocks whose rows Select Models renders, besides Copilot's.
const SELECTION_BLOCKS = Object.freeze(['claudeModels', 'cursorModels', 'grokModels', 'deepseekModels', 'claudeApiModels', 'openaiModels']);

/**
 * What an open Select Models shows of the catalog state: every provider
 * block's models, which are on, its switch, unseen ids and fallback, and the
 * Copilot rows with which are on. A `models_updated` whose catalog reads the
 * same leaves the open modal (and the user's unsaved ticks) alone.
 */
export function modelSelectionSignature(catalogState) {
  const enabledVariants = new Set(idList(catalogState?.enabledVariantIds));
  const copilotState = catalogState?.copilotModelState || null;
  return JSON.stringify({
    variants: (Array.isArray(catalogState?.variants) ? catalogState.variants : [])
      .map((entry) => [String(entry?.variantId || ''), enabledVariants.has(String(entry?.variantId || ''))]),
    copilot: copilotState
      ? { autoEnableNew: copilotState.autoEnableNew ?? null, unseen: idList(copilotState.unseen) }
      : null,
    ...Object.fromEntries(SELECTION_BLOCKS.map((key) => {
      const block = catalogState?.[key];
      return [key, block
        ? {
          defaultModel: String(block.defaultModel || ''),
          availableModels: idList(block.availableModels),
          enabledModels: idList(block.enabledModels),
          autoEnableNew: typeof block.autoEnableNew === 'boolean' ? block.autoEnableNew : null,
          unseen: idList(block.unseen),
          fallback: block.fallback === true,
        }
        : null];
    })),
  });
}

function unsavedTickKey(input) {
  const read = (name) => String((typeof input?.getAttribute === 'function' ? input.getAttribute(name) : '') || '').trim();
  const variantId = read('data-variant-id');
  if (variantId) return `variant:${variantId}`;
  const tab = read('data-auto-enable-tab');
  return tab ? `auto:${tab}` : '';
}

/**
 * The ticks of an open Select Models not saved yet: each checkbox (a model
 * row or the switch) whose `checked` differs from what it was rendered with.
 */
export function collectUnsavedModelTicks(inputs) {
  const ticks = new Map();
  for (const input of Array.isArray(inputs) ? inputs : Array.from(inputs || [])) {
    if (!input || input.disabled || input.checked === input.defaultChecked) continue;
    const key = unsavedTickKey(input);
    if (key) ticks.set(key, input.checked === true);
  }
  return ticks;
}

/**
 * Puts the unsaved ticks back on the re-rendered checkboxes of the same row
 * or switch; a row that is gone, or now locked, takes none. Answers how many
 * it set.
 */
export function applyUnsavedModelTicks(inputs, ticks) {
  if (!(ticks instanceof Map) || !ticks.size) return 0;
  let applied = 0;
  for (const input of Array.isArray(inputs) ? inputs : Array.from(inputs || [])) {
    if (!input || input.disabled) continue;
    const key = unsavedTickKey(input);
    if (!key || !ticks.has(key)) continue;
    input.checked = ticks.get(key);
    applied += 1;
  }
  return applied;
}

/**
 * The OpenAI tab's rows from `openaiModels`, one per offered model, like
 * Cursor's: the default model is always on and cannot be unticked.
 */
export function buildOpenAIModelRows(openaiCatalog, labelFor = (id) => id) {
  const enabledSet = new Set(idList(openaiCatalog?.enabledModels));
  const defaultModel = String(openaiCatalog?.defaultModel || '').trim();
  return idList(openaiCatalog?.availableModels).map((openaiModelId, index) => {
    const isDefaultModel = openaiModelId === defaultModel;
    return {
      variantId: `${openaiModelId}--provider-openai-byok`,
      baseModelId: openaiModelId,
      provider: 'openai-byok',
      label: labelFor(openaiModelId),
      releaseStatus: null,
      reasoningEffort: null,
      // The default model always stays enabled, as for the other providers.
      selectable: !isDefaultModel,
      enabled: enabledSet.has(openaiModelId) || isDefaultModel,
      openaiModelId,
      sortOrder: index,
    };
  });
}

// The row field and checkbox attribute of each provider with its own
// selection; a Copilot row has none and reads the enabled variant ids.
const SDK_MODEL_ROW_FIELDS = Object.freeze([
  ['claudeModelId', 'data-claude-model'],
  ['cursorModelId', 'data-cursor-model'],
  ['grokModelId', 'data-grok-model'],
  ['deepseekModelId', 'data-deepseek-model'],
  ['claudeApiModelId', 'data-claude-api-model'],
  ['openaiModelId', 'data-openai-model'],
]);

/** The provider model id of a Select Models row, '' for a Copilot row. */
export function modelRowSdkModelId(row) {
  for (const [field] of SDK_MODEL_ROW_FIELDS) {
    if (row?.[field]) return String(row[field]);
  }
  return '';
}

/**
 * The checkbox of a Select Models row. A provider row carries its model id
 * (`data-cursor-model`, …) and its own on flag; a Copilot row is on when its
 * variant is in `selectedVariantIds`. A row that is not selectable (the
 * default model) is disabled.
 */
export function renderModelVariantCheckboxHtml(row, selectedVariantIds) {
  const selectable = row?.selectable !== false;
  const sdkField = SDK_MODEL_ROW_FIELDS.find(([field]) => row?.[field]);
  const checked = sdkField
    ? row.enabled === true
    : (selectable && !!selectedVariantIds?.has?.(row?.variantId));
  const sdkModelAttr = sdkField ? ` ${sdkField[1]}="${escapeHtml(row[sdkField[0]])}"` : '';
  return `<input class="model-variant-checkbox" type="checkbox" data-selectable="${selectable ? '1' : '0'}" data-variant-id="${escapeHtml(row?.variantId)}"${sdkModelAttr} ${checked ? 'checked' : ''} ${selectable ? '' : 'disabled'}>`;
}

/** The tab's warning while every model the user had on has vanished. */
export function renderModelFallbackWarningHtml(defaultModel) {
  const model = String(defaultModel || '').trim();
  if (!model) return '';
  return `<div class="model-fallback-warning" style="font-size:0.78rem;color:var(--warn,#f7c873)">⚠️ None of the models you turned on are offered any more; ${escapeHtml(model)} is used until you pick others.</div>`;
}

// The tab of a provider id whose tab is named differently; the others share it.
const PROVIDER_TABS = Object.freeze({ github: 'copilot', claude: 'anthropic' });

function newModelsEntries(newModels) {
  return (Array.isArray(newModels) ? newModels : [])
    .map((entry) => {
      const provider = String(entry?.provider || '').trim().toLowerCase();
      const tab = String(entry?.tab || '').trim().toLowerCase() || PROVIDER_TABS[provider] || provider;
      return {
        tab,
        label: String(entry?.label || '').trim() || modelTabLabel(tab),
        count: idList(entry?.ids).length,
        on: entry?.on === true,
      };
    })
    .filter((entry) => entry.count > 0 && entry.label);
}

/**
 * The toast of a `models_updated` that found models never seen before:
 * "2 new Cursor models (on)", several providers joined in one line. '' when
 * the event found none.
 */
export function buildNewModelsToastText(newModels) {
  return newModelsEntries(newModels)
    .map(({ count, label, on }) => `${count} new ${label} ${count === 1 ? 'model' : 'models'} (${on ? 'on' : 'off'})`)
    .join(', ');
}

/** The Select Models tab the toast's Show opens: the first provider listed. */
export function newModelsToastTab(newModels) {
  return newModelsEntries(newModels)[0]?.tab || 'copilot';
}

/**
 * The toast one `models_updated` event shows: `{ text, tab }` when it found
 * new models, null otherwise and on a shared view (a viewer has no Select
 * Models).
 */
export function newModelsToastFor(payload, { sharedView = false } = {}) {
  if (sharedView) return null;
  const text = buildNewModelsToastText(payload?.newModels);
  return text ? { text, tab: newModelsToastTab(payload.newModels) } : null;
}

/** "Every 6 h" … "Every 7 days", for the interval select. */
export function formatModelRefreshIntervalLabel(hours) {
  const value = Math.max(1, Math.round(Number(hours) || DEFAULT_MODEL_REFRESH_INTERVAL_HOURS));
  if (value >= 48 && value % 24 === 0) return `Every ${value / 24} days`;
  return `Every ${value} h`;
}

// The same steps as a share's age (share-format.mjs).
function age(iso, now) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at) || at <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const LAST_ERROR_MAX_CHARS = 120;

/** A provider's last check, beside its checkbox: when, or why it failed. */
export function formatModelRefreshLastChecked(last, now = Date.now()) {
  const when = age(last?.at, now);
  if (!when) return 'Not checked yet';
  if (last?.ok === false) {
    const raw = String(last?.error || '').replace(/\s+/g, ' ').trim();
    const error = raw.length > LAST_ERROR_MAX_CHARS ? `${raw.slice(0, LAST_ERROR_MAX_CHARS - 1)}…` : raw;
    return error ? `Last check failed ${when}: ${error}` : `Last check failed ${when}`;
  }
  return `Last checked ${when}`;
}

/**
 * GET/POST /api/model-refresh-settings, read defensively: an answer without
 * a field keeps the relay's default for it.
 */
export function normalizeModelRefreshSettings(payload) {
  const choices = Array.isArray(payload?.intervalChoices)
    ? payload.intervalChoices.map((value) => Math.round(Number(value))).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const intervalHours = Math.round(Number(payload?.intervalHours));
  return {
    auto: typeof payload?.auto === 'boolean' ? payload.auto : true,
    intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : DEFAULT_MODEL_REFRESH_INTERVAL_HOURS,
    intervalChoices: choices.length ? choices : [...MODEL_REFRESH_INTERVAL_CHOICES],
    excluded: idList(payload?.excluded),
    providers: (Array.isArray(payload?.providers) ? payload.providers : [])
      .map((entry) => ({
        id: String(entry?.id || '').trim(),
        label: String(entry?.label || '').trim() || String(entry?.id || '').trim(),
        last: entry?.last && typeof entry.last === 'object' ? entry.last : null,
        // Listed while enabled; a relay from before the field lists only
        // providers that are set up.
        setUp: entry?.setUp !== false,
      }))
      .filter((entry) => entry.id),
  };
}

/** The excluded list after one provider's checkbox changed. */
export function nextModelRefreshExcluded(excluded, providerId, checked) {
  const id = String(providerId || '').trim();
  const list = idList(excluded).filter((entry) => entry !== id);
  return checked ? list : [...list, id];
}
