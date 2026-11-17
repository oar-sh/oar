/**
 * A light scanner for JavaScript source text, for the scripts that read the
 * runtime and its tests (server-runtime-inventory.mjs,
 * server-runtime-source-readers.mjs); the repository has no parser. It knows
 * strings, template literals, comments and regular expression literals well
 * enough to find where a call's arguments or a statement end. A `/` starts a
 * regular expression where an expression may start (after one of `( , = : [
 * ! & | ? { } ; + - * % < > ~ ^` or a keyword like `return`); elsewhere it is
 * division.
 */

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

function regexMayStart(source, index) {
  let j = index - 1;
  while (j >= 0 && /\s/.test(source[j])) j -= 1;
  const before = j < 0 ? '' : source[j];
  if (REGEX_BEFORE.has(before)) return true;
  return /[\w$]/.test(before) && REGEX_AFTER_WORD.test(source.slice(Math.max(0, j - 10), j + 1));
}

/** The index just past the literal (string, template, regex) or comment at `i`, or -1 when there is none. */
export function skipLiteral(source, i) {
  const ch = source[i];
  if (ch === '/' && source[i + 1] === '/') {
    const end = source.indexOf('\n', i);
    return end < 0 ? source.length : end;
  }
  if (ch === '/' && source[i + 1] === '*') {
    const end = source.indexOf('*/', i + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    let j = i + 1;
    while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (ch === '`') {
    let j = i + 1;
    while (j < source.length && source[j] !== '`') {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '$' && source[j + 1] === '{') {
        // ${ … }: code up to its own closing brace.
        let depth = 1;
        j += 2;
        while (j < source.length && depth > 0) {
          const skipped = skipLiteral(source, j);
          if (skipped > 0) { j = skipped; continue; }
          if (source[j] === '{') depth += 1;
          else if (source[j] === '}') depth -= 1;
          j += 1;
        }
        continue;
      }
      j += 1;
    }
    return j + 1;
  }
  if (ch === '/' && regexMayStart(source, i)) {
    let j = i + 1;
    let inClass = false;
    while (j < source.length && source[j] !== '\n') {
      if (source[j] === '\\') { j += 2; continue; }
      if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      else if (source[j] === '/' && !inClass) break;
      j += 1;
    }
    if (source[j] !== '/') return -1;
    j += 1;
    while (/[a-z]/.test(source[j] || '')) j += 1;
    return j;
  }
  return -1;
}

/**
 * `source` with every comment replaced by spaces (line breaks kept), so
 * offsets stay. With `literals`, the insides of strings, template literals
 * and regular expressions are blanked too (their delimiters kept): what is
 * left is the code's structure alone.
 */
export function blankComments(source, { literals = false } = {}) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const end = skipLiteral(source, i);
    if (end < 0) { out += source[i]; i += 1; continue; }
    const text = source.slice(i, end);
    if (text.startsWith('//') || text.startsWith('/*')) out += text.replace(/[^\n]/g, ' ');
    else if (literals) {
      const close = text[0] === '/' ? text.lastIndexOf('/') : text.length - 1;
      out += text[0] + text.slice(1, close).replace(/[^\n]/g, ' ') + text.slice(close);
    } else out += text;
    i = end;
  }
  return out;
}

/**
 * The argument texts of the call whose `(` is at `open`, where each one
 * starts and ends (`spans`, untrimmed), and the index of its `)`:
 * `{ args, spans, end }`, or null when it cannot be told.
 */
export function callArgumentsAt(source, open) {
  if (source[open] !== '(') return null;
  const args = [];
  const spans = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < source.length && i < open + 50_000; i += 1) {
    const skipped = skipLiteral(source, i);
    if (skipped > 0) { i = skipped - 1; continue; }
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        const last = source.slice(start, i).trim();
        if (last || args.length) { args.push(last); spans.push([start, i]); }
        return { args, spans, end: i };
      }
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      args.push(source.slice(start, i).trim());
      spans.push([start, i]);
      start = i + 1;
    }
  }
  return null;
}

/** The index of the bracket that closes the one at `open` (`(`, `[` or `{`), or -1. */
export function closingBracket(source, open) {
  if (!'([{'.includes(source[open] || ' ')) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const skipped = i === open ? -1 : skipLiteral(source, i);
    if (skipped > 0) { i = skipped - 1; continue; }
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The index of the `;` that ends the statement starting at `start` (depth 0), or the source's end. */
export function statementEnd(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const skipped = skipLiteral(source, i);
    if (skipped > 0) { i = skipped - 1; continue; }
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === ';' && depth === 0) return i;
  }
  return source.length;
}
