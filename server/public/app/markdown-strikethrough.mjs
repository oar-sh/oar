// Strikethrough needs two tildes.
//
// The Markdown library also strikes text between two SINGLE tildes. In prose
// a single tilde means "about" ("~35 s … ~7 min"), and two of them in one
// paragraph struck out everything in between. Only `~~text~~` strikes now;
// a single tilde is the character it is.

const DOUBLE_TILDE = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/;

/**
 * The `del` tokenizer for `marked.use({ tokenizer: … })`. Returns the token
 * for `~~text~~`, and undefined for anything else: "no strikethrough here".
 * (`false` would hand the text back to the library's own rule.)
 */
export function strictStrikethroughTokenizer(src) {
  const match = DOUBLE_TILDE.exec(String(src || ''));
  if (!match) return undefined;
  return {
    type: 'del',
    raw: match[0],
    text: match[1],
    tokens: this.lexer.inlineTokens(match[1]),
  };
}

/** Installs the rule on a Markdown library; false when it cannot take one. */
export function useStrictStrikethrough(markdown) {
  if (!markdown || typeof markdown.use !== 'function') return false;
  markdown.use({ tokenizer: { del: strictStrikethroughTokenizer } });
  return true;
}
