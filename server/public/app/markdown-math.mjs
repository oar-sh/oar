// Maths in Markdown: which stretches of a reply are formulas.
//
// A formula is read from its delimiters, never guessed from what stands in a
// parenthesis: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` as a display, and
// a fenced `math` block. The rules are tokenizers of the Markdown library, so
// code spans, code blocks, link targets and HTML are out of reach by
// construction, and the formula text reaches KaTeX as it was written (Markdown
// never sees its `\,`, `*` or `_`).
//
// The rules, in full:
// - A boundary stands before an opening delimiter: the start of the text,
//   whitespace, one of `( [ { " ' -`, a non-ASCII character, a line break or
//   an HTML tag. `C:\Program Files\(x86)` and `A$B` open nothing.
// - `$…$`: a non-space after the opening sign; only the next unescaped `$`
//   closes, after a non-space, and before the end, whitespace, punctuation, an
//   HTML tag, a non-ASCII character or an ordinal ending (`$n$th`). At most one line break
//   inside, no backtick. `$5 and $9`, `$HOME/$PATH`, `$(a)$(b)` and the two
//   signs of `/^a$/ or /^b$/` stay text.
// - `$5 or 10$`: a number first, a plain word between spaces and nothing of
//   TeX is a pair of prices. This is the one rule that looks at the content.
// - `\(…\)`: closes within one line break.
// - `$$…$$` inside a line: no space inside either end.
// - `\[ … \]` on one line, wherever it stands: a space inside both ends, as
//   `\[1\]`, `\[x\]` and `## \[Unreleased\]` are escaped brackets.
// - A display that opens at the start of a line runs to a line that ends with
//   its closer. One that opens at the end of a line ("So: $$") runs to a line
//   that is the closer alone. One of `. , ; :` may follow the closer.
// - Nothing but dots is no formula: `$...$` is talk about the notation.
// What KaTeX then refuses is shown as the source it was (router.js).

const MAX_INLINE_CHARS = 1000;
const MAX_BRACKET_LINE_CHARS = 2000;
const MAX_DISPLAY_CHARS = 10_000;
/** A longer message is rendered without maths, at the Markdown library's own speed. */
export const MATH_MESSAGE_MAX_CHARS = 100_000;

const OPEN_BOUNDARY = /[\s(\[{"'\-]/;
const CLOSE_BOUNDARY = /^[\s.,;:!?)\]}"'\-<]/;
const ORDINAL_ENDING = /^(?:th|st|nd|rd)\b/;
const ONLY_DOTS = /^(?:[.\u2026\s]|\\l?dots)+$/;
const PRICE_START = /^\d/;
const TEX_CHARACTER = /[\\^_{}]/;
const PLAIN_WORD = /(?:^|\s)[A-Za-z]{2,}(?=\s|$)/;
const BLANK_REST = /^[ \t]*(?:\n|$)/;
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})/;
const CLOSING_LINE = /^(.*?)(\$\$|\\\])([.,;:]?)[ \t]*$/;
const MATH_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*math[ \t]*(?:\n|$)/;

function isSpace(char) {
  return char === undefined || char === '' || /\s/.test(char);
}

function boundaryBefore(prev) {
  return !prev || OPEN_BOUNDARY.test(prev) || prev.charCodeAt(0) > 127;
}

function boundaryAfter(rest) {
  return rest === '' || CLOSE_BOUNDARY.test(rest) || rest.charCodeAt(0) > 127 || ORDINAL_ENDING.test(rest);
}

function isFormula(tex) {
  return Boolean(tex) && !ONLY_DOTS.test(tex);
}

function looksLikePrices(tex) {
  return PRICE_START.test(tex) && !TEX_CHARACTER.test(tex) && PLAIN_WORD.test(tex);
}

/**
 * The index of `closer` behind `from`, or -1. `closer` is `$`, `$$`, `\)` or
 * `\]`. A backslash escapes the next character. The search ends at the cap,
 * at a second line break (`lineBreaks` allows that many), at a blank line and,
 * for the dollar closers, at a backtick or at a `$` that is not the closer.
 */
