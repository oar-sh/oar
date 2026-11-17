// Finds a known text in a message while letting any run of whitespace stand
// in for the whitespace between its words, ignoring case.
//
// It does what a RegExp `w1\s+w2\s+…\s+wn` with the `i` flag (and no `u`)
// does, without building one. A regex built from a long text, such as the
// relay tool guidance of a few thousand words, recurses once per word when
// V8 compiles it, and overflows the stack once the text is long enough
// (sooner on Windows, whose threads get less stack). Walking the words keeps
// the stack flat however long the text grows.
//
// Served to the browser as is, and imported by the server copy of the prompt
// sanitizer and by the worker runtime, so all of them match alike.

// Exactly the characters `\s` matches in a JavaScript regex: WhiteSpace
// (tab, VT, FF, ZWNBSP and the Zs category) and LineTerminator.
export function isRegExpWhitespace(code) {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  if (code < 0xa0) return false;
  return code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

const CANONICAL_CACHE = new Map();

// The case folding of a RegExp with `i` and without `u` (ECMA-262
// Canonicalize): a code unit is upper-cased, unless that gives more than one
// code unit or turns a non-ASCII character into an ASCII one.
function canonicalize(code) {
  if (code < 0x80) return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  const cached = CANONICAL_CACHE.get(code);
  if (cached !== undefined) return cached;
  const upper = String.fromCharCode(code).toUpperCase();
  let result = code;
  if (upper.length === 1) {
    const upperCode = upper.charCodeAt(0);
    if (upperCode >= 0x80) result = upperCode;
  }
  CANONICAL_CACHE.set(code, result);
  return result;
}

/**
 * Split a text into the words to match, once. Whitespace is split the way
 * `split(/\s+/)` splits it.
 */
export function compileWordSequence(text) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const codes = new Uint16Array(word.length);
      for (let i = 0; i < word.length; i += 1) codes[i] = canonicalize(word.charCodeAt(i));
      return codes;
    });
  return Object.freeze({ words });
}

/**
 * The end offset of the word sequence when it starts exactly at `start` in
 * `input` (words separated by at least one whitespace character), or -1.
 */
export function matchWordSequenceAt(input, start, sequence) {
  const { words } = sequence;
  const length = input.length;
  let position = start;
  for (let w = 0; w < words.length; w += 1) {
    if (w > 0) {
      if (position >= length || !isRegExpWhitespace(input.charCodeAt(position))) return -1;
      position += 1;
      while (position < length && isRegExpWhitespace(input.charCodeAt(position))) position += 1;
    }
    const word = words[w];
    if (position + word.length > length) return -1;
    for (let i = 0; i < word.length; i += 1) {
      if (canonicalize(input.charCodeAt(position + i)) !== word[i]) return -1;
    }
    position += word.length;
  }
  return position;
}

/**
 * Like `^w1\s+…\s+wn\s*` with the `i` flag: the offset where the rest of
 * `input` starts when it begins with the word sequence (trailing whitespace
 * included), or -1.
 */
export function matchLeadingWordSequence(input, sequence) {
  const value = String(input ?? '');
  let end = matchWordSequenceAt(value, 0, sequence);
  if (end < 0) return -1;
  while (end < value.length && isRegExpWhitespace(value.charCodeAt(end))) end += 1;
  return end;
}

/**
 * Like `input.replace(/w1\s+…\s+wn/gi, '')`: every occurrence, left to right
 * and not overlapping, removed.
 */
export function removeWordSequences(input, sequence) {
  const value = String(input ?? '');
  const { words } = sequence;
  if (!words.length) return value;
  const first = words[0][0];
  let result = '';
  let copiedUpTo = 0;
  let position = 0;
  while (position < value.length) {
    if (canonicalize(value.charCodeAt(position)) === first) {
      const end = matchWordSequenceAt(value, position, sequence);
      if (end >= 0) {
        result += value.slice(copiedUpTo, position);
        copiedUpTo = end;
        position = end;
        continue;
      }
    }
    position += 1;
  }
  return copiedUpTo === 0 ? value : result + value.slice(copiedUpTo);
}
