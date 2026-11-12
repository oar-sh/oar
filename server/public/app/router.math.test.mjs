import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as markedLibrary from 'marked';
import katex from 'katex';

// platform-agnostic: the Windows paths in this file are message text. Nothing
// here opens a path, on any platform.

// A reply through the page's own renderer, with the Markdown library and
// KaTeX the page loads: the versions are pinned to the page's (last test).
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.marked = markedLibrary;
globalThis.katex = katex;
await import('katex/contrib/mhchem');

const { renderMarkdownPreview } = await import('./router.js');
const { MATH_ENVIRONMENTS, MATH_MESSAGE_MAX_CHARS } = await import('./markdown-math.mjs');

function render(source, allowEmbeddedHtml = false) {
  const box = document.createElement('div');
  box.innerHTML = renderMarkdownPreview(source, allowEmbeddedHtml);
  return box;
}
/** The TeX of the formulas KaTeX set, as its own annotation carries it. */
const rendered = (box) => [...box.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent);
const text = (box) => box.textContent.replace(/\s+/g, ' ').trim();

test('the reply that was shown as one formula is prose', () => {
  const source = 'Recorded. LIST on `live` now carries job-0412 (session c3d2e1f0 on boxA, brief job-0412-tidy-and-hop.md, '
    + 'branch fix/tidy-and-hop, worktree D:\\wt\\app\\job-0412, sub_27ac41e9b0, narrowed item 2, no deploy). Both applied.';
  const box = render(source);
  assert.equal(box.querySelector('.katex, [data-math]'), null);
  assert.equal(text(box), source.replace(/`/g, ''));
});

test('prices, shell variables and paths are rendered as the library renders them alone', () => {
  const plain = new markedLibrary.Marked({ breaks: true });
  for (const source of [
    'This run: $5.95. The earlier one: $5.93.',
    'Use $FOO/$BAR, then $(git rev-parse HEAD)$(date).',
    'Folder C:\\Program Files\\(x86)\\app and D:\\tmp\\) stay.',
    'See the helper (step_2 of the list) and (C:\\Users\\dev\\to\\file.txt).',
    'between $5 or 10$ total',
  ]) {
    assert.equal(renderMarkdownPreview(source, false), plain.parse(source), source);
  }
});

test('an inline formula is set by KaTeX inside its placeholder', () => {
  const box = render('Energy is $E=mc^2$ here, and \\(a_1\\) too.');
  assert.deepEqual(rendered(box), ['E=mc^2', 'a_1']);
  const spans = [...box.querySelectorAll('span[data-math]')];
  assert.deepEqual(spans.map((span) => span.getAttribute('data-math')), ['inline', 'inline']);
  assert.ok(spans.every((span) => span.firstElementChild?.classList.contains('katex')));
  assert.ok(spans.every((span) => !span.hasAttribute('data-tex')), 'the TeX is in the annotation; the attribute is dropped');
  assert.equal(box.querySelector('.katex-display'), null);
  assert.ok(text(box).startsWith('Energy is '));
  assert.ok(text(box).endsWith(' too.'));
});

test('displays are set in display mode: $$ and \\[ \\] blocks, inside a sentence, a math fence', () => {
  for (const [source, tex] of [
    ['$$\n\\int_0^1 x^2\\,dx\n$$', '\\int_0^1 x^2\\,dx'],
    ['So:\n$$\na^2+b^2=c^2\n$$\nand on.', 'a^2+b^2=c^2'],
    ['So $$a^2+b^2=c^2$$ holds.', 'a^2+b^2=c^2'],
    ['\\[\n\\frac{a}{b}\n\\]', '\\frac{a}{b}'],
    ['```math\n\\frac{a}{b}\n```', '\\frac{a}{b}'],
    ['$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$', '\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}'],
  ]) {
    const box = render(source);
    assert.deepEqual(rendered(box), [tex], source);
    assert.ok(box.querySelector('span[data-math="display"] > .katex-display'), source);
  }
});

// The bare environment a model wrote at the start of a line, without `$$`.
const BARE_ALIGN = '\\begin{align*}\nf(x) &= (x+1)^2 - 1 \\\\\n&= x^2 + 2x \\\\\n&= x(x+2)\n\\end{align*}';

test('a bare environment at the start of a line is set as a display, its source untouched', () => {
  for (const source of [BARE_ALIGN, `The expansion:\n${BARE_ALIGN}\nSo it factors.`, `Before.\n\n${BARE_ALIGN}\n\nAfter.`]) {
    const box = render(source);
    assert.deepEqual(rendered(box), [BARE_ALIGN], source);
    assert.ok(box.querySelector('span[data-math="display"] > .katex-display'), source);
    assert.equal(box.querySelector('.math-source'), null, source);
  }
  assert.equal(text(render('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}.')).endsWith('.'), true);
  // `$$` around an environment is read as before.
  assert.deepEqual(rendered(render('$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$')), ['\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}']);
});

test('every accepted environment is one the bundled KaTeX sets in display mode', () => {
  const body = (environment) => {
    if (environment === 'CD') return 'A @>>> B';
    if (/^(?:align(?:ed)?at\*?|alignedat)$/.test(environment)) return '{1} a &= b \\\\ c &= d';
    if (/^(?:d?array|subarray)$/.test(environment)) return '{c} a \\\\ b';
    if (/^equation\*?$/.test(environment)) return 'a = b';
    return 'a & b \\\\ c & d';
  };
  for (const environment of MATH_ENVIRONMENTS) {
    const source = `\\begin{${environment}}${body(environment)}\\end{${environment}}`;
    const box = render(source);
    assert.deepEqual(rendered(box), [source], environment);
    assert.equal(box.querySelector('.math-source'), null, environment);
  }
  // What KaTeX does not know is prose, as before.
  for (const source of ['\\begin{document}\ntext\n\\end{document}', '\\begin{itemize}\n\\item a\n\\end{itemize}', '\\begin{multline}\na \\\\\nb\n\\end{multline}']) {
    assert.equal(render(source).querySelector('[data-math]'), null, source);
  }
});

test('a bare environment is not read in a sentence, in code, or before its end arrives', () => {
  for (const source of [
    'See \\begin{align} inside a sentence \\end{align} here.',
    'Run `\\begin{align} x \\end{align}` as code.',
    '```latex\n\\begin{align}\nx &= 1\n\\end{align}\n```',
    '\\begin{align*}\nf(x) &= (x+1)^2 - 1 \\\\\n&= x^2 + 2x',
  ]) {
    assert.equal(render(source).querySelector('[data-math]'), null, source);
  }
  // Still streaming: text, as an unclosed `$$` is; a formula once the end arrives.
  const open = render('The expansion:\n\\begin{align*}\nf(x) &= (x+1)^2 - 1 \\\\\n&= x^2 + 2x');
  assert.equal(open.innerHTML.trim(), '<p>The expansion:<br>\\begin{align*}<br>f(x) &amp;= (x+1)^2 - 1 \\<br>&amp;= x^2 + 2x</p>');
  assert.deepEqual(rendered(render(`The expansion:\n${BARE_ALIGN}`)), [BARE_ALIGN]);
});

test('a bare environment KaTeX refuses is shown as written, its double backslashes intact', () => {
  const source = '\\begin{align*}\nx &= \\nosuchmacro{y} \\\\\n&= z\n\\end{align*}';
  const box = render(`${source}.\nNext.`);
  assert.equal(box.querySelector('.katex'), null);
  assert.equal(box.querySelector('span.math-source').textContent, source);
  assert.equal(box.querySelector('span.math-source').getAttribute('data-math'), 'display');
  assert.equal(box.textContent.trim(), `${source}.\nNext.`);
});

test('punctuation straight behind an inline formula stays with it', () => {
  const box = render('Used to check recovery: $x^2 + y^2$. Then ($a_1$), and "$b$"; 函数$f(x)$。');
  const tails = [...box.querySelectorAll('span.math-tail')];
  assert.deepEqual(tails.map((tail) => tail.lastChild.textContent), ['.', '),', '";', '。']);
  assert.ok(tails.every((tail) => tail.childNodes.length === 2 && tail.firstChild.matches('span[data-math="inline"]') && tail.firstChild.querySelector('.katex')));
  assert.ok(tails.every((tail) => tail.lastChild.nodeType === 3));
  assert.equal(text(box).startsWith('Used to check recovery: '), true);
  assert.equal(text(box).endsWith('。'), true);
  assert.deepEqual(rendered(box), ['x^2 + y^2', 'a_1', 'b', 'f(x)']);
  // Curly quotes and an ellipsis; at most three marks go along.
  assert.deepEqual([...render('“$p$”’ and $q$…!?) end').querySelectorAll('span.math-tail')].map((tail) => tail.lastChild.textContent), ['”’', '…!?']);
});

test('no wrapper where nothing follows the formula, around a display, or around a refused formula', () => {
  assert.equal(render('Take $x$ and $y$ here').querySelector('.math-tail'), null);
  assert.equal(render('$x$').querySelector('.math-tail'), null);
  assert.equal(render('So $$x^2$$. Then\n$$\ny\n$$.').querySelector('.math-tail'), null);
  assert.equal(render('Broken $\\nosuchmacro$. Fine.').querySelector('.math-tail'), null);
  assert.equal(render('Take $x$<br>next').querySelector('.math-tail'), null);
  assert.equal(render('Use $...$ for inline, and $5 or $6. Also `$x$`.').querySelector('.math-tail, [data-math]'), null);
});

test('macros a message defines carry over to its later formulas', () => {
  const source = 'Let $\\def\\R{\\mathbb{R}}$ and $\\newcommand{\\vect}[1]{\\mathbf{#1}}$ and $\\gdef\\eps{\\varepsilon}$. '
    + 'Then $\\R^2$, $\\vect{v}$ and $\\eps > 0$.';
  const box = render(source);
  assert.equal(box.querySelector('.math-source'), null, 'every formula is set');
  assert.deepEqual(rendered(box).slice(3), ['\\R^2', '\\vect{v}', '\\eps > 0']);
  assert.equal(box.querySelectorAll('.katex-html').length, 6);
  // In document order: a use before its definition stays as written.
  const early = render('First $\\foo$, then $\\def\\foo{x}$, then $\\foo$.');
  assert.deepEqual([...early.querySelectorAll('.math-source')].map((span) => span.textContent), ['$\\foo$']);
  assert.deepEqual(rendered(early), ['\\def\\foo{x}', '\\foo']);
  // Through a display and a bare environment as well.
  assert.equal(render('$$\\gdef\\half{\\frac12}$$\n\n\\begin{align}\nx &= \\half\n\\end{align}\n\nand $\\half$.').querySelector('.math-source'), null);
});

test('nothing of a message\'s macros leaks into another rendering, or into the cache', () => {
  const alone = () => [...render('Here $\\lone$ stands.').querySelectorAll('.math-source')].map((span) => span.textContent);
  assert.deepEqual(alone(), ['$\\lone$'], 'refused before any definition, and remembered as refused');
  const defined = render('Let $\\def\\lone{\\ell}$; here $\\lone$ stands.');
  assert.equal(defined.querySelector('.math-source'), null, 'set once defined, not served from the cache');
  assert.deepEqual(alone(), ['$\\lone$'], 'the next rendering starts without macros');
  assert.equal(render('Let $\\def\\lone{\\ell}$; here $\\lone$ stands.').querySelector('.math-source'), null, 'the definition takes effect on every rendering');
  // A streaming re-render of the same text is the same HTML each time.
  const streamed = 'Let $\\def\\lone{\\ell}$; here $\\lone$ stands';
  assert.equal(renderMarkdownPreview(streamed, false), renderMarkdownPreview(`${streamed}.`, false).replace('stands.</p>', 'stands</p>'));
});

test('macros keep KaTeX\'s limits: no redefining a built-in, no endless expansion, nothing trusted', () => {
  // \R is KaTeX's own: \newcommand refuses it and the built-in stays.
  const builtIn = render('$\\newcommand{\\R}{x}$ and $\\R$.');
  assert.deepEqual([...builtIn.querySelectorAll('.math-source')].map((span) => span.textContent), ['$\\newcommand{\\R}{x}$']);
  assert.deepEqual(rendered(builtIn), ['\\R']);
  // An expansion that never ends is stopped by maxExpand and shown as written.
  const endless = render('$\\def\\grow{\\grow\\grow}$ then $\\grow$.');
  assert.deepEqual([...endless.querySelectorAll('.math-source')].map((span) => span.textContent), ['$\\grow$']);
  // A macro cannot smuggle in a link.
  const link = render('$\\def\\go{\\href{https://example.com/}{y}}$ then $\\go$.');
  assert.equal(link.querySelector('a'), null);
  assert.doesNotMatch(link.innerHTML, /cc0000|color:\s*red/i);
});

test('what Markdown would eat stays in the formula: emphasis signs, a less-than sign, escapes', () => {
  assert.deepEqual(rendered(render('Product $a*b*c$ and $x_i y_j$ and $a<b$ and $\\eta_{\\%}$.')), ['a*b*c', 'x_i y_j', 'a<b', '\\eta_{\\%}']);
  assert.deepEqual(rendered(render('$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$')), ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}']);
});

test('chemistry is set through mhchem', () => {
  assert.deepEqual(rendered(render('Water: $\\ce{2H2 + O2 -> 2H2O}$')), ['\\ce{2H2 + O2 -> 2H2O}']);
});

test('a percent sign in a formula is shown, not read as the start of a comment', () => {
  const box = render('In $50%$ of cases, with $p < 5%$.');
  assert.deepEqual([...box.querySelectorAll('.katex-html')].map((node) => node.textContent), ['50%', 'p<5%']);
});

test('a formula KaTeX refuses is shown as its source, in the text colour', () => {
  const box = render('A broken one: $\\nosuchmacro{x}$ and $x^$ stay.');
  assert.equal(box.querySelector('.katex, .katex-error'), null);
  assert.deepEqual([...box.querySelectorAll('span.math-source')].map((span) => span.textContent), ['$\\nosuchmacro{x}$', '$x^$']);
  assert.equal(text(box), 'A broken one: $\\nosuchmacro{x}$ and $x^$ stay.');
  // A refused display keeps its lines, and the punctuation behind it stands once.
  const display = render('$$\n\\nosuchmacro\n+ 1\n$$.');
  assert.equal(display.querySelector('span.math-source').textContent, '$$\n\\nosuchmacro\n+ 1\n$$');
  assert.equal(display.textContent.trim(), '$$\n\\nosuchmacro\n+ 1\n$$.');
});

test('a command KaTeX does not trust is set in the text colour, not in red', () => {
  for (const source of ['$\\href{https://example.com/}{y}$', '$\\url{https://example.com/}$', '$\\includegraphics{a.png}$', '$\\htmlClass{a}{y}$']) {
    const box = render(`See ${source} here.`);
    assert.doesNotMatch(box.innerHTML, /cc0000|color:\s*red/i, source);
    assert.equal(box.querySelector('a, img'), null, source);
  }
});

test('an image\'s alternative text is an attribute, with no formula in it', () => {
  const box = render('![cost $x$ here](https://example.com/b.png) and $y$.');
  assert.equal(box.querySelector('img').getAttribute('alt'), 'cost $x$ here');
  assert.deepEqual(rendered(box), ['y']);
  assert.equal(text(box), 'and y.'.replace('y', box.querySelector('.katex').textContent));
});

test('prose that got past the delimiter rules with a backslash word in it still reads as prose', () => {
  const box = render('Moved \\(the worktree D:\\wt\\app\\) today.');
  assert.equal(box.querySelector('.katex'), null);
  assert.equal(text(box), 'Moved \\(the worktree D:\\wt\\app\\) today.');
});

test('a formula that is not closed yet is text, and a formula once it is', () => {
  assert.deepEqual(rendered(render('The area is $x^2 + y')), []);
  assert.deepEqual(rendered(render('The area is $x^2 + y^2$')), ['x^2 + y^2']);
  const open = render('So:\n$$\n\\int_0^1 x^2');
  assert.equal(open.querySelector('[data-math]'), null);
  assert.equal(open.innerHTML.trim(), '<p>So:<br>$$<br>\\int_0^1 x^2</p>');
  assert.deepEqual(rendered(render('So:\n$$\n\\int_0^1 x^2\\,dx\n$$')), ['\\int_0^1 x^2\\,dx']);
});

test('each formula is set once: a reply rendered again takes it from the cache', (t) => {
  const calls = [];
  const original = katex.renderToString;
  t.mock.method(katex, 'renderToString', (tex, options) => { calls.push(tex); return original.call(katex, tex, options); });
  const source = 'Take $q_7 + q_8$ and $q_7 + q_8$ again, and $\\nosuchcommand_9$.';
  const first = renderMarkdownPreview(source, false);
  assert.deepEqual(calls, ['q_7 + q_8', '\\nosuchcommand_9']);
  assert.equal(renderMarkdownPreview(`${source} More text.`, false).replace(' More text.', ''), first);
  assert.equal(calls.length, 2, 'a refusal is remembered as well');
});

test('without KaTeX a formula reads as its source', () => {
  const loaded = globalThis.katex;
  globalThis.katex = undefined;
  try {
    const box = render('Energy is $E=mc^2$ here.');
    assert.equal(box.querySelector('.katex'), null);
    assert.equal(text(box), 'Energy is $E=mc^2$ here.');
  } finally {
    globalThis.katex = loaded;
  }
});

test('a message over the size cap is rendered without maths', () => {
  const filler = 'Plain prose. '.repeat(Math.ceil(MATH_MESSAGE_MAX_CHARS / 13));
  assert.deepEqual(rendered(render(`Energy is $E=mc^2$ here.\n\n${filler}`)), []);
  assert.deepEqual(rendered(render(`Energy is $E=mc^2$ here.\n\n${filler.slice(0, 2000)}`)), ['E=mc^2']);
});

test('the sanitiser keeps the placeholder attributes on a span, and nothing else of them', () => {
  // A previewed file may carry HTML: a placeholder written by hand is set like any formula.
  const byHand = render('<span data-math="inline" data-tex="x^2">x squared</span>', true);
  assert.deepEqual(rendered(byHand), ['x^2']);
  const refused = render('<span data-math="block" data-tex="x^2" onclick="x()">kept</span> <div data-math="inline" data-tex="y^2">a div</div>', true);
  assert.deepEqual(rendered(refused), []);
  assert.equal(refused.querySelector('[data-math], [onclick]'), null);
  assert.equal(text(refused), 'kept a div');
  // In a reply, HTML is text.
  const reply = render('<span data-math="inline" data-tex="x^2">x squared</span>');
  assert.deepEqual(rendered(reply), []);
  assert.equal(reply.querySelector('[data-math]'), null);
});

test('the page loads the versions the tests run on', async () => {
  const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const indexHtml = await read('../index.html');
  const { devDependencies } = JSON.parse(await read('../../../package.json'));
  const loaded = (name) => [...new Set([...indexHtml.matchAll(new RegExp(`/npm/${name}@([^/"]+)/`, 'g'))].map((match) => match[1]))];

  // Exact pins, so a test run and the page cannot drift apart unnoticed.
  assert.deepEqual(loaded('marked'), [devDependencies.marked]);
  assert.deepEqual(loaded('katex'), [devDependencies.katex], 'KaTeX: its script, its stylesheet and mhchem are one version');
  assert.match(devDependencies.marked, /^\d+\.\d+\.\d+$/);
  assert.match(devDependencies.katex, /^\d+\.\d+\.\d+$/);
  assert.equal(katex.version, devDependencies.katex);
  const installedMarked = JSON.parse(await read('../../../node_modules/marked/package.json'));
  assert.equal(installedMarked.version, devDependencies.marked, 'the installed Markdown library is the pinned one');
  assert.ok(!indexHtml.includes('auto-render'), 'formulas are read by markdown-math.mjs, not by auto-render');

  // Each KaTeX tag carries the hash of the file the pinned package holds:
  // the CDN serves the package's files, so the browser refuses anything else.
  const readBytes = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)));
  for (const file of ['dist/katex.min.css', 'dist/katex.min.js', 'dist/contrib/mhchem.min.js']) {
    const tag = indexHtml.split('\n').find((line) => line.includes(`/npm/katex@${devDependencies.katex}/${file}"`));
    assert.ok(tag, `${file} is loaded`);
    const sha384 = createHash('sha384').update(await readBytes(`../../../node_modules/katex/${file}`)).digest('base64');
    assert.ok(tag.includes(`integrity="sha384-${sha384}"`), `${file}: integrity is the installed file's sha384`);
    assert.ok(tag.includes('crossorigin="anonymous"'), `${file}: a cross-origin integrity check needs crossorigin`);
  }
});

test('input LaTeX would not take is set without a warning: strict is ignore', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
  // An emoji has no character metrics; Unicode text in math mode and \\ in display are non-strict input.
  assert.deepEqual(rendered(render('Mood $x + 🎉$ and $é = 1$.')), ['x + 🎉', 'é = 1']);
  assert.deepEqual(rendered(render('$$a \\\\ b$$')), ['a \\\\ b']);
  assert.deepEqual(warnings, []);
});