function findCloser(src, from, closer, maxChars, lineBreaks) {
  const escapedCloser = closer[0] === '\\';
  const end = Math.min(src.length, from + maxChars);
  let breaks = 0;
  for (let i = from; i < end; i += 1) {
    const char = src[i];
    if (char === '\n') {
      breaks += 1;
      if (breaks > lineBreaks || BLANK_REST.test(src.slice(i + 1, i + 200))) return -1;
      continue;
    }
    if (char === '\\') {
      if (escapedCloser && src[i + 1] === closer[1]) return i;
      i += 1;
      continue;
    }
    if (escapedCloser) continue;
    if (char === '`') return -1;
    if (char === '$') {
      if (closer === '$') return i;
      return src[i + 1] === '$' ? i : -1;
    }
  }
  return -1;
}

/** The closing line `line` is for `closer`, as { texLength, trail }, or null. */
function closingOf(line, closer, closerAlone) {
  const closing = CLOSING_LINE.exec(line);
  if (!closing || closing[2] !== closer || closing[1].includes(closer)) return null;
  if (closerAlone && closing[1].trim()) return null;
  return { texLength: closing[1].length, trail: closing[3] };
}

/**
 * Walks whole lines from `from` to the one that ends the display.
 * @returns {{ texEnd: number, end: number, trail: string } | { stoppedAt: number, hard: boolean }}
 *   the hit, or where the search gave up. `hard`: a blank line, a code
 *   fence, a stray closer or the end of the text ended it, not the size cap.
 */
function findClosingLine(src, from, closer, { closerAlone = false, limitFrom = from } = {}) {
  let lineStart = from;
  while (lineStart < src.length) {
    if (lineStart - limitFrom > MAX_DISPLAY_CHARS) return { stoppedAt: lineStart, hard: false };
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = src.length;
    const line = src.slice(lineStart, lineEnd);
    if (!line.trim() || FENCE_LINE.test(line)) return { stoppedAt: lineStart, hard: true };
    const closing = closingOf(line, closer, closerAlone);
    if (closing) return { texEnd: lineStart + closing.texLength, end: lineEnd, trail: closing.trail };
    // A closer in the middle of a line belongs to another formula.
    if (line.includes(closer)) return { stoppedAt: lineStart, hard: true };
    lineStart = lineEnd + 1;
  }
  return { stoppedAt: src.length, hard: true };
}

/**
 * A display over lines, `src` starting with its opener: from the opener's
 * own line (`closerAlone` false: it may close there, as in `$$ x $$`) to
 * the line that ends with the closer.
 *
 * `memo` remembers, per closer, the whole lines a failed search found without
 * a closing line, so a paragraph of many unclosed openers is walked once.
 * Places are kept as the length of the text still ahead, which names a place
 * whatever `src` is cut to.
 */
function matchDisplayOverLines(src, closer, { closerAlone = false, memo = null } = {}) {
  let firstEnd = src.indexOf('\n', 2);
  if (firstEnd < 0) firstEnd = src.length;
  const firstLine = src.slice(2, firstEnd);
  let hit = null;
  let closingFirst = closerAlone ? null : closingOf(firstLine, closer, false);
  if (closingFirst && closer === '\\]') {
    // On one line, brackets without blanks inside are escaped brackets.
    const inner = firstLine.slice(0, closingFirst.texLength);
    if (!(isSpace(inner[0]) && isSpace(inner[inner.length - 1]))) return null;
  }
  if (closingFirst) {
    hit = { texEnd: 2 + closingFirst.texLength, end: firstEnd, trail: closingFirst.trail };
  } else {
    if (firstLine.includes(closer) || firstEnd >= src.length) return null;
    let from = firstEnd + 1;
    const ahead = src.length - from;
    const known = closerAlone ? null : memo?.[closer];
    const covered = Boolean(known) && known.until < ahead && ahead <= known.from;
    if (covered) {
      if (known.hard) return null;
      from = src.length - known.until;
    }
    hit = findClosingLine(src, from, closer, { closerAlone, limitFrom: 2 });
    if (hit.texEnd === undefined) {
      if (memo && !closerAlone) {
        memo[closer] = { from: covered ? known.from : ahead, until: src.length - hit.stoppedAt, hard: hit.hard };
      }
      return null;
    }
  }
  const tex = src.slice(2, hit.texEnd).trim();
  if (!isFormula(tex)) return null;
  return { raw: src.slice(0, hit.texEnd + closer.length), rawEnd: hit.end, tex, display: true, trail: hit.trail };
}

