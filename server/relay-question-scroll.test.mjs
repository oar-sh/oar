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
  assert.match(
    askUserViewSource,
    /target\?\.scrollIntoView\(\{ block: 'start', inline: 'nearest' \}\);/,
  );
  assert.match(
    askUserViewSource,
    /if \(firstNewQuestionId\) \{[\s\S]*?\} else if \(shouldAutoScroll\) \{/,
  );
});
