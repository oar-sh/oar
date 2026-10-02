import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
};
globalThis.sessionStorage = {
  getItem() { return ''; },
  setItem() {},
};

const { normalizeMathDelimiters } = await import('./router.js');

test('normalizes Copilot bracketed TeX displays for KaTeX', () => {
  const source = [
    'It maps the complex plane by',
    '',
    '[',
    '\\frac1z=\\frac{x-iy}{x^2+y^2}',
    ']',
    '',
    'and preserves prose.',
  ].join('\n');

  assert.equal(normalizeMathDelimiters(source), [
    'It maps the complex plane by',
    '',
    '$$\\frac1z=\\frac{x-iy}{x^2+y^2}$$',
    '',
    'and preserves prose.',
  ].join('\n'));
});

test('normalizes standard multiline display delimiters before Markdown inserts line breaks', () => {
  assert.equal(normalizeMathDelimiters('$$\n\\int_0^1 x^2\\,dx\n$$'), '$$\\int_0^1 x^2\\\\,dx$$');
  assert.equal(normalizeMathDelimiters('\\[\n\\ce{2H2 + O2 -> 2H2O}\n\\]'), '$$\\ce{2H2 + O2 -> 2H2O}$$');
  assert.equal(normalizeMathDelimiters('\\[\\frac{1}{z}\\]'), '$$\\frac{1}{z}$$');
});

test('does not treat ordinary brackets or fenced code as mathematical displays', () => {
  const source = [
    '[',
    'ordinary bracketed prose',
    ']',
    '',
    '```tex',
    '[',
    '\\frac1z',
    ']',
    '```',
  ].join('\n');

  assert.equal(normalizeMathDelimiters(source), source);
});

test('normalizes strict TeX-like parenthesized inline math without changing ordinary text', () => {
  const source = 'Ein Draht mit (0{,}23,\\Omega) bei (20^\\circ\\text{C}) hat bei (70^\\circ\\text{C}) ungefähr';

  assert.equal(
    normalizeMathDelimiters(source),
    'Ein Draht mit $0{,}23,\\Omega$ bei $20^\\circ\\text{C}$ hat bei $70^\\circ\\text{C}$ ungefähr',
  );
  assert.equal(
    normalizeMathDelimiters('Visit (https://example.com/a_b), keep (ordinary text), and show `\\Omega`.'),
    'Visit (https://example.com/a_b), keep (ordinary text), and show `\\Omega`.',
  );
  assert.equal(normalizeMathDelimiters('$f(\\Omega)$ and \\(x^2\\)'), '$f(\\Omega)$ and $x^2$');
});

test('preserves TeX escapes that Markdown would otherwise consume', () => {
  assert.equal(
    normalizeMathDelimiters('$\\eta_{\\%}$'),
    '$\\eta_{\\\\%}$',
  );
  assert.equal(normalizeMathDelimiters('`$\\eta_{\\%}$`'), '`$\\eta_{\\%}$`');
});

test('prices do not open dollar maths: the text between two prices is left as it is', () => {
  // Backslashes between the two signs would be doubled if the pair counted as a formula.
  const prices = 'This run: $5.95, see docs\\_old. The earlier one: $5.93.';
  assert.equal(normalizeMathDelimiters(prices), prices);
  // TeX-style parentheses after a price are still converted: the price opened nothing.
  assert.equal(normalizeMathDelimiters('It costs $5 and \\(x^2\\) is the area, for $9.'), 'It costs $5 and $x^2$ is the area, for $9.');
});

test('real dollar maths keeps its escape protection next to a price', () => {
  assert.equal(normalizeMathDelimiters('For $7 you get $a\\,b$ here.'), 'For $7 you get $a\\\\,b$ here.');
});
