import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileWordSequence,
  isRegExpWhitespace,
  matchLeadingWordSequence,
  matchWordSequenceAt,
  removeWordSequences,
} from './whitespace-flexible-match.mjs';
import { relayPromptPrefixTextsForTests } from '../../services/relay-prompt-sanitizer.mjs';
import { renderMediaEmbedInstructionBlock } from '../../../shared/media-embed-instructions.mjs';
import { renderMathInstructionBlock } from '../../../shared/math-instructions.mjs';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flexiblePattern(text) {
  return text.trim().split(/\s+/).filter(Boolean).map(escapeRegExp).join('\\s+');
}

const EVERY_CODE_UNIT = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).join('');

test('whitespace is exactly what \\s matches in a regex', () => {
  for (let code = 0; code < 0x10000; code += 1) {
    assert.equal(isRegExpWhitespace(code), /\s/.test(String.fromCharCode(code)), `U+${code.toString(16)}`);
  }
});

test('case folding is exactly that of a regex with the i flag, for every character the prefixes use', () => {
  const texts = [
    ...relayPromptPrefixTextsForTests(''),
    renderMediaEmbedInstructionBlock(),
    renderMathInstructionBlock(),
    'ßſKµİıǅΣσςẞΩÅ',
  ];
  const chars = new Set();
  for (const text of texts) for (const char of text) if (char.length === 1 && !/\s/.test(char)) chars.add(char);
  for (const char of chars) {
    const expected = [];
    for (const match of EVERY_CODE_UNIT.matchAll(new RegExp(escapeRegExp(char), 'gi'))) expected.push(match.index);
    const sequence = compileWordSequence(char);
    const actual = [];
    for (let code = 0; code < 0x10000; code += 1) {
      if (matchWordSequenceAt(EVERY_CODE_UNIT, code, sequence) === code + 1) actual.push(code);
    }
    assert.deepEqual(actual, expected, `characters matching ${JSON.stringify(char)}`);
  }
});

test('a leading sequence matches like an anchored regex with trailing whitespace', () => {
  const cases = [
    ['[Relay mode: agent]', '[Relay mode: agent] fix it'],
    ['[Relay mode: agent]', '[relay MODE:\n agent]\t\n fix it'],
    ['[Relay mode: agent]', '[Relay mode: agent]fix it'],
    ['[Relay mode: agent]', '[Relay mode:agent] fix it'],
    ['[Relay mode: agent]', ' [Relay mode: agent] fix it'],
    ['[Relay mode: agent]', '[Relay mode: agen'],
    ['[Relay mode: agent]', '[Relay mode: agent]'],
    ['[Relay mode: agent]', '[Relay mode: agent]   '],
    ['a b', 'a  b c'],
    ['  a   b  ', 'A　B'],
    ['', '  text'],
  ];
  for (const [expected, input] of cases) {
    const reference = input.replace(new RegExp(`^${flexiblePattern(expected)}\\s*`, 'i'), '');
    const end = matchLeadingWordSequence(input, compileWordSequence(expected));
    assert.equal(end < 0 ? input : input.slice(end), reference, JSON.stringify([expected, input]));
  }
});

test('removing a sequence everywhere matches a global regex replace', () => {
  const cases = [
    ['a a', 'a a a a a'],
    ['a a', 'a\na\ta'],
    ['## Heading text', 'x ## heading\n\nTEXT y ##  Heading text'],
    ['## Heading text', '## Heading tex'],
    ['## Heading text', '## Heading text## Heading text'],
    ['word', ''],
    ['word', 'swordfish word WORDS'],
    ['', 'unchanged'],
  ];
  for (const [expected, input] of cases) {
    const words = expected.trim() ? flexiblePattern(expected) : '';
    const reference = words ? input.replace(new RegExp(words, 'gi'), '') : input;
    assert.equal(removeWordSequences(input, compileWordSequence(expected)), reference, JSON.stringify([expected, input]));
  }
});
