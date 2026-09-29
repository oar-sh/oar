import test from 'node:test';
import assert from 'node:assert/strict';

import { strictStrikethroughTokenizer, useStrictStrikethrough } from './markdown-strikethrough.mjs';

// The tokenizer runs with the library's tokenizer as `this`.
const library = { lexer: { inlineTokens: (text) => [{ type: 'text', raw: text, text }] } };
const tokenize = (src) => strictStrikethroughTokenizer.call(library, src);

test('two tildes on each side strike the text between them', () => {
  assert.deepEqual(tokenize('~~gone~~ and the rest'), {
    type: 'del',
    raw: '~~gone~~',
    text: 'gone',
    tokens: [{ type: 'text', raw: 'gone', text: 'gone' }],
  });
  assert.equal(tokenize('~~two words~~').text, 'two words');
});

test('a single tilde means "about" and strikes nothing', () => {
  // The library calls the tokenizer at each tilde.
  assert.equal(tokenize('~35s), followed by the full suite in the background (~7-11 min).'), undefined);
  assert.equal(tokenize('~7-11 min).'), undefined);
  assert.equal(tokenize('~one~'), undefined);
  assert.equal(tokenize('~/notes/lantern.md and ~/notes/harbour.md'), undefined);
});

test('what is not a pair of double tildes is left alone', () => {
  assert.equal(tokenize('~~ spaced out ~~'), undefined);
  assert.equal(tokenize('~~never closed'), undefined);
  assert.equal(tokenize(''), undefined);
});

test('the rule is installed as a tokenizer of the library', () => {
  const used = [];
  assert.equal(useStrictStrikethrough({ use: (extension) => used.push(extension) }), true);
  assert.equal(used[0].tokenizer.del, strictStrikethroughTokenizer);
  assert.equal(useStrictStrikethrough(null), false);
  assert.equal(useStrictStrikethrough({}), false);
});
