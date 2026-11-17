/**
 * Size guard for source files. A source file should stay at or below
 * MAX_LINES; the files that are larger today are listed with a ceiling at
 * their current size. The test fails when a listed file grows past its
 * ceiling, an unlisted file crosses MAX_LINES, or a listed file is gone or
 * smaller than its ceiling: a file that shrinks has its ceiling lowered to
 * the new size in the same change, or removed once it is at or below
 * MAX_LINES. Never raise a ceiling to make this test pass: split the file
 * instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MAX_LINES = 3000;

const CEILINGS = new Map([
  // The archive and unarchive fixes: +5 the dead-worker sweep's archived and Stop rows;
  // +13 a failed row's cards and Stops end in its failure; -4 the shared liveness probe;
  // -6 getOrCreateConversation's unreachable unarchive; +1 the unarchive wake's Claude API check;
  // +2 the imports re-pointed from messages-routes.mjs's re-exports.
  // The Copilot switch: -33 net from 9440. The empty-chat provider rebind
  // went (-129); the switch's CLI detector, the boot, ledger and usage gates,
  // the binding backstop, the claim fence and the launch checks came in.
  // -62 compacting a conversation moved to conversation-compaction-service.mjs.
  // -54: the PWA shell version moved to pwa-shell-version.mjs (-57); the
  // Copilot switch's checks at the worker launch and the worker replacement (+3).
  ['server/server-runtime.mjs', 9291],
  ['server/public/app/bootstrap.js', 6490],
  ['server/public/app/conversation-view.js', 5272],
  ['server/copilot-worker/copilot-sdk-session-process.mjs', 5204],
  // +6 for the local-relay branch of mapRemoteError.
  ['server/services/remote-relay-dispatcher.mjs', 4641],
  ['server/claude-worker/claude-session-process.mjs', 4600],
  ['server/public/app/journal-view.js', 3785],
  ['server/public/app/attachments-view.js', 3267],
]);

const SOURCE_DIRS = ['server/', 'shared/', 'bin/'];
const SOURCE_FILE_RE = /\.(mjs|js)$/;
// Tests, their harnesses and fixtures are not source; the package excludes
// the same patterns.
const NOT_SOURCE_RE = /(\.(test|spec)\.(mjs|js)$)|(-test-harness\.mjs$)|(-test-fixtures\.mjs$)|(\/fixtures\/)/;

// Tracked files only, so a local scratch file cannot fail the guard. Returns
// null when git cannot answer (no git on PATH, a source export without .git).
function listTrackedSourceFiles() {
  let listed = '';
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--', ...SOURCE_DIRS], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  return listed
    .split('\0')
    .filter(Boolean)
    .filter((file) => SOURCE_FILE_RE.test(file) && !NOT_SOURCE_RE.test(file));
}

function countLines(text) {
  if (text.length === 0) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

test('source files stay within their size ceilings', (t) => {
  const files = listTrackedSourceFiles();
  if (files === null) {
    t.skip('git ls-files is unavailable');
    return;
  }
  assert.ok(files.length > 0, 'git ls-files listed no source files');

  const failures = [];
  const sizes = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    const size = countLines(text);
    sizes.set(file, size);
    const ceiling = CEILINGS.get(file) ?? MAX_LINES;
    if (size > ceiling) {
      failures.push(`${file}: ceiling ${ceiling} lines, size ${size} lines`);
    }
  }
  for (const [file, ceiling] of CEILINGS) {
    const size = sizes.get(file);
    if (size === undefined) {
      failures.push(`${file}: ceiling ${ceiling} lines, but the file is not a tracked source file: remove its ceiling`);
    } else if (size < ceiling) {
      const fix = size > MAX_LINES ? `lower its ceiling to ${size}` : 'remove its ceiling';
      failures.push(`${file}: ceiling ${ceiling} lines, size ${size} lines: ${fix}`);
    }
  }

  assert.deepEqual(failures, [], `source files off their ceiling:\n${failures.join('\n')}`);
});
