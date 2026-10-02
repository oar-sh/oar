import { tokenLabel } from './context-tier-options.mjs';

/**
 * The composer placeholder, decided by the MODEL FAMILY of the current
 * selection (maintainer's rule: the hint names who answers, whatever runtime serves
 * it — claude-* through Cursor's catalog still reads "Message Claude…").
 * Provider only breaks ties: Auto/empty follows the conversation's bound
 * provider, unknown families on the OpenAI BYOK provider read OpenAI, and
 * everything else falls back to the historical Copilot text.
 */
export function composerPlaceholderFor({ modelId = '', providerType = '' } = {}) {
  const provider = String(providerType || '').trim().toLowerCase();
  const id = String(modelId || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  const providerFallback = () => {
    if (provider === 'claude' || provider === 'claude-cloud') return 'Message Claude…';
    if (provider === 'grok') return 'Message Grok…';
    if (provider === 'openai' || provider === 'openai-byok') return 'Message OpenAI…';
    if (provider === 'cursor') return 'Message Cursor…';
    return 'Message Copilot…';
  };
  if (!id || id === 'auto') return providerFallback();
  if (id.startsWith('claude-')) return 'Message Claude…';
  if (id.startsWith('grok-')) return 'Message Grok…';
  if (id.startsWith('gpt-')) return 'Message GPT…';
  if (id.startsWith('gemini-')) return 'Message Gemini…';
  // Composer is Cursor's house model family.
  if (id.startsWith('composer-')) return 'Message Cursor…';
  return providerFallback();
}

/**
 * Human label for a model id, tuned to fit narrow composer selects.
 *
 * Claude ids drop the redundant "claude-" prefix (Opus/Sonnet/Haiku/Fable are
 * unmistakably Claude), join hyphenated version parts with dots, and drop
 * trailing -YYYYMMDD snapshot dates: `claude-fable-5-1` -> "Fable 5.1",
 * `claude-haiku-4-5-20251001` -> "Haiku 4.5". A bracketed capability suffix
 * survives verbatim: `claude-opus-5[1m]` -> "Opus 5 [1m]".
 */
export function humanizeModelLabel(modelId = '') {
  const text = String(modelId || '').trim();
  if (!text) return '';
  if (/^gpt-/i.test(text)) {
    return text
      .replace(/^gpt-/i, 'GPT-')
      .replace(/-codex$/i, ' Codex')
      .replace(/-mini$/i, ' Mini');
  }
  if (/^claude-/i.test(text)) {
    const suffixMatch = /\[([^\]]+)\]$/.exec(text);
    const base = suffixMatch ? text.slice(0, suffixMatch.index) : text;
    const parts = base
      .replace(/^claude-/i, '')
      .split('-')
      .filter((part, index, all) => !(index === all.length - 1 && /^\d{8}$/.test(part)));
    const words = [];
    for (const part of parts) {
      const isNumeric = /^\d+(\.\d+)?$/.test(part);
      if (isNumeric && words.length && words[words.length - 1].isNumeric) {
        words[words.length - 1].text += `.${part}`;
      } else {
        words.push({ text: isNumeric ? part : part.charAt(0).toUpperCase() + part.slice(1), isNumeric });
      }
    }
    const label = words.map((word) => word.text).join(' ');
    return suffixMatch ? `${label} [${suffixMatch[1]}]` : label;
  }
  if (/^gemini-/i.test(text)) {
    return text
      .replace(/^gemini-/i, 'Gemini ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : (part.charAt(0).toUpperCase() + part.slice(1))))
      .join(' ');
  }
  return text;
}

const VARIANT_EFFORT_SUFFIX = /^(.*)-(none|minimal|low|medium|high|xhigh|max)$/i;

// "gpt-5-high" style ids carry the effort as a suffix; the label shows it in
// parentheses and the metadata lookup uses the base id.
export function splitModelVariantId(modelVariantId = '') {
  const value = String(modelVariantId || '').trim();
  if (!value) return { baseModelId: '', reasoningEffort: null };
  const match = value.match(VARIANT_EFFORT_SUFFIX);
  if (!match) return { baseModelId: value, reasoningEffort: null };
  return {
    baseModelId: String(match[1] || '').trim(),
    reasoningEffort: String(match[2] || '').trim().toLowerCase(),
  };
}

// Server catalogs key metadata by the id they publish; stored preferences and
// variant ids may differ only in case.
export function modelMetadataFor(modelId = '', metadataByModel = {}) {
  const map = metadataByModel && typeof metadataByModel === 'object' ? metadataByModel : {};
  const { baseModelId } = splitModelVariantId(modelId);
  if (!baseModelId) return null;
  const direct = map[baseModelId];
  if (direct && typeof direct === 'object') return direct;
  const lower = baseModelId.toLowerCase();
  const key = Object.keys(map).find((candidate) => candidate.toLowerCase() === lower);
  return key && map[key] && typeof map[key] === 'object' ? map[key] : null;
}

// Number(null) is 0, which would put every unindexed model first.
function finiteIndexOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const index = Number(value);
  return Number.isFinite(index) && index >= 0 ? index : null;
}

