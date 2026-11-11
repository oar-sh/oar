// How agents write formulas in their reply messages, taught once per provider
// through the same four seams as shared/media-embed-instructions.mjs: Claude
// (system-prompt append), Copilot (relay tool guidance document), Cursor and
// Grok (once-per-worker prompt prefix). The web app reads a formula from its
// delimiters only (server/public/app/markdown-math.mjs); a model that writes
// TeX in bare parentheses or brackets gets its source shown, so every agent
// is told the notation that renders.

export const MATH_INSTRUCTION_HEADING = '## Formulas in replies';

export const MATH_INSTRUCTION_TEXT =
  'To show a formula in a reply, write it in TeX between dollar signs: '
  + '$E = mc^2$ inside a sentence, and $$ ... $$ on lines of its own for a '
  + 'displayed formula. The web app renders both with KaTeX; \\( ... \\) and '
  + '\\[ ... \\] work as well. TeX in bare parentheses or square brackets is '
  + 'not rendered. A dollar amount such as $5 stays text.';

export function renderMathInstructionBlock() {
  return `${MATH_INSTRUCTION_HEADING}\n\n${MATH_INSTRUCTION_TEXT}`;
}

/**
 * Append the formula block to a guidance document unless it already carries
 * one (idempotent, like applyMediaEmbedInstructions).
 */
export function applyMathInstructions(baseInstructions = '') {
  const base = String(baseInstructions || '').trimEnd();
  if (base.includes(MATH_INSTRUCTION_HEADING)) return base;
  return [base, renderMathInstructionBlock()].filter(Boolean).join('\n\n');
}
