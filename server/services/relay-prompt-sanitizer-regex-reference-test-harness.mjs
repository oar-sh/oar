// The prompt sanitizer as it worked with one RegExp per prefix, kept as the
// reference the word-by-word matcher must equal byte for byte. Compiling those
// regexes takes a deep stack, so the test runs this file in a worker thread
// with a large one.
//
// Covers the steps the matcher replaced: the guidance blocks dropped anywhere
// in the text, then the first prefix that leaves something behind. The test's
// corpus carries none of the artifacts the unchanged steps strip (attachment
// notes, steer notes, the slash-command guard), so those reduce to trim().

import { parentPort, workerData } from 'node:worker_threads';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function whitespaceFlexiblePattern(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join('\\s+');
}

// The browser copy matches the guidance blocks by their shape, not verbatim.
const BROWSER_BLOCK_PATTERNS = [
  /##\s*Embedding media in replies\s+[\s\S]*?(?=\n\s*\n|$)/gi,
  /##\s*Formulas in replies\s+[\s\S]*?(?=\n\s*\n|$)/gi,
];

function referenceStrip(text, prefixPatterns, blockPatterns) {
  let value = String(text || '').trim();
  for (const pattern of blockPatterns) value = value.replace(pattern, '');
  value = value.trim();
  if (!value) return '';
  for (const pattern of prefixPatterns) {
    const stripped = value.replace(pattern, '').trim();
    if (stripped && stripped !== value) return stripped;
  }
  return value;
}

const { cases, prefixTextsByMode, blockTexts, browserBlocks } = workerData;
const blockPatterns = browserBlocks
  ? BROWSER_BLOCK_PATTERNS
  : blockTexts.map((text) => new RegExp(whitespaceFlexiblePattern(text), 'gi'));
const prefixPatternsByMode = new Map(Object.entries(prefixTextsByMode).map(([mode, texts]) => [
  mode,
  texts.map((text) => new RegExp(`^${whitespaceFlexiblePattern(text)}\\s*`, 'i')),
]));
parentPort.postMessage(cases.map(({ mode, text }) => referenceStrip(text, prefixPatternsByMode.get(mode), blockPatterns)));