export function catalogOrderFor(modelId = '', metadataByModel = {}) {
  return finiteIndexOrNull(modelMetadataFor(modelId, metadataByModel)?.catalogIndex);
}

// Runtime display name when the catalog has one ("GPT-5.4 mini"), otherwise
// the compact humanized id; variant ids keep their "(effort)" tail.
export function catalogModelLabel(modelId = '', metadataByModel = {}, { autoValue = 'auto' } = {}) {
  const value = String(modelId || '').trim();
  if (value.toLowerCase() === String(autoValue || 'auto').trim().toLowerCase()) return 'Auto';
  const { baseModelId, reasoningEffort } = splitModelVariantId(value);
  if (!baseModelId) return value;
  const displayName = String(modelMetadataFor(value, metadataByModel)?.displayName || '').trim();
  const baseLabel = displayName || humanizeModelLabel(baseModelId);
  return reasoningEffort ? `${baseLabel} (${reasoningEffort})` : baseLabel;
}

export function contextWindowSuffix(modelId = '', metadataByModel = {}) {
  const metadata = modelMetadataFor(modelId, metadataByModel);
  if (!metadata) return '';
  const real = Number(metadata.contextWindowTokens);
  const tokens = Number.isFinite(real) && real > 0 ? real : Number(metadata.defaultContextLimitTokens);
  return Number.isFinite(tokens) && tokens > 0 ? ` · ${tokenLabel(tokens)}` : '';
}

/**
 * Auto first, then the server's catalog order where it supplies one
 * (orderFor → finite index), then everything else alphabetically by bare
 * label. Copilot's canonical order therefore wins for Copilot models while
 * SDK-only catalogs (no index) keep the alphabetical list they always had.
 * suffixFor is applied after sorting and after collision detection so the
 * sort key and the "same label" check never see the window annotation.
 */
export function normalizeModelSelectorOptions(models = [], {
  autoValue = 'auto',
  labelFor = (modelId) => modelId,
  orderFor = () => null,
  suffixFor = () => '',
} = {}) {
  const normalizedAuto = String(autoValue || 'auto').trim() || 'auto';
  const values = Array.from(new Set(
    (Array.isArray(models) ? models : [])
      .map((modelId) => String(modelId || '').trim())
      .filter(Boolean),
  )).filter((modelId) => modelId.toLowerCase() !== normalizedAuto.toLowerCase());
  const orderOf = (modelId) => finiteIndexOrNull(orderFor(modelId)) ?? Number.POSITIVE_INFINITY;
  values.sort((left, right) => {
    const indexOrder = orderOf(left) - orderOf(right);
    if (indexOrder) return indexOrder;
    const labelOrder = String(labelFor(left) || left).localeCompare(
      String(labelFor(right) || right),
      undefined,
      { sensitivity: 'base', numeric: true },
    );
    return labelOrder || left.localeCompare(right);
  });
  const options = [
    { value: normalizedAuto, label: String(labelFor(normalizedAuto) || normalizedAuto) },
    ...values.map((value) => ({ value, label: String(labelFor(value) || value) })),
  ];
  // Date-stripping in humanizeModelLabel can collapse an alias and its dated
  // snapshot ("claude-fable-5-1" + "claude-fable-5-1-20251103") into the same
  // label; two indistinguishable rows are worse than one ugly one, so
  // colliding labels fall back to the raw id.
  const labelCounts = new Map();
  for (const option of options) {
    labelCounts.set(option.label, (labelCounts.get(option.label) || 0) + 1);
  }
  return options.map((option) => {
    const label = labelCounts.get(option.label) > 1 ? option.value : option.label;
    const suffix = option.value === normalizedAuto ? '' : String(suffixFor(option.value) || '');
    return { value: option.value, label: `${label}${suffix}` };
  });
}

/**
 * The one option list both pickers render (composer #model-select and the
 * New Chat modal), so they cannot disagree on order or wording. Callers filter
 * by provider afterwards; annotateContextWindow is off for Claude SDK
 * conversations, whose window the merged metadata does not know (see
 * buildContextTierOptions).
 */
export function buildCatalogModelOptions(models = [], {
  autoValue = 'auto',
  metadataByModel = {},
  annotateContextWindow = true,
} = {}) {
  return normalizeModelSelectorOptions(models, {
    autoValue,
    labelFor: (modelId) => catalogModelLabel(modelId, metadataByModel, { autoValue }),
    orderFor: (modelId) => catalogOrderFor(modelId, metadataByModel),
    suffixFor: annotateContextWindow
      ? (modelId) => contextWindowSuffix(modelId, metadataByModel)
      : () => '',
  });
}

export function modelSelectorOptionsEqual(currentOptions = [], nextOptions = []) {
  return currentOptions.length === nextOptions.length
    && nextOptions.every((option, index) => (
      currentOptions[index]?.value === option.value
      && currentOptions[index]?.label === option.label
    ));
}
