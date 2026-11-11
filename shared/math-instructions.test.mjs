import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MATH_INSTRUCTION_HEADING,
  MATH_INSTRUCTION_TEXT,
  renderMathInstructionBlock,
  applyMathInstructions,
} from './math-instructions.mjs';
import { matchInlineMath } from '../server/public/app/markdown-math.mjs';

test('block renders heading plus text, the text as one paragraph', () => {
  assert.equal(renderMathInstructionBlock(), `${MATH_INSTRUCTION_HEADING}\n\n${MATH_INSTRUCTION_TEXT}`);
  // The browser's prompt cleaner drops the heading and the one paragraph under it.
  assert.ok(!MATH_INSTRUCTION_TEXT.includes('\n'));
});

test('the taught notation is the one the web app renders', () => {
  assert.deepEqual(matchInlineMath('$E = mc^2$ inside'), { raw: '$E = mc^2$', tex: 'E = mc^2', display: false });
  assert.match(MATH_INSTRUCTION_TEXT, /\$E = mc\^2\$ inside a sentence/);
  assert.match(MATH_INSTRUCTION_TEXT, /\$\$ \.\.\. \$\$ on lines of its own/);
  assert.match(MATH_INSTRUCTION_TEXT, /bare parentheses or square brackets is not rendered/);
});

test('apply appends the block to a guidance document', () => {
  const applied = applyMathInstructions('# Relay Tool Guidance\n\nAsk through ask_user.');
  assert.ok(applied.startsWith('# Relay Tool Guidance\n\nAsk through ask_user.\n\n'));
  assert.ok(applied.endsWith(renderMathInstructionBlock()));
});

test('apply is idempotent and tolerates empty input', () => {
  const once = applyMathInstructions('base');
  assert.equal(applyMathInstructions(once), once);
  assert.equal(applyMathInstructions(''), renderMathInstructionBlock());
});