/**
 * The formula `src` starts with, or null. `prev` is the character before it
 * ('' at the start of the text). `atLineStart` says whether only blanks stand
 * between the last line break and `src`.
 * @returns {{ raw: string, tex: string, display: boolean } | null}
 */
export function matchInlineMath(src, prev = '', { atLineStart = !prev || prev === '\n', memo = null } = {}) {
  const text = String(src ?? '');
  const first = text[0];
  if (first !== '$' && first !== '\\') return null;
  if (!boundaryBefore(prev)) return null;
  const opener = text.slice(0, 2);

  if (opener === '\\(') {
    const close = findCloser(text, 2, '\\)', MAX_INLINE_CHARS, 1);
    if (close < 0) return null;
    const tex = text.slice(2, close).trim();
    return isFormula(tex) ? { raw: text.slice(0, close + 2), tex, display: false } : null;
  }

  if (opener === '$$' || opener === '\\[') {
    const closer = opener === '$$' ? '$$' : '\\]';
    // The opener starts its line, or ends it ("So: $$"): the display runs over lines.
    const opensAtLineEnd = !atLineStart && BLANK_REST.test(text.slice(2, 200)) && text.indexOf('\n', 2) >= 0;
    if (atLineStart || opensAtLineEnd) {
      const overLines = matchDisplayOverLines(text, closer, { closerAlone: opensAtLineEnd, memo });
      if (overLines) return { raw: overLines.raw, tex: overLines.tex, display: true };
    }
    const close = findCloser(text, 2, closer, opener === '$$' ? MAX_DISPLAY_CHARS : MAX_BRACKET_LINE_CHARS, 0);
    if (close < 0) return null;
    const inner = text.slice(2, close);
    if (opener === '$$') {
      if (isSpace(inner[0]) || isSpace(inner[inner.length - 1])) return null;
      if (text[close + 2] === '$' || !boundaryAfter(text.slice(close + 2, close + 5))) return null;
    } else if (!(isSpace(inner[0]) && isSpace(inner[inner.length - 1]))) {
      return null;
    }
    const tex = inner.trim();
    return isFormula(tex) ? { raw: text.slice(0, close + 2), tex, display: true } : null;
  }

  if (first !== '$' || isSpace(text[1])) return null;
  const close = findCloser(text, 1, '$', MAX_INLINE_CHARS, 1);
  if (close < 0 || isSpace(text[close - 1]) || text[close + 1] === '$') return null;
  if (!boundaryAfter(text.slice(close + 1, close + 4))) return null;
  const tex = text.slice(1, close);
  if (!isFormula(tex) || looksLikePrices(tex)) return null;
  return { raw: text.slice(0, close + 1), tex, display: false };
}

function matchMathFence(src) {
  const open = MATH_FENCE_OPEN.exec(src);
  if (!open) return null;
  const fence = open[1];
  let lineStart = open[0].length;
  while (lineStart < src.length) {
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = src.length;
    const line = src.slice(lineStart, lineEnd).trim();
    if (line.length >= fence.length && line[0] === fence[0] && line === line[0].repeat(line.length)) {
      const tex = src.slice(open[0].length, lineStart).trim();
      if (!tex) return null;
      return { raw: src.slice(0, Math.min(src.length, lineEnd + 1)), source: src.slice(0, lineEnd), tex, display: true, trail: '' };
    }
    lineStart = lineEnd + 1;
  }
  // Not closed yet (a reply still streaming): the library shows it as code.
  return null;
}

/**
 * The display block `src` starts with, or null: `$$` or `\[` at the start of
 * a line up to the line that ends with the closer, or a fenced `math` block.
 * `raw` takes the rest of the closing line with it; `source` is the formula
 * as written, up to its closer, and `trail` the punctuation behind that.
 * @returns {{ raw: string, source: string, tex: string, display: true, trail: string } | null}
 */
