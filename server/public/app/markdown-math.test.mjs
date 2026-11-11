import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';

import {
  MATH_MESSAGE_MAX_CHARS,
  mathAppliesTo,
  mathPlaceholderHtml,
  matchInlineMath,
  matchMathBlock,
  setMathEnabled,
  texForKatex,
  useMathMarkdown,
} from './markdown-math.mjs';

// platform-agnostic: the Windows paths in this file are message text. Nothing
// here opens a path, on any platform.

// The library as the page sets it up (store.js): line breaks kept, maths rules on.
const markdown = new Marked({ breaks: true });
useMathMarkdown(markdown);
const plainMarkdown = new Marked({ breaks: true });

/** The TeX of every formula the Markdown library finds in `source`, in order. */
function formulasIn(source) {
  setMathEnabled(true);
  const html = markdown.parse(source);
  return [...html.matchAll(/<span data-math="(?:inline|display)" data-tex="([^"]*)">/g)]
    .map((match) => match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

const inline = (src, prev = '') => matchInlineMath(src, prev);

// ─── Prose stays text ─────────────────────────────────────────────────

const PROSE = [
  // The message that was shown as one formula: ids, a branch and a Windows path in parentheses.
  'Recorded. LIST on `live` now carries job-0412 (session c3d2e1f0 on boxA, brief job-0412-tidy-and-hop.md, branch fix/tidy-and-hop, worktree D:\\wt\\app\\job-0412, sub_27ac41e9b0, narrowed item 2, checker off boxA, merge card, no deploy). Both corrections applied.',
  'See the helper (step_2 of the list) for details.',
  'Use the caret (press ^2 twice) to move.',
  'Bumped (v1_2 to v1_3) today. Call (items_0, items_1) first.',
  // Folders named like TeX commands.
  'Copied (from C:\\Users\\dev\\to\\file.txt) today. Logs (D:\\git\\app\\log\\run.txt). Paths (C:\\foo\\bar\\end) differ.',
  'Worktree D:\\wt\\app\\job-0412 and C:\\Users\\dev\\to\\file.txt exist.',
  // TeX delimiters inside paths.
  'Folder C:\\Program Files\\(x86)\\app and D:\\tmp\\) stay.',
  'Folders C:\\[old]\\x and D:\\tmp\\] stay.',
  'Two roots (D:\\wt\\) and (C:\\work\\) exist.',
  'The root is D:\\wt\\ and the cache C:\\work\\',
  'Share \\\\filer\\(old)\\x and \\\\filer\\tmp\\) too.',
  // Prices.
  'This run: $5.95. The earlier one: $5.93.',
  'You have $27 left of the $5 cap, or $1,000 total.',
  'It costs $5-$10 or $5/$10 per run.',
  'Spent $5 (of $20) on A$B testing.',
  'Costs ($5) and ($6), or ($7.50).',
  'between $5 or 10$ total',
  'from $5 to 10$ each',
  '€5 and $5, 5€ and 5$',
  'Earned $5🎉 then lost 3$',
  'Cost: $5 and\n$6 more',
  'A costs $5,\nB costs 10$.',
  '| a | b |\n|---|---|\n| $5 | $6 |',
  // Shell.
  'Set $HOME and $PATH before $(pwd) runs.',
  'Use $FOO/$BAR and ${A}_$B here.',
  'Export PATH=$HOME/bin:$PATH and $a$b too.',
  'Compare $(git rev-parse HEAD)$(date) output.',
  'Kill $$ and then wait for $$ again.',
  'Write /tmp/run.$$ and /tmp/out.$$ files.',
  'Kill $$\nthen $$ again',
  'Its id is $$\nand the parent has $$ too.',
  '$$ is the shell PID.\nUse it as $$ in scripts.',
  '$$ expands to PID\nand $$ too',
  '$$ is the shell PID.\n\nAnd more text.',
  // Code.
  'Run `echo $HOME $PATH` and `$(date)` and `\\(x\\)`.',
  '```tex\n$$\\frac{a}{b}$$ and \\(x^2\\) and $y_1$\n```',
  'Text\n\n    $x^2$ and \\(y\\)\n',
  '```math\n\\frac{a}{b}\n',
  // Other languages' dollars and brackets.
  'Pattern (^\\d+$) matches digits and $1 the group; /^\\d+$/ and /^x$/ too.',
  'Call $("#a").hide() then $this->x and $_GET["a"].',
  '[\nordinary bracketed prose\n]',
  'Names like a_b_c and __init__ and sub_1 stay.',
  'Literal \\$x^2\\$ stays.',
  'See [the $5 plan](https://example.com/a$b) and [the $9 plan](https://example.com/c$).',
  // Escaped brackets, as pages turned into Markdown carry them.
  'Paris is the capital. \\[1\\] It has people. \\[2\\]',
  '\\[WIP\\] Fix login',
  '- \\[WIP\\] Fix login\n- \\[DONE\\] Other',
  '- \\[ \\] todo\n- \\[x\\] done',
  '## \\[Unreleased\\]',
  '\\[1\\]',
  '- \\[1\\]\n- \\[2\\]',
  'See:\n\\[x\\]',
  '\\[\\frac{1}{z}\\]',
  // Talk about the notation.
  'Use $...$ for inline and $$...$$ for display.',
  'Wrap with \\(...\\) or \\[...\\] delimiters.',
  // Not closed (a reply still streaming), or closed past a blank line or a code fence.
  'The area is $x^2 + y',
  'So:\n$$\n\\int_0^1 x^2',
  '$$\nx = 1\n\nLater text that ends with $$',
  '$$x\n```\ncode $$\n```',
  // No guessing from bare brackets.
  'Ein Draht mit (0{,}23,\\Omega) bei (20^\\circ\\text{C}).',
  'It maps by\n\n[\n\\frac1z=\\frac{x-iy}{x^2+y^2}\n]\n\nand so on.',
];

test('prose holds no formula', () => {
  for (const source of PROSE) {
    assert.deepEqual(formulasIn(source), [], JSON.stringify(source));
  }
});

// ─── Formulas are found ───────────────────────────────────────────────

const MATHS = [
  ['Energy is $E=mc^2$ here.', ['E=mc^2']],
  ['Energy is \\(E=mc^2\\) here.', ['E=mc^2']],
  ['Let $x$ and $y$ be real, the $n$th and $k$-th.', ['x', 'y', 'n', 'k']],
  ['So ($a_1$) and "$b$" hold; $c$, $d$.', ['a_1', 'b', 'c', 'd']],
  // What Markdown would take for emphasis or a tag stays inside the formula.
  ['Product $a*b*c$ and $x_i y_j$ and $a<b$.', ['a*b*c', 'x_i y_j', 'a<b']],
  ['**$x^2$** done\n\n- item $y_1$\n\n| h |\n|---|\n| $z$ |', ['x^2', 'y_1', 'z']],
  ['# Heading with $x^2$', ['x^2']],
  ['The ratio $\\frac{a}{b}$ holds.', ['\\frac{a}{b}']],
  ['For $7 you get $a\\,b$ here.', ['a\\,b']],
  ['A $3 \\times 3$ matrix with $0$ and $1/2$.', ['3 \\times 3', '0', '1/2']],
  ['Terms $2ab$ and $1, 2, 3$ and $2x+1$.', ['2ab', '1, 2, 3', '2x+1']],
  ['函数$f(x)$的值和\\(g\\)。', ['f(x)', 'g']],
  // Over one line break, after a tag.
  ['where \\(a +\nb\\) holds', ['a +\nb']],
  ['where $a +\nb$ holds', ['a +\nb']],
  ['a<br>$x$', ['x']],
  ['| h |\n|---|\n| x<br>$y$ |', ['y']],
  // Displays.
  ['$$\n\\int_0^1 x^2\\,dx\n$$', ['\\int_0^1 x^2\\,dx']],
  ['So:\n$$\na^2+b^2=c^2\n$$\nand on.', ['a^2+b^2=c^2']],
  ['$$a^2+b^2=c^2$$', ['a^2+b^2=c^2']],
  ['$$ a^2+b^2=c^2 $$', ['a^2+b^2=c^2']],
  ['$$ a = b\n+ c $$', ['a = b\n+ c']],
  ['So $$a^2+b^2=c^2$$ holds.', ['a^2+b^2=c^2']],
  ['We get\n$$\nx^2 + y^2\n$$.\nThen more.', ['x^2 + y^2']],
  ['The formula is: $$\na^2+b^2=c^2\n$$', ['a^2+b^2=c^2']],
  ['We have: $$\na\n$$\nand also: $$\nb\n$$', ['a', 'b']],
  ['$$\na\n$$\nand also: $$\nb\n$$', ['a', 'b']],
  ['$$a$$ and\nthen $$b$$', ['a', 'b']],
  ['$$ never closed\n$$ x $$', ['x']],
  ['\\[\n\\frac{a}{b}\n\\]', ['\\frac{a}{b}']],
  ['So \\[ \\frac{1}{z} \\] holds.', ['\\frac{1}{z}']],
  ['\\[ \\frac{1}{z} \\]', ['\\frac{1}{z}']],
  ['<sub>$x$</sub> and $y$<br>next', ['x', 'y']],
  ['\\[ x = 1 \\]', ['x = 1']],
  ['$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$', ['\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}']],
  ['$$\nx = a\n- b\n$$', ['x = a\n- b']],
  ['- step:\n  $$\n  x = 1\n  $$\n- next', ['x = 1']],
  ['> $$\n> x = 1\n> $$', ['x = 1']],
  ['$$\na\n$$\n\ntext $5\n\n$$\nb\n$$', ['a', 'b']],
  ['```math\n\\frac{a}{b}\n```', ['\\frac{a}{b}']],
  ['Text\n~~~ math\nx^2\n~~~\nmore', ['x^2']],
  ['Water: $\\ce{2H2 + O2 -> 2H2O}$', ['\\ce{2H2 + O2 -> 2H2O}']],
  ['$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$', ['\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}']],
];

test('formulas are found between their delimiters, with their TeX untouched', () => {
  for (const [source, expected] of MATHS) {
    assert.deepEqual(formulasIn(source), expected, JSON.stringify(source));
  }
});

test('what stands around a formula is rendered as before', () => {
  setMathEnabled(true);
  assert.equal(
    markdown.parse('We get\n$$\nx^2\n$$.\nThen **more**.'),
    '<p>We get<br><span data-math="display" data-tex="x^2">$$\nx^2\n$$</span>.<br>Then <strong>more</strong>.</p>\n',
  );
  assert.equal(
    markdown.parse('$$\nx^2\n$$;\n\nNext.'),
    '<p><span data-math="display" data-tex="x^2">$$\nx^2\n$$</span>;</p>\n<p>Next.</p>\n',
  );
  assert.equal(markdown.parse('Costs $5, `$x$` stays.'), plainMarkdown.parse('Costs $5, `$x$` stays.'));
});

test('an image\'s alternative text holds no formula; a link\'s text does', () => {
  setMathEnabled(true);
  for (const source of [
    '![cost $x$ here](https://example.com/b.png)',
    '![so $$y$$ and \\(z\\)](https://example.com/b.png "a $t$ title")',
    '![a *b $x$* "q" <i> & c](https://example.com/b.png)',
    '[![badge $x$](https://example.com/b.png)](https://example.com/)',
    // A reference inside the alt text is resolved as before.
    '![see [foo] $x$][ref]\n\n[foo]: https://example.com/f\n[ref]: https://example.com/b.png',
  ]) {
    assert.equal(markdown.parse(source), plainMarkdown.parse(source), source);
  }
  assert.equal(
    markdown.parse('![cost $x$ here](https://example.com/b.png)'),
    '<p><img src="https://example.com/b.png" alt="cost $x$ here"></p>\n',
  );
  assert.deepEqual(formulasIn('See [the $x^2$ term](https://example.com/) and ![alt $y$](https://example.com/b.png) and $z$.'), ['x^2', 'z']);
});

// ─── Known leftovers: a change in any of them should be a decision ────

test('prose in valid delimiters is a formula: a code span or \\$ keeps it text', () => {
  assert.deepEqual(formulasIn('Call foo \\(see docs\\) now'), ['see docs']);
  assert.deepEqual(formulasIn('job $1a2b$ failed'), ['1a2b']);
  assert.deepEqual(formulasIn('Write inline math as $x$ or \\(x\\).'), ['x', 'x']);
  assert.deepEqual(formulasIn('$$ is one way\nto write $$'), ['is one way\nto write']);
  assert.deepEqual(formulasIn('Call foo `\\(see docs\\)` and job \\$1a2b\\$.'), []);
});

test('formulas that need another spelling', () => {
  // A letter right behind the closing sign, or no boundary before the opening one.
  assert.deepEqual(formulasIn('$x$s and Answer:$x=1$'), []);
  // The table splits its cells at `|` before any formula is read.
  assert.deepEqual(formulasIn('| h |\n|---|\n| $|x|$ |'), []);
  assert.deepEqual(formulasIn('| h |\n|---|\n| $\\lvert x \\rvert$ |'), ['\\lvert x \\rvert']);
});

// ─── The matchers ─────────────────────────────────────────────────────

test('a boundary stands before an opening delimiter', () => {
  for (const prev of ['', ' ', '\n', '(', '[', '{', '"', "'", '-', '的', '—']) {
    assert.equal(inline('$x$', prev)?.tex, 'x', JSON.stringify(prev));
    assert.equal(inline('\\(x\\)', prev)?.tex, 'x', JSON.stringify(prev));
  }
  for (const prev of ['a', '5', ':', '\\', '$', '/', '=', '.', ',', ')', '>']) {
    assert.equal(inline('$x$', prev), null, JSON.stringify(prev));
    assert.equal(inline('\\(x\\)', prev), null, JSON.stringify(prev));
    assert.equal(inline('$$x$$', prev), null, JSON.stringify(prev));
    assert.equal(inline('\\[ x \\]', prev), null, JSON.stringify(prev));
  }
});

test('a closing dollar sign stands before the end, a blank, punctuation or an ordinal ending', () => {
  for (const after of ['', ' ', '\n', '.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '-', '<br>', '</b>', 'th', 'st term', 'nd', 'rd.', '的']) {
    assert.deepEqual(inline(`$n$${after}`), { raw: '$n$', tex: 'n', display: false }, JSON.stringify(after));
  }
  for (const after of ['s', '5', 'x', '(', '[', '$', '=', '_', '/', 'the', 'stone', '`']) {
    assert.equal(inline(`$n$${after}`), null, JSON.stringify(after));
  }
});

test('only the next dollar sign can close, and an escaped one is part of the formula', () => {
  assert.equal(inline('$5, and $x^2$'), null);
  assert.equal(inline('$x^2$', ' ')?.tex, 'x^2');
  assert.equal(inline('$a\\$b$')?.tex, 'a\\$b');
  assert.equal(inline('$ x$'), null);
  assert.equal(inline('$x $'), null);
  assert.equal(inline('$x`y`$'), null);
  assert.equal(inline(`$${'x'.repeat(1001)}$`), null);
  assert.equal(inline('$a\nb\nc$'), null, 'two line breaks');
  assert.equal(inline('$a\n\nb$'), null, 'a blank line');
});

test('a pair of prices is no formula; a formula that starts with a number is', () => {
  for (const tex of ['5 or 10', '5 to 10', '27 left of 5', '5, 5€ and 5', '3 apples']) {
    assert.equal(inline(`$${tex}$`), null, tex);
  }
  for (const tex of ['3 \\times 3', '0', '1/2', '2ab', '1, 2, 3', '2x + 1', '5 \\text{ or } 10', '10^{3} or so']) {
    assert.equal(inline(`$${tex}$`)?.tex, tex, tex);
  }
});

test('nothing but dots is talk about the notation', () => {
  for (const source of ['$...$', '$…$', '\\(...\\)', '$$...$$', '\\[ ... \\]', '$\\ldots$', '$$\n...\n$$']) {
    assert.equal(inline(source), null, source);
  }
  assert.equal(matchMathBlock('$$\n...\n$$\n'), null);
  assert.equal(inline('$a, \\ldots, z$')?.tex, 'a, \\ldots, z');
});

test('a display inside a line: $$ without blanks inside, \\[ \\] with them', () => {
  assert.deepEqual(inline('$$x^2$$ holds', ' '), { raw: '$$x^2$$', tex: 'x^2', display: true });
  assert.equal(inline('$$ and then wait for $$ again.', ' '), null);
  assert.equal(inline('$$x^2$$5', ' '), null);
  assert.deepEqual(inline('\\[ x^2 \\] holds', ' '), { raw: '\\[ x^2 \\]', tex: 'x^2', display: true });
  assert.equal(inline('\\[1\\] It has people.', ' '), null);
  assert.equal(inline('\\[WIP\\] Fix login'), null);
});

test('a display over lines: from the start of a line to a line that ends with the closer', () => {
  assert.deepEqual(inline('$$\nx = 1\n$$\nand on'), { raw: '$$\nx = 1\n$$', tex: 'x = 1', display: true });
  assert.deepEqual(inline('$$ a = b\n+ c $$'), { raw: '$$ a = b\n+ c $$', tex: 'a = b\n+ c', display: true });
  assert.deepEqual(inline('\\[\nx\n\\].'), { raw: '\\[\nx\n\\]', tex: 'x', display: true });
  // Opened at the end of a line: the closing line is the closer alone.
  assert.deepEqual(inline('$$\nx\n$$', ' ', { atLineStart: false }), { raw: '$$\nx\n$$', tex: 'x', display: true });
  assert.equal(inline('$$\nthen $$ again', ' ', { atLineStart: false }), null);
  assert.equal(inline('$$\nand the parent has $$', ' ', { atLineStart: false }), null);
  // A closer in the middle of a line belongs to another formula.
  assert.deepEqual(inline('$$a$$ and\nthen b $$'), { raw: '$$a$$', tex: 'a', display: true });
  assert.equal(inline('$$ x\n\n$$'), null, 'a blank line');
  assert.equal(inline('$$x\n```\ncode $$'), null, 'a code fence');
  assert.equal(inline(`$$\n${'x + \n'.repeat(2100)}$$`), null, 'over the size limit');
});

test('a display block takes its closing line with it, punctuation included', () => {
  assert.deepEqual(matchMathBlock('$$\nx = 1\n$$\nnext'), { raw: '$$\nx = 1\n$$\n', source: '$$\nx = 1\n$$', tex: 'x = 1', display: true, trail: '' });
  // The source ends at the closer: the punctuation behind it is rendered once, behind the formula.
  assert.deepEqual(matchMathBlock('  $$ x $$.  \nnext'), { raw: '  $$ x $$.  \n', source: '$$ x $$', tex: 'x', display: true, trail: '.' });
  assert.deepEqual(matchMathBlock('\\[\nx\n\\]'), { raw: '\\[\nx\n\\]', source: '\\[\nx\n\\]', tex: 'x', display: true, trail: '' });
  assert.equal(matchMathBlock('\\[ x \\]:\nnext')?.trail, ':');
  assert.equal(matchMathBlock('\\[1\\]\nnext'), null, 'an escaped bracket');
  assert.equal(matchMathBlock('$$ is the shell PID.\n\nAnd $$'), null);
  assert.equal(matchMathBlock('    $$\nx\n$$'), null, 'four blanks are a code block');
  assert.equal(matchMathBlock('text $$\nx\n$$'), null);
});

test('a fenced math block is a display once it is closed', () => {
  assert.deepEqual(
    matchMathBlock('```math\na\n\nb\n```\nnext'),
    { raw: '```math\na\n\nb\n```\n', source: '```math\na\n\nb\n```', tex: 'a\n\nb', display: true, trail: '' },
  );
  assert.equal(matchMathBlock('~~~~ math\nx\n~~~~')?.tex, 'x');
  assert.equal(matchMathBlock('````math\nx\n```\ny\n````')?.tex, 'x\n```\ny');
  assert.equal(matchMathBlock('```math\nx\n'), null, 'still open: the library shows it as code');
  assert.equal(matchMathBlock('```mathematica\nx\n```'), null);
  assert.equal(matchMathBlock('```tex\nx\n```'), null);
  assert.equal(matchMathBlock('```math\n\n```'), null);
});

test('a bare percent sign is escaped for KaTeX in a one-line formula', () => {
  assert.equal(texForKatex('50%'), '50\\%');
  assert.equal(texForKatex('p < 5% and q > 1%'), 'p < 5\\% and q > 1\\%');
  assert.equal(texForKatex('\\eta_{\\%}'), '\\eta_{\\%}');
  assert.equal(texForKatex('a \\\\% b'), 'a \\\\\\% b', 'an escaped backslash escapes nothing');
  assert.equal(texForKatex('a % a comment\nb'), 'a % a comment\nb', 'over lines a comment stays a comment');
  assert.equal(texForKatex('x^2'), 'x^2');
});

test('the placeholder carries the source as text and the TeX as an attribute', () => {
  assert.equal(
    mathPlaceholderHtml({ raw: '$a<b & "c"$', tex: 'a<b & "c"', display: false }),
    '<span data-math="inline" data-tex="a&lt;b &amp; &quot;c&quot;">$a&lt;b &amp; &quot;c&quot;$</span>',
  );
  assert.equal(
    mathPlaceholderHtml({ raw: '$$\nx\n$$\n', tex: 'x', display: true }),
    '<span data-math="display" data-tex="x">$$\nx\n$$</span>',
  );
});

// ─── Switching the rules off ──────────────────────────────────────────

test('maths applies to a message with a delimiter that is not over the size cap', () => {
  assert.equal(mathAppliesTo('Plain prose with (some_id_1) and a path C:\\Users\\dev\\x.'), false);
  assert.equal(mathAppliesTo(''), false);
  assert.equal(mathAppliesTo(null), false);
  for (const source of ['costs $5', 'a \\(x\\)', 'a \\[ x \\]', '```math\nx\n```', '~~~ math\nx\n~~~']) {
    assert.equal(mathAppliesTo(source), true, source);
  }
  assert.equal(mathAppliesTo(`$x$ ${'a'.repeat(MATH_MESSAGE_MAX_CHARS - 4)}`), true);
  assert.equal(mathAppliesTo(`$x$ ${'a'.repeat(MATH_MESSAGE_MAX_CHARS)}`), false);
});

test('with the rules switched off the library renders as it does without them', () => {
  const source = 'Energy is $E=mc^2$ here.\n\n$$\nx\n$$\n\n```math\ny\n```';
  setMathEnabled(false);
  try {
    assert.equal(markdown.parse(source), plainMarkdown.parse(source));
  } finally {
    setMathEnabled(true);
  }
  assert.notEqual(markdown.parse(source), plainMarkdown.parse(source));
});

test('the library asks an inline rule at every step of its inline loop', () => {
  // The previous character is read from the text handed over on the last
  // call (markdown-math.mjs). A library version that asks only where `start`
  // pointed would break that silently.
  const seen = [];
  const probe = new Marked();
  probe.use({ extensions: [{ name: 'probe', level: 'inline', tokenizer(src) { seen.push(src); return undefined; } }] });
  probe.parse('a *b* `c` d');
  assert.deepEqual(seen.slice(0, 5), ['a *b* `c` d', '*b* `c` d', 'b', ' `c` d', '`c` d']);
});

// ─── Speed ────────────────────────────────────────────────────────────

test('no shape of 100,000 characters takes the rules long', () => {
  const shapes = [
    ['ordinary prose with prices', 'Plain prose that costs $5 with (some_id_1) here.\n\n'],
    ['nothing but dollar openers', '$a '],
    ['nothing but prices', '$5 '],
    ['list and emphasis signs', 'a * b _ c '],
    ['one long dollar word', '$xxxxxxxxxx'],
    ['unclosed display openers, one per line', '$$ x\n'],
    ['bare display openers, one per line', '$$\n'],
    ['unclosed bracket openers, one per line', '\\[ x\n'],
    ['displays between text lines, no blank line', 'text\n$$\nx^2\n$$\n'],
    ['real formulas', 'Let $x_i^2$ and \\(\\frac{a}{b}\\) be.\n\n'],
    // One delimiter switches the rules on; the rest of the paragraph holds none.
    ['a formula, then one paragraph of paths', 'C:\\Users\\dev\\x ', '$x$ '],
    ['a price, then one paragraph of emphasis signs', 'a * b _ c ', 'Cost $5.\n'],
    ['a price, then one paragraph of code spans', '`a` b ', 'Cost $5.\n'],
  ];
  setMathEnabled(true);
  for (const [name, unit, lead = ''] of shapes) {
    const source = (lead + unit.repeat(Math.ceil(MATH_MESSAGE_MAX_CHARS / unit.length))).slice(0, MATH_MESSAGE_MAX_CHARS);
    const baselineStart = performance.now();
    plainMarkdown.parse(source);
    const baseline = performance.now() - baselineStart;
    const start = performance.now();
    markdown.parse(source);
    const took = performance.now() - start;
    // Generous for a loaded CI runner: the quadratic walks this guards
    // against took 4 to 140 seconds.
    assert.ok(took < 3000 + baseline * 3, `${name}: ${Math.round(took)} ms (the library alone: ${Math.round(baseline)} ms)`);
  }
});
