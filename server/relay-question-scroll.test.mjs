import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const askUserViewPath = fileURLToPath(new URL('./public/app/ask-user-view.js', import.meta.url));
const askUserViewSource = fs.readFileSync(askUserViewPath, 'utf8');

test('new relay question cards scroll to their first card only', () => {
  assert.match(askUserViewSource, /let renderedRelayQuestionIds = new Set\(\);/);
  assert.match(
    askUserViewSource,
    /const firstNewQuestionId = questions\.find\(\(question\) => !renderedRelayQuestionIds\.has\(question\.id\)\)\?\.id \|\| '';/,
  );
  // The scroll must stay inside #messages: scrollIntoView walks ancestor
  // scrollers and spills leftover alignment onto the page root, shifting the
  // header off-screen when the card is shorter than the container.
  assert.doesNotMatch(askUserViewSource, /scrollIntoView\(/);
  assert.match(askUserViewSource, /scrollQuestionCardIntoMessages\(el, target\);/);
  assert.match(
    askUserViewSource,
    /el\.scrollTop = Math\.max\(0, Math\.min\(top, el\.scrollHeight - el\.clientHeight\)\);/,
  );
  assert.match(
    askUserViewSource,
    /if \(firstNewQuestionId\) \{[\s\S]*?\} else if \(shouldAutoScroll\) \{/,
  );
});
