// Which `$` in a run of text delimit inline maths, and which are plain dollar
// signs. Prices are the common case of the second kind: without a rule,
// "$5 for one and $9 for two" reads as one formula running from the first
// sign to the second.
//
// The rule is the one pandoc uses for dollar maths: the opening `$` has a
// non-space character directly after it, the closing `$` is the next dollar
// sign, has a non-space character directly before it and no digit directly
// after it. A `$$` pair is
// display maths and is left alone, and a `$` behind a backslash is escaped.

const TEX_LOOKING = /[\\^_{}=]/;

function isEscaped(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isSpace(char) {
  return char === undefined || /\s/.test(char);
}

// A formula holds no dollar sign of its own, so only the next one can close
// it. When that one does not qualify ("$5, and $x^2$": it follows a space),
// the opening sign is a plain dollar and the next one gets its own turn.
function findClosingDollar(text, openIndex) {
  let i = openIndex + 1;
  while (i < text.length && (text[i] !== '$' || isEscaped(text, i))) i += 1;
  if (i >= text.length) return -1;
  // Part of a `$$`: not the end of an inline formula.
  if (text[i + 1] === '$') return -1;
  if (isSpace(text[i - 1])) return -1;
  const content = text.slice(openIndex + 1, i);
  // "$5/$10": a digit right behind the sign means the sign starts a number.
  // Real maths directly followed by a digit ("$x^2$3") is told apart by
  // looking like TeX.
  if (/\d/.test(text[i + 1] || '') && !TEX_LOOKING.test(content)) return -1;
  return i;
}

/**
 * Scan `text` for single-dollar maths.
 * @returns {{ spans: Array<[number, number]>, literals: number[] }} `spans`
 *   are [open, close] index pairs of formulas, `literals` the indexes of `$`
 *   that are plain dollar signs.
 */
export function scanInlineDollars(text) {
  const source = String(text ?? '');
  const spans = [];
  const literals = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '$' || isEscaped(source, index)) {
      index += 1;
      continue;
    }
    if (source[index + 1] === '$') {
      const close = source.indexOf('$$', index + 2);
      index = close < 0 ? index + 2 : close + 2;
      continue;
    }
    const close = isSpace(source[index + 1]) ? -1 : findClosingDollar(source, index);
    if (close < 0) {
      literals.push(index);
      index += 1;
      continue;
    }
    spans.push([index, close]);
    index = close + 1;
  }
  return { spans, literals };
}

/** `text` cut at its plain dollar signs: `[{ text, literal }]`, in order. */
export function splitAtLiteralDollars(text) {
  const source = String(text ?? '');
  const { literals } = scanInlineDollars(source);
  if (!literals.length) return [{ text: source, literal: false }];
  const parts = [];
  let from = 0;
  for (const index of literals) {
    if (index > from) parts.push({ text: source.slice(from, index), literal: false });
    parts.push({ text: '$', literal: true });
    from = index + 1;
  }
  if (from < source.length) parts.push({ text: source.slice(from), literal: false });
  return parts;
}
