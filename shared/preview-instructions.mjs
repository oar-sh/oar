// Preview guidance for providers without a custom-tool surface (Copilot CLI,
// Grok). The wording lives in preview-tool-core.mjs; this module only decides
// whether a relay should advertise the capability at all, and where the
// generated block lands inside an existing guidance document.

import { renderPreviewInstructionBlock } from './preview-tool-core.mjs';

// Derived rather than restated, so a heading change in the generated block
// still matches the section it is meant to replace.
export const PREVIEW_INSTRUCTION_HEADING = String(
  renderPreviewInstructionBlock({}).split('\n')[0] || '',
).trim();

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Resolves the instruction block for this relay, or '' when the preview lane
 * is off. Preview settings only change on relay restart, so the answer is
 * cached: this must not become a per-turn HTTP call.
 */
export function createPreviewInstructionsProvider({
  api,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  let cachedText = '';
  let cachedUntil = 0;
  let inFlight = null;

  async function load() {
    const response = await api('GET', '/api/previews');
    const text = response?.enabled === true
      ? renderPreviewInstructionBlock({ publicBaseUrl: response?.publicBaseUrl || '' })
      : '';
    cachedText = text;
    cachedUntil = now() + ttlMs;
    return text;
  }

  return async function getPreviewInstructions() {
    if (typeof api !== 'function') return '';
    if (cachedUntil > now()) return cachedText;
    if (!inFlight) {
      // A failed lookup is deliberately not cached, and yields no block: an
      // unreachable relay must neither lose the capability for the rest of the
      // process nor advertise one that would 503.
      inFlight = load()
        .catch(() => '')
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

/**
 * Swap a guidance document's preview section for the generated block, or drop
 * the section when there is no block. Other sections are untouched.
 */
export function applyPreviewInstructions(baseInstructions = '', previewBlock = '') {
  const base = String(baseInstructions || '');
  const block = String(previewBlock || '').trim();
  const lines = base.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === PREVIEW_INSTRUCTION_HEADING);
  if (start === -1) {
    return [base.trimEnd(), block].filter(Boolean).join('\n\n');
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, start).join('\n').trim();
  const after = lines.slice(end).join('\n').trim();
  return [before, block, after].filter(Boolean).join('\n\n');
}
