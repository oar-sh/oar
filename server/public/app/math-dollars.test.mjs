import test from 'node:test';
import assert from 'node:assert/strict';

import { scanInlineDollars, splitAtLiteralDollars } from './math-dollars.mjs';

const spansOf = (text) => scanInlineDollars(text).spans.map(([open, close]) => text.slice(open, close + 1));
const literalCount = (text) => scanInlineDollars(text).literals.length;

test('two prices in one sentence are dollar signs, not a formula', () => {
  const text = 'This session: $5.95. The earlier one with the helper agent: $5.93. Total: about $11.90.';
  assert.deepEqual(spansOf(text), []);
  assert.equal(literalCount(text), 3);
});

test('prices in the usual shapes stay text', () => {
  for (const text of [
    'Between $5 and $10 a month.',
    'It was $20,000, now $30,000.',
    'Either $5/$10 or free.',
    'A range of $5-$10.',
    'Costs $ 5 and $ 6.',
    'One price only: $7.',
  ]) {
    assert.deepEqual(spansOf(text), [], text);
  }
});

test('inline maths between dollars is kept', () => {
  assert.deepEqual(spansOf('Euler: $e^{i\\pi}+1=0$ holds.'), ['$e^{i\\pi}+1=0$']);
  assert.deepEqual(spansOf('Let $x$ and $y$ be real.'), ['$x$', '$y$']);
  assert.deepEqual(spansOf('$a+b$'), ['$a+b$']);
});

test('a formula directly followed by a digit is still a formula when it looks like TeX', () => {
  assert.deepEqual(spansOf('The term $x^2$3 times.'), ['$x^2$']);
});

test('a price next to real maths: the price is text, the formula is maths', () => {
  const text = 'It costs $5, and $x^2$ is the area.';
  assert.deepEqual(spansOf(text), ['$x^2$']);
  assert.equal(literalCount(text), 1);
});

test('display maths and escaped dollars are left alone', () => {
  assert.deepEqual(scanInlineDollars('$$\\int_0^1 x\\,dx$$ and more'), { spans: [], literals: [] });
  assert.deepEqual(scanInlineDollars('Escaped \\$5 and \\$6.'), { spans: [], literals: [] });
});

test('text is cut at its plain dollar signs only', () => {
  assert.deepEqual(splitAtLiteralDollars('From $5 to $9.'), [
    { text: 'From ', literal: false },
    { text: '$', literal: true },
    { text: '5 to ', literal: false },
    { text: '$', literal: true },
    { text: '9.', literal: false },
  ]);
  assert.deepEqual(splitAtLiteralDollars('Let $x$ be real.'), [{ text: 'Let $x$ be real.', literal: false }]);
  assert.deepEqual(splitAtLiteralDollars(''), [{ text: '', literal: false }]);
});
