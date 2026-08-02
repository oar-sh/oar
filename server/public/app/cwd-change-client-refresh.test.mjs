import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// bootstrap.js / attachments-view.js touch window and document at module scope,
// so they cannot be imported under plain node. These assertions are structural,
// matching the pattern in attachments-view.repo-refresh.test.mjs.
function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function functionBody(source, name) {
  const signatures = [
    `export function ${name}(`,
    `export async function ${name}(`,
    `function ${name}(`,
    `async function ${name}(`,
  ];
  let start = -1;
  for (const signature of signatures) {
    start = source.indexOf(signature);
    if (start !== -1) break;
  }
  assert.notEqual(start, -1, `expected to find function ${name}`);
  const next = source.slice(start).search(/\r?\n\}\r?\n/);
  assert.notEqual(next, -1, `expected to find the end of ${name}`);
  return source.slice(start, start + next + 3);
}

test('a CWD change discards every cached path of the previous workspace root', () => {
  const body = functionBody(readSource('./attachments-view.js'), 'resetWorkspaceRepoBrowserForRootChange');
  assert.match(body, /activeRoot !== 'workspace'/, 'only the workspace root is repointed by a CWD change');
  assert.match(body, /pendingRepoBrowserRestore = null/, 'a parked restore targets the old root');
  assert.match(body, /expandedPaths = new Set\(\)/);
  assert.match(body, /collapsedPaths = new Set\(\)/);
  assert.match(body, /currentPath: ''/);
  assert.match(body, /tree: null/);
  assert.match(body, /loadRepoBrowserTree\(\)/, 'an open browser must refetch against the new root');
});

test('a workspace root update refreshes the header label and the file explorer', () => {
  const body = functionBody(readSource('./bootstrap.js'), 'applyConversationWorkspaceRootUpdate');
  assert.match(body, /syncChatHeaderWorkspaceLabel\(\)/, 'the header CWD under the title must resync');
  assert.match(body, /resetWorkspaceRepoBrowserForRootChange\(\)/, 'the explorer must drop the old root');
  assert.match(body, /previousCurrentPath/, 'the reset is only for a genuine root change');
  assert.match(body, /toLowerCase\(\) !== previousCurrentPath\.toLowerCase\(\)/);
});

test('a relaunch payload replaces the runtime root instead of falling back to the stale one', () => {
  const body = functionBody(readSource('./bootstrap.js'), 'applyConversationWorkspaceRootUpdate');
  assert.match(body, /hasOwnProperty\.call\(payload, 'runtimeWorkspaceRootPath'\)/);
  assert.doesNotMatch(
    body,
    /payload\.runtimeWorkspaceRootPath \|\| existing\.runtimeWorkspaceRootPath/,
    'the old runtime root must not survive a payload that clears it',
  );
});