export function matchMathBlock(src) {
  const text = String(src ?? '');
  const fence = matchMathFence(text);
  if (fence) return fence;
  const open = /^ {0,3}(\$\$|\\\[)/.exec(text);
  if (!open) return null;
  const closer = open[1] === '$$' ? '$$' : '\\]';
  const indent = open[0].length - 2;
  const match = matchDisplayOverLines(text.slice(indent), closer);
  if (!match) return null;
  return {
    raw: text.slice(0, Math.min(text.length, indent + match.rawEnd + 1)),
    source: match.raw,
    tex: match.tex,
    display: true,
    trail: match.trail,
  };
}

/**
 * The TeX handed to KaTeX. In a one-line formula a bare `%` is escaped: TeX
 * reads it as the start of a comment, so `$50%$` came out as "50".
 */
export function texForKatex(tex) {
  const text = String(tex ?? '');
  if (text.includes('\n') || !text.includes('%')) return text;
  return text.replace(/\\[\s\S]|%/g, (match) => (match === '%' ? '\\%' : match));
}

/** Whether `source` holds anything a formula could start with. */
export function sourceHasMathDelimiters(source) {
  const text = String(source ?? '');
  return text.includes('$') || text.includes('\\(') || text.includes('\\[') || /(?:`{3,}|~{3,})[ \t]*math/.test(text);
}

/** Maths applies to `source`: it has a delimiter and is not over the size cap. */
export function mathAppliesTo(source) {
  const text = String(source ?? '');
  return text.length <= MATH_MESSAGE_MAX_CHARS && sourceHasMathDelimiters(text);
}

let mathEnabled = true;

/** Switches the tokenizers off for the next parse (a message without maths, or one over the cap). */
export function setMathEnabled(enabled) {
  mathEnabled = Boolean(enabled);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A formula as a placeholder: its source as text, its TeX in `data-tex`.
 * KaTeX fills it in after the HTML is sanitised (router.js); where KaTeX is
 * missing or refuses the formula, the placeholder stays, and reads as the
 * source that was written.
 */
export function mathPlaceholderHtml({ raw, tex, display }) {
  const mode = display ? 'display' : 'inline';
  return `<span data-math="${mode}" data-tex="${escapeHtml(tex)}">${escapeHtml(String(raw ?? '').trim())}</span>`;
}

// Per list of inline tokens: the text the tokenizer was handed on its last
// call, and what failed searches for a closing line found. The library asks
// the tokenizer at every step of its inline loop, so the text handed over
// last ends where the current one begins, and the character before `src` is
// read in constant time. (The last token's own `raw` grows by concatenation;
// reading its end is quadratic over a long paragraph.)
const inlineRuns = new WeakMap();

function inlineMathTokenizer(src, tokens) {
  if (!mathEnabled) return undefined;
  let run = inlineRuns.get(tokens);
  const before = run ? run.src : null;
  if (!run) {
    run = { src, memo: {}, nextOpenerAhead: undefined };
    inlineRuns.set(tokens, run);
  } else {
    run.src = src;
  }
  activeRun = run;
  const first = src[0];
  if (first !== '$' && first !== '\\') return undefined;

  let prev = '';
  let atLineStart = true;
  const last = tokens.length ? tokens[tokens.length - 1] : null;
  if (before !== null && !(last && (last.type === 'html' || last.type === 'br'))) {
    let index = before.length - src.length - 1;
    prev = index >= 0 ? before[index] : '';
    while (index >= 0 && (before[index] === ' ' || before[index] === '\t')) index -= 1;
    atLineStart = index < 0 ? !prev : before[index] === '\n';
  }
  const match = matchInlineMath(src, prev, { atLineStart, memo: run.memo });
  return match ? { type: 'mathInline', ...match } : undefined;
}

/** The index of the next `$`, `\(` or `\[` in `src`, or undefined. */
function nextOpenerIndex(src) {
  const dollar = src.indexOf('$');
  let backslash = src.indexOf('\\');
  while (backslash >= 0 && (dollar < 0 || backslash < dollar) && src[backslash + 1] !== '(' && src[backslash + 1] !== '[') {
    // `\\(` is an escaped backslash before a parenthesis, not an opener.
    backslash = src.indexOf('\\', backslash + (src[backslash + 1] === '\\' ? 2 : 1));
  }
  if (backslash >= 0 && dollar >= 0 && backslash > dollar) backslash = -1;
  if (dollar < 0) return backslash < 0 ? undefined : backslash;
  return backslash < 0 ? dollar : Math.min(dollar, backslash);
}

// The run whose tokenizer call came last. The library asks `start` in the
// same step of the same inline loop, with that call's text less its first
// character, which is how the run is recognised here.
let activeRun = null;

/**
 * Where the library's text rule has to stop: the next possible opener. The
 * library asks at every step of a paragraph; the answer is kept per run as
 * the length of the text behind the opener, so a long paragraph is searched
 * once and not once per step.
 */
function inlineMathStart(src) {
  if (!mathEnabled) return undefined;
  const run = activeRun && activeRun.src.length === src.length + 1 && activeRun.src[1] === src[0] ? activeRun : null;
  if (run && run.nextOpenerAhead !== undefined) {
    if (run.nextOpenerAhead < 0) return undefined;
    if (run.nextOpenerAhead <= src.length) return src.length - run.nextOpenerAhead;
  }
  const index = nextOpenerIndex(src);
  if (run) run.nextOpenerAhead = index === undefined ? -1 : src.length - index;
  return index;
}

function blockMathTokenizer(src) {
  if (!mathEnabled) return undefined;
  const first = src[0];
  if (first !== '$' && first !== '\\' && first !== ' ' && first !== '`' && first !== '~') return undefined;
  const match = matchMathBlock(src);
  return match ? { type: 'mathBlock', ...match } : undefined;
}

function holdsMath(tokens) {
  return Array.isArray(tokens)
    && tokens.some((token) => token.type === 'mathInline' || token.type === 'mathBlock' || holdsMath(token.tokens));
}

/**
 * An image's alternative text is an attribute: a formula placeholder in it
 * would end the attribute and spill its rest into the page. Such an alt text
 * is read again without the maths rules, as the library reads it alone.
 *
 * Runs once over the finished token tree. (The library's own `walkTokens`
 * gathers its callbacks' results by concatenation, which is quadratic in the
 * number of tokens of a long message.)
 */
function imageAltsWithoutMath(tokens, lexInline) {
  if (!Array.isArray(tokens)) return;
  for (const token of tokens) {
    if (token.type === 'image') {
      if (holdsMath(token.tokens)) token.tokens = lexInline(token.text);
      continue;
    }
    imageAltsWithoutMath(token.tokens, lexInline);
    imageAltsWithoutMath(token.items, lexInline);
    if (token.type === 'table') {
      for (const cell of token.header) imageAltsWithoutMath(cell.tokens, lexInline);
      for (const row of token.rows) for (const cell of row) imageAltsWithoutMath(cell.tokens, lexInline);
    }
  }
}

/** Installs the maths rules on a Markdown library; false when it cannot take them. */
export function useMathMarkdown(markdown) {
  if (!markdown || typeof markdown.use !== 'function') return false;
  const Lexer = markdown.Lexer;
  markdown.use({
    hooks: {
      processAllTokens(tokens) {
        if (!mathEnabled) return tokens;
        imageAltsWithoutMath(tokens, (text) => {
          if (typeof Lexer !== 'function') return [{ type: 'text', raw: text, text }];
          mathEnabled = false;
          try {
            // With the document's link definitions, as the first reading had them.
            const lexer = new Lexer(this.options);
            if (tokens.links) lexer.tokens.links = tokens.links;
            return lexer.inlineTokens(text);
          } finally {
            mathEnabled = true;
          }
        });
        return tokens;
      },
    },
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        tokenizer: blockMathTokenizer,
        renderer: (token) => `<p>${mathPlaceholderHtml({ ...token, raw: token.source })}${escapeHtml(token.trail || '')}</p>\n`,
      },
      {
        name: 'mathInline',
        level: 'inline',
        start: inlineMathStart,
        tokenizer: inlineMathTokenizer,
        renderer: (token) => mathPlaceholderHtml(token),
      },
    ],
  });
  return true;
}
