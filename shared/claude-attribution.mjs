// Commit and pull-request attribution for Claude sessions.
//
// Claude Code appends its own trailer to every commit an agent makes
// ("Co-Authored-By: Claude … <noreply@anthropic.com>") and a line to every PR
// body. The CLI lets a settings object replace both (`Settings.attribution`,
// SDK 0.3.x), and OAR uses that so commits made through the relay carry one
// identity whatever model wrote them:
//
//   Co-authored-by: Open Agent Relay (Claude Fable 5.1) <no-reply@oar.sh>
//
// Three modes: `oar` (the default), `vanilla` (the CLI's own attribution),
// `off` (none). The relay resolves the mode (provider setting, later a
// per-folder override) and the model label, and hands the finished settings
// object to the worker with each delivery; the worker applies it at spawn and
// when it changes. Shared by both sides so they build the same object.

export const CLAUDE_ATTRIBUTION_MODES = Object.freeze(['oar', 'vanilla', 'off']);
export const DEFAULT_CLAUDE_ATTRIBUTION_MODE = 'oar';

export const OAR_ATTRIBUTION_NAME = 'Open Agent Relay';
export const OAR_ATTRIBUTION_EMAIL = 'no-reply@oar.sh';
export const OAR_PR_ATTRIBUTION = '🤖 Generated with [Open Agent Relay](https://oar.sh)';

/** A mode string, or null for anything that is not one. */
export function normalizeClaudeAttributionMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return CLAUDE_ATTRIBUTION_MODES.includes(mode) ? mode : null;
}

/** The provider mode unless a folder override says otherwise; never null. */
export function resolveClaudeAttributionMode({ providerMode = null, folderMode = null } = {}) {
  return normalizeClaudeAttributionMode(folderMode)
    || normalizeClaudeAttributionMode(providerMode)
    || DEFAULT_CLAUDE_ATTRIBUTION_MODE;
}

const FAMILY_LABELS = Object.freeze({
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  mythos: 'Mythos',
});

/**
 * "claude-fable-5-1[1m]" → "Claude Fable 5.1"; "claude-haiku-4-5-20251001" →
 * "Claude Haiku 4.5". The context-tier suffix and a date stamp are not part
 * of the model's name. An id the pattern does not know is used as it is.
 */
export function claudeAttributionModelLabel(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return 'Claude';
  const id = raw.replace(/\[[^\]]*\]\s*$/, '').trim();
  const parts = id.toLowerCase().split('-').filter(Boolean);
  if (parts[0] !== 'claude' || parts.length < 2) return id || raw;
  const family = FAMILY_LABELS[parts[1]];
  if (!family) return id;
  const version = parts.slice(2)
    .filter((part) => /^\d+$/.test(part) && part.length < 8)
    .join('.');
  return version ? `Claude ${family} ${version}` : `Claude ${family}`;
}

export function claudeAttributionTrailer(modelLabel) {
  const label = String(modelLabel || '').trim() || 'Claude';
  return `Co-authored-by: ${OAR_ATTRIBUTION_NAME} (${label}) <${OAR_ATTRIBUTION_EMAIL}>`;
}

/**
 * The `Settings.attribution` object for a mode and model: the OAR identity,
 * nothing at all (`off`), or null for `vanilla` (the key is left to the CLI).
 * Always the object form: older CLIs reject `true`/`false` here.
 */
export function buildClaudeAttributionSettings({ mode, modelId = '', modelLabel = '' } = {}) {
  const resolved = normalizeClaudeAttributionMode(mode) || DEFAULT_CLAUDE_ATTRIBUTION_MODE;
  if (resolved === 'vanilla') return null;
  if (resolved === 'off') return { commit: '', pr: '', sessionUrl: false };
  const label = String(modelLabel || '').trim() || claudeAttributionModelLabel(modelId);
  return {
    commit: claudeAttributionTrailer(label),
    pr: OAR_PR_ATTRIBUTION,
    // A relay session link in a public history: never.
    sessionUrl: false,
  };
}

function normalizeAttributionObject(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  return {
    commit: String(value.commit ?? ''),
    pr: String(value.pr ?? ''),
    sessionUrl: value.sessionUrl === true,
  };
}

/**
 * What a delivery's `settings` does to the worker's attribution — the twin
 * of resolveDeliveredThinking: an absent key (an older relay) keeps the last
 * known value; a present key replaces it, and null means vanilla.
 */
export function resolveDeliveredAttribution(current, settings) {
  const base = normalizeAttributionObject(current);
  const kept = base === undefined ? null : base;
  if (!settings || typeof settings !== 'object') return kept;
  if (!Object.prototype.hasOwnProperty.call(settings, 'attribution')) return kept;
  const next = normalizeAttributionObject(settings.attribution);
  return next === undefined ? kept : next;
}

/** Two attribution values mean the same thing (both vanilla, or equal fields). */
export function sameClaudeAttribution(left, right) {
  const a = normalizeAttributionObject(left) ?? null;
  const b = normalizeAttributionObject(right) ?? null;
  if (a === null || b === null) return a === b;
  return a.commit === b.commit && a.pr === b.pr && a.sessionUrl === b.sessionUrl;
}
