import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('normal relay client retains its existing CLI tool defaults', () => {
  // Normalize CRLF so the section-divider anchors below match on Windows checkouts.
  const relaySource = fs.readFileSync(new URL('./relay.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const optionsBuilder = relaySource.match(
    /export function buildCopilotClientOptions\([\s\S]*?\n}\n\n\/\/ ─── Client Init/,
  )?.[0] || '';

  assert.match(optionsBuilder, /connection:\s*\{\s*kind: 'stdio'/);
  assert.match(optionsBuilder, /useLoggedInUser: true/);
  assert.match(optionsBuilder, /logLevel: 'debug'/);
  assert.doesNotMatch(optionsBuilder, /mode:\s*'empty'/);
});
