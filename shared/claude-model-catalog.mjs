// How the relay's Claude model list survives Anthropic rotating its lineup.
//
// `supportedModels()` reports only what the CLI currently advertises, so a
// straight replace silently drops a model you are using the moment a successor
// appears (Fable 5 -> Fable 5.1, 2026-09-05). Previous ids keep working through
// `--model` until they are actually retired server-side, so the catalog keeps
// them and lets the user decide when to stop using one.

export const MAX_CLAUDE_CATALOG_MODELS = 32;

/**
 * Freshly discovered models first (they are the current lineup), then models a
 * previous discovery found and this one no longer advertises. The default model
 * always leads so the composer's selection can never fall out of its own list.
 */
export function mergeDiscoveredClaudeModels({
  defaultModel = '',
  discovered = [],
  previouslyKnown = [],
  max = MAX_CLAUDE_CATALOG_MODELS,
} = {}) {
  const merged = [];
  const seen = new Set();
  const add = (value) => {
    const id = String(value || '').trim();
    if (!id) return;
    // Ids are conventionally lowercase; dedupe case-insensitively but keep the
    // first spelling seen so discovery's casing wins over a stored variant.
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(id);
  };

  add(defaultModel);
  for (const id of Array.isArray(discovered) ? discovered : []) add(id);
  for (const id of Array.isArray(previouslyKnown) ? previouslyKnown : []) add(id);

  const limit = Number.isInteger(max) && max > 0 ? max : MAX_CLAUDE_CATALOG_MODELS;
  // Retained ids trail the current lineup, so the cap sheds the stalest first.
  return merged.slice(0, limit);
}

/** Discovered effort ladders win; retained models keep the ladder they had. */
export function mergeClaudeModelEfforts(previousEfforts = {}, discoveredEfforts = {}) {
  const previous = previousEfforts && typeof previousEfforts === 'object' ? previousEfforts : {};
  const discoveredMap = discoveredEfforts && typeof discoveredEfforts === 'object' ? discoveredEfforts : {};
  return { ...previous, ...discoveredMap };
}
