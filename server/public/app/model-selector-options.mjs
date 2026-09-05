/**
 * The composer placeholder, decided by the MODEL FAMILY of the current
 * selection (Simon's rule: the hint names who answers, whatever runtime serves
 * it — claude-* through Cursor's catalog still reads "Message Claude…").
 * Provider only breaks ties: Auto/empty follows the conversation's bound
 * provider, unknown families on the OpenAI BYOK provider read OpenAI, and
 * everything else falls back to the historical Copilot text.
 */
export function composerPlaceholderFor({ modelId = '', providerType = '' } = {}) {
  const provider = String(providerType || '').trim().toLowerCase();
  const id = String(modelId || '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  const providerFallback = () => {
    if (provider === 'claude') return 'Message Claude…';
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

export function normalizeModelSelectorOptions(models = [], {
  autoValue = 'auto',
  labelFor = (modelId) => modelId,
} = {}) {
  const normalizedAuto = String(autoValue || 'auto').trim() || 'auto';
  const values = Array.from(new Set(
    (Array.isArray(models) ? models : [])
      .map((modelId) => String(modelId || '').trim())
      .filter(Boolean),
  )).filter((modelId) => modelId.toLowerCase() !== normalizedAuto.toLowerCase());
  values.sort((left, right) => {
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
  return options.map((option) => (
    labelCounts.get(option.label) > 1 ? { ...option, label: option.value } : option
  ));
}

export function modelSelectorOptionsEqual(currentOptions = [], nextOptions = []) {
  return currentOptions.length === nextOptions.length
    && nextOptions.every((option, index) => (
      currentOptions[index]?.value === option.value
      && currentOptions[index]?.label === option.label
    ));
}
