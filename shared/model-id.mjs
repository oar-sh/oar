const MODEL_ID_PREFIXES = [
  'gpt-',
  'chatgpt-',
  'claude-',
  'gemini-',
  'mai-',
  'o1-',
  'o3-',
  'o4-',
  'codex-',
  'openai/',
  'anthropic/',
  'google/',
  'microsoft/',
];
const PROVIDER_PREFIXES = ['openai/', 'anthropic/', 'google/', 'microsoft/'];
const BASE_MODEL_PREFIXES = MODEL_ID_PREFIXES.filter((prefix) => !prefix.includes('/'));

const MODEL_ID_TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]{0,118}[a-z0-9])$/i;

const MODEL_ID_DENY_SUBSTRINGS = [
  'requires enablement',
  'enable this model',
  'pick a different one',
  'accept',
  'settings',
  'policy',
  'missing required authentication',
  'missing-required-authentication',
  'not authorized',
  'not-authorized',
  'http://',
  'https://',
  'github.com/settings',
];

function isLikelyModelIdPrefix(value) {
  const lower = String(value || '').toLowerCase();
  if (lower === 'o1' || lower === 'o3') return true;
  return MODEL_ID_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function normalizeModelIdCandidate(value) {
  return String(value || '').trim();
}

export function isSafeProviderModelId(value) {
  const candidate = normalizeModelIdCandidate(value);
  return candidate.length <= 120 && MODEL_ID_TOKEN_PATTERN.test(candidate);
}

// Claude Agent SDK model ids may carry a bracketed capability suffix
// (e.g. "claude-opus-5[1m]" for the 1M-context variant).
export function isSafeClaudeModelId(value) {
  const candidate = normalizeModelIdCandidate(value);
  if (candidate.length > 120) return false;
  const base = candidate.replace(/\[[a-z0-9-]{1,12}\]$/i, '');
  return MODEL_ID_TOKEN_PATTERN.test(base);
}

// Cursor model ids ("composer-2.5", "gpt-5.5", "auto-smart") carry no fixed
// prefix; the safe-chars token check is the whole validation today. Kept as a
// named seam so cursor-specific rules can diverge without touching callers.
export function isSafeCursorModelId(value) {
  return isSafeProviderModelId(value);
}

// Grok / xAI model ids ("grok-4.5", "grok-code-fast-1") use the same safe-token
// rules as other unprefixed agent providers.
export function isSafeGrokModelId(value) {
  return isSafeProviderModelId(value);
}

// The "[1m]" suffix marks the 1M-context variant of a Claude model. The UI
// treats it as a context tier of the base model, not a separate model.
export const CLAUDE_LONG_CONTEXT_SUFFIX = '[1m]';
export const CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN = /\[1m\]$/i;
export const CLAUDE_LONG_CONTEXT_LIMIT_TOKENS = 1_000_000;
export const CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS = 200_000;

export function isClaudeLongContextModelId(value) {
  return CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN.test(normalizeModelIdCandidate(value));
}

export function claudeBaseModelId(value) {
  return normalizeModelIdCandidate(value).replace(CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN, '');
}

export function claudeLongContextModelId(value) {
  const base = claudeBaseModelId(value);
  return base ? `${base}${CLAUDE_LONG_CONTEXT_SUFFIX}` : '';
}

export function isOpenAIModelId(value) {
  const candidate = normalizeModelIdCandidate(value).toLowerCase();
  if (candidate === 'o1' || candidate === 'o3') return true;
  return [
    'gpt-',
    'chatgpt-',
    'o1-',
    'o3-',
    'o4-',
    'codex-',
    'openai/',
  ].some((prefix) => candidate.startsWith(prefix));
}

export function canonicalizeModelId(value) {
  const candidate = normalizeModelIdCandidate(value).toLowerCase();
  if (!candidate) return '';
  for (const providerPrefix of PROVIDER_PREFIXES) {
    if (!candidate.startsWith(providerPrefix)) continue;
    const stripped = candidate.slice(providerPrefix.length);
    // Provider prefixes are redundant for known base model families.
    if (BASE_MODEL_PREFIXES.some((prefix) => stripped.startsWith(prefix))) {
      return stripped;
    }
  }
  return candidate;
}

export function isValidModelId(value) {
  const candidate = normalizeModelIdCandidate(value);
  if (!candidate) return false;
  if (candidate.length > 120) return false;
  if (!isSafeProviderModelId(candidate)) return false;
  if (!isLikelyModelIdPrefix(candidate)) return false;
  const lower = candidate.toLowerCase();
  if (MODEL_ID_DENY_SUBSTRINGS.some((token) => lower.includes(token))) return false;
  return true;
}

export function filterValidModelIds(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const candidate = normalizeModelIdCandidate(value);
    if (!isValidModelId(candidate)) continue;
    const canonical = canonicalizeModelId(candidate);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
