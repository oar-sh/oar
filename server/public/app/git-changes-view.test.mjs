import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// git-changes-view.js touches window/document at module scope via its store
// import, so it cannot be imported under plain node. The wiring that matters
// is structural, so it is asserted against the source — the pattern used by
// attachments-view.repo-refresh.test.mjs.
function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const viewSource = readSource('./git-changes-view.js');
const indexHtml = readSource('../index.html');
const bootstrapSource = readSource('./bootstrap.js');

test('closing the diff viewer does not close the git changes modal', () => {
  const start = viewSource.indexOf('export function closeGitDiffViewer(');
  const end = viewSource.indexOf('\nexport ', start + 1);
  const body = viewSource.slice(start, end === -1 ? viewSource.length : end);
  assert.match(body, /diffModal\.classList\.remove\('visible'\)/);
  assert.doesNotMatch(body, /closeGitChangesModal/);
});

test('escape closes the diff viewer before the changes modal', () => {
  const escapeBlock = viewSource.slice(viewSource.indexOf("event.key !== 'Escape'"));
  const diffIndex = escapeBlock.indexOf('closeGitDiffViewer()');
  const modalIndex = escapeBlock.indexOf('closeGitChangesModal()');
  assert.ok(diffIndex !== -1 && modalIndex !== -1);
  assert.ok(diffIndex < modalIndex, 'diff viewer must close first');
});

test('deleted files render with the strikethrough class on the filename row', () => {
  assert.match(viewSource, /file\.deleted \? 'git-changes-file-name deleted'/);
  assert.match(indexHtml, /\.git-changes-file-name\.deleted\s*\{[^}]*line-through/);
});

test('entries split the path into a filename row and a muted directory row', () => {
  assert.match(viewSource, /fullPath\.lastIndexOf\('\/'\)/);
  assert.match(viewSource, /class="git-changes-file-dir"/);
  assert.match(indexHtml, /\.git-changes-file-dir\s*\{[^}]*var\(--muted\)/);
  assert.match(indexHtml, /\.git-changes-file-name\s*\{[^}]*var\(--text\)/);
});

test('the git status request is scoped to the current conversation', () => {
  assert.match(viewSource, /loadGitStatus\(currentConvId\)/);
  assert.match(viewSource, /loadGitDiff\(diff\.path, \{ conversationId: currentConvId/);
});

test('the diff viewer stacks above the git changes modal and below the file preview', () => {
  const gitZ = Number(indexHtml.match(/#git-changes-modal \{ z-index: (\d+); \}/)?.[1]);
  const diffZ = Number(indexHtml.match(/#git-diff-modal \{ z-index: (\d+); \}/)?.[1]);
  assert.ok(gitZ > 0 && diffZ > gitZ, 'diff modal must stack above the changes modal');
  assert.ok(diffZ < 11000, 'diff modal must stay below the file preview modal');
});

test('the chat actions menu opens the git changes modal', () => {
  assert.match(indexHtml, /id="chat-menu-git-changes"/);
  assert.match(bootstrapSource, /chat-menu-git-changes/);
  assert.match(bootstrapSource, /openGitChangesModal\(\)/);
  assert.match(bootstrapSource, /initGitChangesView\(\)/);
});
