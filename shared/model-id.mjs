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
